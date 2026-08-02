// turn-controller.js — the single coordinator for one user turn in the new
// conversational surface (POST /api/conversations/:id/turns and friends).
//
// Everything a turn needs to do lives here, in one place, in this order:
//   resolve conversation + source scope -> retrieve (engine-ground.js) ->
//   assemble a grounded model context -> call the talker model, streaming ->
//   verify citations + quoted prose mechanically (citation-check.js) ->
//   persist the completed turn (conversation-store.js).
//
// It does not classify the turn's EO cell by keyword regex — that scaffolding
// (classifyMessage/classifyCode) has been removed from proxy.js entirely, not
// relocated here. Terrain/EO facts either come from a real engine consequence
// (e.g. terrain_report, which is mechanical) or are simply absent. No new
// keyword classifier has been substituted.
//
// Depends on nothing in proxy.js, so proxy.js can import this without a cycle.

import { validateCitations, verifyQuotedFidelity } from "./citation-check.js";

export const HISTORY_TURNS = 6;

// No caller — client or otherwise — has ever set a system message for this
// surface (the UI sends only { question, sourceScope, pool, attachments }).
// Without this, every turn's only "system" instruction was the grounding
// prompt below, which talks about citations and source material, not about
// who is answering or how to handle a harmful ask. Kept short: this rides on
// every turn a small local model sees, and prompt weight it can't spare is
// prompt weight it drops first.
const DEFAULT_PERSONA_PROMPT =
  "You are a warm, direct conversational assistant. Speak naturally and get " +
  "to the point rather than hedging or over-explaining. If a request is " +
  "genuinely harmful — violence, serious illegality, or someone's safety or " +
  "privacy at risk — decline briefly and help with the legitimate need behind " +
  "it if there is one, without a lecture. Otherwise, just help.";
const DEFAULT_PERSONA_MESSAGE = { role: "system", content: DEFAULT_PERSONA_PROMPT };

function newAnswerEventKey(conversationId, turnId) {
  return `${conversationId}:${turnId}`;
}

// Same mechanical (no model call) keyword extraction DiscourseStore uses in
// proxy.js for its own fold — kept as an independent copy rather than a
// shared import so this module still depends on nothing in proxy.js.
const TOPIC_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "was", "are", "were", "be", "been", "has",
  "had", "have", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "can", "that", "this", "it", "its", "i", "you", "we", "they",
  "he", "she", "me", "my", "your", "our", "their", "his", "her", "him", "not",
  "no", "so", "if", "then", "just", "about", "like", "what", "when", "where",
  "how", "which", "who",
]);

function extractTopics(text, limit = 12) {
  const freq = {};
  for (const w of text.toLowerCase().split(/\s+/)) {
    const clean = w.replace(/[^a-z0-9]/g, "");
    if (clean.length > 3 && !TOPIC_STOPWORDS.has(clean)) freq[clean] = (freq[clean] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

// Turns older than the recent window are folded into one mechanical summary
// system message instead of being silently dropped — the same shape as
// DiscourseStore's priorSummary fold in proxy.js, applied here so THIS
// surface (the one the UI actually talks to) doesn't just forget everything
// past HISTORY_TURNS back with no trace at all.
function foldOlderTurns(turns) {
  const dialogue = turns.map((t) => {
    const active = (t.answers || []).find((a) => a.id === t.activeAnswerId);
    const answerText = active && active.status === "completed" ? (active.text || "") : "";
    return `User: ${(t.question || "").slice(0, 300)}\nAssistant: ${answerText.slice(0, 300)}`;
  }).join("\n");
  const allText = turns.map((t) => {
    const active = (t.answers || []).find((a) => a.id === t.activeAnswerId);
    return `${t.question || ""} ${active?.text || ""}`;
  }).join(" ");
  const content = [
    `[Earlier in this conversation — ${turns.length} exchange(s), compressed]`,
    `Topics discussed: ${extractTopics(allText).join(", ")}`,
    "",
    dialogue.slice(0, 2000),
  ].join("\n");
  return { role: "system", content };
}

// Every [n] the answer actually cites, matched against the engine's real
// citation table. A bracket with no matching entry is a gap, never a guess.
function resolveCitationBrackets(text, citations) {
  const table = new Map((citations || []).map((c) => [String(c.index), c]));
  const seen = new Set();
  const resolved = [];
  const unresolvedNums = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const num = m[1];
    if (seen.has(num)) continue;
    seen.add(num);
    const c = table.get(num);
    if (c) {
      resolved.push({
        num, resolved: true,
        sourceId: c.source_id, spanId: c.span_id,
        byteStart: c.byte_start, byteEnd: c.byte_end, score: c.score,
      });
    } else {
      unresolvedNums.push(num);
      resolved.push({ num, resolved: false });
    }
  }
  return { citations: resolved, unresolvedNums };
}

/**
 * @param {object} deps
 * @param {import('./conversation-store.js').ConversationStore} deps.conversationStore
 * @param {(query: string, opts: object) => object} deps.groundQuery - engineGroundQuery
 * @param {string} deps.target - Ollama base URL
 * @param {number} deps.numCtx
 * @param {object|null} deps.modelRouter - learned router (has .pick/.reveal), or null
 * @param {(messages: object[]) => string} deps.heuristicModel - cold-start model choice, latency/shape based (not EO/keyword classification)
 * @param {number} deps.latencyBudgetMs
 * @param {() => boolean} deps.isWarming - true while the corpus is still ingesting at boot
 */
export function createTurnController(deps) {
  const {
    conversationStore, groundQuery, target, numCtx,
    modelRouter, heuristicModel, latencyBudgetMs, isWarming,
  } = deps;

  // One in-flight generation per (conversation, turn) at a time — stop/regenerate
  // both need to find it by that key alone, before they know an answerId.
  const activeControllers = new Map();

  function buildGroundedSystemMessage(groundResult) {
    if (!groundResult.context) {
      const warming = isWarming ? isWarming() : false;
      const content = warming
        ? `Answer the reader's question directly, from your own knowledge, as naturally as you would in ` +
          `ordinary conversation. Do not mention an index, a document search, sources, or any retrieval ` +
          `process. Do NOT use bracketed citations like [1] — there are no passages to cite.`
        : `Answer the reader's question directly, from your own knowledge, as naturally as you would in ` +
          `ordinary conversation. Do not preface the answer or otherwise mention that you lack sources, ` +
          `documents, or "source material" — just answer. Do NOT use bracketed citations like [1], [2] — ` +
          `there are no source passages, and a bracket would look like a citation that does not exist.`;
      return { message: { role: "system", content }, maxCitation: 0, warming };
    }

    const citationRange = groundResult.citations.length > 0
      ? `You have ${groundResult.citations.length} source passage(s) numbered [1] through [${groundResult.citations.length}]. ` +
        `ONLY cite these numbers. NEVER cite [${groundResult.citations.length + 1}] or higher — those do not exist. `
      : "";
    const content =
      `Answer the reader's question using the material below, citing the passages you draw on ` +
      `with bracketed numbers like [1], [2], etc. ` + citationRange +
      `Do NOT invent facts beyond what the material contains. If it does not contain the answer, ` +
      `say so plainly — but do not describe your process, and do not refer to "the source material", ` +
      `"the provided text", "your sources", or similar; just answer directly.\n\n` +
      `--- Material (${groundResult.total} passages found, ${groundResult.folded} folded, ${groundResult.tokens} tokens) ---\n` +
      `${groundResult.context}`;
    return { message: { role: "system", content }, maxCitation: groundResult.citations.length, warming: false };
  }

  // Recent completed turns from THIS conversation, as real message history —
  // not reconstructed from a keyword memory search. Bounded so a long-running
  // conversation doesn't grow the prompt without limit.
  function buildHistoryMessages(conv, beforeTurnId) {
    const turns = (conv.turns || []).filter((t) => t.id !== beforeTurnId);
    const older = turns.slice(0, -HISTORY_TURNS);
    const recent = turns.slice(-HISTORY_TURNS);
    const out = [];
    if (older.length > 0) out.push(foldOlderTurns(older));
    for (const t of recent) {
      out.push({ role: "user", content: t.question });
      const active = (t.answers || []).find((a) => a.id === t.activeAnswerId);
      if (active && active.status === "completed" && active.text) {
        out.push({ role: "assistant", content: active.text });
      }
    }
    return out;
  }

  async function callModelStreaming(messages, { signal, onDelta }) {
    let model, routerCtx;
    if (modelRouter) {
      ({ model, ctx: routerCtx } = modelRouter.pick(messages));
    } else {
      model = heuristicModel(messages);
      routerCtx = null;
    }
    const startedAt = Date.now();
    const resp = await fetch(`${target}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, messages, stream: true,
        options: { temperature: 0.7, num_predict: 4096, num_ctx: numCtx },
      }),
      signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`Ollama ${resp.status}: ${errText}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim().replace(/^data:\s*/, "");
        if (!t) continue;
        let j;
        try { j = JSON.parse(t); } catch { continue; }
        if (j.error) throw new Error(`Ollama: ${j.error}`);
        const delta = j.message?.content || "";
        if (delta) { text += delta; onDelta(delta, text); }
      }
    }
    const elapsedMs = Date.now() - startedAt;
    if (routerCtx) {
      const outcome = elapsedMs > latencyBudgetMs ? "failure" : "success";
      try { await modelRouter.reveal(routerCtx, outcome); } catch { /* best-effort */ }
    }
    return { text, model };
  }

  // The core pipeline shared by a fresh turn and a regenerate — both already
  // have a turnId/answerId and a question by the time this runs.
  async function runAnswer({ conv, turn, answerId, question, sourceScope, pool }, sendEvent) {
    const key = newAnswerEventKey(conv.id, turn.id);
    const controller = new AbortController();
    activeControllers.set(key, controller);

    try {
      sendEvent("retrieval_started", { turnId: turn.id, answerId });

      const groundResult = groundQuery(question, {
        budget: 3000, maxUnits: 5, limit: 16,
        source: sourceScope, pool: pool || "corpus",
      });
      const { message: systemMsg, maxCitation, warming } = buildGroundedSystemMessage(groundResult);

      sendEvent("witnesses_selected", {
        turnId: turn.id, answerId,
        empty: !groundResult.context,
        warming,
        sourceCount: groundResult.total || 0,
        foldedCount: groundResult.folded || 0,
        tokens: groundResult.tokens,
        budget: groundResult.budget,
        dropped: groundResult.dropped,
        retrieved: groundResult.retrieved || [],
        citations: (groundResult.citations || []).map((c, i) => ({
          index: i + 1, span_id: c.span_id, source_id: c.source_id,
          byte_start: c.byte_start, byte_end: c.byte_end,
          score: Math.round((c.score || 0) * 100) / 100, text: c.text,
        })),
        gaps: groundResult.gaps || [],
        // Priors widen retrieval but are metadata about HOW retrieval was
        // steered, never themselves offered as a citation — kept in its own
        // field so a client cannot accidentally render it as evidence.
        priorWidening: groundResult.priorWidening || null,
      });

      await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
        grounding: {
          sourceCount: groundResult.total || 0,
          foldedCount: groundResult.folded || 0,
          tokens: groundResult.tokens,
          budget: groundResult.budget,
          dropped: groundResult.dropped,
          empty: !groundResult.context,
          warming,
          priorWidening: groundResult.priorWidening || null,
        },
      });

      // The one citation table this whole answer is checked against — index,
      // byte range, and verbatim text together, so bracket resolution and
      // quote-fidelity checking can never drift apart into two different ideas
      // of what citation [n] is.
      const lastCitations = (groundResult.citations || []).map((c, i) => ({
        index: i + 1, source_id: c.source_id, span_id: c.span_id,
        byte_start: c.byte_start, byte_end: c.byte_end, score: c.score, text: c.text,
      }));

      const history = buildHistoryMessages(conv, turn.id);
      const messages = [DEFAULT_PERSONA_MESSAGE, systemMsg, ...history, { role: "user", content: question }];

      let sawStart = false;
      const { text: rawText, model } = await callModelStreaming(messages, {
        signal: controller.signal,
        onDelta: (delta, text) => {
          // Captured on the controller itself so a stop mid-stream can persist
          // exactly what the reader already saw, not an empty answer.
          controller._partialText = text;
          if (!sawStart) { sawStart = true; sendEvent("writing_started", { turnId: turn.id, answerId, passageCount: groundResult.folded || 0 }); }
          sendEvent("answer_delta", { turnId: turn.id, answerId, delta, text });
        },
      });

      // Resolve brackets against the RAW text first — validateCitations below
      // rewrites an unresolved [9] into "[⊘ no source 9]", which no longer
      // looks like a citation at all and would make the very gap it exists to
      // report invisible to bracket resolution.
      const { citations: brackets, unresolvedNums } = resolveCitationBrackets(rawText, lastCitations);
      const finalText = maxCitation > 0 ? validateCitations(rawText, maxCitation) : rawText;
      const fidelity = verifyQuotedFidelity(finalText, lastCitations);

      for (const c of brackets) {
        sendEvent("citation_verified", { turnId: turn.id, answerId, ...c });
      }
      const gaps = [];
      if (unresolvedNums.length) {
        gaps.push({ type: "unresolved_citation", nums: unresolvedNums, reason: `[${unresolvedNums.join("], [")}] — no engine passage matches this bracket.` });
      }
      for (const u of fidelity.unverified) {
        gaps.push({ type: "unverified_quote", quote: u.quote, reason: "This quoted text does not appear verbatim in any cited passage." });
      }
      for (const g of groundResult.gaps || []) gaps.push(g);
      if (!groundResult.context) {
        gaps.push({
          type: warming ? "corpus_warming" : "no_evidence_matched",
          reason: warming
            ? "The document index was still loading when this was asked."
            : "No passage in your sources matches this question — answered from general knowledge, uncited.",
        });
      }
      for (const g of gaps) sendEvent("gap", { turnId: turn.id, answerId, ...g });

      await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
        text: finalText, model, citations: brackets, gaps,
        fidelity, status: "completed", completedAt: new Date().toISOString(),
      });
      sendEvent("completed", {
        turnId: turn.id, answerId, status: "completed", text: finalText,
        citations: brackets, gaps, model,
        summary: `${groundResult.folded || 0} passages · ${new Set((groundResult.citations || []).map((c) => c.source_id)).size} sources`,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        // Whatever streamed before the stop is a valid, honest partial turn —
        // not an error. Persist and report it as interrupted, not failed.
        const partial = controller._partialText || "";
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          text: partial, status: "interrupted", completedAt: new Date().toISOString(),
        }).catch(() => {});
        sendEvent("completed", { turnId: turn.id, answerId, status: "interrupted", text: partial });
      } else {
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          status: "failed", completedAt: new Date().toISOString(), error: err.message,
        }).catch(() => {});
        sendEvent("failed", { turnId: turn.id, answerId, message: err.message });
      }
    } finally {
      activeControllers.delete(key);
    }
  }

  async function startTurn({ conversationId, question, sourceScope, pool, attachments }, sendEvent) {
    const conv = await conversationStore.require(conversationId);
    const effectiveScope = sourceScope !== undefined ? sourceScope : conv.sourceScope;
    const { turn } = await conversationStore.appendTurn(conversationId, {
      question, sourceScope: effectiveScope, attachments,
    });
    const answer = await conversationStore.addAnswer(conversationId, turn.id, {});
    sendEvent("accepted", {
      turnId: turn.id, answerId: answer.id, question,
      sourceScope: effectiveScope, pool: pool || conv.pool || "corpus",
    });

    const run = runAnswer({
      conv, turn, answerId: answer.id,
      question, sourceScope: effectiveScope, pool: pool || conv.pool,
    }, sendEvent);

    return { turnId: turn.id, answerId: answer.id, done: run };
  }

  async function regenerateTurn({ conversationId, turnId }, sendEvent) {
    const conv = await conversationStore.require(conversationId);
    const turn = (conv.turns || []).find((t) => t.id === turnId);
    if (!turn) throw new Error(`turn not found: ${turnId}`);
    const answer = await conversationStore.addAnswer(conversationId, turnId, {});
    sendEvent("accepted", {
      turnId, answerId: answer.id, question: turn.question,
      sourceScope: turn.sourceScope, pool: conv.pool || "corpus",
      regenerate: true,
    });
    const run = runAnswer({
      conv: { ...conv, id: conversationId }, turn, answerId: answer.id,
      question: turn.question, sourceScope: turn.sourceScope, pool: conv.pool,
    }, sendEvent);
    return { turnId, answerId: answer.id, done: run };
  }

  function stopTurn(conversationId, turnId) {
    const key = newAnswerEventKey(conversationId, turnId);
    const controller = activeControllers.get(key);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  return { startTurn, regenerateTurn, stopTurn };
}
