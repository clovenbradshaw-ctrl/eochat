#!/usr/bin/env node
// Runs the SAME 3 critical-thinking probes, over the SAME folded context,
// through the SAME judge/rubric as run-milkshake-reasoning.mjs's flat
// fold+hosted pipeline — but via eval/agent/holon-reasoning.mjs's
// SEG-per-candidate / checkpointed-EVA / SYN pipeline instead of one
// collapsed generation. Directly comparable to the 7/9 (78%) flat baseline
// recorded in eval/chat/results/live/milkshake-reasoning-scoreboard.md.
//
// Usage:
//   ANTHROPIC_API_KEY=... node eval/chat/live/run-milkshake-holonic-reasoning.mjs \
//     --claude-model claude-haiku-4-5 --judge-model claude-haiku-4-5

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { replay, holonicContext } from "../pipelines.mjs";
import { REASONING_PROBES } from "./milkshake-reasoning.mjs";
import { createClaudeAdapter } from "../../adapters/claude-adapter.mjs";
import { runHolonicReasoningTask } from "../../agent/holon-reasoning.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "results", "live");
const TRANSCRIPT_PATH = join(__dirname, "transcripts", "milkshake.transcript.json");

function parseArgs(argv) {
  const args = { claudeModel: "claude-haiku-4-5", judgeModel: "claude-haiku-4-5" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claude-model") args.claudeModel = argv[++i];
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--key-file") args.keyFile = argv[++i];
  }
  return args;
}

function resolveApiKey(args) {
  if (args.keyFile) return readFileSync(args.keyFile, "utf8").trim();
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  throw new Error("No API key: pass --key-file <path> or set ANTHROPIC_API_KEY");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Same judge/rubric shape as run-milkshake-reasoning.mjs, duplicated only because it's a small, self-contained grading call — not worth an extra shared-module indirection for one function. */
async function judge(judgeAdapter, { question, answer, groundTruthExcerpts, rubric }) {
  const prompt = `You are grading whether an AI assistant's answer to a troubleshooting question correctly synthesizes information from an earlier real conversation. Be skeptical — do not give credit for vague, generic, or hedged statements that merely sound plausible.

QUESTION ASKED:
${question}

CANDIDATE ANSWER TO GRADE:
${answer || "(empty — the pipeline produced no visible text)"}

GROUND TRUTH — verbatim excerpts from earlier in the SAME real conversation, which the candidate answer must be consistent with (the candidate did not necessarily see these exact excerpts, but its claims must not contradict them):
${groundTruthExcerpts.map((e, i) => `[Excerpt ${i + 1}]\n${e}`).join("\n\n")}

RUBRIC — score each item true or false:
${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"items": [{"index": 1, "met": true, "note": "one short sentence"}, ...], "overallSound": true, "overallNote": "one short sentence"}`;

  const result = await judgeAdapter.generate([{ role: "user", content: prompt }], { maxTokens: 600 });
  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { parseError: true, raw: result.text };
  try { return JSON.parse(jsonMatch[0]); } catch { return { parseError: true, raw: result.text }; }
}

function excerptsForTurns(script, turnIndices) {
  return turnIndices.map((i) => `Q: ${script[i].question}\nA: ${script[i].answer}`);
}

function scoreFromVerdict(verdict) {
  if (!verdict || verdict.parseError || !Array.isArray(verdict.items)) return null;
  const met = verdict.items.filter((it) => it.met).length;
  return { met, total: verdict.items.length, overallSound: !!verdict.overallSound };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(TRANSCRIPT_PATH)) throw new Error(`No transcript at ${TRANSCRIPT_PATH} — run build-transcript.mjs first.`);
  const apiKey = resolveApiKey(args);
  const claudeAdapter = createClaudeAdapter({ model: args.claudeModel, apiKey });
  const judgeAdapter = args.judgeModel === args.claudeModel ? claudeAdapter : createClaudeAdapter({ model: args.judgeModel, apiKey });

  const { script } = JSON.parse(readFileSync(TRANSCRIPT_PATH, "utf8"));
  const { holonicConv, memory } = replay(script);
  const holonicMsgs = holonicContext(holonicConv, memory);

  console.log(`Holonic-reasoning comparison — ${REASONING_PROBES.length} probes, folded context: ${holonicMsgs.map((m) => m.content).join("\n").length} chars.\n`);

  const probeResults = [];
  for (const p of REASONING_PROBES) {
    console.log(`--- ${p.id} ---`);
    console.log(`  "${p.probe}"`);
    const groundTruthExcerpts = excerptsForTurns(script, p.requiresGroundTurns);

    const run = await runHolonicReasoningTask({ taskId: p.id, question: p.probe, adapter: claudeAdapter, groundingMessages: holonicMsgs });
    console.log(`  decomposed: ${run.decomposed} into ${run.candidates.length} candidate(s)${run.tiebreak ? " — TIEBREAK TRIGGERED" : ""}`);
    for (const c of run.candidates) console.log(`    [${c.verdict}/${c.confidence}] ${c.claim}`);
    if (run.tiebreak) console.log(`    tiebreak -> primary: ${run.tiebreak.primary}`);
    if (run.cubeCheck?.length) console.log(`    cube-progression flags: ${JSON.stringify(run.cubeCheck)}`);

    const verdict = await judge(judgeAdapter, { question: p.probe, answer: run.text, groundTruthExcerpts, rubric: p.rubric });
    const score = scoreFromVerdict(verdict);
    console.log(`  holonic: ${score ? `${score.met}/${score.total} rubric items, sound=${score.overallSound}` : "JUDGE PARSE FAILED"}`);
    console.log();

    probeResults.push({ id: p.id, probe: p.probe, text: run.text, decomposed: run.decomposed, candidates: run.candidates, tiebreak: run.tiebreak, cubeCheck: run.cubeCheck, verdict, score });
  }

  const total = probeResults.reduce((a, r) => a + (r.score?.total ?? 0), 0);
  const met = probeResults.reduce((a, r) => a + (r.score?.met ?? 0), 0);
  const sound = probeResults.filter((r) => r.score?.overallSound).length;

  console.log("=== Summary ===");
  console.log(`holonic: ${met}/${total} rubric items met (${total ? ((met / total) * 100).toFixed(0) : "?"}%), ${sound}/${probeResults.length} probes judged overall-sound`);
  console.log(`(flat fold+hosted baseline: 7/9, 78%, 2/3 sound — see milkshake-reasoning-scoreboard.md)`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `${nowStamp()}__milkshake-holonic-reasoning__${args.claudeModel}`;
  const outPath = join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(outPath, JSON.stringify({ runId, claudeModel: args.claudeModel, judgeModel: args.judgeModel, probeResults }, null, 2));
  console.log(`\nResults: ${outPath}`);

  const scoreboardPath = join(RESULTS_DIR, "milkshake-reasoning-scoreboard.md");
  const section = [
    `## ${runId} (holonic — eval/agent/holon-reasoning.mjs)`,
    ``,
    `| pipeline | rubric items met | probes overall-sound |`,
    `|---|---|---|`,
    `| holonic (SEG-per-candidate, ${args.claudeModel}) | ${met}/${total} (${total ? ((met / total) * 100).toFixed(0) : "?"}%) | ${sound}/${probeResults.length} |`,
    `| flat fold+hosted baseline (same model, prior run) | 7/9 (78%) | 2/3 |`,
    ``,
    ...probeResults.map((r) => `- **${r.id}**: decomposed into ${r.candidates.length} candidate(s)${r.tiebreak ? `, tiebreak resolved to "${r.tiebreak.primary}"` : ""} — ${r.score ? `${r.score.met}/${r.score.total} rubric items` : "judge parse error"}`),
    ``,
  ].join("\n");
  const header = `# Milkshake-Machine-Repair — Critical-Thinking / Synthesis Comparison\n\nHarder counterpart to milkshake-scoreboard.md: not single-fact recall, but multi-fact synthesis and diagnostic reasoning, graded by an LLM judge against real ground-truth excerpts. Newest runs first.\n`;
  let existing = "";
  if (existsSync(scoreboardPath)) {
    const prior = readFileSync(scoreboardPath, "utf8");
    const bodyStart = prior.indexOf("\n## ");
    existing = bodyStart === -1 ? "" : prior.slice(bodyStart);
  }
  writeFileSync(scoreboardPath, `${header}\n${section}\n${existing}`);
  console.log(`Scoreboard: ${scoreboardPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
