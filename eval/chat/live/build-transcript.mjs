#!/usr/bin/env node
// Generates the REAL milkshake-machine-repair transcript: for each user turn
// in milkshake-scenario.mjs, makes a real Anthropic API call (with the
// web_search server tool enabled) using the growing conversation so far, and
// records the model's real answer. This is EOchat's own growing-context
// adversary pipeline, run for real, turn by turn — not anything hand-authored
// in this repo. The resulting (question, answer) pairs are exactly the
// script eval/chat/pipelines.mjs's replay() expects, so the saved transcript
// drops straight into the comparison harness (run-milkshake.mjs).
//
// Resumable: progress is appended to a .jsonl file turn by turn, so a
// timeout or interruption partway through can be continued by re-running the
// same command — already-completed turns are skipped.
//
// Usage:
//   ANTHROPIC_API_KEY=... node eval/chat/live/build-transcript.mjs --model claude-sonnet-5

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { userTurns } from "./milkshake-scenario.mjs";
import { createClaudeAdapter } from "../../adapters/claude-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = join(__dirname, "transcripts");
const PROGRESS_PATH = join(TRANSCRIPTS_DIR, "milkshake.progress.jsonl");
const FINAL_PATH = join(TRANSCRIPTS_DIR, "milkshake.transcript.json");

function parseArgs(argv) {
  // Claude Sonnet 5 runs adaptive thinking on by default, and max_tokens is a
  // hard cap on thinking + visible text COMBINED — a tight budget here can
  // (and did, in an earlier run of this script: 3/28 turns came back with
  // thinking_tokens == output_tokens and an EMPTY visible answer) starve the
  // actual response entirely while thinking eats the whole budget. 2000
  // leaves real headroom for both.
  const args = { model: "claude-sonnet-5", maxTokens: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i];
    else if (a === "--max-tokens") args.maxTokens = parseInt(argv[++i], 10);
    else if (a === "--key-file") args.keyFile = argv[++i];
  }
  return args;
}

function resolveApiKey(args) {
  if (args.keyFile) return readFileSync(args.keyFile, "utf8").trim();
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  throw new Error("No API key: pass --key-file <path> or set ANTHROPIC_API_KEY");
}

function loadProgress() {
  if (!existsSync(PROGRESS_PATH)) return [];
  return readFileSync(PROGRESS_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = resolveApiKey(args);
  const adapter = createClaudeAdapter({ model: args.model, apiKey });
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const questions = userTurns();
  let done = loadProgress();
  if (done.length && done[0].model !== args.model) {
    console.log(`Progress file was built with model ${done[0].model}, requested ${args.model} — starting fresh.`);
    done = [];
    writeFileSync(PROGRESS_PATH, "");
  }
  console.log(`Building real milkshake-machine-repair transcript — model: ${args.model}, ${questions.length} turns, ${done.length} already done.`);

  // Rebuild the growing message history from what's already completed.
  const messages = [];
  for (const turn of done) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }

  for (let i = done.length; i < questions.length; i++) {
    const question = questions[i];
    messages.push({ role: "user", content: question });
    process.stdout.write(`  [${i + 1}/${questions.length}] ${question.slice(0, 70)}... `);
    const result = await adapter.generate(messages, { maxTokens: args.maxTokens, webSearch: true });
    messages.push({ role: "assistant", content: result.text });
    console.log(`searched=${result.searched} (${result.wallMs}ms, ${result.usage?.output_tokens ?? "?"} out tokens)`);
    appendFileSync(PROGRESS_PATH, JSON.stringify({ model: args.model, question, answer: result.text, searched: result.searched, wallMs: result.wallMs, usage: result.usage }) + "\n");
  }

  const final = loadProgress().map(({ question, answer, searched }) => ({ question, answer, searched }));
  writeFileSync(FINAL_PATH, JSON.stringify({ model: args.model, generatedAt: new Date().toISOString(), turnCount: final.length, script: final }, null, 2));
  console.log(`\nDone. ${final.length} turns. Final transcript: ${FINAL_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
