// Runs one agentic-level task end to end: fresh sandbox -> (optional) seed
// files -> the recursive holonic coding loop (all planning AND all coding
// done by the adapter's model, never by this harness) -> the independently-
// authored oracle -> a scored, metric-annotated result.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runHolonicCodingTask } from "./agent/holon-coder.mjs";
import { createTools } from "./agent/tools.mjs";
import { resolveAndCloneRepo, ingestCodebase, createSurf } from "./agent/ingest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_ROOT = join(__dirname, ".sandbox");

function loadTask(taskDir) {
  const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
  return { ...task, dir: taskDir };
}

function seedSandbox(sandboxDir, task) {
  mkdirSync(sandboxDir, { recursive: true });
  // Without this, Node resolves module type from the nearest ANCESTOR
  // package.json — which is eochat's own ("type": "module") since the
  // sandbox lives under eval/.sandbox/ — so a plain require()-based script
  // the agent writes would fail with no visible connection to anything it
  // did wrong. Pinning "commonjs" here, once, makes the sandbox behave like
  // an ordinary fresh directory, not a corner of this specific host repo.
  writeFileSync(join(sandboxDir, "package.json"), JSON.stringify({ name: "sandbox", type: "commonjs" }, null, 2));
  if (task.seedDir) {
    const src = join(task.dir, task.seedDir);
    if (existsSync(src)) cpSync(src, sandboxDir, { recursive: true });
  }
}

const CLAIMS_SUCCESS = /\b(pass|passed|success|works|verified|complete|done|fixed)\b/i;

/**
 * Level 3+ tasks declare `task.repo` (a "owner/repo" GitHub shorthand or a
 * local directory) instead of, or alongside, `seedDir`: the sandbox holds
 * only the files the agent is meant to actually edit (seedDir, as before —
 * small, deliberately bounded), while the REST of the real codebase — too
 * big to hand a CPU-bound local model directly, which is the entire reason
 * `surf` exists — is cloned once and admitted into a dedicated ingest pool,
 * exposing a bounded `surf(query)` research callback. `task.ingestSubdir`
 * narrows ingestion to a real subtree when the whole repo is more than the
 * task needs. Honest, not silent: the caller gets back exactly how many
 * files were found vs. actually ingested.
 */
function ingestRepoForTask(task, runId) {
  if (!task.repo) return { surf: null, ingest: null };
  const ingestDir = join(SANDBOX_ROOT, runId, `${task.id}__ingest-src`);
  const { dir } = resolveAndCloneRepo(task.repo, ingestDir);
  const rootDir = task.ingestSubdir ? join(dir, task.ingestSubdir) : dir;
  const poolName = `eval-${runId}-${task.id}`;
  const ingest = ingestCodebase(rootDir, poolName);
  const surf = createSurf(poolName, { budget: task.surfBudget ?? 1200, maxUnits: task.surfMaxUnits ?? 6 });
  return { surf, ingest };
}

/** @param {object} opts.adapter  the local-model adapter — the ONLY thing that plans or writes code */
export async function runLevelTask(taskDir, { adapter, runId, maxDepth = 1, surf: surfOverride = null } = {}) {
  const task = loadTask(taskDir);
  const sandboxDir = join(SANDBOX_ROOT, runId, task.id);
  rmSync(sandboxDir, { recursive: true, force: true });
  seedSandbox(sandboxDir, task);

  const { surf: repoSurf, ingest } = surfOverride ? { surf: surfOverride, ingest: null } : ingestRepoForTask(task, runId);
  const surf = surfOverride ?? repoSurf;

  const toolset = createTools(sandboxDir);
  const t0 = Date.now();
  const run = await runHolonicCodingTask({
    taskId: task.id, taskPrompt: task.taskPrompt, adapter, toolset, surf,
    maxSteps: task.maxSteps ?? 8, maxTokensPerStep: task.maxTokensPerStep ?? 300,
    seed: task.seed ?? 0, maxDepth: task.maxDepth ?? maxDepth,
  });
  const wallMs = Date.now() - t0;

  const testMod = await import(pathToFileURL(join(taskDir, "test.mjs")).href);
  const oracle = await testMod.evaluate(sandboxDir);
  const overallPass = oracle.checks.length > 0 && oracle.checks.every((c) => c.pass);

  const toolCalls = run.leafResults.flatMap((r) => r.toolCalls ?? []);
  const shellCalls = toolCalls.filter((t) => t.name === "run_shell");
  const filesWritten = [...new Set(toolCalls.filter((t) => t.name === "write_file").map((t) => t.args.path))];
  const claimsSuccess = CLAIMS_SUCCESS.test(run.summary ?? "");
  const selfReportMismatch = claimsSuccess && !overallPass;

  return {
    taskId: task.id,
    level: task.level,
    title: task.title,
    model: adapter.id,
    runId,
    wallMs,
    finished: run.finished,
    decomposed: run.decomposed,
    retried: run.retried,
    retryConsidered: run.retryConsidered,
    retryDeclined: run.retryDeclined,
    overallPass,
    oracleChecks: oracle.checks,
    agentSummary: run.summary,
    ingest: ingest ? { pool: ingest.pool, filesIngested: ingest.filesIngested, filesFound: ingest.filesFound, hitFileCap: ingest.hitFileCap } : undefined,
    metrics: {
      iterationsToGreen: shellCalls.length,
      totalToolCalls: toolCalls.length,
      toolCallCounts: countBy(toolCalls.map((t) => t.name)),
      filesWritten,
      hitStepCapAnyLeaf: run.leafResults.some((r) => r.hitStepCap),
      selfReportMismatch,
    },
    logEntryCount: run.log.entries.length,
  };
}

function countBy(arr) {
  const out = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}

export function discoverLevelTasks(levelsDir) {
  return readdirSync(levelsDir)
    .filter((d) => statSync(join(levelsDir, d)).isDirectory())
    .map((d) => join(levelsDir, d))
    .filter((d) => existsSync(join(d, "task.json")))
    .sort();
}
