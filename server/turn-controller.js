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
import { buildVerbatimSnippets } from "./verbatim-snippets.js";
import { HolonicTask } from "./holonic-task.js";
import { createInstructionGate, countTokens as gateCountTokens } from "./instruction-gate.js";
import { reviewOutput, buildCorrectionSystemContent } from "./output-review.js";

// Mechanical post-processing: read the model's own output and format it for
// display — no model call, no learned system, just regexes and rules.
// Handles sentence-boundary spacing, paragraph breaks before numbered lists,
// and whitespace cleanup.
function formatOutput(text) {
  if (!text) return text;
  let t = text;

  // Fix missing space after sentence-ending punctuation when the next
  // character is a capital letter, opening quote, opening bracket, or
  // opening paren (but NOT inside a citation bracket like [1] or a
  // decimal like 3.14 — ".\d" is left alone).
  t = t.replace(/([.!?])([A-Z"'(])/g, '$1 $2');

  // Ensure a paragraph break before numbered list items — these are
  // patterns like " 1. ", " 2. ", " 3. " that commonly follow a colon
  // or sentence end without a line break.
  t = t.replace(/([.:])\s*(\d+)\.\s+/g, '$1\n\n$2. ');

  // Ensure each subsequent numbered item gets its own line.
  t = t.replace(/\n(\d+)\.\s/g, '\n\n$1. ');

  // Fix missing space after ellipsis when followed by text.
  t = t.replace(/\.\.\.([A-Za-z])/g, '... $1');

  // Collapse runs of 3+ newlines down to exactly 2 (paragraph separator).
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

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

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * @param {object} deps
 * @param {import('./conversation-store.js').ConversationStore} deps.conversationStore
 * @param {(query: string, opts: object) => object} deps.groundQuery - engineGroundQuery
 * @param {string} deps.target - Ollama base URL
 * @param {string} deps.anthropicKey - Anthropic API key (empty string if not configured)
 * @param {string} deps.anthropicModel - default Anthropic model id
 * @param {number} deps.numCtx
 * @param {object|null} deps.modelRouter - learned router (has .pick/.reveal), or null
 * @param {(messages: object[]) => string} deps.heuristicModel - cold-start model choice, latency/shape based (not EO/keyword classification)
 * @param {number} deps.latencyBudgetMs
 * @param {() => boolean} deps.isWarming - true while the corpus is still ingesting at boot
 * @param {(query: string, opts?: object) => Promise<Array<{rank:number,title:string,url:string,snippet:string,text:string}>>} deps.webSearchFn - performs web search + fetch, returns structured results
 */
export function createTurnController(deps) {
  const {
    conversationStore, groundQuery, target, anthropicKey, anthropicModel,
    numCtx,
    modelRouter, heuristicModel, latencyBudgetMs, isWarming, webSearchFn,
  } = deps;

  const _getAnthropicKey = () => typeof anthropicKey === 'function' ? anthropicKey() : anthropicKey;

  // The instruction gate: surfaces the relevant instruction folds verbatim each
  // turn, folds the rest to a fingerprint index, and injects the resulting
  // block as an extra system message. A missing corpus yields an empty gate
  // (no-op); a corpus parse error throws at boot, on purpose.
  const instructionGate = createInstructionGate();

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

  function buildWebSystemMessage(webResults) {
    if (!webResults || webResults.length === 0) {
      return {
        message: { role: "system", content: "Answer the reader's question from your own knowledge. Do NOT use bracketed citations like [1] — there are no sources to cite." },
        maxCitation: 0, warming: false,
      };
    }
    const parts = webResults.map((r, i) => {
      const body = (r.text || r.snippet || "").trim();
      return `[${i + 1}] ${r.title}\n    URL: ${r.url}\n${body ? `\n${body}` : ""}`;
    });
    const content =
      `Answer the reader's question using the web search results below. When you draw on specific information, ` +
      `cite the source number like [1], [2], etc. Do NOT invent facts beyond what the material contains. ` +
      `If it does not contain the answer, say so plainly.\n\n` +
      `--- Web Search Results (${webResults.length} sources) ---\n\n` +
      parts.join("\n\n");
    return { message: { role: "system", content }, maxCitation: webResults.length, warming: false };
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

  // The user turns this gate should judge relevance against — the same bounded
  // history the model sees, user messages only.
  function recentUserQuestions(conv, beforeTurnId) {
    return (conv.turns || []).filter((t) => t.id !== beforeTurnId).slice(-HISTORY_TURNS).map((t) => t.question);
  }

  // Gate one turn's instruction context. Returns null when there is no corpus
  // (an empty gate is a no-op, never a crash), otherwise the report for SSE +
  // persistence plus the system message to prepend to the model call.
  function gateInstructionBlock({ question, conv, turnId }) {
    if (!instructionGate.folds.length) return null;
    const r = instructionGate.gate({ question, history: recentUserQuestions(conv, turnId) });
    return {
      activeIds: r.activeIds,
      foldedIds: r.foldedIds,
      blockTokens: gateCountTokens(r.systemMessage),
      budget: r.stats.budget,
      overflow: r.stats.overflow,
      stats: { gap: r.stats.gap, rejectedByBudget: r.stats.rejectedByBudget },
      systemMessage: r.systemMessage,
    };
  }

  function emitGateReport(sendEvent, turnId, answerId, g) {
    if (!g) return;
    sendEvent("gate_report", {
      turnId, answerId,
      activeIds: g.activeIds,
      foldedIds: g.foldedIds,
      blockTokens: g.blockTokens,
      budget: g.budget,
      overflow: g.overflow,
    });
  }

  async function callOllamaStreaming(model, messages, { signal, onDelta }) {
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
    return { text, model };
  }

  async function callAnthropicStreaming(model, messages, { signal, onDelta }) {
    const systemMessages = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const nonSystem = messages.filter(m => m.role !== "system");
    const body = {
      model,
      max_tokens: 4096,
      messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (systemMessages) body.system = systemMessages;
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": _getAnthropicKey(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`Anthropic ${resp.status}: ${errText}`);
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
        const t = line.trim();
        if (!t || !t.startsWith("data: ")) continue;
        const json = t.slice(6);
        if (json === "[DONE]") continue;
        let j;
        try { j = JSON.parse(json); } catch { continue; }
        if (j.type === "content_block_delta" && j.delta?.text) {
          text += j.delta.text;
          onDelta(j.delta.text, text);
        }
      }
    }
    return { text, model };
  }

  async function callModelStreaming(messages, { signal, onDelta, provider, modelOverride }) {
    let model, routerCtx;
    const key = _getAnthropicKey();
    const useAnthropic = provider === "anthropic" && key;
    if (useAnthropic) {
      model = modelOverride || anthropicModel || "claude-sonnet-4-20250514";
      routerCtx = null;
    } else if (modelOverride) {
      model = modelOverride;
      routerCtx = null;
    } else if (modelRouter) {
      ({ model, ctx: routerCtx } = modelRouter.pick(messages));
    } else {
      model = heuristicModel(messages);
      routerCtx = null;
    }
    const startedAt = Date.now();
    const result = useAnthropic
      ? await callAnthropicStreaming(model, messages, { signal, onDelta })
      : await callOllamaStreaming(model, messages, { signal, onDelta });
    const elapsedMs = Date.now() - startedAt;
    if (routerCtx) {
      const outcome = elapsedMs > latencyBudgetMs ? "failure" : "success";
      try { await modelRouter.reveal(routerCtx, outcome); } catch { /* best-effort */ }
    }
    return result;
  }

  // Non-streaming model call, used only by the output-review correction pass.
  // Same provider routing as callModelStreaming; the correction is short
  // (num_predict 1500) and low-temperature.
  async function callModelNonStreaming(messages, { provider, modelOverride }) {
    const key = _getAnthropicKey();
    const useAnthropic = provider === "anthropic" && key;
    let model;
    if (useAnthropic) {
      model = modelOverride || anthropicModel || "claude-sonnet-4-20250514";
    } else if (modelOverride) {
      model = modelOverride;
    } else if (modelRouter) {
      ({ model } = modelRouter.pick(messages));
    } else {
      model = heuristicModel(messages);
    }
    if (useAnthropic) {
      const systemMessages = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
      const body = {
        model, max_tokens: 1500,
        messages: messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })),
      };
      if (systemMessages) body.system = systemMessages;
      const resp = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
      const j = await resp.json();
      return (j.content?.map((c) => c.text).join("") || "").trim();
    }
    const resp = await fetch(`${target}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, messages, stream: false,
        options: { temperature: 0.4, num_predict: 1500, num_ctx: numCtx },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    const j = await resp.json();
    return (j.message?.content || "").trim();
  }

  // Finalize the model's raw output AND review it against the instruction
  // folds that were in force (grounding). When the mechanical review flags the
  // answer, a bounded correction loop (≤2) re-asks the model to fix ONLY the
  // flagged violations, then re-reviews. The text that ships is the reviewed
  // one; the review itself is emitted as `review_report` and persisted.
  //
  // Order matters: citations/brackets/fidelity are resolved on the final text,
  // whether that text is the original or a correction.
  async function finalizeAndReview({ rawText, lastCitations, maxCitation, question, gate, groundText, sendEvent, turnId, answerId, provider, modelOverride }) {
    let text = rawText;
    let display = formatOutput(text);
    let brackets = resolveCitationBrackets(text, lastCitations).citations;
    let finalText = maxCitation > 0 ? validateCitations(display, maxCitation) : display;

    let corrected = false, iterations = 0;
    let review = null;
    if (gate) {
      review = reviewOutput({
        question, answer: finalText,
        gate: { activeIds: gate.activeIds, folds: instructionGate.folds, stats: gate.stats || {} },
        groundText,
      });
      while (review.verdict === "FLAGGED" && iterations < 2) {
        const correction = buildCorrectionSystemContent(review.flags, gate.activeIds);
        let next;
        try {
          next = await callModelNonStreaming([
            { role: "system", content: gate.systemMessage },
            { role: "system", content: correction },
            { role: "user", content: question },
          ], { provider, modelOverride });
        } catch {
          break; // keep the flagged text; the report will show correction was not achieved
        }
        if (!next) break;
        text = next;
        corrected = true;
        iterations++;
        display = formatOutput(text);
        brackets = resolveCitationBrackets(text, lastCitations).citations;
        finalText = maxCitation > 0 ? validateCitations(display, maxCitation) : display;
        review = reviewOutput({
          question, answer: finalText,
          gate: { activeIds: gate.activeIds, folds: instructionGate.folds, stats: gate.stats || {} },
          groundText,
        });
      }
    }

    const fidelity = verifyQuotedFidelity(finalText, lastCitations);
    const snippets = buildVerbatimSnippets(brackets, lastCitations);
    const reviewReport = gate
      ? { verdict: review.verdict, flags: review.flags, corrected, iterations }
      : null;
    if (reviewReport) {
      sendEvent("review_report", { turnId, answerId, ...reviewReport });
    }
    return { finalText, brackets, fidelity, snippets, review: reviewReport };
  }

  // ── Surf mode: wide retrieval with no model generation ──
  // Returns the evidence surf itself as the answer, formatted as a structured
  // report. No synthesis, no citations — just the raw passages the engine found.
  async function runSurfAnswer({ conv, turn, answerId, question, sourceScope, pool }, sendEvent) {
    const key = newAnswerEventKey(conv.id, turn.id);
    const controller = new AbortController();
    activeControllers.set(key, controller);

    try {
      sendEvent("retrieval_started", { turnId: turn.id, answerId, mode: "surf" });

      // Extra-wide retrieval — surf mode maximizes evidence surface area
      const groundResult = groundQuery(question, {
        budget: 6000, maxUnits: 20, limit: 50,
        source: sourceScope, pool: pool || "corpus",
      });

      const retrieved = groundResult.retrieved || [];
      const citations = groundResult.citations || [];

      sendEvent("witnesses_selected", {
        turnId: turn.id, answerId,
        mode: "surf",
        empty: !groundResult.context,
        sourceCount: groundResult.total || 0,
        foldedCount: groundResult.folded || 0,
        tokens: groundResult.tokens,
        budget: groundResult.budget,
        dropped: groundResult.dropped,
        retrievedCount: retrieved.length,
        citationCount: citations.length,
        priorWidening: groundResult.priorWidening || null,
      });

      // Format the surf as a structured evidence report
      const lines = [];
      lines.push(`◈ SURF MODE — ${question}`);
      lines.push(`   ${citations.length} passages across ${groundResult.total || 0} sources\n`);

      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        lines.push(`[${i + 1}] source: ${c.source_id}`);
        lines.push(`    span: ${c.span_id}  bytes ${c.byte_start}–${c.byte_end}  score: ${(c.score || 0).toFixed(2)}`);
        lines.push(`    ${(c.text || "").trim()}`);
        lines.push("");
      }

      if (citations.length === 0) {
        lines.push("(No matching passages found.)");
      }

      const surfText = lines.join("\n");

      await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
        text: surfText, model: null, status: "completed",
        mode: "surf", grounding: {
          sourceCount: groundResult.total || 0,
          foldedCount: groundResult.folded || 0,
          tokens: groundResult.tokens,
          budget: groundResult.budget,
          dropped: groundResult.dropped,
          empty: !groundResult.context,
        },
        completedAt: new Date().toISOString(),
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
        turnId: turn.id, answerId, status: "completed", text: surfText,
        mode: "surf", model: null,
        summary: `${citations.length} passages · ${new Set(citations.map((c) => c.source_id)).size} sources`,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        const partial = "(surf interrupted)";
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          text: partial, status: "interrupted", completedAt: new Date().toISOString(),
        }).catch(() => {});
        sendEvent("completed", { turnId: turn.id, answerId, status: "interrupted", text: partial });
      } else {
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          status: "failed", completedAt: new Date().toISOString(), error: err.message,
        }).catch(() => {});
        sendEvent("failed", { turnId: turn.id, answerId, message: err.message, stack: err.stack });
      }
    } finally {
      activeControllers.delete(key);
    }
  }

  // ── Think mode: holonic task decomposition ──
  // The question becomes the task for a full holonic decomposition pipeline:
  // plan → research → execute (with grounding correction loops) → cite → assemble.
  async function runThinkAnswer({ conv, turn, answerId, question, sourceScope, pool, provider, model: modelOverride }, sendEvent) {
    const key = newAnswerEventKey(conv.id, turn.id);
    const controller = new AbortController();
    activeControllers.set(key, controller);

    try {
      sendEvent("retrieval_started", { turnId: turn.id, answerId, mode: "think" });

      // Build an engine adapter so the holonic task can search the same corpus
      const engineAdapter = {
        search: (query, opts = {}) => {
          const result = groundQuery(query, {
            budget: opts.budget || 3000,
            maxUnits: opts.maxUnits || 5,
            limit: opts.limit || 16,
            source: sourceScope,
            pool: pool || "corpus",
          });
          return (result.citations || []).map((c) => ({
            text: c.text,
            source: c.source_id,
            score: c.score || 0,
            span_id: c.span_id,
            byte_start: c.byte_start,
            byte_end: c.byte_end,
          }));
        },
      };

      const task = new HolonicTask({
        task: question,
        model: modelOverride || "phi4-mini:latest",
        engine: engineAdapter,
        ollamaUrl: target,
      });

      // Pipe holonic progress events through to the SSE stream
      const result = await task.run({
        onProgress: (phase, msg, data = {}) => {
          sendEvent(`holonic_${phase}`, { turnId: turn.id, answerId, msg, ...data });
        },
      });

      const thinkText = result.output;

      await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
        text: thinkText, model: task.model, status: "completed",
        mode: "think",
        trace: result.results.map((r) => ({
          id: r.id, label: r.label,
          groundingScore: r.groundingScore,
          surplusScore: r.surplusScore,
          citations: r.citations,
          iterations: r.iterations,
        })),
        completedAt: new Date().toISOString(),
      });

      sendEvent("completed", {
        turnId: turn.id, answerId, status: "completed", text: thinkText,
        mode: "think", model: task.model,
        sections: result.results.length,
        mechanicalCitations: result.results.reduce((a, r) => a + r.citations.length, 0),
        gaps: result.gaps.length,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        const partial = "(think interrupted)";
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          text: partial, status: "interrupted", completedAt: new Date().toISOString(),
        }).catch(() => {});
        sendEvent("completed", { turnId: turn.id, answerId, status: "interrupted", text: partial });
      } else {
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          status: "failed", completedAt: new Date().toISOString(), error: err.message,
        }).catch(() => {});
        sendEvent("failed", { turnId: turn.id, answerId, message: err.message, stack: err.stack });
      }
    } finally {
      activeControllers.delete(key);
    }
  }

  // The core pipeline shared by a fresh turn and a regenerate — both already
  // have a turnId/answerId and a question by the time this runs.
  async function runAnswer({ conv, turn, answerId, question, sourceScope, pool, provider, model: modelOverride, mode, webSearch }, sendEvent) {
    // Dispatch to mode-specific handler
    if (mode === "surf") {
      return runSurfAnswer({ conv, turn, answerId, question, sourceScope, pool, provider, model: modelOverride }, sendEvent);
    }
    if (mode === "think") {
      return runThinkAnswer({ conv, turn, answerId, question, sourceScope, pool, provider, model: modelOverride }, sendEvent);
    }

    const key = newAnswerEventKey(conv.id, turn.id);
    const controller = new AbortController();
    activeControllers.set(key, controller);

    try {
      sendEvent("retrieval_started", { turnId: turn.id, answerId, webSearch: !!webSearch });

      if (webSearch && webSearchFn) {
        // ── Web search path: retrieved carries web results, no engine grounding ──
        const webResults = await webSearchFn(question, { numResults: 5, maxFetchChars: 5000 });
        const { message: systemMsg, maxCitation } = buildWebSystemMessage(webResults);

        const retrieved = webResults.map((r) => ({
          rank: r.rank,
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          text: r.text,
          source: "web",
        }));

        sendEvent("witnesses_selected", {
          turnId: turn.id, answerId,
          empty: webResults.length === 0,
          warming: false,
          sourceCount: webResults.length,
          foldedCount: webResults.length,
          retrieved,
          citations: [],
          gaps: [],
          priorWidening: null,
        });

        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          grounding: {
            sourceCount: webResults.length,
            foldedCount: webResults.length,
            tokens: 0, budget: 0, dropped: 0,
            empty: webResults.length === 0,
            warming: false,
          },
        });

        const lastCitations = [];
        const history = buildHistoryMessages(conv, turn.id);
        const messages = [systemMsg, ...history, { role: "user", content: question }];

        const gateInfo = gateInstructionBlock({ question, conv, turnId: turn.id });
        emitGateReport(sendEvent, turn.id, answerId, gateInfo);
        if (gateInfo) messages.unshift({ role: "system", content: gateInfo.systemMessage });

        let sawStart = false;
        const { text: rawText, model } = await callModelStreaming(messages, {
          signal: controller.signal, provider, modelOverride,
          onDelta: (delta, text) => {
            if (!sawStart) { sawStart = true; sendEvent("writing_started", { turnId: turn.id, answerId, passageCount: webResults.length }); }
            controller._partialText = formatOutput(text);
            sendEvent("answer_delta", { turnId: turn.id, answerId, delta, text: controller._partialText });
          },
        });

        const groundText = webResults.map((r) => `${r.title}\n${r.text || r.snippet || ""}`).join("\n\n");
        const { finalText, brackets, fidelity, snippets, review } = await finalizeAndReview({
          rawText, lastCitations, maxCitation, question,
          gate: gateInfo, groundText, sendEvent, turnId: turn.id, answerId, provider, modelOverride,
        });

        for (const c of brackets) {
          sendEvent("citation_verified", { turnId: turn.id, answerId, ...c });
        }

        for (const s of snippets) {
          sendEvent("verbatim_snippet", { turnId: turn.id, answerId, ...s });
        }

        const gaps = [];
        if (brackets.some((b) => !b.resolved)) {
          const unresolvedNums = brackets.filter((b) => !b.resolved).map((b) => b.num);
          gaps.push({ type: "unresolved_citation", nums: unresolvedNums, reason: `[${unresolvedNums.join("], [")}] — no web source matches this bracket.` });
        }
        for (const u of fidelity.unverified) {
          gaps.push({ type: "unverified_quote", quote: u.quote, reason: "This quoted text does not appear verbatim in any cited source." });
        }
        if (webResults.length === 0) {
          gaps.push({ type: "no_web_results", reason: "No web search results matched this question — answered from general knowledge, uncited." });
        }
        for (const g of gaps) sendEvent("gap", { turnId: turn.id, answerId, ...g });

        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          text: finalText, model, citations: brackets, gaps, snippets,
          fidelity, webSearch: true, status: "completed", completedAt: new Date().toISOString(),
          review,
          instructionGate: gateInfo ? {
            activeIds: gateInfo.activeIds, foldedIds: gateInfo.foldedIds,
            blockTokens: gateInfo.blockTokens, budget: gateInfo.budget, overflow: gateInfo.overflow,
            gap: gateInfo.stats?.gap, rejectedByBudget: gateInfo.stats?.rejectedByBudget,
          } : null,
        });
        sendEvent("completed", {
          turnId: turn.id, answerId, status: "completed", text: finalText,
          citations: brackets, gaps, snippets, model, webSearch: true,
          summary: `${webResults.length} web sources`,
        });
      } else {
        // ── Engine grounding path: retrieved is empty (reserved for web results) ──
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
          retrieved: [],
          citations: (groundResult.citations || []).map((c, i) => ({
            index: i + 1, span_id: c.span_id, source_id: c.source_id,
            byte_start: c.byte_start, byte_end: c.byte_end,
            score: Math.round((c.score || 0) * 100) / 100, text: c.text,
          })),
          gaps: groundResult.gaps || [],
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

        const lastCitations = (groundResult.citations || []).map((c, i) => ({
          index: i + 1, source_id: c.source_id, span_id: c.span_id,
          byte_start: c.byte_start, byte_end: c.byte_end, score: c.score, text: c.text,
        }));

        const history = buildHistoryMessages(conv, turn.id);
        const messages = [systemMsg, ...history, { role: "user", content: question }];

        const gateInfo = gateInstructionBlock({ question, conv, turnId: turn.id });
        emitGateReport(sendEvent, turn.id, answerId, gateInfo);
        if (gateInfo) messages.unshift({ role: "system", content: gateInfo.systemMessage });

        let sawStart = false;
        const { text: rawText, model } = await callModelStreaming(messages, {
          signal: controller.signal, provider, modelOverride,
          onDelta: (delta, text) => {
            if (!sawStart) { sawStart = true; sendEvent("writing_started", { turnId: turn.id, answerId, passageCount: groundResult.folded || 0 }); }
            controller._partialText = formatOutput(text);
            sendEvent("answer_delta", { turnId: turn.id, answerId, delta, text: controller._partialText });
          },
        });

        const groundText = (groundResult.citations || []).map((c) => c.text).join("\n\n");
        const { finalText, brackets, fidelity, snippets, review } = await finalizeAndReview({
          rawText, lastCitations, maxCitation, question,
          gate: gateInfo, groundText, sendEvent, turnId: turn.id, answerId, provider, modelOverride,
        });

        for (const c of brackets) {
          sendEvent("citation_verified", { turnId: turn.id, answerId, ...c });
        }

        for (const s of snippets) {
          sendEvent("verbatim_snippet", { turnId: turn.id, answerId, ...s });
        }

        const gaps = [];
        if (brackets.some((b) => !b.resolved)) {
          const unresolvedNums = brackets.filter((b) => !b.resolved).map((b) => b.num);
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
          text: finalText, model, citations: brackets, gaps, snippets,
          fidelity, review, status: "completed", completedAt: new Date().toISOString(),
          instructionGate: gateInfo ? {
            activeIds: gateInfo.activeIds, foldedIds: gateInfo.foldedIds,
            blockTokens: gateInfo.blockTokens, budget: gateInfo.budget, overflow: gateInfo.overflow,
            gap: gateInfo.stats?.gap, rejectedByBudget: gateInfo.stats?.rejectedByBudget,
          } : null,
        });
        sendEvent("completed", {
          turnId: turn.id, answerId, status: "completed", text: finalText,
          citations: brackets, gaps, snippets, model, review,
          summary: `${groundResult.folded || 0} passages · ${new Set((groundResult.citations || []).map((c) => c.source_id)).size} sources`,
        });
      }
    } catch (err) {
      if (err.name === "AbortError") {
        const partial = controller._partialText || "";
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          text: partial, status: "interrupted", completedAt: new Date().toISOString(),
        }).catch(() => {});
        sendEvent("completed", { turnId: turn.id, answerId, status: "interrupted", text: partial });
      } else {
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          status: "failed", completedAt: new Date().toISOString(), error: err.message,
        }).catch(() => {});
        sendEvent("failed", { turnId: turn.id, answerId, message: err.message, stack: err.stack });
      }
    } finally {
      activeControllers.delete(key);
    }
  }

  async function startTurn({ conversationId, question, sourceScope, pool, attachments, provider, model, mode, webSearch }, sendEvent) {
    const conv = await conversationStore.require(conversationId);
    const effectiveScope = sourceScope !== undefined ? sourceScope : conv.sourceScope;
    const effectiveMode = mode || conv.mode || "chat";
    const effectiveWebSearch = webSearch !== undefined ? webSearch : (conv.webSearch || false);
    const { turn } = await conversationStore.appendTurn(conversationId, {
      question, sourceScope: effectiveScope, attachments,
    });
    const answer = await conversationStore.addAnswer(conversationId, turn.id, {});
    sendEvent("accepted", {
      turnId: turn.id, answerId: answer.id, question,
      sourceScope: effectiveScope, pool: pool || conv.pool || "corpus",
      mode: effectiveMode, webSearch: effectiveWebSearch,
    });

    const run = runAnswer({
      conv, turn, answerId: answer.id,
      question, sourceScope: effectiveScope, pool: pool || conv.pool,
      provider, model, mode: effectiveMode, webSearch: effectiveWebSearch,
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
      mode: conv.mode || "chat", webSearch: conv.webSearch || false,
      regenerate: true,
    });
    const run = runAnswer({
      conv: { ...conv, id: conversationId }, turn, answerId: answer.id,
      question: turn.question, sourceScope: turn.sourceScope, pool: conv.pool,
      mode: conv.mode || "chat", webSearch: conv.webSearch || false,
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
