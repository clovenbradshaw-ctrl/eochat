// The actual read-execute-observe-correct loop (Agentic Coding Capability
// Test Spec, Level 2+): the model chooses one tool call per turn, the tool
// actually runs against the sandbox, the real result is appended as an
// observation, and the loop repeats until the model calls finish() or a
// step cap is hit. No hidden retry-until-green on the harness's part — if
// the model never runs its own code, that is a real, measured failure this
// loop must surface, not paper over.

import { parseAction } from "./lib/parse-action.mjs";

const PROTOCOL = (toolDescriptions) => `You are an autonomous coding agent working in a real sandbox directory. You have exactly these tools:

${toolDescriptions.map((d) => `- ${d}`).join("\n")}

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
    transcript.push({ step, tool: parsed.tool, args: parsed.args, result });
    messages.push({ role: "user", content: formatObservation(parsed.tool, result) });
  }

  return {
    finished,
    summary,
    steps: step + (finished || transcript.at(-1)?.note ? 1 : 0),
    stepsRun: transcript.length,
    hitStepCap: !finished && step >= maxSteps,
    transcript,
    toolCalls: [...toolCalls],
    messages,
  };
}
