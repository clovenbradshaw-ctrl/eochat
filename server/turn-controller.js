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

import {
  validateCitations, verifyQuotedFidelity, parseCitationRefs,
  checkGrounding, groundingGaps, annotateVoids, autoAttachCitations,
} from "./citation-check.js";
import { buildVerbatimSnippets } from "./verbatim-snippets.js";
import { HolonicTask } from "./holonic-task.js";
import { createInstructionGate, countTokens as gateCountTokens } from "./instruction-gate.js";
import { needsProsify, buildProsifyMessages, applyProsifyResult } from "./prosify-cue.js";
import { reviewOutput, buildCorrectionSystemContent } from "./output-review.js";
import {
  applyTurn, buildMemoryMessage, checkRecallDenial, emptyMemory,
  isAcknowledgment,
} from "./conversation-memory.js";
import {
  buildCabinetBlock, emptyCabinet, mergeDeskFacts, markAccessed, retrieveCabinet,
} from "./project-memory.js";
import { createConversationHolon, recordTurn } from "./conversation-holon.js";
import { generateAnswer } from "./turn-generation.js";

// Every blink can be longform — these are ceilings, not targets; the model
// still decides when to stop. DEFAULT is generous headroom for the common
// case where a turn's evidence doesn't structurally split into more than one
// earned section (turn-generation.js's outline collapses to one call, same
// as before that module existed).
const DEFAULT_MAX_TOKENS = 8192;
// The output-review correction pass only fixes flagged violations in an
// already-generated answer — it does not need longform headroom.
const CORRECTION_MAX_TOKENS = 1500;
// How many earned sections a turn's outline is allowed to grow to.
// LONGFORM is the ceiling a turn earns once conversation-holon.js discovers
// (never declares) that it depends on a prior turn's evidence — see
// recordTurn in conversation-holon.js. Either way this bounds how far an
// outline CAN split, never how far it must.
const DEFAULT_MAX_SECTIONS = 4;
const LONGFORM_MAX_SECTIONS = 8;

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

const HISTORY_TURNS = 6;

function newAnswerEventKey(conversationId, turnId) {
  return `${conversationId}:${turnId}`;
}

// Every [n] the answer actually cites, matched against the engine's real
// citation table. A bracket with no matching entry is a gap, never a guess.
// Uses the shared bracket parser rather than a local /\[(\d+)\]/ so a
// "[1,2]" or "[2-4]" resolves to the passages it names instead of vanishing
// from the citation panel entirely.
function resolveCitationBrackets(text, citations) {
  const table = new Map((citations || []).map((c) => [String(c.index), c]));
  const seen = new Set();
  const resolved = [];
  const unresolvedNums = [];
  for (const ref of parseCitationRefs(text)) {
    for (const n of ref.nums) {
      const num = String(n);
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
 * @param {string} [deps.prosifyModel] - Ollama model id used to rewrite a terse follow-up
 *   ("read it again") into a self-contained retrieval/gate cue (prosify-cue.js). Omitted or
 *   falsy disables the rewrite entirely — the raw question is used everywhere, unchanged,
 *   which is the same behavior as before this dependency existed.
 * @param {number} [deps.prosifyTimeoutMs] - abort budget for the rewrite call (default 4000)
 * @param {object|null} deps.cabinetStore - project file-cabinet store (has .get(pool) and .set(pool, cabinet)); null disables cabinet memory
 */
// The grounding instruction the talker actually receives.
//
// Module-level and exported rather than closed over the controller so a test
// harness can drive the REAL prompt. A harness that reimplements the prompt
// measures its own copy: the thing under test — how a weak model behaves when
// told which numbers exist — is exactly the thing a copy stops testing the
// moment the two drift.
export function buildGroundedSystemMessage(groundResult, warming = false) {
  if (!groundResult.context) {
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

// The web-search counterpart of buildGroundedSystemMessage — same shape
// (a system message plus the highest citation number in force), but built
// from live web results instead of engine passages. Module-level for the
// same reason: a caller with no tool loop of its own (the browser-local
// WebLLM path, via /api/web-ground) needs the exact same instruction
// wording the server's own tool-calling talker gets, not a reimplementation
// that can drift from it.
export function buildWebSystemMessage(webResults) {
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
    `Before asserting a fact, look for confirmation the way a careful person would: does more than one ` +
    `source here agree? If a claim rests on a single source, or the sources conflict, say so instead of ` +
    `stating it as settled — name the disagreement or the thinness rather than picking one source silently. ` +
    `A claim two or more independent sources agree on can be stated with more confidence than one only a ` +
    `single source makes.\n\n` +
    `--- Web Search Results (${webResults.length} sources) ---\n\n` +
    parts.join("\n\n");
  return { message: { role: "system", content }, maxCitation: webResults.length, warming: false };
}

export function createTurnController(deps) {
  const {
    conversationStore, groundQuery, target, anthropicKey, anthropicModel,
    numCtx,
    modelRouter, heuristicModel, latencyBudgetMs, isWarming, webSearchFn,
    cabinetStore, prosifyModel, prosifyTimeoutMs,
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

  // The user turns this gate should judge relevance against — the same bounded
  // history the model sees, user messages only.
  function recentUserQuestions(conv, beforeTurnId) {
    return (conv.turns || []).filter((t) => t.id !== beforeTurnId).slice(-HISTORY_TURNS).map((t) => t.question);
  }

  // The desk (conversation-memory.js) and the cabinet (project-memory.js),
  // resolved together for one turn. The desk is always injected, from the
  // conversation record's own persisted state; the cabinet is cued by the
  // question and only its matching memos are injected. Returns the blocks to
  // place in the model context AND the raw state the turn's own memory update
  // will advance from.
  async function loadDiscourseBlocks({ question, conv, pool }) {
    const state = conv.memory && (conv.memory.hot?.length || conv.memory.facts?.length)
      ? conv.memory
      : emptyMemory();
    const memoryMsg = buildMemoryMessage(state);

    const poolId = pool || conv.pool;
    let cabinet = null;
    let retrieval = null;
    let cabinetBlock = null;
    if (cabinetStore && poolId && poolId !== "corpus") {
      cabinet = await cabinetStore.get(poolId);
      retrieval = cabinet ? retrieveCabinet(cabinet, { question }) : null;
      cabinetBlock = retrieval?.memos.length ? buildCabinetBlock(retrieval.memos) : null;
    }

    return { state, memoryMsg, cabinet, retrieval, cabinetBlock };
  }

  // Advance the desk by this turn and persist it, then fold any newly confirmed
  // facts into the project cabinet (and mark the memos that were actually
  // injected this turn as accessed — being reached for IS use). Emits the
  // discourse_report the UI and the audit trail both read. No-op-safe: a
  // conversation with no pool and no cabinet still persists its desk.
  async function persistTurnMemory({ conv, turn, question, answerText, denial, discourse, answerId, sendEvent }) {
    const turnNumber = (conv.turns || []).length;
    const confirmed = isAcknowledgment(answerText);
    const next = applyTurn(discourse.state, turnNumber, {
      userText: question,
      assistantText: answerText,
      confirmed,
    });

    await conversationStore.setMemory(conv.id, next);

    const poolId = conv.pool;
    if (cabinetStore && poolId && poolId !== "corpus") {
      const merged = mergeDeskFacts(discourse.cabinet || emptyCabinet(), {
        facts: next.facts,
        conversationId: conv.id,
        turn: turnNumber,
      });
      const accessed = discourse.retrieval?.memos.length
        ? markAccessed(merged, discourse.retrieval.memos.map((m) => m.id))
        : merged;
      await cabinetStore.set(poolId, accessed);
    }

    const nextMsg = buildMemoryMessage(next);
    sendEvent("discourse_report", {
      turnId: turn.id, answerId,
      facts: next.facts.length,
      acknowledged: confirmed,
      denial: denial ? { verdict: denial.verdict, flags: denial.flags } : null,
      deskTokens: gateCountTokens(nextMsg || ""),
    });
    return next;
  }

  const DEFAULT_PROSIFY_TIMEOUT_MS = 4000;

  // Rewrite a terse follow-up into a self-contained cue, using ONLY this
  // conversation's own recorded state (the desk's hot terms/facts and recent
  // raw history) — never the model's general knowledge. The raw `question`
  // is what the model is told the reader said and what the desk extracts
  // facts from (both unchanged by this); `cue` is used ONLY to decide what
  // gets retrieved and which instruction folds surface. See prosify-cue.js.
  //
  // Disabled by default (no deps.prosifyModel): returns the raw question
  // unchanged, at zero cost, so a deployment that never configures this
  // dependency behaves exactly as it did before it existed.
  async function prosifyCue({ question, history, hot, facts }) {
    if (!prosifyModel || !needsProsify(question)) {
      return {
        cue: question, raw: question, changed: false,
        reason: prosifyModel ? "self-contained" : "disabled",
      };
    }
    try {
      const messages = buildProsifyMessages({ question, history, hot, facts });
      const resp = await fetch(`${target}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: prosifyModel, messages, stream: false,
          options: { temperature: 0.2, num_predict: 128 },
        }),
        signal: AbortSignal.timeout(prosifyTimeoutMs || DEFAULT_PROSIFY_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
      const data = await resp.json();
      return applyProsifyResult({ question, modelText: data.message?.content });
    } catch (err) {
      // A failed or slow rewrite degrades to the raw question — the same
      // behavior as a self-contained message, not a broken turn.
      return { cue: question, raw: question, changed: false, reason: "error", error: err.message };
    }
  }

  // Gate one turn's instruction context. Returns null when there is no corpus
  // (an empty gate is a no-op, never a crash), otherwise the report for SSE +
  // persistence plus the system message to prepend to the model call.
  //
  // Two corpora can be in force at once: the app's own instruction set, and —
  // when the conversation lives in a project — that project's instructions,
  // written by the reader and of any length. Both go through the SAME gate
  // (R3: one scoreFold, one budget discipline, one folded index), just with
  // different fold sets and their own budgets, so a long project manual cannot
  // crowd out the app's identity and citation rules or vice versa. Each keeps
  // its own block so the model can tell whose rule it is reading.
  function gateInstructionBlock({ question, conv, turnId, evidence }) {
    const history = recentUserQuestions(conv, turnId);
    const blocks = [];
    const reports = [];

    const inForce = [];

    if (instructionGate.folds.length) {
      const r = instructionGate.gate({ question, history, evidence });
      blocks.push(r.systemMessage);
      reports.push({ corpus: "app", ...summarizeGate(r) });
      inForce.push(...instructionGate.folds);
    }

    const project = deps.projectInstructionFolds ? deps.projectInstructionFolds(conv) : null;
    if (project?.folds?.length) {
      const projectGate = createInstructionGate({
        folds: project.folds,
        budgetTokens: project.budgetTokens,
        label: "PROJECT INSTRUCTION GATE",
      });
      const r = projectGate.gate({ question, history, evidence });
      blocks.push(r.systemMessage);
      reports.push({ corpus: "project", ...summarizeGate(r) });
      inForce.push(...project.folds);
    }

    if (!blocks.length) return null;
    const systemMessage = blocks.join("\n\n");
    const merged = reports.reduce((acc, r) => ({
      activeIds: acc.activeIds.concat(r.activeIds),
      foldedIds: acc.foldedIds.concat(r.foldedIds),
      overflow: acc.overflow + r.overflow,
    }), { activeIds: [], foldedIds: [], overflow: 0 });

    return {
      activeIds: merged.activeIds,
      foldedIds: merged.foldedIds,
      // Every fold that could have been in force this turn, both corpora. R9's
      // output review checks the answer against the rules that governed it, so
      // it has to see the project's rules too — reviewing a project answer
      // against only the app's manual would pass a reply that breaks the very
      // instruction the reader wrote.
      folds: inForce,
      blockTokens: gateCountTokens(systemMessage),
      budget: reports.reduce((n, r) => n + r.budget, 0),
      overflow: merged.overflow,
      // Per-corpus detail, so a reader auditing why a rule did or did not
      // apply can see which manual it came from rather than one flat list.
      corpora: reports,
      stats: {
        gap: reports.every((r) => r.gap),
        rejectedByBudget: reports.reduce((n, r) => n + r.rejectedByBudget, 0),
      },
      systemMessage,
    };
  }

  function summarizeGate(r) {
    return {
      activeIds: r.activeIds,
      foldedIds: r.foldedIds,
      blockTokens: gateCountTokens(r.systemMessage),
      budget: r.stats.budget,
      overflow: r.stats.overflow,
      gap: r.stats.gap,
      rejectedByBudget: r.stats.rejectedByBudget,
      crowdedOutIds: r.stats.crowdedOutIds,
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
      // Which manual each rule came from. A flat id list cannot answer "was
      // that my project's rule or the app's?", and that is the first question
      // a reader asks when an answer surprises them.
      corpora: g.corpora,
    });
  }

  async function callOllamaStreaming(model, messages, { signal, onDelta, maxTokens = DEFAULT_MAX_TOKENS }) {
    const resp = await fetch(`${target}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, messages, stream: true,
        options: { temperature: 0.7, num_predict: maxTokens, num_ctx: numCtx },
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

  async function callAnthropicStreaming(model, messages, { signal, onDelta, maxTokens = DEFAULT_MAX_TOKENS }) {
    const systemMessages = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const nonSystem = messages.filter(m => m.role !== "system");
    const body = {
      model,
      max_tokens: maxTokens,
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

  async function callModelStreaming(messages, { signal, onDelta, provider, modelOverride, draftModel, maxTokens = DEFAULT_MAX_TOKENS }) {
    let model, routerCtx;
    const key = _getAnthropicKey();
    const useAnthropic = provider === "anthropic" && key;
    if (useAnthropic) {
      model = modelOverride || anthropicModel || "claude-sonnet-4-20250514";
    } else if (draftModel) {
      model = draftModel;
    } else if (modelOverride) {
      model = modelOverride;
    } else if (modelRouter) {
      ({ model, ctx: routerCtx } = modelRouter.pick(messages));
    } else {
      model = heuristicModel(messages);
    }
    const startedAt = Date.now();
    const result = useAnthropic
      ? await callAnthropicStreaming(model, messages, { signal, onDelta, maxTokens })
      : await callOllamaStreaming(model, messages, { signal, onDelta, maxTokens });
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
        model, max_tokens: CORRECTION_MAX_TOKENS,
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
        options: { temperature: 0.4, num_predict: CORRECTION_MAX_TOKENS, num_ctx: numCtx },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    const j = await resp.json();
    return (j.message?.content || "").trim();
  }

  // Finalize the model's raw output AND review it against the instruction
  // folds that were in force (grounding) and the conversation's working memory
  // (recall-denial). When either mechanical review flags the answer, a bounded
  // correction loop (≤2) re-asks the model to fix ONLY the flagged violations,
  // then re-reviews. The text that ships is the reviewed one; both reviews are
  // emitted (`review_report` for instruction folds, `discourse_report` via the
  // caller) and persisted.
  //
  // Order matters: citations/brackets/fidelity are resolved on the final text,
  // whether that text is the original or a correction.
  async function finalizeAndReview({ rawText, lastCitations, maxCitation, question, gate, groundText, memory, sendEvent, turnId, answerId, provider, modelOverride, draftModel }) {
    // Mechanical pass before anything else touches the text: any sentence the
    // model left uncited gets a bracket (plus a verbatim clause as proof) when
    // — and only when — its own vocabulary is concentrated enough in one
    // source to name it without guessing. Everything below (bracket
    // resolution, fidelity, the void-checker) runs against this text exactly
    // as it would against citations the model wrote itself; the mechanical
    // pass never gets a separate, weaker check.
    let text = maxCitation > 0 ? autoAttachCitations(rawText, lastCitations) : rawText;
    let display = formatOutput(text);
    let brackets = resolveCitationBrackets(text, lastCitations).citations;
    let finalText = maxCitation > 0 ? validateCitations(display, maxCitation) : display;

    const facts = memory?.state?.facts || [];
    const runReviews = () => ({
      review: gate
        ? reviewOutput({
            question, answer: finalText,
            gate: { activeIds: gate.activeIds, folds: gate.folds || instructionGate.folds, stats: gate.stats || {} },
            groundText,
          })
        : { verdict: "PASS", flags: [] },
      denial: facts.length
        ? checkRecallDenial({ question, answer: finalText, facts })
        : { verdict: "PASS", flags: [], denialSentences: [] },
    });

    let corrected = false, iterations = 0;
    let { review, denial } = runReviews();
    // The denial flags as first seen, kept even when a correction resolves
    // them: an audit trail that says "the answer denied, then was fixed" must
    // say what it denied, not just that something was fixed.
    let denialSeen = denial.verdict === "FLAGGED" ? denial : null;
    const allFlags = () => [...(review.flags || []), ...(denial.flags || [])];
    const needCorrection = () => review.verdict === "FLAGGED" || denial.verdict === "FLAGGED";

    if (gate || facts.length) {
      // The correction pass regenerates the answer, so it must see the same
      // numbered passages the first pass saw — a [3] it writes is meaningless
      // if it never saw passage 3. Rebuilt from the turn's own citation table
      // so the bracket numbers agree with resolveCitationBrackets.
      const correctionPassages = lastCitations?.length
        ? "CITED PASSAGES — the bracket numbers in your answer must reference these passages:\n\n" +
          lastCitations.map((c, i) => `[${i + 1}] ${c.text || ""}`).join("\n\n")
        : "";
      // Correction model: when a draft model was used, correction uses the
      // standard model (router pick or override) — a better model that can fix
      // what the fast draft got wrong. When no draft model, correction uses the
      // same model as the draft (the default behavior).
      const correctionModel = draftModel ? modelOverride : undefined;
      while (needCorrection() && iterations < 2) {
        const correction = buildCorrectionSystemContent(allFlags(), gate?.activeIds);
        let next;
        try {
          // The correction directive goes LAST, as the final user content — the
          // same convention narrative/code/svg-longform use. A bare question as
          // the final turn re-rolls the original dice (which already failed);
          // the flagged-violations frame must be the most recent thing the
          // model reads before generating.
          next = await callModelNonStreaming([
            ...(gate?.systemMessage ? [{ role: "system", content: gate.systemMessage }] : []),
            ...(memory?.message ? [{ role: "system", content: memory.message }] : []),
            ...(correctionPassages ? [{ role: "system", content: correctionPassages }] : []),
            // Show the model the exact text that was flagged, so "fix ONLY the
            // flagged violations" means something it can act on — a blind
            // regeneration from the question alone re-rolls the same dice.
            ...(finalText ? [{ role: "system", content: `Your previous answer (rewrite it to fix ONLY the flagged violations):\n\n${finalText.slice(0, 4000)}` }] : []),
            { role: "user", content: `${question}\n\n${correction}` },
          ], { provider, modelOverride: correctionModel });
        } catch {
          break; // keep the flagged text; the report will show correction was not achieved
        }
        if (!next) break;
        text = maxCitation > 0 ? autoAttachCitations(next, lastCitations) : next;
        corrected = true;
        iterations++;
        display = formatOutput(text);
        brackets = resolveCitationBrackets(text, lastCitations).citations;
        finalText = maxCitation > 0 ? validateCitations(display, maxCitation) : display;
        ({ review, denial } = runReviews());
        if (!denialSeen && denial.verdict === "FLAGGED") denialSeen = denial;
      }
    }

    const fidelity = verifyQuotedFidelity(finalText, lastCitations);
    const snippets = buildVerbatimSnippets(brackets, lastCitations);

    // The full mechanical fact-check: does every checkable atom (name, date,
    // figure) in a cited sentence actually occur in the passage it cites? This
    // is what catches the case fidelity/bracket-resolution above cannot — a
    // perfectly well-formed [2] attached to a claim whose content is nowhere
    // in passage 2. Computed from the answer and the engine's citation table
    // alone — no second model call, nothing the writer could have influenced.
    //
    // Run against `display` (formatted, but pre-validateCitations) rather than
    // `finalText`: validateCitations has already rewritten an invented [9]
    // into "[⊘ no source 9]", which no longer parses as a bracket, so checking
    // the rewritten text would report zero unresolved citations and erase the
    // very finding it exists to make. `annotatedText` is the one derived
    // artifact clients render, so no caller has to reconcile the two passes.
    const groundingCheck = checkGrounding(display, lastCitations, { question });
    const annotatedText = maxCitation > 0
      ? validateCitations(annotateVoids(display, groundingCheck), maxCitation)
      : annotateVoids(display, groundingCheck);

    const reviewReport = gate
      ? { verdict: review.verdict, flags: review.flags, corrected, iterations }
      : null;
    if (reviewReport) {
      sendEvent("review_report", { turnId, answerId, ...reviewReport });
    }
    const denialReport = denial
      ? {
          verdict: denial.verdict,
          wasFlagged: !!denialSeen,
          flags: (denialSeen || denial).flags,
          denialSentences: (denialSeen || denial).denialSentences,
          corrected,
          iterations,
        }
      : null;
    if (denialReport && (denial.verdict === "FLAGGED" || corrected)) {
      sendEvent("discourse_review", { turnId, answerId, ...denialReport });
    }
    return { finalText, brackets, fidelity, snippets, review: reviewReport, denial: denialReport, groundingCheck, annotatedText };
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

  // Records this turn in the conversation's holon log against the sources its
  // OWN retrieval actually grounded on, and returns the section-count ceiling
  // this blink earned — DEFAULT unless the log discovers this turn depends on
  // a prior one (conversation-holon.js). This only bounds how far
  // turn-generation.js's outline is ALLOWED to split; the outline still only
  // splits as far as the evidence itself earns. Persists the updated log
  // best-effort; a persistence failure should never block the answer itself.
  async function resolveMaxSections(conv, turn, sourceIds) {
    const priorLog = conv.holonLog || createConversationHolon();
    const { log, promoted } = recordTurn(priorLog, { turnId: turn.id, sourceIds });
    conversationStore.setHolonLog(conv.id, log).catch(() => {});
    conv.holonLog = log;
    return promoted ? LONGFORM_MAX_SECTIONS : DEFAULT_MAX_SECTIONS;
  }

  // The core pipeline shared by a fresh turn and a regenerate — both already
  // have a turnId/answerId and a question by the time this runs.
  async function runAnswer({ conv, turn, answerId, question, sourceScope, pool, provider, model: modelOverride, draftModel, mode, webSearch }, sendEvent) {
    // Dispatch to mode-specific handler
    if (mode === "surf") {
      return runSurfAnswer({ conv, turn, answerId, question, sourceScope, pool, provider, model: modelOverride, draftModel }, sendEvent);
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
        let { message: systemMsg, maxCitation } = buildWebSystemMessage(webResults);

        const retrieved = webResults.map((r) => ({
          rank: r.rank,
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          text: r.text,
          source: "web",
        }));

        // Same citation table shape the engine-grounding branch builds below
        // (index/source_id/text), just sourced from a live page instead of an
        // ingested one — a bracket the model writes against a web result has
        // to resolve against SOMETHING, or every web citation reports as
        // fabricated regardless of whether the page actually backs it.
        let lastCitations = webResults.map((r, i) => ({
          index: i + 1, source_id: r.url, title: r.title, url: r.url,
          text: r.text || r.snippet || "",
        }));

        sendEvent("witnesses_selected", {
          turnId: turn.id, answerId,
          empty: webResults.length === 0,
          warming: false,
          sourceCount: webResults.length,
          foldedCount: webResults.length,
          retrieved,
          citations: lastCitations,
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
            citations: lastCitations,
          },
        });

        const history = buildHistoryMessages(conv, turn.id);
        const discourse = await loadDiscourseBlocks({ question, conv, pool });
        // webSearchFn already ran on the raw question above, before the desk
        // loaded — the cue cannot widen the search itself on this path. It
        // still sharpens which instruction folds this turn surfaces.
        const cueResult = await prosifyCue({
          question, history: recentUserQuestions(conv, turn.id),
          hot: discourse.state.hot, facts: discourse.state.facts,
        });
        const messages = [];
        if (discourse.cabinetBlock) messages.push({ role: "system", content: discourse.cabinetBlock });
        if (discourse.memoryMsg) messages.push({ role: "system", content: discourse.memoryMsg });
        messages.push(systemMsg);

        const gateInfo = gateInstructionBlock({
          question: cueResult.cue, conv, turnId: turn.id,
          evidence: webResults.map((r) => [r.title, r.text || r.snippet || ""].join("\n")),
        });
        emitGateReport(sendEvent, turn.id, answerId, gateInfo);
        if (gateInfo) messages.push({ role: "system", content: gateInfo.systemMessage });
        const webDeliberate = !!gateInfo?.activeIds?.some((id) => DELIBERATE_FOLD_IDS.has(id))
          && webResults.length > 0;

        const maxSections = await resolveMaxSections(conv, turn, webResults.map((r) => r.url));
        const webEvidence = webResults.map((r) => ({ source_id: r.url, span_id: r.url, text: r.text || r.snippet || "" }));
        let sawStart = false;
        const { text: rawText, model } = await generateAnswer({
          messages, evidence: webEvidence, maxSections, singleSectionMaxTokens: DEFAULT_MAX_TOKENS,
          callModelStreaming, provider, modelOverride, draftModel, signal: controller.signal,
          onSectionDelta: (delta, text) => {
            if (!sawStart) { sawStart = true; sendEvent("writing_started", { turnId: turn.id, answerId, passageCount: webResults.length }); }
            controller._partialText = formatOutput(text);
            sendEvent("answer_delta", { turnId: turn.id, answerId, delta, text: controller._partialText });
          },
        });

        // Draft info: which model produced this draft. When draftModel is set,
        // the reader sees both the draft model and the correction model (if any).
        // This is the auditability the reader needs to know: a fast model drafted
        // this answer, and a better model may have corrected it.
        sendEvent("draft_info", {
          turnId: turn.id, answerId,
          draftModel: model,
          correctionModel: draftModel ? (modelOverride || null) : null,
          corrected: false, // updated after review
        });

        const groundText = webResults.map((r) => `${r.title}\n${r.text || r.snippet || ""}`).join("\n\n");
        const { finalText, brackets, fidelity, snippets, review, denial, groundingCheck, annotatedText } = await finalizeAndReview({
          rawText, lastCitations, maxCitation, question,
          gate: gateInfo, groundText, memory: discourse, sendEvent, turnId: turn.id, answerId, provider, modelOverride, draftModel,
        });

        for (const c of brackets) {
          sendEvent("citation_verified", { turnId: turn.id, answerId, ...c });
        }

        for (const s of snippets) {
          sendEvent("verbatim_snippet", { turnId: turn.id, answerId, ...s });
        }

        // Emitted before the gaps it explains, and unconditionally — a turn
        // with nothing wrong must still be able to say what was examined, or
        // "clean" and "unchecked" render identically (LAWS.md candidate: two
        // facts that differ must not read alike).
        sendEvent("grounding_checked", { turnId: turn.id, answerId, ...groundingCheck, annotatedText });

        const gaps = groundingGaps(groundingCheck);
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
          text: finalText, annotatedText, model, citations: brackets, gaps, snippets,
          fidelity, grounding_check: groundingCheck, webSearch: true, status: "completed", completedAt: new Date().toISOString(),
          review,
          draftModel: draftModel || null,
          correctionModel: draftModel ? (modelOverride || null) : null,
          instructionGate: gateInfo ? {
            activeIds: gateInfo.activeIds, foldedIds: gateInfo.foldedIds,
            blockTokens: gateInfo.blockTokens, budget: gateInfo.budget, overflow: gateInfo.overflow,
            gap: gateInfo.stats?.gap, rejectedByBudget: gateInfo.stats?.rejectedByBudget,
            corpora: gateInfo.corpora,
          } : null,
          prosify: { raw: cueResult.raw, cue: cueResult.cue, changed: cueResult.changed, reason: cueResult.reason },
        });
        sendEvent("completed", {
          turnId: turn.id, answerId, status: "completed", text: finalText,
          annotatedText, groundingCheck,
          citations: brackets, gaps, snippets, model, webSearch: true,
          summary: `${webResults.length} web sources`,
        });
        await persistTurnMemory({
          conv, turn, question, answerText: finalText, denial,
          discourse, answerId, sendEvent,
        });
      } else {
        // ── Engine grounding path: retrieved is empty (reserved for web results) ──
        // The desk loads BEFORE retrieval so the conversation's topic trace can
        // condition the ground query (engineGroundQuery's `discourse` widening).
        const discourse = await loadDiscourseBlocks({ question, conv, pool });
        const cueResult = await prosifyCue({
          question, history: recentUserQuestions(conv, turn.id),
          hot: discourse.state.hot, facts: discourse.state.facts,
        });
        const groundResult = groundQuery(cueResult.cue, {
          budget: 3000, maxUnits: 5, limit: 16,
          source: sourceScope, pool: pool || "corpus",
          discourse: discourse.state.hot?.length
            ? discourse.state.hot.slice(0, 4).map((t) => t.term).join(" ")
            : undefined,
        });
        const { message: systemMsg, maxCitation, warming } =
          buildGroundedSystemMessage(groundResult, isWarming ? isWarming() : false);

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
          discourse: groundResult.discourse || null,
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
            discourse: groundResult.discourse || null,
          },
        });

        const lastCitations = (groundResult.citations || []).map((c, i) => ({
          index: i + 1, source_id: c.source_id, span_id: c.span_id,
          byte_start: c.byte_start, byte_end: c.byte_end, score: c.score, text: c.text,
        }));

        const history = buildHistoryMessages(conv, turn.id);
        const messages = [];
        if (discourse.cabinetBlock) messages.push({ role: "system", content: discourse.cabinetBlock });
        if (discourse.memoryMsg) messages.push({ role: "system", content: discourse.memoryMsg });
        messages.push(systemMsg);

        const gateInfo = gateInstructionBlock({
          question: cueResult.cue, conv, turnId: turn.id,
          evidence: (groundResult.citations || []).map((c) => c.text),
        });
        emitGateReport(sendEvent, turn.id, answerId, gateInfo);
        if (gateInfo) messages.push({ role: "system", content: gateInfo.systemMessage });
        messages.push(...history, { role: "user", content: question });

        const maxSections = await resolveMaxSections(conv, turn, (groundResult.citations || []).map((c) => c.source_id));
        let sawStart = false;
        const { text: rawText, model } = await generateAnswer({
          messages, evidence: groundResult.citations || [], maxSections, singleSectionMaxTokens: DEFAULT_MAX_TOKENS,
          callModelStreaming, provider, modelOverride, draftModel, signal: controller.signal,
          onSectionDelta: (delta, text) => {
            if (!sawStart) { sawStart = true; sendEvent("writing_started", { turnId: turn.id, answerId, passageCount: groundResult.folded || 0 }); }
            controller._partialText = formatOutput(text);
            sendEvent("answer_delta", { turnId: turn.id, answerId, delta, text: controller._partialText });
          },
        });

        // Draft info: which model produced this draft.
        sendEvent("draft_info", {
          turnId: turn.id, answerId,
          draftModel: model,
          correctionModel: draftModel ? (modelOverride || null) : null,
          corrected: false,
        });

        const groundText = effectiveLastCitations.map((c) => c.text).join("\n\n");
        const { finalText, brackets, fidelity, snippets, review, denial, groundingCheck, annotatedText } = await finalizeAndReview({
          rawText, lastCitations: effectiveLastCitations, maxCitation: effectiveMaxCitation, question,
          gate: gateInfo, groundText, memory: discourse, sendEvent, turnId: turn.id, answerId, provider, modelOverride, draftModel,
        });

        for (const c of brackets) {
          sendEvent("citation_verified", { turnId: turn.id, answerId, ...c });
        }

        for (const s of snippets) {
          sendEvent("verbatim_snippet", { turnId: turn.id, answerId, ...s });
        }

        // Emitted before the gaps it explains, and unconditionally — a turn
        // with nothing wrong must still be able to say what was examined, or
        // "clean" and "unchecked" render identically (LAWS.md candidate: two
        // facts that differ must not read alike).
        sendEvent("grounding_checked", { turnId: turn.id, answerId, ...groundingCheck, annotatedText });

        const gaps = groundingGaps(groundingCheck);
        if (brackets.some((b) => !b.resolved)) {
          const unresolvedNums = brackets.filter((b) => !b.resolved).map((b) => b.num);
          gaps.push({ type: "unresolved_citation", nums: unresolvedNums, reason: `[${unresolvedNums.join("], [")}] — no engine passage matches this bracket.` });
        }
        for (const u of fidelity.unverified) {
          gaps.push({ type: "unverified_quote", quote: u.quote, reason: "This quoted text does not appear verbatim in any cited passage." });
        }
        for (const g of effectiveGround.gaps || []) gaps.push(g);
        if (!effectiveGround.context) {
          gaps.push({
            type: warming ? "corpus_warming" : "no_evidence_matched",
            reason: warming
              ? "The document index was still loading when this was asked."
              : "No passage in your sources matches this question — answered from general knowledge, uncited.",
          });
        }
        for (const g of gaps) sendEvent("gap", { turnId: turn.id, answerId, ...g });

        await conversationStore.patchAnswer(conv.id, turn.id, answerId, {
          text: finalText, annotatedText, model, citations: brackets, gaps, snippets,
          fidelity, grounding_check: groundingCheck, review, status: "completed", completedAt: new Date().toISOString(),
          draftModel: draftModel || null,
          correctionModel: draftModel ? (modelOverride || null) : null,
          instructionGate: gateInfo ? {
            activeIds: gateInfo.activeIds, foldedIds: gateInfo.foldedIds,
            blockTokens: gateInfo.blockTokens, budget: gateInfo.budget, overflow: gateInfo.overflow,
            gap: gateInfo.stats?.gap, rejectedByBudget: gateInfo.stats?.rejectedByBudget,
            corpora: gateInfo.corpora,
          } : null,
          prosify: { raw: cueResult.raw, cue: cueResult.cue, changed: cueResult.changed, reason: cueResult.reason },
        });
        sendEvent("completed", {
          turnId: turn.id, answerId, status: "completed", text: finalText,
          annotatedText, groundingCheck,
          citations: brackets, gaps, snippets, model, review,
          summary: `${effectiveGround.folded || 0} passages · ${new Set((effectiveGround.citations || []).map((c) => c.source_id)).size} sources`,
        });
        await persistTurnMemory({
          conv, turn, question, answerText: finalText, denial,
          discourse, answerId, sendEvent,
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

  async function startTurn({ conversationId, question, sourceScope, pool, attachments, provider, model, draftModel, mode, webSearch }, sendEvent) {
    const conv = await conversationStore.require(conversationId);
    const effectiveScope = sourceScope !== undefined ? sourceScope : conv.sourceScope;
    const effectiveMode = mode || conv.mode || "chat";
    const effectiveWebSearch = webSearch !== undefined ? webSearch : (conv.webSearch !== undefined ? conv.webSearch : true);

    // Cross-turn correction: if the previous turn's active answer was flagged,
    // inject the flags as correction context into this turn's question. The
    // model sees "your previous answer was flagged" and fixes only the flagged
    // violations. This extends the within-turn correction loop (finalizeAndReview)
    // across turns when the model can't fix everything in one pass.
    let effectiveQuestion = question;
    let crossTurnCorrection = null;
    const turns = conv.turns || [];
    if (turns.length > 0) {
      const prevTurn = turns[turns.length - 1];
      const prevAnswer = (prevTurn.answers || []).find((a) => a.id === prevTurn.activeAnswerId);
      if (prevAnswer?.review?.verdict === "FLAGGED" && prevAnswer.review.flags?.length) {
        const correctionContext = buildCorrectionSystemContent(prevAnswer.review.flags, prevAnswer.instructionGate?.activeIds || []);
        effectiveQuestion = `${question}\n\n${correctionContext}`;
        crossTurnCorrection = { previousTurnId: prevTurn.id, flags: prevAnswer.review.flags.map((f) => f.type) };
      }
    }

    const { turn } = await conversationStore.appendTurn(conversationId, {
      question: effectiveQuestion, sourceScope: effectiveScope, attachments,
    });
    // Emitted only once `turn` exists — the event names THIS turn, so it
    // cannot fire before this turn has an id.
    if (crossTurnCorrection) sendEvent("cross_turn_correction", { turnId: turn.id, ...crossTurnCorrection });
    const answer = await conversationStore.addAnswer(conversationId, turn.id, {});
    sendEvent("accepted", {
      turnId: turn.id, answerId: answer.id, question: effectiveQuestion,
      sourceScope: effectiveScope, pool: pool || conv.pool || "corpus",
      mode: effectiveMode, webSearch: effectiveWebSearch,
    });

    const run = runAnswer({
      conv, turn, answerId: answer.id,
      question: effectiveQuestion, sourceScope: effectiveScope, pool: pool || conv.pool,
      provider, model, draftModel, mode: effectiveMode, webSearch: effectiveWebSearch,
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
      mode: conv.mode || "chat", webSearch: conv.webSearch !== undefined ? conv.webSearch : true,
      regenerate: true,
    });
    const run = runAnswer({
      conv: { ...conv, id: conversationId }, turn, answerId: answer.id,
      question: turn.question, sourceScope: turn.sourceScope, pool: conv.pool,
      mode: conv.mode || "chat", webSearch: conv.webSearch !== undefined ? conv.webSearch : true,
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
