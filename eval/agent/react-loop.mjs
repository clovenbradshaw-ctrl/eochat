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
// discipline the malformed-response abort below already uses.

import { parseAction } from "./lib/parse-action.mjs";

const STUCK_LOOP_NUDGE_AT = 2;   // the 2nd identical failing call gets an explicit "you are repeating yourself" notice
const STUCK_LOOP_ABORT_AT = 4;   // the 4th identical failing call ends the attempt rather than exhausting the step budget on a loop that has already shown it will not resolve itself

// SURF AND FOLD, applied to the running conversation. Ollama's /api/chat is
// stateless per request, so every turn resends the WHOLE prompt — left
// unbounded, a real run measured n_tokens climbing past 3400 within half a
// dozen steps (system prompt + every raw assistant reply + every full tool
// observation, replayed in full every single turn), which is most of a
// small local model's entire context window spent on replaying its own
// history rather than reasoning about the next step. This is the same
// discipline task-log.js's foldToWorkingSet already applies to tasks —
// "hand the model a small, bounded, current state, not more context as the
// work grows" — applied here to conversation turns instead: the most
// recent FOLD_K turns are replayed verbatim (recency is what a ReAct step
// actually needs), everything older is folded to one short line per step,
// and if even the fold gets long only the most recent folded lines are
// shown, with an explicit count of what's withheld — never a silent
// truncation.
const DEFAULT_FOLD_K = 6;          // most recent turns kept in full
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

/** One compact user message standing in for everything folded out. */
function buildFoldedSummaryMessage(entries) {
  const shown = entries.length > MAX_FOLDED_SUMMARY_LINES ? entries.slice(-MAX_FOLDED_SUMMARY_LINES) : entries;
  const withheldExtra = entries.length - shown.length;
  const header = withheldExtra > 0
    ? `EARLIER STEPS (folded to keep this prompt small — showing the last ${shown.length} of ${entries.length} folded step(s); ${withheldExtra} even-earlier step(s) withheld entirely):`
    : `EARLIER STEPS (folded to keep this prompt small — ${shown.length} step(s), full detail withheld):`;
  return { role: "user", content: `${header}\n${shown.map(summarizeFoldedEntry).join("\n")}` };
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
  return [system, intro, buildFoldedSummaryMessage(folded.map((t) => t.entry)), ...kept.flatMap((t) => t.msgs)];
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
  const { tools, toolCalls } = toolset;
  const toolNames = Object.keys(tools);
  const system = { role: "system", content: PROTOCOL(toolNames.map((n) => tools[n].description)) };

  const userIntro = groundingBlock
    ? `TASK:\n${taskPrompt}\n\nRESEARCH (surfaced before you started, folded to what fit the budget):\n${groundingBlock}`
    : `TASK:\n${taskPrompt}`;
  const intro = { role: "user", content: userIntro };

  // The full, honest, append-only record of everything said — never
  // truncated, returned whole in the result. What's actually SENT to the
  // model each turn is the separate, bounded `foldedTurns` view below.
  const messages = [system, intro];
  const foldedTurns = []; // { entry, msgs }[] — one per step that needs another generate() call after it

  const transcript = [];
  let finished = false;
  let summary = null;
  let step = 0;
  let malformedStreak = 0;
  let repeatFailStreak = 0;
  let lastFailedCallKey = null;
  let stuckLoopAbort = false;

  for (; step < maxSteps; step++) {
    const promptView = buildPromptView(system, intro, foldedTurns, foldK);
    if (foldedTurns.length > foldK) {
      emit({ step, phase: "folded", keptTurns: Math.min(foldedTurns.length, foldK), foldedTurns: foldedTurns.length - foldK });
    }
    emit({ step, phase: "generating" });
    const raw = await adapter.generate(promptView, { maxTokens: maxTokensPerStep, seed: seed + step });
    const assistantMsg = { role: "assistant", content: raw };
    messages.push(assistantMsg);
    emit({ step, phase: "assistant_raw", raw });

    const parsed = parseAction(raw, toolNames);
    if (!parsed.ok) {
      malformedStreak += 1;
      const entry = { step, raw, malformed: true, reason: parsed.reason };
      transcript.push(entry);
      emit({ ...entry, phase: "malformed" });
      const nudge = `Your last response could not be parsed: ${parsed.reason}. Respond with exactly one JSON object: {"tool": "<name>", "args": {...}}.`;
      const nudgeMsg = { role: "user", content: nudge };
      messages.push(nudgeMsg);
      foldedTurns.push({ entry, msgs: [assistantMsg, nudgeMsg] });
      if (malformedStreak >= 3) {
        const abortEntry = { step, note: "aborted after 3 consecutive malformed responses" };
        transcript.push(abortEntry);
        emit({ ...abortEntry, phase: "aborted" });
        break;
      }
      continue;
    }
    malformedStreak = 0;

    if (parsed.tool === "finish") {
      finished = true;
      summary = typeof parsed.args.summary === "string" ? parsed.args.summary : "(no summary given)";
      const entry = { step, tool: "finish", args: parsed.args };
      transcript.push(entry);
      emit({ ...entry, phase: "finish" });
      break;
    }

    emit({ step, phase: "tool_call", tool: parsed.tool, args: parsed.args });
    const result = tools[parsed.tool].run(parsed.args);
    const callKey = `${parsed.tool}:${JSON.stringify(parsed.args)}`;
    const isFailure = result && typeof result === "object" && "error" in result;
    repeatFailStreak = isFailure && callKey === lastFailedCallKey ? repeatFailStreak + 1 : isFailure ? 1 : 0;
    lastFailedCallKey = isFailure ? callKey : null;

    const entry = { step, tool: parsed.tool, args: parsed.args, result, repeatFailStreak: repeatFailStreak || undefined };
    transcript.push(entry);
    emit({ ...entry, phase: "tool_result" });

    let observation = formatObservation(parsed.tool, result);
    if (repeatFailStreak >= STUCK_LOOP_NUDGE_AT) {
      observation += `\n\nSTUCK LOOP: this is the ${repeatFailStreak}${repeatFailStreak === 2 ? "nd" : repeatFailStreak === 3 ? "rd" : "th"} time in a row you have called ${parsed.tool} with the EXACT SAME arguments, and it has failed the SAME way every time. Repeating it again will fail again. Stop: re-read the OBSERVATION above (or call read_file again) and base your next argument on what it actually says, not on what you expect it to say.`;
    }
    const observationMsg = { role: "user", content: observation };
    messages.push(observationMsg);
    foldedTurns.push({ entry, msgs: [assistantMsg, observationMsg] });

    if (repeatFailStreak >= STUCK_LOOP_ABORT_AT) {
      stuckLoopAbort = true;
      const abortEntry = { step, note: `aborted after ${repeatFailStreak} consecutive identical failing ${parsed.tool} calls (stuck loop, not a step-budget exhaustion)` };
      transcript.push(abortEntry);
      emit({ ...abortEntry, phase: "aborted" });
      break;
    }
  }

  return {
    finished,
    summary,
    steps: step + (finished || transcript.at(-1)?.note ? 1 : 0),
    stepsRun: transcript.length,
    hitStepCap: !finished && !stuckLoopAbort && step >= maxSteps,
    // A distinct honest reason from hitStepCap: the loop stopped itself
    // early because it detected it was not converging, not because it ran
    // out of budget -- these must not read alike (same discipline
    // task-log.js's `closed` vs `halted_by` distinguishes).
    stuckLoopAbort,
    transcript,
    toolCalls: [...toolCalls],
    messages,
  };
}
