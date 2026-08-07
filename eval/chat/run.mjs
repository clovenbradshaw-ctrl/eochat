#!/usr/bin/env node
// CLI entry point for the Conversational Memory Capability Eval — the
// "normal NL chatting" counterpart to eval/run.mjs's Agentic Coding
// Capability Eval. Same discipline: every scenario's oracle is mechanical
// (string/structure checks against real production functions, never an
// LLM's own self-report), every run is recorded in full and folded into an
// append-only scoreboard, nothing is cherry-picked.
//
//   node eval/chat/run.mjs

import { writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, "scenarios");
const RESULTS_DIR = join(__dirname, "results");

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function discoverScenarios() {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".mjs")).sort();
  const mods = [];
  for (const f of files) {
    mods.push(await import(pathToFileURL(join(SCENARIOS_DIR, f)).href));
  }
  return mods;
}

function summaryLine(r) {
  const pass = r.overallPass ? "PASS" : "FAIL";
  const failed = r.checks.filter((c) => !c.pass);
  const failNote = failed.length ? ` — FAILED: ${failed.map((c) => c.name).join("; ")}` : "";
  return `- **${r.id}** — ${pass} (${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks)${failNote}`;
}

function updateScoreboard({ runId, results }) {
  const scoreboardPath = join(RESULTS_DIR, "scoreboard.md");
  const passCount = results.filter((r) => r.overallPass).length;

  const section = [
    `## ${runId}`,
    ``,
    `${passCount}/${results.length} scenarios passed (scripted, deterministic context-only run — see README.md for what this does and does not prove).`,
    ``,
    ...results.map(summaryLine),
    ``,
  ].join("\n");

  const header = `# Conversational Memory Capability — Eval Scoreboard\n\nEach run replays the same scripted multi-turn conversations through two REAL context-assembly pipelines from server/turn-controller.js and server/conversation-memory.js — a windowed-only baseline (what a plain chat completion passthrough gives you) and the holonic pipeline (windowing + the desk). Newest runs first.\n`;

  let existing = "";
  if (existsSync(scoreboardPath)) {
    const prior = readFileSync(scoreboardPath, "utf8");
    const bodyStart = prior.indexOf("\n## ");
    existing = bodyStart === -1 ? "" : prior.slice(bodyStart);
  }
  writeFileSync(scoreboardPath, `${header}\n${section}\n${existing}`);
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(join(RESULTS_DIR, "runs"), { recursive: true });

  const runId = `${nowStamp()}__scripted`;
  const jsonlPath = join(RESULTS_DIR, "runs", `${runId}.jsonl`);

  const scenarios = await discoverScenarios();
  console.log(`Conversational Memory Capability eval — scripted, deterministic run`);
  console.log(`Scenarios: ${scenarios.length}. Run id: ${runId}\n`);

  const results = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  running ${scenario.id} ... `);
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await scenario.run();
    } catch (err) {
      outcome = { checks: [{ name: "scenario ran without throwing", pass: false, message: err.stack }] };
    }
    const wallMs = Date.now() - t0;
    const overallPass = outcome.checks.length > 0 && outcome.checks.every((c) => c.pass);
    const result = { id: scenario.id, title: scenario.title, runId, wallMs, overallPass, checks: outcome.checks };
    console.log(`${overallPass ? "PASS" : "FAIL"} (${outcome.checks.filter((c) => c.pass).length}/${outcome.checks.length})`);
    for (const c of outcome.checks) {
      if (!c.pass) console.log(`      FAIL: ${c.name}${c.message ? ` — ${c.message}` : ""}`);
    }
    results.push(result);
    appendFileSync(jsonlPath, JSON.stringify(result) + "\n");
  }

  const passCount = results.filter((r) => r.overallPass).length;
  console.log(`\n${passCount}/${results.length} scenarios passed. Results: ${jsonlPath}`);

  updateScoreboard({ runId, results });
  process.exit(passCount === results.length ? 0 : 1);
}

main();
