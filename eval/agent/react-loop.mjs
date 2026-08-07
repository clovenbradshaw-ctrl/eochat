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
 */
export async function runReactLoop({
  taskPrompt, groundingBlock = null, toolset, adapter, maxSteps = 8, maxTokensPerStep = 200, seed = 0,
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
  let repeatFailStreak = 0;
  let lastFailedCallKey = null;
  let stuckLoopAbort = false;

  for (; step < maxSteps; step++) {
    const raw = await adapter.generate(messages, { maxTokens: maxTokensPerStep, seed: seed + step });
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
    repeatFailStreak = isFailure && callKey === lastFailedCallKey ? repeatFailStreak + 1 : isFailure ? 1 : 0;
    lastFailedCallKey = isFailure ? callKey : null;

    transcript.push({ step, tool: parsed.tool, args: parsed.args, result, repeatFailStreak: repeatFailStreak || undefined });

    let observation = formatObservation(parsed.tool, result);
    if (repeatFailStreak >= STUCK_LOOP_NUDGE_AT) {
      observation += `\n\nSTUCK LOOP: this is the ${repeatFailStreak}${repeatFailStreak === 2 ? "nd" : repeatFailStreak === 3 ? "rd" : "th"} time in a row you have called ${parsed.tool} with the EXACT SAME arguments, and it has failed the SAME way every time. Repeating it again will fail again. Stop: re-read the OBSERVATION above (or call read_file again) and base your next argument on what it actually says, not on what you expect it to say.`;
    }
    messages.push({ role: "user", content: observation });

    if (repeatFailStreak >= STUCK_LOOP_ABORT_AT) {
      stuckLoopAbort = true;
      transcript.push({ step, note: `aborted after ${repeatFailStreak} consecutive identical failing ${parsed.tool} calls (stuck loop, not a step-budget exhaustion)` });
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
