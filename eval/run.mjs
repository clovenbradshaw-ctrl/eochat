#!/usr/bin/env node
// CLI entry point for the Agentic Coding Capability eval.
//
//   node eval/run.mjs --model qwen2.5-coder:7b            # real run
//   node eval/run.mjs --dry-run                            # harness smoke test, no model, no network
//   node eval/run.mjs --model qwen2.5-coder:7b --level 1   # just Level 1 tasks
//
// Every run is recorded to eval/results/runs/<timestamp>__<label>.jsonl and
// folded into eval/results/scoreboard.md — never just printed and lost.

import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runLevelTask, discoverLevelTasks } from "./harness.mjs";
import { createOllamaAdapter } from "./adapters/ollama-adapter.mjs";
import { createScriptedAdapter } from "./adapters/scripted-adapter.mjs";
import { DRY_RUN_SCRIPTS } from "./dry-run-scripts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVELS_DIR = join(__dirname, "levels");
const RESULTS_DIR = join(__dirname, "results");

function parseArgs(argv) {
  const args = { model: null, dryRun: false, levels: null, out: RESULTS_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--level") args.levels = argv[++i].split(",").map((s) => Number(s.trim()));
  }
  return args;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function summaryLine(r) {
  const pass = r.overallPass ? "PASS" : "FAIL";
  return `- **${r.taskId}** (Level ${r.level}) — ${pass} — finished:${r.finished} decomposed:${r.decomposed} iterationsToGreen:${r.metrics.iterationsToGreen} tools:${r.metrics.totalToolCalls} wall:${(r.wallMs / 1000).toFixed(1)}s${r.metrics.selfReportMismatch ? " **[SELF-REPORT MISMATCH: claimed success but oracle disagrees]**" : ""}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.model) {
    console.error("Usage: node eval/run.mjs --model <ollama-model> [--level 1,2]  |  node eval/run.mjs --dry-run");
    process.exit(1);
  }

  const label = args.dryRun ? "dry-run" : args.model.replace(/[^\w.-]/g, "_");
  const runId = `${nowStamp()}__${label}`;
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(join(RESULTS_DIR, "runs"), { recursive: true });
  const jsonlPath = join(RESULTS_DIR, "runs", `${runId}.jsonl`);

  let taskDirs = discoverLevelTasks(LEVELS_DIR);
  if (args.levels) {
    taskDirs = taskDirs.filter((d) => {
      const task = JSON.parse(readFileSync(join(d, "task.json"), "utf8"));
      return args.levels.includes(task.level);
    });
  }

  console.log(`Agentic Coding Capability eval — ${args.dryRun ? "DRY RUN (no model, harness smoke test only)" : `model: ${args.model}`}`);
  console.log(`Tasks: ${taskDirs.length}. Run id: ${runId}\n`);

  const results = [];
  for (const taskDir of taskDirs) {
    const taskId = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")).id;
    const adapter = args.dryRun
      ? createScriptedAdapter(DRY_RUN_SCRIPTS[taskId] ?? (() => { throw new Error(`no dry-run script for ${taskId}`); })())
      : createOllamaAdapter({ model: args.model });

    process.stdout.write(`  running ${taskId} ... `);
    const t0 = Date.now();
    let result;
    try {
      result = await runLevelTask(taskDir, { adapter, runId });
    } catch (err) {
      result = {
        taskId, level: JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")).level,
        model: adapter.id, runId, overallPass: false, finished: false, decomposed: false,
        oracleChecks: [], agentSummary: null, wallMs: Date.now() - t0,
        metrics: { iterationsToGreen: 0, totalToolCalls: 0, toolCallCounts: {}, filesWritten: [], hitStepCapAnyLeaf: false, selfReportMismatch: false },
        error: err.message,
      };
    }
    console.log(`${result.overallPass ? "PASS" : "FAIL"} (${(result.wallMs / 1000).toFixed(1)}s)`);
    results.push(result);
    appendFileSync(jsonlPath, JSON.stringify(result) + "\n");
  }

  const passCount = results.filter((r) => r.overallPass).length;
  console.log(`\n${passCount}/${results.length} passed. Results: ${jsonlPath}`);

  updateScoreboard({ runId, model: args.dryRun ? "(dry-run, no model)" : args.model, results });
}

function updateScoreboard({ runId, model, results }) {
  const scoreboardPath = join(RESULTS_DIR, "scoreboard.md");
  const passCount = results.filter((r) => r.overallPass).length;
  const byLevel = {};
  for (const r of results) (byLevel[r.level] ??= []).push(r);

  const section = [
    `## ${runId}`,
    ``,
    `Model: \`${model}\` — ${passCount}/${results.length} tasks passed.`,
    ``,
    ...Object.keys(byLevel).sort().flatMap((lvl) => [
      `### Level ${lvl}`,
      ...byLevel[lvl].map(summaryLine),
      ``,
    ]),
  ].join("\n");

  const header = `# Agentic Coding Capability — Eval Scoreboard\n\nEach run is a local CPU model attempting the Level 1-7 task ladder (see eval/README.md). All planning and all coding is done by the model under test via the tool loop in eval/agent/ — the harness only sandboxes, seeds, scores, and records. Newest runs first.\n`;

  let existing = "";
  if (existsSync(scoreboardPath)) {
    existing = readFileSync(scoreboardPath, "utf8");
    const bodyStart = existing.indexOf("\n## ");
    existing = bodyStart === -1 ? "" : existing.slice(bodyStart);
  }
  writeFileSync(scoreboardPath, `${header}\n${section}\n${existing}`);
}

main();
