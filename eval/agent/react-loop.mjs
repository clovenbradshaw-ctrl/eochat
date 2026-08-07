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

//
// BOUNDED CONTEXT. Every other budget in this harness is declared and
// folded — surf()'s token budget, holon-coder.mjs's MAX_HANDOFF_CHARS,
// foldToWorkingSet's k. This loop's own `messages` array was the one place
// that was NOT: it grew by two entries every single step, forever, with no
// fold and no report. That is not a cosmetic gap — the local server this
// eval actually runs against (`ollama serve`) is started with a 4096-TOKEN
// context window and `--context-shift` enabled, which SILENTLY drops the
// oldest tokens once the conversation overflows it. Two independent
// sessions found and fixed this on the same day: one (against
// qwen2.5-coder:0.5b) landed `buildPromptMessages`/`foldOlderSteps` below —
// keep the last FOLD_WINDOW_STEPS steps verbatim, compress everything older
// into one honest digest line per step, nothing ever fully vanishes without
// a trace. The other (this branch, against qwen2.5-coder:7b) landed a
// relevance-scored keep-the-most-relevant-N version — bounded and reported,
// but capable of dropping an older step's content entirely, with only a
// count left behind. Merged: the digest-everything structure is the better
// base (a compressed trace survives for every step, which the drop-entirely
// version could not guarantee), but its OWN internal budget enforcement
// (`digest.slice(0, MAX_FOLDED_DIGEST_CHARS)`) had the identical defect
// this whole fix exists to name — bounded, reported, and still picking what
// to keep by POSITION (truncate the tail) rather than relevance. Fixed by
// scoring each digest line's lexical overlap with the current window (the
// same lexical-presence discipline ingest.mjs's real corpus search already
// uses) and keeping the highest-scoring lines when even the compact digest
// does not fit — see AMENDMENT-13-PROPOSAL.md (eo-constitution) for the
// full accounting of why "bounded and reported" is not sufficient on its
// own.

import { parseAction } from "./lib/parse-action.mjs";
import { significantTerms, overlapScore } from "./lib/lexical-relevance.mjs";

const STUCK_LOOP_NUDGE_AT = 2;   // the 2nd identical failing call gets an explicit "you are repeating yourself" notice
const STUCK_LOOP_ABORT_AT = 4;   // the 4th identical failing call ends the attempt rather than exhausting the step budget on a loop that has already shown it will not resolve itself

// PROMPT FOLDING. `messages` accumulates every raw response and every full
// observation with no bound -- fine for the harness's own record
// (`result.messages`, untouched by any of this), but sent WHOLE to the
// adapter every single step it becomes exactly the unbounded-context growth
// `ingest.mjs`'s surf/fold and task-log.js's foldToWorkingSet exist to
// prevent. Keep the last FOLD_WINDOW_STEPS steps verbatim (recent tool
// results are what the next decision actually turns on), fold everything
// older into one bounded, relevance-selected digest line per step -- never
// silently dropped, always says how much was condensed.
const FOLD_WINDOW_STEPS = 3;
const MAX_FOLDED_DIGEST_CHARS = 600;

function digestTranscriptEntry(entry) {
  if (entry.malformed) return `step ${entry.step}: (unparseable response) ${entry.reason}`;
  if (entry.tool === "finish") return `step ${entry.step}: finish`;
  const argsStr = JSON.stringify(entry.args ?? {});
  const briefArgs = argsStr.length > 100 ? `${argsStr.slice(0, 100)}…` : argsStr;
  const outcome = entry.result && typeof entry.result === "object" && "error" in entry.result
    ? `error: ${String(entry.result.error).slice(0, 100)}`
    : "ok";
  return `step ${entry.step}: ${entry.tool}(${briefArgs}) -> ${outcome}`;
}

/**
 * One digest line per folded step, newline-joined. If that whole digest
 * still exceeds the char budget, SURF before folding further: score each
 * line's lexical overlap with `focusText` (what the model is actually
 * looking at right now — the verbatim recent window) and keep the
 * highest-scoring lines, restored to chronological order, rather than
 * truncating the tail by position.
 */
function foldOlderSteps(transcript, foldedCount, focusText) {
  const lines = transcript.slice(0, foldedCount).map((entry, index) => ({ index, line: digestTranscriptEntry(entry) }));
  const joined = lines.map((l) => l.line).join("\n");
  if (joined.length <= MAX_FOLDED_DIGEST_CHARS) return joined;

  const focusTerms = significantTerms(focusText);
  const kept = [];
  let used = 0;
  for (const item of [...lines].map((l) => ({ ...l, score: overlapScore(focusTerms, l.line) }))
    .sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (used + item.line.length + 1 > MAX_FOLDED_DIGEST_CHARS) continue;
    kept.push(item);
    used += item.line.length + 1;
  }
  kept.sort((a, b) => a.index - b.index); // restore chronological order
  const withheldCount = lines.length - kept.length;
  const keptText = kept.map((k) => k.line).join("\n");
  return `${keptText}\n(${withheldCount} more folded step-digest line(s) withheld by relevance — kept by lexical overlap with the current window, not just recency; folded to the ${MAX_FOLDED_DIGEST_CHARS}-char budget, not silently grown)`;
}

/**
 * The actual prompt sent to the model each step: fixed prefix (system +
 * task), a folded digest of everything older than the window (only once
 * there IS anything to fold), then the last `windowSteps` steps verbatim.
 * `messages` itself (the harness's full record) is left untouched by this —
 * folding only changes what the model is actually shown, never what gets
 * recorded.
 */
function buildPromptMessages(messages, transcript, windowSteps) {
  const stepsSoFar = transcript.length;
  if (stepsSoFar <= windowSteps) return messages;
  const foldedCount = stepsSoFar - windowSteps;
  const recent = messages.slice(2 + foldedCount * 2);
  const focusText = recent.map((m) => m.content).join(" ");
  const foldedMsg = {
    role: "user",
    content: `EARLIER STEPS (${foldedCount} step(s) folded to keep this prompt small, not silently dropped):\n${foldOlderSteps(transcript, foldedCount, focusText)}`,
  };
  return [messages[0], messages[1], foldedMsg, ...recent];
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
 * @param {number} [opts.foldWindowSteps] how many of the most recent steps are shown verbatim before older ones fold to a digest — see buildPromptMessages
 */
export async function runReactLoop({
  taskPrompt, groundingBlock = null, toolset, adapter, maxSteps = 8, maxTokensPerStep = 200, seed = 0,
  foldWindowSteps = FOLD_WINDOW_STEPS,
}) {
  const { tools, toolCalls } = toolset;
  const toolNames = Object.keys(tools);
  const system = PROTOCOL(toolNames.map((n) => tools[n].description));

  const userIntro = groundingBlock
    ? `TASK:\n${taskPrompt}\n\nRESEARCH (surfaced before you started, folded to what fit the budget):\n${groundingBlock}`
    : `TASK:\n${taskPrompt}`;

  const messages = [
    { role: "system", content: system },
    { role: "user", content: userIntro },
  ];

  const transcript = [];
  let finished = false;
  let summary = null;
  let step = 0;
  let malformedStreak = 0;
  // Keyed by exact (tool, args) — how many times THIS specific call has
  // failed, total, across the whole attempt so far. Deliberately NOT reset
  // by an intervening successful call to something else: a real transcript
  // showed edit_file(fail) -> read_file(succeed) -> edit_file(SAME fail)
  // repeated 11 times, and a naive "reset on anything non-matching" streak
  // counter never once saw it as a repeat, because the successful read
  // in between reset it back to 1 every single time. Reading the file
  // again is normal, expected, and not itself the problem; what matters is
  // whether THIS exact failing action keeps recurring regardless of what
  // else happened around it.
  const failureCounts = new Map();
  let stuckLoopAbort = false;

  for (; step < maxSteps; step++) {
    // `messages` keeps the FULL history for the returned transcript (real
    // research data, per the same reasoning harness.mjs bounds-but-never-
    // discards transcripts) — only what is actually SENT to the model is
    // folded.
    const promptMessages = buildPromptMessages(messages, transcript, foldWindowSteps);
    const raw = await adapter.generate(promptMessages, { maxTokens: maxTokensPerStep, seed: seed + step });
    messages.push({ role: "assistant", content: raw });

    const parsed = parseAction(raw, toolNames);
    if (!parsed.ok) {
      malformedStreak += 1;
      transcript.push({ step, raw, malformed: true, reason: parsed.reason });
      const nudge = `Your last response could not be parsed: ${parsed.reason}. Respond with exactly one JSON object: {"tool": "<name>", "args": {...}}.`;
      messages.push({ role: "user", content: nudge });
      if (malformedStreak >= 3) {
        transcript.push({ step, note: "aborted after 3 consecutive malformed responses" });
        break;
      }
      continue;
    }
    malformedStreak = 0;

    if (parsed.tool === "finish") {
      finished = true;
      summary = typeof parsed.args.summary === "string" ? parsed.args.summary : "(no summary given)";
      transcript.push({ step, tool: "finish", args: parsed.args });
      break;
    }

    const result = tools[parsed.tool].run(parsed.args);
    const callKey = `${parsed.tool}:${JSON.stringify(parsed.args)}`;
    const isFailure = result && typeof result === "object" && "error" in result;
    const repeatCount = isFailure ? (failureCounts.get(callKey) ?? 0) + 1 : 0;
    if (isFailure) failureCounts.set(callKey, repeatCount);

    transcript.push({ step, tool: parsed.tool, args: parsed.args, result, repeatFailStreak: repeatCount || undefined });

    let observation = formatObservation(parsed.tool, result);
    if (repeatCount >= STUCK_LOOP_NUDGE_AT) {
      observation += `\n\nSTUCK LOOP: this exact ${parsed.tool} call (the SAME arguments) has now failed ${repeatCount} times, the same way every time — reading the file in between has not changed what you try next. Repeating it again will fail again. Stop: re-read the OBSERVATION above and base your next argument on what it actually says, not on what you expect it to say.`;
    }
    messages.push({ role: "user", content: observation });

    if (repeatCount >= STUCK_LOOP_ABORT_AT) {
      stuckLoopAbort = true;
      transcript.push({ step, note: `aborted after ${repeatCount} total identical failing ${parsed.tool} calls across the attempt (stuck loop, not a step-budget exhaustion)` });
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
