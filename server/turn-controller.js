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
import { describeStopReason, streamAnthropicChat, describeApiError } from "./anthropic-provider.js";
import { normalizeOllamaUsage, summarizeUsage } from "./token-tally.js";
import { createInstructionGate } from "./instruction-gate.js";
import { customInstructionStore } from "./custom-instruction-store.js";
import { workspaceMemory } from "./workspace-memory.js";
import { checkCompliance } from "./instruction-compliance.js";
import { HolonicTask } from "./holonic-task.js";

const HISTORY_TURNS = 6;

function detectMultiSectionNeed(question) {
  const q = question.toLowerCase();
  const multiKeywords = [
    'write', 'essay', 'report', 'analysis', 'explain', 'describe',
    'compare', 'contrast', 'discuss', 'outline', 'summarize',
    'what are the', 'list the', 'steps to', 'how to',
  ];
  const multiIndicators = [
    'multiple', 'several', 'various', 'different',
    'first', 'second', 'third',
    'and', 'or', 'as well as',
  ];
  const hasMultiKeyword = multiKeywords.some(kw => q.includes(kw));
  const hasMultiIndicator = multiIndicators.some(ind => q.includes(ind));
  const isLongQuestion = question.length > 100;
  const asksForStructure = /(\d+\.|\bbullet|\bstep|\bpart|\bsection|\bchapter)/i.test(q);
  return (hasMultiKeyword && hasMultiIndicator) || isLongQuestion || asksForStructure;
}

function newAnswerEventKey(conversationId, turnId) {
  return `${conversationId}:${turnId}`;
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
 * @param {import('./settings-store.js').SettingsStore} [deps.settings] - which model answers, and the key for it. Omitted ⇒ local only.
 * @param {typeof streamAnthropicChat} [deps.anthropicStream] - injected in tests
 */
export function createTurnController(deps) {
  const {
    conversationStore, groundQuery, target, numCtx,
    modelRouter, heuristicModel, latencyBudgetMs, isWarming,
    settings = null, anthropicStream = streamAnthropicChat,
  } = deps;

  // The instruction gate: loads custom folds per project, scores them against
  // the turn's cue, and surfaces the relevant ones. Memory adjustments from
  // workspace feedback influence the scoring.
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

  // Recent completed turns from THIS conversation, as real message history —
  // not reconstructed from a keyword memory search. Bounded so a long-running
  // conversation doesn't grow the prompt without limit.
  function buildHistoryMessages(conv, beforeTurnId) {
    const turns = (conv.turns || []).filter((t) => t.id !== beforeTurnId);
    const recent = turns.slice(-HISTORY_TURNS);
    const out = [];
    for (const t of recent) {
      out.push({ role: "user", content: t.question });
      const active = (t.answers || []).find((a) => a.id === t.activeAnswerId);
      if (active && active.status === "completed" && active.text) {
        out.push({ role: "assistant", content: active.text });
      }
    }
    return out;
  }

  // ── The talker, one call, either provider ────────────────────────────────
  //
  // Both branches return the same shape — { text, model, usage, provider,
  // stopReason, stopDetails } — so everything downstream (citation checking,
  // fidelity, persistence, events) is provider-blind, exactly as it was when
  // there was only one provider. The differences that DO matter to the reader
  // (which model answered, what it cost, whether the answer was cut short)
  // travel as data rather than as branches in the pipeline.

  /** The local Ollama path — unchanged, except that it now keeps the counts. */
  async function callOllamaStreaming(messages, { signal, onDelta, onUsage, forceModel = null }) {
    let model, routerCtx;
    if (forceModel) {
      model = forceModel;
      routerCtx = null;
    } else if (modelRouter) {
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
    let buf = "", text = "", usage = null;
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
        // Ollama reports its counts once, on the final chunk. A stream cut
        // short by a stop therefore has none — which is why this is null
        // rather than zero on that path: nothing was measured, and saying
        // "0 tokens" would be a measurement.
        const chunkUsage = normalizeOllamaUsage(j);
        if (chunkUsage) { usage = chunkUsage; if (onUsage) onUsage(usage, model); }
        const delta = j.message?.content || "";
        if (delta) { text += delta; onDelta(delta, text); }
      }
    }
    const elapsedMs = Date.now() - startedAt;
    if (routerCtx) {
      const outcome = elapsedMs > latencyBudgetMs ? "failure" : "success";
      try { await modelRouter.reveal(routerCtx, outcome); } catch { /* best-effort */ }
    }
    return { text, model, usage, provider: "local", stopReason: null, stopDetails: null };
  }

  /**
   * Route the turn to whichever provider the reader has configured.
   *
   * A configured-but-unusable provider (Anthropic selected, key removed) does
   * not fail the turn: it answers locally and returns the reason, which the
   * caller reports as a gap. Refusing to answer would be worse than answering
   * with the other model — but answering with the other model SILENTLY would
   * be worse than both.
   */
  async function callModelStreaming(messages, { signal, onDelta, onThinking, onUsage, forceModel = null }) {
    const { provider, fallbackReason } = settings
      ? settings.effectiveProvider()
      : { provider: "local", fallbackReason: null };

    if (provider !== "anthropic") {
      const result = await callOllamaStreaming(messages, { signal, onDelta, onUsage, forceModel });
      return { ...result, fallbackReason };
    }

    const model = settings.anthropicModel();
    try {
      const result = await anthropicStream({
        apiKey: settings.anthropicKey(),
        model,
        messages,
        signal,
        onDelta,
        onThinking,
        onUsage: (usage) => { if (onUsage) onUsage(usage, model); },
      });
      return { ...result, provider: "anthropic", fallbackReason: null };
    } catch (err) {
      if (err?.name === "AbortError" || err?.name === "APIUserAbortError") throw err;
      // An API error is this host's failure to reach the model the reader
      // chose, not a fact about their sources — say which, in the message the
      // failure surfaces with, rather than letting a raw SDK error through.
      throw new Error(describeApiError(err));
    }
  }

  /**
   * Write this call's token tally to the record and tell the client.
   *
   * Called on every exit from a turn — completed, stopped, failed — because
   * all three can have spent tokens, and a tally that only counted clean
   * completions would be a tally of the good days. Never throws: a bookkeeping
   * failure must not turn a delivered answer into an error.
   */
  async function persistUsage({ conv, turn, answerId, controller, model, sendEvent }) {
    const usage = controller._usage;
    if (!usage) return null;
    const usageModel = controller._usageModel || model || null;
    try {
      const conversationUsage = await conversationStore.recordUsage(
        conv.id, turn.id, answerId, usage, usageModel,
      );
      sendEvent("usage", {
        turnId: turn.id, answerId,
        answer: summarizeUsage(usage, usageModel),
        conversation: conversationUsage,
      });
      return conversationUsage;
    } catch (err) {
      console.error(`[turn-controller] could not record usage for ${conv.id}/${answerId}: ${err.message}`);
      return null;
    }
  }

  // The core pipeline shared by a fresh turn and a regenerate — both already
  // have a turnId/answerId and a question by the time this runs.
  async function runAnswer({ conv, turn, answerId, question, sourceScope, pool, forceModel = null }, sendEvent) {
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

      // Build history from conversation turns
      const history = buildHistoryMessages(conv, turn.id);

      // The one citation table this whole answer is checked against — index,
      // byte range, and verbatim text together, so bracket resolution and
      // quote-fidelity checking can never drift apart into two different ideas
      // of what citation [n] is.
      const lastCitations = (groundResult.citations || []).map((c, i) => ({
        index: i + 1, source_id: c.source_id, span_id: c.span_id,
        byte_start: c.byte_start, byte_end: c.byte_end, score: c.score, text: c.text,
      }));

      // Load custom instruction folds for this project and gate them.
      const projectId = conv.pool || conv.id;
      const customFolds = await customInstructionStore.loadFolds(projectId);
      instructionGate.setFolds(customFolds);
      const memoryAdjustments = await workspaceMemory.allAdjustments(projectId);
      const gateResult = instructionGate.gate({
        question,
        history: history.map(h => h.content).filter(Boolean),
        memoryAdjustments,
        debug: true,
      });

      // Build messages array, inserting instruction gate system message if present.
      const messages = [systemMsg, ...history, { role: "user", content: question }];
      if (gateResult.systemMessage) {
        messages.splice(1, 0, { role: "system", content: gateResult.systemMessage });
      }

      sendEvent("instruction_gate", {
        turnId: turn.id, answerId,
        activeIds: gateResult.activeIds,
        foldedIds: gateResult.foldedIds,
        stats: gateResult.stats,
        scores: gateResult.scores,
      });

      let sawStart = false;
      // Held on the controller so the stop path can persist the tokens the
      // reader actually spent before they pressed stop — a stopped turn is
      // still a billed turn, and a tally that quietly forgot it would drift
      // below the real bill exactly when someone is watching the number.
      controller._usage = null;
      controller._usageModel = null;
      let thinkingBuf = "";
      const flushThinking = () => {
        if (!thinkingBuf.trim()) { thinkingBuf = ""; return; }
        sendEvent("thinking_delta", { turnId: turn.id, answerId, text: thinkingBuf.trim() });
        thinkingBuf = "";
      };

      const { text: rawText, model, stopReason, stopDetails, provider, fallbackReason } = await callModelStreaming(messages, {
        signal: controller.signal,
        forceModel,
        onUsage: (usage, usageModel) => {
          controller._usage = usage;
          controller._usageModel = usageModel || controller._usageModel;
        },
        // Summarized reasoning, batched into readable fragments rather than
        // per-token: this feeds an activity log, not a transcript, and one
        // SSE frame per token would cost more than the signal is worth.
        onThinking: (delta) => {
          thinkingBuf += delta;
          if (thinkingBuf.length > 160 || /[.!?]\s$|\n/.test(thinkingBuf)) flushThinking();
        },
        onDelta: (delta, text) => {
          flushThinking();
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
      // An answer cut off at the output ceiling, or declined outright, is a
      // fact about the answer the reader must be told (LAWS.md L3) — not
      // something to leave looking like a complete reply that happens to end
      // abruptly.
      const stopGap = describeStopReason(stopReason, stopDetails);
      if (stopGap) gaps.push(stopGap);
      // Likewise a provider downgrade: answered locally when a hosted model
      // was selected is a different answer than the one that was asked for.
      if (fallbackReason) gaps.push({ type: "provider_fallback", reason: fallbackReason });
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

      // DEF·EVA·REC compliance check: did the response follow the surfaced instructions?
      let complianceResult = null;
      if (gateResult.surfaced.length > 0) {
        try {
          complianceResult = await checkCompliance({
            response: finalText,
            activeFolds: gateResult.surfaced,
            question,
            model: null, // mechanical check only; model-based REC requires a speak function
            speak: null,
          });
          sendEvent("compliance_checked", {
            turnId: turn.id, answerId,
            verdict: complianceResult.verdict,
            method: complianceResult.method,
            violations: complianceResult.violations || [],
          });
        } catch (err) {
          // Compliance check failure should not break the turn
          complianceResult = { verdict: "unknown", method: "error", error: err.message };
        }
      }

      // Record the turn to workspace memory for future surf scoring.
      await workspaceMemory.recordTurn(projectId, {
        turnId: turn.id,
        question,
        activeFoldIds: gateResult.activeIds,
        verdict: complianceResult?.verdict || "unknown",
        compliance: complianceResult,
      });

      await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
        text: finalText, model, provider, citations: brackets, gaps,
        fidelity, status: "completed", completedAt: new Date().toISOString(),
      });
      await persistUsage({ conv, turn, answerId, controller, model, sendEvent });
      sendEvent("completed", {
        turnId: turn.id, answerId, status: "completed", text: finalText,
        citations: brackets, gaps, model, provider,
        summary: `${groundResult.folded || 0} passages · ${new Set((groundResult.citations || []).map((c) => c.source_id)).size} sources`,
      });
    } catch (err) {
      if (err.name === "AbortError" || err.name === "APIUserAbortError") {
        // Whatever streamed before the stop is a valid, honest partial turn —
        // not an error. Persist and report it as interrupted, not failed.
        const partial = controller._partialText || "";
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          text: partial, status: "interrupted", completedAt: new Date().toISOString(),
        }).catch(() => {});
        // Tokens spent before the stop were still spent.
        await persistUsage({ conv, turn, answerId, controller, model: controller._usageModel, sendEvent });
        sendEvent("completed", { turnId: turn.id, answerId, status: "interrupted", text: partial });
      } else {
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          status: "failed", completedAt: new Date().toISOString(), error: err.message,
        }).catch(() => {});
        // A call that died mid-stream may already have been billed for what
        // it produced; tally it before reporting the failure.
        await persistUsage({ conv, turn, answerId, controller, model: controller._usageModel, sendEvent });
        sendEvent("failed", { turnId: turn.id, answerId, message: err.message });
      }
    } finally {
      activeControllers.delete(key);
    }
  }

  async function runMultiSectionAnswer({ conv, turn, answerId, question, sourceScope, pool }, sendEvent) {
    const key = newAnswerEventKey(conv.id, turn.id);
    const controller = new AbortController();
    activeControllers.set(key, controller);

    try {
      sendEvent("multi_section_started", { turnId: turn.id, answerId, question });

      const task = new HolonicTask({
        task: question,
        model: heuristicModel([{ role: "user", content: question }]),
        engine: {
          search: (query, opts) => {
            const groundResult = groundQuery(query, {
              budget: 2000, maxUnits: 5, limit: 10,
              source: sourceScope, pool: pool || "corpus",
            });
            return (groundResult.citations || []).map((c, i) => ({
              text: c.text,
              source: c.source_id,
              score: c.score,
              span_id: c.span_id,
              byte_start: c.byte_start,
              byte_end: c.byte_end,
            }));
          },
          getPriors: null,
        },
      });

      const sections = [];
      let totalChars = 0;

      const result = await task.run({
        onProgress: (phase, msg, data) => {
          sendEvent("multi_section_progress", {
            turnId: turn.id, answerId,
            phase, msg, ...data,
          });
        },
      });

      for (const sectionResult of result.results) {
        const section = {
          id: sectionResult.id,
          label: sectionResult.label,
          content: sectionResult.content,
          citations: sectionResult.citations.map(c => {
            const surf = sectionResult.surf[c.surfIndex];
            return {
              jaccard: c.evidence.jaccard,
              source: surf ? surf.source : null,
              quote: surf ? surf.text.slice(0, 200) : null,
            };
          }),
        };
        sections.push(section);
        totalChars += section.content.length;

        sendEvent("multi_section_completed", {
          turnId: turn.id, answerId,
          section,
          sectionIndex: sections.length - 1,
          totalSections: result.results.length,
        });
      }

      await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
        text: result.output,
        sections,
        status: "completed",
        completedAt: new Date().toISOString(),
        multiSection: true,
      });

      sendEvent("completed", {
        turnId: turn.id, answerId,
        status: "completed",
        text: result.output,
        sections,
        multiSection: true,
        summary: `${sections.length} sections · ${totalChars} chars`,
      });
    } catch (err) {
      if (err.name === "AbortError" || err.name === "APIUserAbortError") {
        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          status: "interrupted", completedAt: new Date().toISOString(),
        }).catch(() => {});
        sendEvent("completed", { turnId: turn.id, answerId, status: "interrupted", text: "" });
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

  async function startTurn({ conversationId, question, sourceScope, pool, attachments, forceModel = null }, sendEvent) {
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

    const useMultiSection = detectMultiSectionNeed(question);
    
    let run;
    if (useMultiSection) {
      run = runMultiSectionAnswer({
        conv, turn, answerId: answer.id,
        question, sourceScope: effectiveScope, pool: pool || conv.pool,
      }, sendEvent);
    } else {
      run = runAnswer({
        conv, turn, answerId: answer.id,
        question, sourceScope: effectiveScope, pool: pool || conv.pool,
        forceModel,
      }, sendEvent);
    }

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
