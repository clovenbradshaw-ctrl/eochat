// The actual read-execute-observe-correct loop (Agentic Coding Capability
// Test Spec, Level 2+): the model chooses one tool call per turn, the tool
// actually runs against the sandbox, the real result is appended as an
// observation, and the loop repeats until the model calls finish() or a
// step cap is hit. No hidden retry-until-green on the harness's part — if
// the model never runs its own code, that is a real, measured failure this
// loop must surface, not paper over.
//
// STUCK-LOOP DETECTION. A real transcript from a real run showed a genuine
// failure mode distinct from "ran out of steps": the model called edit_file
// with the identical (wrong) old_string 10 times in a row, re-reading the
// real file in between every attempt and never once incorporating what it
// actually observed. A doubled step budget did not fix this — it just
// repeated the same loop longer, which ruled out "not enough steps" as the
// cause. This is a real, measured prediction-error-correction failure: the
// SAME observation kept arriving and the model's next action did not
// change in response to it. Two responses, both proportionate to how many
// times the exact same failure has now repeated: an escalating, explicit
// nudge naming the loop (a stronger correction signal than the generic
// per-step error, since a REPEATED identical error is itself evidence a
// gentler nudge already failed), and an honest early abort if it still
// does not budge — the same "do not silently burn the rest of the budget"
// discipline the malformed-response abort below already uses. Counting is
// CUMULATIVE per exact (tool, args) across the whole attempt, never reset
// by an intervening successful call: the real failure pattern is
// edit_file(fail) -> read_file(succeed) -> edit_file(SAME fail) repeated,
// and a naive "reset on anything non-matching" streak counter never once
// saw it as a repeat, because the successful read in between reset it back
// to 1 every single time. Reading the file again is normal and not itself
// the problem; what matters is whether one SPECIFIC action keeps recurring
// regardless of what else happens around it.
//
// SURF AND FOLD, applied to the running conversation. Ollama's /api/chat is
// stateless per request, so every turn resends the WHOLE prompt — left
// unbounded, a real run measured n_tokens climbing past 3400 within half a
// dozen steps, most of a small local model's entire context window spent
// replaying its own history rather than reasoning about the next step.
// Three independent sessions converged on the same fix, the same day: keep
// the most recent turns verbatim (recency is what a ReAct step actually
// needs to act on right now) and fold everything older into one compact
// summary line per step, the same task-log.js foldToWorkingSet discipline
// applied to conversation turns instead of tasks. What did NOT converge on
// the first attempt: two of those three sessions independently bounded the
// fold ITSELF by keeping only the most recent N folded lines and dropping
// anything older — bounded, reported, and still picking what survives by
// POSITION rather than relevance, the identical defect one layer down.
// Fixed by scoring each folded line's lexical overlap with the current
// window (the same lexical-presence discipline ingest.mjs's real corpus
// search already uses) and keeping the highest-scoring lines when even the
// compact digest does not fit — see AMENDMENT-13-PROPOSAL.md (eo-
// constitution, ratified as II.18, the surf-before-fold test) for the full
// accounting of why "bounded and reported" is not sufficient on its own.

import { parseAction } from "./lib/parse-action.mjs";
import { significantTerms, overlapScore } from "./lib/lexical-relevance.mjs";

const STUCK_LOOP_NUDGE_AT = 2;   // the 2nd identical failing call gets an explicit "you are repeating yourself" notice
const STUCK_LOOP_ABORT_AT = 4;   // the 4th identical failing call ends the attempt rather than exhausting the step budget on a loop that has already shown it will not resolve itself
const DEFAULT_FOLD_K = 6;          // most recent turns kept verbatim — the same 4-7 "mouth" range task-log.js's foldToWorkingSet documents
const MAX_FOLDED_SUMMARY_LINES = 12; // even the fold itself is bounded

function summarizeResult(tool, result) {
  if (result && typeof result === "object" && "error" in result) {
    return `ERROR: ${String(result.error).slice(0, 140)}`;
  }
  if (tool === "read_file") return `ok (${result?.content?.length ?? 0} chars${result?.truncated ? ", truncated" : ""})`;
  if (tool === "list_files") return `ok (${result?.files?.length ?? 0} file(s))`;
  if (tool === "write_file" || tool === "edit_file") return `ok (${result?.bytesWritten ?? "?"} bytes written)`;
  if (tool === "run_shell") return `exit ${result?.exitCode}${result?.truncated ? ", output truncated" : ""}`;
  return "ok";
}

function summarizeFoldedEntry(e) {
  if (e.malformed) return `step ${e.step}: (unparseable response) — ${e.reason}`;
  if (e.note) return `step ${e.step}: ${e.note}`;
  return `step ${e.step}: ${e.tool}(${JSON.stringify(e.args)}) -> ${summarizeResult(e.tool, e.result)}`;
}

/**
 * One compact user message standing in for everything folded out. If the
 * full set of folded summary lines fits the budget, show them all — every
 * step still leaves a trace, nothing vanishes silently. If it does not,
 * SURF before folding further: score each line's lexical overlap with
 * `focusText` (the verbatim recent window the model is actually looking at
 * right now) and keep the highest-scoring lines, restored to chronological
 * order — not the most recent lines by position, which is exactly the
 * truncation-wearing-a-fold's-report-format defect this whole mechanism
 * exists to avoid.
 */
function buildFoldedSummaryMessage(entries, focusText) {
  const lines = entries.map((e, index) => ({ index, line: summarizeFoldedEntry(e) }));
  if (lines.length <= MAX_FOLDED_SUMMARY_LINES) {
    return { role: "user", content: `EARLIER STEPS (folded to keep this prompt small — ${lines.length} step(s), full detail withheld):\n${lines.map((l) => l.line).join("\n")}` };
  }

  const focusTerms = significantTerms(focusText);
  const kept = [...lines]
    .map((l) => ({ ...l, score: overlapScore(focusTerms, l.line) }))
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, MAX_FOLDED_SUMMARY_LINES)
    .sort((a, b) => a.index - b.index); // restore chronological order
  const withheld = lines.length - kept.length;
  const header = `EARLIER STEPS (folded to keep this prompt small — showing ${kept.length} of ${lines.length} folded step(s), kept by relevance to what you are looking at right now, not just recency; ${withheld} more folded step(s) withheld):`;
  return { role: "user", content: `${header}\n${kept.map((k) => k.line).join("\n")}` };
}

/**
 * Build what's actually SENT to the model this turn: system + task intro,
 * always; then either every turn verbatim (a short run) or the most recent
 * `foldK` turns verbatim plus one folded summary message standing in for
 * everything older. `foldedTurns` pairs each transcript entry with the raw
 * message(s) it produced, so folding never has to re-derive them.
 */
function buildPromptView(system, intro, foldedTurns, foldK) {
  if (foldedTurns.length <= foldK) {
    return [system, intro, ...foldedTurns.flatMap((t) => t.msgs)];
  }
  const kept = foldedTurns.slice(-foldK);
  const folded = foldedTurns.slice(0, -foldK);
  const focusText = kept.flatMap((t) => t.msgs).map((m) => m.content).join(" ");
  return [system, intro, buildFoldedSummaryMessage(folded.map((t) => t.entry), focusText), ...kept.flatMap((t) => t.msgs)];
}

const PROTOCOL = (toolDescriptions) => `You are an autonomous coding agent working in a real sandbox directory. You have exactly these tools:

${toolDescriptions.map((d) => `- ${d}`).join("\n")}

ENVIRONMENT: this sandbox has Node.js built-in modules only — no npm packages are installed and there is no network access to install any. A require()/import of anything other than a Node.js built-in (fs, path, etc.) will fail. Write dependency-free code.

RULES:
- Respond with EXACTLY ONE JSON object per turn: {"tool": "<name>", "args": {...}}. Nothing else — no prose, no markdown fences.
- Use run_shell to actually RUN your code / the test command and READ the output before deciding you are done. Do not guess that something works.
- Call "finish" only after you have observed real evidence (a passing test, real program output) that the task is complete.
- If your last action failed, read the error and fix the actual problem — do not repeat the same action unchanged.`;

function formatObservation(toolName, result) {
  const json = JSON.stringify(result, null, 0);
  return `OBSERVATION (${toolName}): ${json}`;
}

/**
 * Everything a react-loop run needs to carry between steps, with NO
 * adapter/generate call baked in — this is what makes the same per-step
 * logic drivable either by runReactLoop's own for-loop (an Ollama-style
 * adapter driving itself) or by an external stepping API where a CLIENT
 * (e.g. a browser running WebLLM) supplies each raw response one HTTP call
 * at a time. Tool execution always happens here, server-side, regardless
 * of where the model itself runs — read_file/write_file/edit_file/run_shell
 * need real filesystem/process access a browser cannot give them.
 *
 * @param {object} opts
 * @param {string} opts.taskPrompt
 * @param {string} [opts.groundingBlock]
 * @param {{tools: object, toolCalls: array}} opts.toolset
 * @param {number} [opts.foldK] see buildPromptView above. Default 6.
 */
export function createSession({ taskPrompt, groundingBlock = null, toolset, foldK = DEFAULT_FOLD_K }) {
  const { tools, toolCalls } = toolset;
  const toolNames = Object.keys(tools);
  const system = { role: "system", content: PROTOCOL(toolNames.map((n) => tools[n].description)) };

  const userIntro = groundingBlock
    ? `TASK:\n${taskPrompt}\n\nRESEARCH (surfaced before you started, folded to what fit the budget):\n${groundingBlock}`
    : `TASK:\n${taskPrompt}`;
  const intro = { role: "user", content: userIntro };

  return {
    tools, toolNames, toolCalls, system, intro, foldK,
    // The full, honest, append-only record of everything said — never
    // truncated. What's actually SENT to the model each turn is the
    // separate, bounded `foldedTurns` view (see promptViewFor below).
    messages: [system, intro],
    foldedTurns: [], // { entry, msgs }[] — one per step that needed another generate() call after it
    transcript: [],
    finished: false,
    summary: null,
    step: 0,
    malformedStreak: 0,
    // Keyed by exact (tool, args) — how many times THIS specific call has
    // failed, total, across the whole attempt so far. See the STUCK-LOOP
    // DETECTION note at the top of this file for why this must be cumulative
    // rather than reset by an intervening successful call.
    failureCounts: new Map(),
    stuckLoopAbort: false,
    // Set once no further applyResponse call should happen: finished,
    // stuckLoopAbort, or the malformed-response abort threshold.
    done: false,
  };
}

/** The bounded prompt to show the model for the session's CURRENT step. */
export function promptViewFor(session) {
  return buildPromptView(session.system, session.intro, session.foldedTurns, session.foldK);
}

/**
 * Apply exactly ONE raw model response to a session: parse it, run the tool
 * (or record why it couldn't), fold the observation into the session, and
 * report what happened as the same {phase, ...} event shape onStep already
 * uses — so a stepping HTTP API can disclose a client-driven run exactly
 * like runReactLoop discloses a server-driven one, with no duplicate
 * rendering logic anywhere downstream.
 *
 * Mutates `session` in place (and returns it) — sessions are meant to be
 * held by a caller (an in-memory map, keyed by session id) across calls.
 *
 * @returns {{ events: object[], done: boolean }}
 */
export function applyResponse(session, raw) {
  const events = [];
  const step = session.step;
  session.step += 1;

  const assistantMsg = { role: "assistant", content: raw };
  session.messages.push(assistantMsg);
  events.push({ step, phase: "assistant_raw", raw });

  const parsed = parseAction(raw, session.toolNames);
  if (!parsed.ok) {
    session.malformedStreak += 1;
    const entry = { step, raw, malformed: true, reason: parsed.reason };
    session.transcript.push(entry);
    events.push({ ...entry, phase: "malformed" });
    const nudge = `Your last response could not be parsed: ${parsed.reason}. Respond with exactly one JSON object: {"tool": "<name>", "args": {...}}.`;
    const nudgeMsg = { role: "user", content: nudge };
    session.messages.push(nudgeMsg);
    session.foldedTurns.push({ entry, msgs: [assistantMsg, nudgeMsg] });
    if (session.malformedStreak >= 3) {
      const abortEntry = { step, note: "aborted after 3 consecutive malformed responses" };
      session.transcript.push(abortEntry);
      events.push({ ...abortEntry, phase: "aborted" });
      session.done = true;
    }
    return { events, done: session.done };
  }
  session.malformedStreak = 0;

  if (parsed.tool === "finish") {
    session.finished = true;
    session.summary = typeof parsed.args.summary === "string" ? parsed.args.summary : "(no summary given)";
    const entry = { step, tool: "finish", args: parsed.args };
    session.transcript.push(entry);
    events.push({ ...entry, phase: "finish" });
    session.done = true;
    return { events, done: true };
  }

  events.push({ step, phase: "tool_call", tool: parsed.tool, args: parsed.args });
  const result = session.tools[parsed.tool].run(parsed.args);
  const callKey = `${parsed.tool}:${JSON.stringify(parsed.args)}`;
  const isFailure = result && typeof result === "object" && "error" in result;
  const repeatCount = isFailure ? (session.failureCounts.get(callKey) ?? 0) + 1 : 0;
  if (isFailure) session.failureCounts.set(callKey, repeatCount);

  const entry = { step, tool: parsed.tool, args: parsed.args, result, repeatFailStreak: repeatCount || undefined };
  session.transcript.push(entry);
  events.push({ ...entry, phase: "tool_result" });

  let observation = formatObservation(parsed.tool, result);
  if (repeatCount >= STUCK_LOOP_NUDGE_AT) {
    observation += `\n\nSTUCK LOOP: this exact ${parsed.tool} call (the SAME arguments) has now failed ${repeatCount} times, the same way every time — reading the file in between has not changed what you try next. Repeating it again will fail again. Stop: re-read the OBSERVATION above and base your next argument on what it actually says, not on what you expect it to say.`;
  }
  const observationMsg = { role: "user", content: observation };
  session.messages.push(observationMsg);
  session.foldedTurns.push({ entry, msgs: [assistantMsg, observationMsg] });

  if (repeatCount >= STUCK_LOOP_ABORT_AT) {
    session.stuckLoopAbort = true;
    const abortEntry = { step, note: `aborted after ${repeatCount} total identical failing ${parsed.tool} calls across the attempt (stuck loop, not a step-budget exhaustion)` };
    session.transcript.push(abortEntry);
    events.push({ ...abortEntry, phase: "aborted" });
    session.done = true;
  }

  return { events, done: session.done };
}

/**
 * @param {object} opts
 * @param {string} opts.taskPrompt      the task description shown to the model
 * @param {string} [opts.groundingBlock] optional surf/fold research context (see holon-coder.mjs)
 * @param {{tools: object, toolCalls: array}} opts.toolset  from tools.mjs
 * @param {{generate: Function}} opts.adapter
 * @param {number} [opts.maxSteps]
 * @param {number} [opts.maxTokensPerStep]
 * @param {number} [opts.seed]
 * @param {number} [opts.foldK] how many recent turns are replayed to the
 *   model verbatim before older ones fold to a one-line summary each (see
 *   buildPromptView above). Default 6 — the same 4-7 "mouth" range
 *   task-log.js's foldToWorkingSet documents.
 * @param {Function} [opts.onStep] optional (transcriptEntry) => void, called
 *   the instant each transcript entry is recorded — the live-disclosure hook.
 *   Purely observational: it cannot alter the loop's own decisions, and a
 *   throwing onStep is never allowed to break a real eval run, so it is
 *   called inside a try/catch that only logs.
 */
export async function runReactLoop({
  taskPrompt, groundingBlock = null, toolset, adapter, maxSteps = 8, maxTokensPerStep = 200, seed = 0,
  foldK = DEFAULT_FOLD_K, onStep = null,
}) {
  const emit = onStep
    ? (entry) => { try { onStep(entry); } catch (err) { console.error(`[react-loop] onStep handler threw: ${err.message}`); } }
    : () => {};

  const session = createSession({ taskPrompt, groundingBlock, toolset, foldK });

  let step = 0;
  for (; step < maxSteps; step++) {
    const promptView = promptViewFor(session);
    if (session.foldedTurns.length > foldK) {
      emit({ step, phase: "folded", keptTurns: Math.min(session.foldedTurns.length, foldK), foldedTurns: session.foldedTurns.length - foldK });
    }
    emit({ step, phase: "generating" });
    const raw = await adapter.generate(promptView, { maxTokens: maxTokensPerStep, seed: seed + step });
    const { events, done } = applyResponse(session, raw);
    for (const event of events) emit(event);
    if (done) break;
  }

  return {
    finished: session.finished,
    summary: session.summary,
    steps: step + (session.finished || session.transcript.at(-1)?.note ? 1 : 0),
    stepsRun: session.transcript.length,
    hitStepCap: !session.finished && !session.stuckLoopAbort && step >= maxSteps,
    // A distinct honest reason from hitStepCap: the loop stopped itself
    // early because it detected it was not converging, not because it ran
    // out of budget -- these must not read alike (same discipline
    // task-log.js's `closed` vs `halted_by` distinguishes).
    stuckLoopAbort: session.stuckLoopAbort,
    transcript: session.transcript,
    toolCalls: [...session.toolCalls],
    messages: session.messages,
  };
}
