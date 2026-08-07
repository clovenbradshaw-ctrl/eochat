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

import { createTaskLog, append, projectTasks, foldToWorkingSet, ENTRY_KINDS, STRUCTURE_OPERATORS, OPERATOR_BASIS } from "../../server/task-log.js";
import { runReactLoop } from "./react-loop.mjs";
import { extractJSONObject } from "./lib/parse-action.mjs";

const DEFAULT_MAX_DEPTH = 1; // the top task may split exactly once; sub-tasks always run directly — bounded recursion for this eval's scope, not a claim the mechanism itself is depth-limited

async function planOrDirect(adapter, taskPrompt, seed) {
  const prompt = `You are a technical lead deciding how to approach a coding task.

TASK: ${taskPrompt}

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

/**
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.taskPrompt
 * @param {object} opts.adapter
 * @param {{tools:object, toolCalls:array}} opts.toolset
 * @param {(prompt:string) => Promise<string|null>} [opts.surf]  surf+fold research callback
 * @param {number} [opts.maxSteps]  react-loop step cap per leaf task
 * @param {number} [opts.depth]
 * @param {number} [opts.maxDepth]
 * @param {import("../../server/task-log.js").TaskLog} [opts.log]
 */
export async function runHolonicCodingTask({
  taskId = "root", taskPrompt, adapter, toolset, surf = null,
  maxSteps = 8, maxTokensPerStep = 200, seed = 0, depth = 0, maxDepth = DEFAULT_MAX_DEPTH,
  log = createTaskLog(),
}) {
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: taskId, description: taskPrompt, depends_on: depth > 0 ? [taskId.split("/").slice(0, -1).join("/")] : [] });

  const groundingBlock = surf ? await surf(taskPrompt) : null;

  const plan = depth < maxDepth ? await planOrDirect(adapter, taskPrompt, seed + 9000) : { decompose: false };

  if (!plan.decompose) {
    const result = await runReactLoop({ taskPrompt, groundingBlock, toolset, adapter, maxSteps, maxTokensPerStep, seed });
    log = append(log, {
      kind: ENTRY_KINDS.RESULT, task_id: taskId, depends_on: [],
      result: { finished: result.finished, summary: result.summary, stepsRun: result.stepsRun, hitStepCap: result.hitStepCap },
    });
    return { log, leafResults: [{ taskId, ...result }], finished: result.finished, summary: result.summary, decomposed: false };
  }

  const leafResults = [];
  let allFinished = true;
  for (const [i, sub] of plan.subtasks.entries()) {
    const subId = `${taskId}/${sub.id || `sub${i}`}`;
    log = append(log, {
      kind: ENTRY_KINDS.PROPOSE, task_id: subId, description: sub.description, depends_on: [taskId],
      operator: STRUCTURE_OPERATORS.SEG, operator_basis: OPERATOR_BASIS.PRODUCED,
    });
    const subRun = await runHolonicCodingTask({
      taskId: subId, taskPrompt: sub.description, adapter, toolset, surf,
      maxSteps, maxTokensPerStep, seed: seed + (i + 1) * 1000, depth: depth + 1, maxDepth, log,
    });
    log = subRun.log;
    leafResults.push(...subRun.leafResults);
    allFinished = allFinished && subRun.finished;
  }

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
