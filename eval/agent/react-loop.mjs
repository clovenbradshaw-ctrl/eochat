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
// oldest tokens once the conversation overflows it. At maxSteps up to 22
// and tool observations up to ~1000 tokens each (read_file's 4000-char
// cap), the unbounded array could exceed 4096 tokens well before the step
// cap — meaning the model could lose its own system prompt and task
// description to a silent context-shift mid-attempt, a plausible
// contributor to exactly the "re-reads the file and still repeats the same
// wrong guess" pattern the stuck-loop detector above exists to catch. Fixed
// by folding the same way every other budget here does — but folding by
// RECENCY ALONE is not the surf-and-fold discipline the rest of this
// harness uses; it is just truncation with a report attached. ingest.mjs's
// surf() SEARCHES the ingested pool for what bears on the current query,
// THEN folds to budget. The equivalent move here: score each older step by
// lexical overlap with what is happening right now (the freshest
// observation) — the same lexical-presence discipline ingest.mjs's real
// corpus search already uses — and keep the most RELEVANT older steps, not
// merely the most recent ones. This also composes naturally with the
// stuck-loop detector above: a step where the model is repeating the same
// failing call will, by construction, score its own past identical
// failures as maximally relevant, surfacing exactly the evidence it needs
// to stop repeating itself.

import { parseAction } from "./lib/parse-action.mjs";
import { significantTerms, overlapScore } from "./lib/lexical-relevance.mjs";

const STUCK_LOOP_NUDGE_AT = 2;   // the 2nd identical failing call gets an explicit "you are repeating yourself" notice
const STUCK_LOOP_ABORT_AT = 4;   // the 4th identical failing call ends the attempt rather than exhausting the step budget on a loop that has already shown it will not resolve itself
const MESSAGE_WINDOW_TURNS = 6;  // a declared starting point (foldToWorkingSet's k=7 is the same kind of number), not derived from the model's actual context size — this harness has no tokenizer to measure against

/**
 * SURF: score every older step-pair (assistant action + its observation)
 * by lexical overlap with the freshest observation. FOLD: keep the head
 * (system + task intro, never dropped), the latest step-pair (what the
 * model must react to right now, always kept), and the top-scoring older
 * pairs up to `windowTurns` total — reassembled in original chronological
 * order so the conversation still reads coherently, with an honest count
 * of what was withheld. Never silent, same as every other fold in this
 * harness.
 */
function surfAndFoldMessagesForModel(messages, windowTurns) {
  const head = messages.slice(0, 2); // system + task intro (with any groundingBlock)
  const turns = messages.slice(2);
  const maxKeptMessages = windowTurns * 2;
  if (turns.length <= maxKeptMessages) return messages;

  const latest = turns.slice(-2);
  const older = turns.slice(0, -2);
  const olderPairs = [];
  for (let i = 0; i < older.length; i += 2) olderPairs.push({ index: i, pair: older.slice(i, i + 2) });

  const focusTerms = significantTerms(latest.map((m) => m.content).join(" "));
  const scored = olderPairs.map(({ index, pair }) => ({
    index, pair, overlap: overlapScore(focusTerms, pair.map((m) => m.content).join(" ")),
  }));

  const pairBudget = Math.max(0, Math.floor(maxKeptMessages / 2) - 1); // minus the always-kept latest pair
  const kept = [...scored]
    .sort((a, b) => b.overlap - a.overlap || b.index - a.index) // most relevant first, ties broken by recency
    .slice(0, pairBudget)
    .sort((a, b) => a.index - b.index) // back to chronological order for the model
    .flatMap((s) => s.pair);

  const withheldCount = olderPairs.length - Math.min(olderPairs.length, pairBudget);
  const foldNote = {
    role: "user",
    content: `[${withheldCount} earlier message(s) from this session were folded out to keep the prompt bounded — kept by relevance to what you are looking at right now, not just recency, so a step relevant to your current situation stays visible even if it happened a while ago. They really happened and their real results still apply, they are just not repeated here.]`,
  };
  return [...head, foldNote, ...kept, ...latest];
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
 * @param {number} [opts.messageWindowTurns] how many step-pairs of conversation history are surfaced to the model per call — see surfAndFoldMessagesForModel
 */
export async function runReactLoop({
  taskPrompt, groundingBlock = null, toolset, adapter, maxSteps = 8, maxTokensPerStep = 200, seed = 0,
  messageWindowTurns = MESSAGE_WINDOW_TURNS,
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
    const raw = await adapter.generate(surfAndFoldMessagesForModel(messages, messageWindowTurns), { maxTokens: maxTokensPerStep, seed: seed + step });
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
