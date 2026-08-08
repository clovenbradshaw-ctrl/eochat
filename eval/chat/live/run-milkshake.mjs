#!/usr/bin/env node
// The real-conversation counterpart to run-live.mjs's synthetic-trivia
// version: replays the REAL, API-generated milkshake-machine-repair
// transcript (build-transcript.mjs — real Claude + real web_search, no
// hand-authored content) through three context-assembly pipelines and asks
// each to answer a recall probe about this session's own stated diagnostic
// details:
//
//   adversary  — the growing-context pipeline: the ENTIRE real transcript,
//     unbounded, answered by a real hosted Claude call (no web_search — this
//     is a pure conversational-recall probe, not a research question).
//   local, windowed-only — the small local CPU model, given only the last
//     HISTORY_TURNS raw turns, no desk. Shows the failure surf/fold exists
//     to fix, on REAL content instead of synthetic trivia.
//   local + surf/fold — the same local model, windowed history PLUS the
//     desk (server/conversation-memory.js).
//
// Usage:
//   ANTHROPIC_API_KEY=... node eval/chat/live/run-milkshake.mjs \
//     --claude-model claude-haiku-4-5 --local-model qwen2.5:3b

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { replay, baselineContext, growingContext, holonicContext, contextText } from "../pipelines.mjs";
import { factProbes } from "./milkshake-scenario.mjs";
import { createClaudeAdapter } from "../../adapters/claude-adapter.mjs";
import { createOllamaChatAdapter } from "../../adapters/ollama-chat-adapter.mjs";
import { isDenialSentence } from "../../../server/conversation-memory.js";
import { splitSentences } from "../../../server/citation-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "results", "live");
const TRANSCRIPT_PATH = join(__dirname, "transcripts", "milkshake.transcript.json");

function parseArgs(argv) {
  const args = { claudeModel: "claude-haiku-4-5", localModel: "qwen2.5:3b", maxTokens: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claude-model") args.claudeModel = argv[++i];
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

function recalled(text, code) {
  if (!text.toLowerCase().includes(code.toLowerCase())) return false;
  const hasDenial = splitSentences(text).some((s) => isDenialSentence(s.text));
  return !hasDenial;
}

async function probe(adapter, contextMessages, question, maxTokens) {
  const messages = [...contextMessages, { role: "user", content: question }];
  const t0 = Date.now();
  const result = await adapter.generate(messages, { maxTokens });
  return { text: result.text, wallMs: result.wallMs ?? Date.now() - t0, usage: result.usage ?? null, promptChars: contextText(messages).length };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function updateScoreboard({ runId, claudeModel, localModel, promptChars, acc, factResults }) {
  const scoreboardPath = join(RESULTS_DIR, "milkshake-scoreboard.md");
  const charRatio = (promptChars.growing / promptChars.holonic).toFixed(1);
  const misses = factResults.filter((f) => !f.holonic.recalled).map((f) => f.topic);
  const section = [
    `## ${runId}`,
    ``,
    `adversary (${claudeModel}, growing, ${promptChars.growing} chars): **${(acc.growing * 100).toFixed(0)}%** — local windowed-only (${localModel}, no fold, ${promptChars.localBaseline} chars): **${(acc.localBaseline * 100).toFixed(0)}%** — local + surf/fold (${promptChars.holonic} chars, ${charRatio}x smaller than the adversary's): **${(acc.holonic * 100).toFixed(0)}%**`,
    ``,
    misses.length ? `local+fold missed: ${misses.join(", ")}` : `local+fold missed nothing.`,
    ``,
  ].join("\n");

  const header = `# Milkshake-Machine-Repair — Real Conversation Adversary Comparison\n\nSame methodology as scoreboard.md in this directory, but against the REAL, API-generated troubleshooting transcript (eval/chat/live/milkshake-scenario.mjs + build-transcript.mjs) instead of synthetic trivia. Newest runs first.\n`;

  let existing = "";
  if (existsSync(scoreboardPath)) {
    const prior = readFileSync(scoreboardPath, "utf8");
    const bodyStart = prior.indexOf("\n## ");
    existing = bodyStart === -1 ? "" : prior.slice(bodyStart);
  }
  writeFileSync(scoreboardPath, `${header}\n${section}\n${existing}`);
  return scoreboardPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(TRANSCRIPT_PATH)) {
    throw new Error(`No transcript at ${TRANSCRIPT_PATH} — run build-transcript.mjs first.`);
  }
  const apiKey = resolveApiKey(args);
  const claudeAdapter = createClaudeAdapter({ model: args.claudeModel, apiKey });
  const localAdapter = createOllamaChatAdapter({ model: args.localModel, url: args.ollamaUrl });

  const { script, turnCount } = JSON.parse(readFileSync(TRANSCRIPT_PATH, "utf8"));
  const facts = factProbes();
  console.log(`Loaded real transcript: ${turnCount} turns. Facts to probe: ${facts.length}.`);

  const { baselineConv, holonicConv, memory } = replay(script);
  const growingMsgs = growingContext(baselineConv);
  const localBaselineMsgs = baselineContext(baselineConv);
  const holonicMsgs = holonicContext(holonicConv, memory);

  console.log(`Prompt sizes — adversary (growing): ${contextText(growingMsgs).length} chars | local windowed-only: ${contextText(localBaselineMsgs).length} chars | local+fold: ${contextText(holonicMsgs).length} chars\n`);

  const factResults = [];
  for (const fact of facts) {
    process.stdout.write(`  probe: "${fact.probe}" ... `);
    const [growingAns, localBaselineAns, holonicAns] = await Promise.all([
      probe(claudeAdapter, growingMsgs, fact.probe, args.maxTokens),
      probe(localAdapter, localBaselineMsgs, fact.probe, args.maxTokens),
      probe(localAdapter, holonicMsgs, fact.probe, args.maxTokens),
    ]);
    const r = {
      topic: fact.topic,
      code: fact.code,
      growing: { text: growingAns.text, recalled: recalled(growingAns.text, fact.code), inputTokens: growingAns.usage?.input_tokens ?? null, wallMs: growingAns.wallMs },
      localBaseline: { text: localBaselineAns.text, recalled: recalled(localBaselineAns.text, fact.code), wallMs: localBaselineAns.wallMs },
      holonic: { text: holonicAns.text, recalled: recalled(holonicAns.text, fact.code), wallMs: holonicAns.wallMs },
    };
    factResults.push(r);
    console.log(`adversary=${r.growing.recalled ? "PASS" : "FAIL"} local-baseline=${r.localBaseline.recalled ? "PASS" : "FAIL"} local+fold=${r.holonic.recalled ? "PASS" : "FAIL"}`);
  }

  const acc = (side) => factResults.filter((f) => f[side].recalled).length / factResults.length;
  console.log(`\nAccuracy — adversary (Claude, growing): ${(acc("growing") * 100).toFixed(0)}% | local, windowed-only: ${(acc("localBaseline") * 100).toFixed(0)}% | local + surf/fold: ${(acc("holonic") * 100).toFixed(0)}%`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `${nowStamp()}__milkshake__${args.localModel.replace(/[:/]/g, "-")}-vs-${args.claudeModel}`;
  const outPath = join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(outPath, JSON.stringify({
    runId, claudeModel: args.claudeModel, localModel: args.localModel,
    promptChars: { growing: contextText(growingMsgs).length, localBaseline: contextText(localBaselineMsgs).length, holonic: contextText(holonicMsgs).length },
    accuracy: { growing: acc("growing"), localBaseline: acc("localBaseline"), holonic: acc("holonic") },
    factResults,
  }, null, 2));
  console.log(`\nResults: ${outPath}`);

  const scoreboardPath = updateScoreboard({
    runId, claudeModel: args.claudeModel, localModel: args.localModel,
    promptChars: { growing: contextText(growingMsgs).length, localBaseline: contextText(localBaselineMsgs).length, holonic: contextText(holonicMsgs).length },
    acc: { growing: acc("growing"), localBaseline: acc("localBaseline"), holonic: acc("holonic") },
    factResults,
  });
  console.log(`Scoreboard: ${scoreboardPath}`);

  for (const r of factResults) {
    if (!r.holonic.recalled) {
      console.log(`\n[MISS] local+fold on "${r.topic}":`);
      console.log(`  expected to contain: ${r.code}`);
      console.log(`  got: ${r.holonic.text}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
