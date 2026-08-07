// The recursive holonic coding wrapper — the "recursive holonic tasks" half
// of the redirect. Reuses task-log.js's real append-only spine (the same one
// code-longform.js/narrative-longform.js/holonic-task.js already share)
// rather than a bespoke tree: a task is PROPOSEd, optionally SEG'd into
// independent sub-tasks (the log records the rule that fired, per
// task-log.js's own OPERATOR_BASIS.PRODUCED discipline — this is not a label
// applied after the fact), each sub-task recurses through the same function,
// and results fold back up via projectTasks/foldToWorkingSet.
//
// The "surf and fold" half lives in the optional `surf` callback: before a
// (sub)task is executed, its research is surfaced (searched) and folded to a
// bounded budget — see ingest.mjs for the real corpus-backed implementation
// used at Level 3+. Level 1-2 tasks run in a fresh scratch directory with
// nothing to surf yet, and `surf: null` is the honest way to say that,
// never a silently-empty search result dressed up as "nothing found."
//
// BIDIRECTIONAL NESTING (the mereotopological half). task-log.js's own
// deriveLevels() and eoreader6's holon_level/index.js both name a level
// relation as TWO independent tests, not one: existence-dependency (remove
// the low and the high's ground moves — the low sets what the high can even
// be) and possibility-constraint (the high's synthesis sits measurably apart
// from — biases — what the low does). Before this file only implemented the
// first direction, one-shot: a plan was guessed BEFORE any leaf ever ran,
// and a leaf's own real outcome never fed back into what the parent believed
// was possible. That is a tree with an arrow pointing one way, not a holon.
//
//   low -> high, sets POSSIBILITY: when a direct attempt does not converge,
//   its own concrete evidence (the actual last tool observation, not a
//   guess) is what the parent is ALLOWED to replan from — see
//   distillEvidence/planOrDirect's `evidence` argument below. A parent may
//   only reach for a different decomposition once the low level has
//   produced a real prediction-error signal to replan against.
//
//   high -> low, sets PROBABILITY: when a task does decompose (eagerly or
//   because a direct attempt's evidence earned a retry), each sub-task is
//   handed a bounded `priorHint` — the parent's goal and how this piece fits
//   among its siblings. This never changes what a leaf CAN do (the tool set,
//   the sandbox are unchanged) — it only biases, precision-weights, which of
//   the possible actions the leaf is likely to try first. It is prose
//   context, not injected code, and it is folded to a small declared budget
//   (MAX_HANDOFF_CHARS) exactly like foldToWorkingSet folds tasks and
//   engineGroundQuery folds passages — "never prompt the model with more
//   than it needs" applies to cross-level handoff too, not only to surf.

import { createTaskLog, append, projectTasks, foldToWorkingSet, ENTRY_KINDS, STRUCTURE_OPERATORS, OPERATOR_BASIS } from "../../server/task-log.js";
import { runReactLoop } from "./react-loop.mjs";
import { extractJSONObject } from "./lib/parse-action.mjs";

const DEFAULT_MAX_DEPTH = 1; // the top task may split exactly once — eagerly (a guessed-up-front decomposition) or reactively (an evidence-informed retry after a failed direct attempt) — never both; sub-tasks always run directly. Bounded recursion for this eval's scope, not a claim the mechanism itself is depth-limited.

// The declared budget for anything handed ACROSS a holon boundary that is
// not the task's own surfaced research (which folds itself, per ingest.mjs):
// a bounded top-down prior, or a bounded bottom-up failure digest. Small on
// purpose — a CPU-bound 7B model's context is the scarce resource this whole
// eval is about, and a handoff that is not bounded is just a second surf
// mechanism nobody declared.
const MAX_HANDOFF_CHARS = 280;

function foldHandoff(text, label) {
  if (!text) return null;
  const s = String(text);
  if (s.length <= MAX_HANDOFF_CHARS) return s;
  const withheld = s.length - MAX_HANDOFF_CHARS;
  return `${s.slice(0, MAX_HANDOFF_CHARS)}… (${withheld} more char(s) of ${label} withheld — folded to the ${MAX_HANDOFF_CHARS}-char handoff budget, not silently grown)`;
}

// Bottom-up: what did the low level actually observe? The real last tool
// result (a real shell exit code, a real error string) is the only honest
// source for this — never a summary invented from what "probably" happened.
function distillEvidence(result) {
  const last = [...result.transcript].reverse().find((t) => t.tool && t.tool !== "finish" && t.result);
  if (result.stuckLoopAbort) {
    const repeatInfo = last?.repeatFailStreak ? ` (identical arguments, ${last.repeatFailStreak} times in a row)` : "";
    return last
      ? `stopped itself in a repeated-failure loop, not a step-budget exhaustion: the last ${last.tool} call kept failing the same way${repeatInfo} — real evidence: ${last.result.error ?? JSON.stringify(last.result)}`
      : "stopped itself in a repeated-failure loop before any tool call produced a usable result";
  }
  if (!last) {
    return result.hitStepCap
      ? "ran out of steps without ever completing a tool call that produced an observable result"
      : null;
  }
  const r = last.result;
  const body = r.error ?? r.output ?? JSON.stringify(r);
  return `last observed evidence from a real ${last.tool} call: ${body}`;
}

async function planOrDirect(adapter, taskPrompt, seed, evidence = null) {
  const evidenceBlock = evidence
    ? `\n\nA prior direct attempt at this exact task did not converge. This is REAL evidence of what actually happened, not a guess — use it to decide whether a different decomposition would help:\n${evidence}\n`
    : "";
  const prompt = `You are a technical lead deciding how to approach a coding task.

TASK: ${taskPrompt}${evidenceBlock}

If this task is small enough to do directly in one focused work session, respond exactly:
{"decompose": false}

If it genuinely needs to be split into 2-4 INDEPENDENT sub-tasks first, respond:
{"decompose": true, "subtasks": [{"id": "short-id", "description": "..."}]}

Respond with ONLY the JSON object, nothing else.`;
  const raw = await adapter.generate(
    [{ role: "system", content: "Respond with only a single JSON object, nothing else." }, { role: "user", content: prompt }],
    { maxTokens: 220, seed },
  );
  const parsed = extractJSONObject(raw);
  if (!parsed || typeof parsed !== "object" || !("decompose" in parsed)) {
    return { decompose: false, planGap: "planning response was not parseable JSON — defaulting to direct execution rather than guessing a split" };
  }
  if (parsed.decompose === true && Array.isArray(parsed.subtasks) && parsed.subtasks.length >= 2) {
    const subtasks = parsed.subtasks.filter((s) => s && typeof s.description === "string").slice(0, 4);
    if (subtasks.length >= 2) return { decompose: true, subtasks };
  }
  return { decompose: false };
}

/** Run a set of already-decided sub-tasks, each handed a bounded top-down
 * prior (the parent's goal + its sibling's piece +, on a retry, the
 * bottom-up evidence that earned the retry), and fold their results back up.
 * Shared by the eager-decompose path and the evidence-triggered retry path
 * so both get the same top-down handoff discipline. */
async function runSubtasksAndFold({
  parentTaskId, subtasks, taskPromptForContext, evidenceDigest = null,
  adapter, toolset, surf, maxSteps, maxTokensPerStep, seed, depth, maxDepth, log,
}) {
  const goal = foldHandoff(taskPromptForContext, "parent task");
  const leafResults = [];
  let allFinished = true;

  for (const [i, sub] of subtasks.entries()) {
    const subId = `${parentTaskId}/${sub.id || `sub${i}`}`;
    log = append(log, {
      kind: ENTRY_KINDS.PROPOSE, task_id: subId, description: sub.description, depends_on: [parentTaskId],
      operator: STRUCTURE_OPERATORS.SEG, operator_basis: OPERATOR_BASIS.PRODUCED,
    });

    const priorParts = [
      `Context from the parent task (this is here to bias, not replace, your own judgment): "${goal}". Your piece is one of ${subtasks.length}: "${sub.description}".`,
    ];
    if (evidenceDigest) priorParts.push(`A prior direct attempt at the whole task did not converge — what was actually observed: ${evidenceDigest}`);
    const priorHint = foldHandoff(priorParts.join(" "), "top-down prior");

    const subRun = await runHolonicCodingTask({
      taskId: subId, taskPrompt: sub.description, adapter, toolset, surf, priorHint,
      maxSteps, maxTokensPerStep, seed: seed + (i + 1) * 1000, depth: depth + 1, maxDepth, log,
    });
    log = subRun.log;
    leafResults.push(...subRun.leafResults);
    allFinished = allFinished && subRun.finished;
  }

  return { log, leafResults, allFinished };
}

/**
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.taskPrompt
 * @param {object} opts.adapter
 * @param {{tools:object, toolCalls:array}} opts.toolset
 * @param {(prompt:string) => Promise<string|null>} [opts.surf]  surf+fold research callback
 * @param {string|null} [opts.priorHint]  bounded top-down context from a parent holon (see runSubtasksAndFold) — the "high sets the probability of the low" half
 * @param {number} [opts.maxSteps]  react-loop step cap per leaf task
 * @param {number} [opts.depth]
 * @param {number} [opts.maxDepth]
 * @param {import("../../server/task-log.js").TaskLog} [opts.log]
 */
export async function runHolonicCodingTask({
  taskId = "root", taskPrompt, adapter, toolset, surf = null, priorHint = null,
  maxSteps = 8, maxTokensPerStep = 200, seed = 0, depth = 0, maxDepth = DEFAULT_MAX_DEPTH,
  log = createTaskLog(),
}) {
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: taskId, description: taskPrompt, depends_on: depth > 0 ? [taskId.split("/").slice(0, -1).join("/")] : [] });

  const surfBlock = surf ? await surf(taskPrompt) : null;
  const groundingBlock = [priorHint, surfBlock].filter(Boolean).join("\n\n") || null;

  const plan = depth < maxDepth ? await planOrDirect(adapter, taskPrompt, seed + 9000) : { decompose: false };

  if (!plan.decompose) {
    const result = await runReactLoop({ taskPrompt, groundingBlock, toolset, adapter, maxSteps, maxTokensPerStep, seed });
    log = append(log, {
      kind: ENTRY_KINDS.RESULT, task_id: taskId, depends_on: [],
      result: { finished: result.finished, summary: result.summary, stepsRun: result.stepsRun, hitStepCap: result.hitStepCap, stuckLoopAbort: result.stuckLoopAbort },
    });

    // Bottom-up: a direct attempt that did NOT converge produces real
    // evidence. That evidence — and only that evidence — is what earns the
    // parent the right to replan. No evidence, no retry: this is the
    // low setting the possibility of the high, not the high guessing twice.
    if (!result.finished && depth < maxDepth) {
      const evidenceDigest = foldHandoff(distillEvidence(result), "prior-attempt evidence");
      const replan = await planOrDirect(adapter, taskPrompt, seed + 9500, evidenceDigest ?? "(no tool was ever run — the model never produced observable evidence)");

      if (replan.decompose) {
        const retryTaskId = `${taskId}@retry`;
        log = append(log, {
          kind: ENTRY_KINDS.SUPERSEDE, task_id: retryTaskId, supersedes: taskId,
          description: taskPrompt, depends_on: [],
          operator: STRUCTURE_OPERATORS.SEG, operator_basis: OPERATOR_BASIS.PRODUCED,
          revised_because: evidenceDigest ?? "the direct attempt exhausted its step budget without ever producing observable evidence",
        });
        const retrySub = await runSubtasksAndFold({
          parentTaskId: retryTaskId, subtasks: replan.subtasks, taskPromptForContext: taskPrompt,
          evidenceDigest, adapter, toolset, surf, maxSteps, maxTokensPerStep, seed: seed + 5000, depth, maxDepth, log,
        });
        log = append(retrySub.log, {
          kind: ENTRY_KINDS.RESULT, task_id: retryTaskId, depends_on: [],
          result: { decomposed: true, subtaskCount: replan.subtasks.length, allFinished: retrySub.allFinished, retried: true },
        });
        return {
          log,
          leafResults: [{ taskId, ...result, supersededBy: retryTaskId }, ...retrySub.leafResults],
          finished: retrySub.allFinished,
          summary: `direct attempt did not converge (${result.summary ?? "no finish"}); retried as ${replan.subtasks.length} evidence-informed sub-task(s)`,
          decomposed: true,
          retried: true,
        };
      }
      // The replan considered the real evidence and still judged the task
      // undecomposable — an honest "no" is not a log-worthy structural act
      // (nothing was produced), so it is reported on the return value only.
      return {
        log, leafResults: [{ taskId, ...result }], finished: result.finished, summary: result.summary,
        decomposed: false, retryConsidered: true, retryDeclined: replan.planGap ?? "replanning judged the task undecomposable even with failure evidence",
      };
    }

    return { log, leafResults: [{ taskId, ...result }], finished: result.finished, summary: result.summary, decomposed: false };
  }

  const { log: foldedLog, leafResults, allFinished } = await runSubtasksAndFold({
    parentTaskId: taskId, subtasks: plan.subtasks, taskPromptForContext: taskPrompt,
    adapter, toolset, surf, maxSteps, maxTokensPerStep, seed, depth, maxDepth, log,
  });
  log = foldedLog;

  const tasks = projectTasks(log);
  const { working, withheld } = foldToWorkingSet(tasks, { k: 7 });
  const summary = `decomposed into ${plan.subtasks.length} sub-task(s): ` +
    leafResults.map((r) => `${r.taskId} ${r.finished ? "finished" : "NOT finished"}`).join("; ");
  log = append(log, {
    kind: ENTRY_KINDS.RESULT, task_id: taskId, depends_on: [],
    result: { decomposed: true, subtaskCount: plan.subtasks.length, allFinished },
  });

  return { log, leafResults, finished: allFinished, summary, decomposed: true, foldedWorkingSetSize: working.length, withheldFromFold: withheld };
}
