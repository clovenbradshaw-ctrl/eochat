#!/usr/bin/env node
// Critical-thinking counterpart to run-milkshake.mjs: instead of single-fact
// recall, asks each pipeline to SYNTHESIZE multiple session-specific facts
// with multiple pieces of domain knowledge established earlier in the same
// real conversation, and grades the result with an LLM judge against the
// real, verbatim ground-truth excerpts (never against a hardcoded guess).
//
// Pipelines tested (local-baseline windowed-only is skipped — run-milkshake.mjs
// already established it has no session memory at all, so testing synthesis
// on top of a pipeline that can't even recall the raw facts wouldn't isolate
// anything new):
//   adversary   — Claude, entire raw transcript, unbounded.
//   local+fold  — small local CPU model, windowed history + the desk.
//   fold+hosted — same folded context, fast hosted model.
//
// Usage:
//   ANTHROPIC_API_KEY=... node eval/chat/live/run-milkshake-reasoning.mjs \
//     --claude-model claude-haiku-4-5 --judge-model claude-haiku-4-5 --local-model qwen2.5:3b

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { replay, growingContext, holonicContext, contextText } from "../pipelines.mjs";
import { REASONING_PROBES } from "./milkshake-reasoning.mjs";
import { createClaudeAdapter } from "../../adapters/claude-adapter.mjs";
import { createOllamaChatAdapter } from "../../adapters/ollama-chat-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "results", "live");
const TRANSCRIPT_PATH = join(__dirname, "transcripts", "milkshake.transcript.json");

function parseArgs(argv) {
  const args = { claudeModel: "claude-haiku-4-5", judgeModel: "claude-haiku-4-5", localModel: "qwen2.5:3b", maxTokens: 900 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claude-model") args.claudeModel = argv[++i];
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--local-model") args.localModel = argv[++i];
    else if (a === "--max-tokens") args.maxTokens = parseInt(argv[++i], 10);
    else if (a === "--key-file") args.keyFile = argv[++i];
    else if (a === "--ollama-url") args.ollamaUrl = argv[++i];
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

async function probe(adapter, contextMessages, question, maxTokens) {
  const messages = [...contextMessages, { role: "user", content: question }];
  const t0 = Date.now();
  const result = await adapter.generate(messages, { maxTokens });
  return { text: result.text, wallMs: result.wallMs ?? Date.now() - t0, usage: result.usage ?? null };
}

/** LLM-judge grading: given the real ground-truth excerpts and the candidate answer, score each rubric item. Never trusts the model's own self-report — a separate call, told to be skeptical. */
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
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { parseError: true, raw: result.text };
  }
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
  const localAdapter = createOllamaChatAdapter({ model: args.localModel, url: args.ollamaUrl });

  const { script } = JSON.parse(readFileSync(TRANSCRIPT_PATH, "utf8"));
  const { baselineConv, holonicConv, memory } = replay(script);
  const growingMsgs = growingContext(baselineConv);
  const holonicMsgs = holonicContext(holonicConv, memory);

  console.log(`Critical-thinking probes: ${REASONING_PROBES.length}. Context sizes — adversary: ${contextText(growingMsgs).length} chars, fold: ${contextText(holonicMsgs).length} chars.\n`);

  const probeResults = [];
  for (const p of REASONING_PROBES) {
    console.log(`--- ${p.id} ---`);
    console.log(`  "${p.probe}"`);
    const groundTruthExcerpts = excerptsForTurns(script, p.requiresGroundTurns);

    const [adversaryAns, holonicAns, foldHostedAns] = await Promise.all([
      probe(claudeAdapter, growingMsgs, p.probe, args.maxTokens),
      probe(localAdapter, holonicMsgs, p.probe, args.maxTokens),
      probe(claudeAdapter, holonicMsgs, p.probe, args.maxTokens),
    ]);

    const [adversaryVerdict, holonicVerdict, foldHostedVerdict] = await Promise.all([
      judge(judgeAdapter, { question: p.probe, answer: adversaryAns.text, groundTruthExcerpts, rubric: p.rubric }),
      judge(judgeAdapter, { question: p.probe, answer: holonicAns.text, groundTruthExcerpts, rubric: p.rubric }),
      judge(judgeAdapter, { question: p.probe, answer: foldHostedAns.text, groundTruthExcerpts, rubric: p.rubric }),
    ]);

    const r = {
      id: p.id,
      probe: p.probe,
      adversary: { text: adversaryAns.text, wallMs: adversaryAns.wallMs, verdict: adversaryVerdict, score: scoreFromVerdict(adversaryVerdict) },
      holonic: { text: holonicAns.text, wallMs: holonicAns.wallMs, verdict: holonicVerdict, score: scoreFromVerdict(holonicVerdict) },
      foldHosted: { text: foldHostedAns.text, wallMs: foldHostedAns.wallMs, verdict: foldHostedVerdict, score: scoreFromVerdict(foldHostedVerdict) },
    };
    probeResults.push(r);

    const fmt = (s) => (s ? `${s.met}/${s.total} rubric items, sound=${s.overallSound}` : "JUDGE PARSE FAILED");
    console.log(`  adversary:   ${fmt(r.adversary.score)} (${r.adversary.wallMs}ms)`);
    console.log(`  local+fold:  ${fmt(r.holonic.score)} (${r.holonic.wallMs}ms)`);
    console.log(`  fold+hosted: ${fmt(r.foldHosted.score)} (${r.foldHosted.wallMs}ms)`);
    console.log();
  }

  const totalRubricItems = (side) => probeResults.reduce((a, r) => a + (r[side].score?.total ?? 0), 0);
  const metRubricItems = (side) => probeResults.reduce((a, r) => a + (r[side].score?.met ?? 0), 0);
  const soundCount = (side) => probeResults.filter((r) => r[side].score?.overallSound).length;

  console.log("=== Summary ===");
  for (const side of ["adversary", "holonic", "foldHosted"]) {
    const total = totalRubricItems(side);
    const met = metRubricItems(side);
    console.log(`${side}: ${met}/${total} rubric items met (${total ? ((met / total) * 100).toFixed(0) : "?"}%), ${soundCount(side)}/${probeResults.length} probes judged overall-sound`);
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `${nowStamp()}__milkshake-reasoning__${args.localModel.replace(/[:/]/g, "-")}-vs-${args.claudeModel}`;
  const outPath = join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(outPath, JSON.stringify({ runId, claudeModel: args.claudeModel, judgeModel: args.judgeModel, localModel: args.localModel, probeResults }, null, 2));
  console.log(`\nResults: ${outPath}`);

  const scoreboardPath = join(RESULTS_DIR, "milkshake-reasoning-scoreboard.md");
  const section = [
    `## ${runId}`,
    ``,
    `| pipeline | rubric items met | probes overall-sound |`,
    `|---|---|---|`,
    ...["adversary", "holonic", "foldHosted"].map((side) => {
      const total = totalRubricItems(side), met = metRubricItems(side);
      const label = side === "adversary" ? `adversary (${args.claudeModel}, growing)` : side === "holonic" ? `local+fold (${args.localModel})` : `fold+hosted (${args.claudeModel})`;
      return `| ${label} | ${met}/${total} (${total ? ((met / total) * 100).toFixed(0) : "?"}%) | ${soundCount(side)}/${probeResults.length} |`;
    }),
    ``,
    `Graded by ${args.judgeModel} against verbatim ground-truth excerpts from the real transcript, not a hardcoded rubric answer.`,
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
