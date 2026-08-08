#!/usr/bin/env node
// Live adversary comparison — the real matchup, not a same-model ablation:
//
//   adversary — a real, larger, hosted Claude model, given the ENTIRE raw
//     conversation every turn (growingContext: unbounded, no fold). This is
//     "just run a Claude model with a growing context window instead of
//     surf and fold" — expensive, but not memory-constrained.
//
//   local + surf/fold — a small, local, CPU-bound Ollama model (the kind of
//     model EOchat actually deploys — see eval/README.md's whole premise),
//     given only the windowed history plus the desk (holonicContext). Cheap
//     and context-bounded regardless of how long the conversation runs, but
//     only as good as the desk's fold actually is.
//
// The question this eval exists to answer: can surf/fold + prompting on the
// small local model be tuned to match the big hosted model's recall, as the
// conversation scales up — not "which pipeline wins on the same model."
//
// Usage:
//   ANTHROPIC_API_KEY=... node eval/chat/live/run-live.mjs \
//     --claude-model claude-sonnet-5 --local-model qwen2.5:3b \
//     --scales 10,30,60 --fact-count 4
//
// Or point at a key file instead of an env var:
//   node eval/chat/live/run-live.mjs --key-file /path/to/key --scales 10,30,60

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { replay, baselineContext, growingContext, holonicContext, contextText } from "../pipelines.mjs";
import { buildScaledConversation } from "./generate-conversation.mjs";
import { createClaudeAdapter } from "../../adapters/claude-adapter.mjs";
import { createOllamaChatAdapter } from "../../adapters/ollama-chat-adapter.mjs";
import { isDenialSentence } from "../../../server/conversation-memory.js";
import { splitSentences } from "../../../server/citation-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "results", "live");

function parseArgs(argv) {
  const args = {
    claudeModel: "claude-haiku-4-5",
    localModel: "qwen2.5:3b",
    scales: [10, 30, 60],
    factCount: 4,
    seed: 0,
    maxTokens: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claude-model") args.claudeModel = argv[++i];
    else if (a === "--local-model") args.localModel = argv[++i];
    else if (a === "--scales") args.scales = argv[++i].split(",").map((s) => parseInt(s.trim(), 10));
    else if (a === "--fact-count") args.factCount = parseInt(argv[++i], 10);
    else if (a === "--seed") args.seed = parseInt(argv[++i], 10);
    else if (a === "--max-tokens") args.maxTokens = parseInt(argv[++i], 10);
    else if (a === "--key-file") args.keyFile = argv[++i];
    else if (a === "--ollama-url") args.ollamaUrl = argv[++i];
  }
  return args;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveApiKey(args) {
  if (args.keyFile) return readFileSync(args.keyFile, "utf8").trim();
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  throw new Error("No API key: pass --key-file <path> or set ANTHROPIC_API_KEY");
}

/** One probe: assembled context + the probe question as the final user turn. */
async function probe(adapter, contextMessages, question, maxTokens) {
  const messages = [...contextMessages, { role: "user", content: question }];
  const t0 = Date.now();
  const result = await adapter.generate(messages, { maxTokens });
  return { text: result.text, wallMs: result.wallMs ?? Date.now() - t0, usage: result.usage ?? null, promptChars: contextText(messages).length };
}

// A real recall, not just a string match: the code must appear in the
// answer AND the answer must not also contain a denial sentence ("I don't
// have any record of that", "there seems to be some confusion") — a model
// that leaks the right code while simultaneously disclaiming it is the
// exact false-denial failure shape server/conversation-memory.js's
// checkRecallDenial() exists to catch, reused here rather than
// reimplemented, so a hedge that happens to contain the substring doesn't
// silently count as a pass.
function recalled(text, code) {
  if (!text.toLowerCase().includes(code.toLowerCase())) return false;
  const hasDenial = splitSentences(text).some((s) => isDenialSentence(s.text));
  return !hasDenial;
}

async function runScale({ claudeAdapter, localAdapter, scale, factCount, seed, maxTokens }) {
  const { script, facts } = buildScaledConversation({ totalTurns: scale, factCount, seed });
  const { baselineConv, holonicConv, memory } = replay(script);

  const growingMsgs = growingContext(baselineConv);       // adversary: hosted Claude, unbounded
  const localBaselineMsgs = baselineContext(baselineConv); // local model, windowed only, no desk (shows the failure without surf/fold)
  const holonicMsgs = holonicContext(holonicConv, memory); // local model, windowed + desk (surf/fold)

  const factResults = [];
  for (const fact of facts) {
    const [growingAns, localBaselineAns, holonicAns] = await Promise.all([
      probe(claudeAdapter, growingMsgs, fact.probe, maxTokens),
      probe(localAdapter, localBaselineMsgs, fact.probe, maxTokens),
      probe(localAdapter, holonicMsgs, fact.probe, maxTokens),
    ]);
    factResults.push({
      topic: fact.topic,
      code: fact.code,
      growing: { text: growingAns.text, recalled: recalled(growingAns.text, fact.code), inputTokens: growingAns.usage?.input_tokens ?? null, promptChars: growingAns.promptChars, wallMs: growingAns.wallMs },
      localBaseline: { text: localBaselineAns.text, recalled: recalled(localBaselineAns.text, fact.code), promptChars: localBaselineAns.promptChars, wallMs: localBaselineAns.wallMs },
      holonic: { text: holonicAns.text, recalled: recalled(holonicAns.text, fact.code), promptChars: holonicAns.promptChars, wallMs: holonicAns.wallMs },
    });
  }

  const acc = (side) => factResults.filter((f) => f[side].recalled).length / factResults.length;
  const avgTokens = (side) => {
    const vals = factResults.map((f) => f[side].inputTokens).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const avgChars = (side) => Math.round(factResults.reduce((a, f) => a + f[side].promptChars, 0) / factResults.length);
  const avgMs = (side) => Math.round(factResults.reduce((a, f) => a + f[side].wallMs, 0) / factResults.length);

  return {
    scale,
    factCount,
    growing: { accuracy: acc("growing"), avgInputTokens: avgTokens("growing"), avgPromptChars: avgChars("growing"), avgWallMs: avgMs("growing") },
    localBaseline: { accuracy: acc("localBaseline"), avgPromptChars: avgChars("localBaseline"), avgWallMs: avgMs("localBaseline") },
    holonic: { accuracy: acc("holonic"), avgPromptChars: avgChars("holonic"), avgWallMs: avgMs("holonic") },
    factResults,
  };
}

function summaryLine(r) {
  const g = r.growing, lb = r.localBaseline, h = r.holonic;
  const charRatio = h.avgPromptChars ? (g.avgPromptChars / h.avgPromptChars).toFixed(1) : "n/a";
  return `- **scale=${r.scale} turns, ${r.factCount} facts** — adversary (Claude, growing): ${(g.accuracy * 100).toFixed(0)}% recall @ ${g.avgInputTokens ?? "?"} input tokens, ${g.avgWallMs}ms | local, windowed-only (no fold): ${(lb.accuracy * 100).toFixed(0)}% recall @ ${lb.avgPromptChars} prompt chars, ${lb.avgWallMs}ms | local + surf/fold: ${(h.accuracy * 100).toFixed(0)}% recall @ ${h.avgPromptChars} prompt chars, ${h.avgWallMs}ms — local+fold context is ${charRatio}x smaller than the adversary's`;
}

function updateScoreboard({ runId, claudeModel, localModel, results }) {
  const scoreboardPath = join(RESULTS_DIR, "scoreboard.md");
  const section = [
    `## ${runId} (adversary: ${claudeModel}, local: ${localModel})`,
    ``,
    ...results.map(summaryLine),
    ``,
  ].join("\n");

  const header = `# Live Adversary Comparison — local CPU model + surf/fold vs. a hosted Claude model with a growing context window\n\nEach run replays the SAME scripted long conversation through THREE real context-assembly pipelines (eval/chat/pipelines.mjs) and asks a REAL model to answer a recall probe against each: a hosted Claude model given the entire unbounded raw history (the adversary — "just run a Claude model with a growing context window instead of surf and fold"), a small local CPU model (Ollama) given only the windowed history with no desk (shows the failure surf/fold exists to fix), and the same local model given the windowed history PLUS the desk (surf/fold). Recall is graded mechanically: does the model's answer contain the planted fact's exact code. Newest runs first.\n`;

  let existing = "";
  if (existsSync(scoreboardPath)) {
    const prior = readFileSync(scoreboardPath, "utf8");
    const bodyStart = prior.indexOf("\n## ");
    existing = bodyStart === -1 ? "" : prior.slice(bodyStart);
  }
  writeFileSync(scoreboardPath, `${header}\n${section}\n${existing}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = resolveApiKey(args);
  const claudeAdapter = createClaudeAdapter({ model: args.claudeModel, apiKey });
  const localAdapter = createOllamaChatAdapter({ model: args.localModel, url: args.ollamaUrl });

  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `${nowStamp()}__${args.localModel.replace(/[:/]/g, "-")}-vs-${args.claudeModel}`;
  const jsonlPath = join(RESULTS_DIR, `${runId}.jsonl`);

  console.log(`Live adversary comparison — adversary: ${args.claudeModel} (hosted, growing context), local: ${args.localModel} (CPU, surf/fold)`);
  console.log(`Scales: ${args.scales.join(",")}, facts/scale: ${args.factCount}`);
  console.log(`Run id: ${runId}\n`);

  const results = [];
  for (const scale of args.scales) {
    process.stdout.write(`  scale=${scale} ... `);
    const r = await runScale({ claudeAdapter, localAdapter, scale, factCount: args.factCount, seed: args.seed, maxTokens: args.maxTokens });
    console.log(`adversary ${(r.growing.accuracy * 100).toFixed(0)}% | local-baseline ${(r.localBaseline.accuracy * 100).toFixed(0)}% | local+fold ${(r.holonic.accuracy * 100).toFixed(0)}%`);
    results.push(r);
    appendFileSync(jsonlPath, JSON.stringify(r) + "\n");
  }

  console.log(`\nResults: ${jsonlPath}`);
  updateScoreboard({ runId, claudeModel: args.claudeModel, localModel: args.localModel, results });
  console.log(`Scoreboard: ${join(RESULTS_DIR, "scoreboard.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
