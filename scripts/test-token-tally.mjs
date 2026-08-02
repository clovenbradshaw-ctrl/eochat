// Standalone tests for the token tally and the provider settings that decide
// which model spends those tokens. Same shape as test-turn-controller.mjs:
// nothing here touches the network, a real Anthropic key, the eoreader6
// engine, or a running Ollama — the Anthropic streaming call is injected, and
// the local model is the same NDJSON fetch mock the turn-controller tests use.
//
// What these are actually defending, in order of how badly a regression would
// hurt:
//   1. The tally never over-counts. A streaming call reports usage many times
//      and a regenerate adds a second answer to one turn; either could inflate
//      the number the reader reads as their bill.
//   2. A stopped turn still counts. Tokens spent before a stop were spent.
//   3. The key never comes back out of the settings surface.
//   4. A hosted model chosen but unreachable answers locally AND SAYS SO.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { ConversationStore } from "../server/conversation-store.js";
import { createTurnController } from "../server/turn-controller.js";
import { SettingsStore } from "../server/settings-store.js";
import {
  addUsage, emptyUsage, estimateCostUsd, formatTokens, isEmptyUsage,
  normalizeAnthropicUsage, normalizeOllamaUsage, rollUpUsage, summarizeUsage,
} from "../server/token-tally.js";
import { toAnthropicMessages, describeStopReason } from "../server/anthropic-provider.js";

const VALID_KEY = "sk-ant-api03-0123456789abcdefghij";

function encode(obj) { return new TextEncoder().encode(JSON.stringify(obj) + "\n"); }

function makeFetchMock(chunks, { neverEnds = false } = {}) {
  return async (url, opts) => {
    let i = 0;
    const signal = opts.signal;
    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (signal?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
              if (i >= chunks.length) {
                if (neverEnds) {
                  await new Promise((_resolve, reject) => {
                    const onAbort = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
                    if (signal) signal.addEventListener("abort", onAbort, { once: true });
                  });
                }
                return { done: true, value: undefined };
              }
              return { done: false, value: encode(chunks[i++]) };
            },
          };
        },
      },
    };
  };
}

const GROUNDED_RESULT = {
  context: "[1] The creature demands a companion of Victor.",
  citations: [{ span_id: "s1", source_id: "source:/pg84.txt:chunk-9", byte_start: 100, byte_end: 180, score: 0.91, text: "The creature demands a companion of Victor." }],
  retrieved: [{ rank: 1, span_id: "s1", source_id: "source:/pg84.txt:chunk-9", kept: true, citation: 1 }],
  total: 1, folded: 1, tokens: 40, budget: 3000, dropped: 0, gaps: [], priorWidening: null,
};

function collectEvents() {
  const events = [];
  return { events, sendEvent: (type, data) => events.push({ type, data }) };
}

async function withController(dir, { fetchMock, settings = null, anthropicStream } = {}) {
  if (fetchMock) globalThis.fetch = fetchMock;
  const conversationStore = new ConversationStore({ dir });
  const controller = createTurnController({
    conversationStore,
    groundQuery: () => GROUNDED_RESULT,
    target: "http://mock-ollama",
    numCtx: 8192,
    modelRouter: null,
    heuristicModel: () => "mock-model:latest",
    latencyBudgetMs: 8000,
    isWarming: () => false,
    settings,
    anthropicStream,
  });
  return { conversationStore, controller };
}

// ── Pure arithmetic ──────────────────────────────────────────────────────

function testUsageArithmetic() {
  assert.ok(isEmptyUsage(emptyUsage()));
  assert.equal(normalizeOllamaUsage({ message: { content: "hi" } }), null,
    "a mid-stream chunk carries no counts and must yield null, never a zero tally");
  const ollama = normalizeOllamaUsage({ done: true, prompt_eval_count: 1200, eval_count: 300 });
  assert.deepEqual(
    { i: ollama.inputTokens, o: ollama.outputTokens, t: ollama.totalTokens, c: ollama.calls },
    { i: 1200, o: 300, t: 1500, c: 1 },
  );

  const anthropic = normalizeAnthropicUsage({
    input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 50,
  });
  assert.equal(anthropic.totalTokens, 1090,
    "cache reads and writes are input tokens the model processed — omitting them under-reports the context sent");

  const summed = addUsage(ollama, anthropic);
  assert.equal(summed.totalTokens, 1500 + 1090);
  assert.equal(summed.calls, 2);
  assert.equal(ollama.totalTokens, 1500, "addUsage must not mutate its arguments");

  console.log("  ok: usage normalizes per provider and folds without mutation");
}

function testCostEstimates() {
  // 1M input + 1M output on Opus 5 = $5 + $25.
  const million = { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(estimateCostUsd("claude-opus-5", million), 30);
  // Cache reads bill at a tenth of input: 1M cached reads = $0.50.
  assert.equal(estimateCostUsd("claude-opus-5", { ...emptyUsage(), cacheReadInputTokens: 1_000_000 }), 0.5);
  // A local model is genuinely free — that is a claim, and it is true.
  assert.equal(estimateCostUsd("llama3.2:latest", million), 0);
  // An unpriced hosted model is null, NOT zero: "we don't know" must not
  // render as "$0.00" next to a real bill.
  assert.equal(estimateCostUsd("claude-something-unreleased", million), null);

  const mixed = rollUpUsage({
    "claude-opus-5": { ...emptyUsage(), inputTokens: 1_000_000, calls: 1 },
    "llama3.2:latest": { ...emptyUsage(), inputTokens: 500, outputTokens: 200, calls: 2 },
  });
  assert.equal(mixed.totalTokens, 1_000_700, "tokens add across models");
  assert.equal(mixed.costUsd, 5, "dollars are summed per model at that model's own rate");
  assert.equal(mixed.costComplete, true);
  assert.equal(mixed.byModel.length, 2);

  const partial = rollUpUsage({
    "claude-opus-5": { ...emptyUsage(), inputTokens: 1_000_000 },
    "claude-something-unreleased": { ...emptyUsage(), inputTokens: 1_000_000 },
  });
  assert.equal(partial.costUsd, null, "one unpriced model makes the whole total unknowable, not merely smaller");
  assert.equal(partial.costComplete, false);

  assert.equal(summarizeUsage(million, "claude-opus-5").pricedAt.length, 10, "an estimate carries the date its prices came from");
  assert.equal(formatTokens(812), "812");
  assert.equal(formatTokens(12_400), "12k");
  assert.equal(formatTokens(1400), "1.4k");
  console.log("  ok: cost is per-model, cache-aware, and null rather than zero when unknown");
}

function testAnthropicMessageShaping() {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "Ground rules." },
    { role: "assistant", content: "orphaned opener" },
    { role: "user", content: "First?" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "Answer." },
    { role: "user", content: "Second?" },
  ]);
  assert.equal(system, "Ground rules.", "system turns become the top-level system field");
  assert.equal(messages[0].role, "user", "a leading assistant turn is dropped — the API rejects it");
  assert.equal(messages.length, 3);
  assert.equal(messages[1].content, "Answer.", "an empty assistant turn (a stopped answer) must not 400 the next question");

  assert.equal(describeStopReason("end_turn", null), null);
  assert.equal(describeStopReason("max_tokens", null).type, "answer_truncated");
  assert.match(describeStopReason("refusal", { category: "cyber" }).reason, /cyber/);
  console.log("  ok: message shaping and stop reasons survive the shapes that used to 400");
}

// ── Settings ─────────────────────────────────────────────────────────────

async function testSettingsNeverLeakTheKey(dir) {
  const settings = new SettingsStore({ file: path.join(dir, "settings.json"), env: {} });
  settings.loadSync();
  assert.equal(settings.publicView().anthropic.hasKey, false);
  assert.equal(settings.effectiveProvider().provider, "local");

  await assert.rejects(() => settings.setAnthropicKey("sk-proj-not-an-anthropic-key"), /Anthropic API key/,
    "a pasted key from another provider fails here, not as a 401 mid-question");

  const view = await settings.setAnthropicKey(VALID_KEY);
  assert.equal(view.anthropic.hasKey, true);
  assert.equal(view.anthropic.keyHint, "sk-ant-…ghij");
  assert.equal(JSON.stringify(view).includes(VALID_KEY), false, "no read path may return the key itself");
  assert.equal(view.provider, "anthropic", "adding a key activates the model it unlocks");

  // It survives a restart, and it is not world-readable on a shared machine.
  const reopened = new SettingsStore({ file: path.join(dir, "settings.json"), env: {} });
  await reopened.load();
  assert.equal(reopened.anthropicKey(), VALID_KEY);
  const mode = (await fs.stat(path.join(dir, "settings.json"))).mode & 0o777;
  assert.equal(mode, 0o600, `settings file must be 0600, was ${mode.toString(8)}`);

  console.log("  ok: key persists, activates its provider, and never crosses the read boundary");
}

async function testEnvKeyIsRespectedAndNotClobbered(dir) {
  const file = path.join(dir, "env-settings.json");
  const settings = new SettingsStore({ file, env: { ANTHROPIC_API_KEY: "sk-ant-env0123456789abcdefgh" } });
  settings.loadSync();
  assert.equal(settings.publicView().anthropic.keySource, "env");
  assert.equal(settings.publicView().anthropic.keyRemovable, false,
    "the UI must not offer to delete a key it did not create");

  await settings.setAnthropicKey(VALID_KEY);
  assert.equal(settings.keySource(), "settings", "a UI key takes precedence over the environment");
  await settings.clearAnthropicKey();
  assert.equal(settings.anthropicKey(), "sk-ant-env0123456789abcdefgh",
    "clearing the stored key falls back to the environment rather than pretending no key exists");
  assert.equal(settings.data.provider, "anthropic", "a still-reachable key means the provider stays put");
  console.log("  ok: an environment key is honoured, outranked, and fallen back to");
}

// ── The tally, end to end through a real turn ────────────────────────────

async function testLocalTurnTallies(dir) {
  const { conversationStore, controller } = await withController(dir, {
    fetchMock: makeFetchMock([
      { message: { content: "The creature demands " } },
      { message: { content: "a companion [1]." } },
      { done: true, prompt_eval_count: 940, eval_count: 60 },
    ]),
  });
  const conv = await conversationStore.create({ title: "Tally" });
  const { events, sendEvent } = collectEvents();
  const { turnId, answerId, done } = await controller.startTurn({ conversationId: conv.id, question: "What?" }, sendEvent);
  await done;

  const usageEvents = events.filter((e) => e.type === "usage");
  assert.equal(usageEvents.length, 1, "one completed call reports one tally");
  assert.equal(usageEvents[0].data.answer.totalTokens, 1000);
  assert.equal(usageEvents[0].data.conversation.totalTokens, 1000);
  assert.equal(usageEvents[0].data.answer.costUsd, 0, "a local model costs nothing, and says so rather than showing blank");

  const stored = await conversationStore.get(conv.id);
  const answer = stored.turns.find((t) => t.id === turnId).answers.find((a) => a.id === answerId);
  assert.equal(answer.usage.totalTokens, 1000, "the tally is durable, not only streamed");
  assert.equal(stored.usage.byModel["mock-model:latest"].totalTokens, 1000);

  const summary = (await conversationStore.list()).find((c) => c.id === conv.id);
  assert.equal(summary.usage.totalTokens, 1000, "the conversation list carries the tally without loading full records");
  console.log("  ok: a local turn tallies prompt+eval tokens into the answer, conversation, and list");
}

async function testTallyDoesNotDoubleCount(dir) {
  // Two turns, then a regenerate of the first. The regenerate adds a SECOND
  // answer to the same turn, so a tally that incremented on write would count
  // the first answer twice.
  const { conversationStore, controller } = await withController(dir, {
    fetchMock: makeFetchMock([{ message: { content: "One [1]." } }, { done: true, prompt_eval_count: 100, eval_count: 10 }]),
  });
  const conv = await conversationStore.create({ title: "No double count" });
  const { sendEvent } = collectEvents();
  const { turnId, done } = await controller.startTurn({ conversationId: conv.id, question: "Q1" }, sendEvent);
  await done;

  globalThis.fetch = makeFetchMock([{ message: { content: "Two [1]." } }, { done: true, prompt_eval_count: 200, eval_count: 20 }]);
  const { events: regenEvents, sendEvent: send2 } = collectEvents();
  await (await controller.regenerateTurn({ conversationId: conv.id, turnId }, send2)).done;

  const stored = await conversationStore.get(conv.id);
  assert.equal(stored.turns[0].answers.length, 2);
  assert.equal(stored.usage.byModel["mock-model:latest"].totalTokens, 110 + 220,
    "both answer variants count once each — the regenerate neither replaces nor re-adds the original");
  assert.equal(stored.usage.byModel["mock-model:latest"].calls, 2);
  const last = regenEvents.filter((e) => e.type === "usage").pop();
  assert.equal(last.data.conversation.totalTokens, 330);
  console.log("  ok: regenerating a turn adds one call to the tally, not two");
}

async function testStoppedTurnStillTallies(dir) {
  // Anthropic reports usage as the stream runs, so a stop still knows what was
  // spent — unlike Ollama, which reports only on its final chunk.
  const anthropicStream = async ({ signal, onDelta, onUsage }) => {
    onUsage({ ...emptyUsage(), inputTokens: 2000, outputTokens: 8, totalTokens: 2008, calls: 1 });
    onDelta("Partial ", "Partial ");
    await new Promise((_resolve, reject) => {
      const onAbort = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const settings = new SettingsStore({ file: path.join(dir, "stop-settings.json"), env: {} });
  settings.loadSync();
  await settings.setAnthropicKey(VALID_KEY);

  const { conversationStore, controller } = await withController(dir, { settings, anthropicStream });
  const conv = await conversationStore.create({ title: "Stopped" });
  const { events, sendEvent } = collectEvents();
  const { turnId, done } = await controller.startTurn({ conversationId: conv.id, question: "Long" }, sendEvent);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(controller.stopTurn(conv.id, turnId), true);
  await done;

  const completed = events.find((e) => e.type === "completed");
  assert.equal(completed.data.status, "interrupted");
  const usage = events.filter((e) => e.type === "usage").pop();
  assert.ok(usage, "a stopped turn still spent tokens and must still report them");
  assert.equal(usage.data.answer.totalTokens, 2008);
  assert.equal(usage.data.answer.model, "claude-opus-5");
  assert.ok(usage.data.answer.costUsd > 0, "hosted tokens carry a cost estimate even when the turn was stopped");

  const stored = await conversationStore.get(conv.id);
  assert.equal(stored.usage.byModel["claude-opus-5"].totalTokens, 2008);
  console.log("  ok: stopping a hosted turn persists the tokens already spent");
}

async function testAnthropicTurnReportsTruncationAndThinking(dir) {
  const anthropicStream = async ({ messages, onDelta, onThinking, onUsage }) => {
    assert.equal(messages[0].role, "system", "the grounded prompt still reaches the provider as a system turn");
    onThinking("Weighing the passage about the companion. ");
    onUsage({ ...emptyUsage(), inputTokens: 1000, outputTokens: 500, totalTokens: 1500, calls: 1 });
    onDelta("A long answer [1]", "A long answer [1]");
    return {
      text: "A long answer [1]",
      model: "claude-opus-5",
      usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 500, totalTokens: 1500, calls: 1 },
      stopReason: "max_tokens",
      stopDetails: null,
    };
  };
  const settings = new SettingsStore({ file: path.join(dir, "trunc-settings.json"), env: {} });
  settings.loadSync();
  await settings.setAnthropicKey(VALID_KEY);

  const { conversationStore, controller } = await withController(dir, { settings, anthropicStream });
  const conv = await conversationStore.create({ title: "Truncated" });
  const { events, sendEvent } = collectEvents();
  await (await controller.startTurn({ conversationId: conv.id, question: "Q" }, sendEvent)).done;

  const gap = events.find((e) => e.type === "gap" && e.data.type === "answer_truncated");
  assert.ok(gap, "an answer cut off at the output ceiling must be reported, never left looking complete (LAWS.md L3)");
  const thinking = events.find((e) => e.type === "thinking_delta");
  assert.ok(thinking && thinking.data.text.length > 0, "summarized reasoning fills the silence before the first word (LAWS.md L1)");
  const completed = events.find((e) => e.type === "completed");
  assert.equal(completed.data.provider, "anthropic");
  assert.equal(completed.data.model, "claude-opus-5");
  console.log("  ok: a hosted turn reports its model, its truncation, and its reasoning as it works");
}

async function testKeylessAnthropicFallsBackLoudly(dir) {
  // Provider says anthropic, no key: the turn must still be answered, and the
  // downgrade must be visible. A silent switch of model is the failure here.
  const settings = new SettingsStore({ file: path.join(dir, "keyless.json"), env: {} });
  settings.loadSync();
  settings.data.provider = "anthropic";

  const { conversationStore, controller } = await withController(dir, {
    fetchMock: makeFetchMock([{ message: { content: "Local answer [1]." } }, { done: true, prompt_eval_count: 10, eval_count: 5 }]),
    settings,
    anthropicStream: async () => { throw new Error("must not be called without a key"); },
  });
  const conv = await conversationStore.create({ title: "Keyless" });
  const { events, sendEvent } = collectEvents();
  await (await controller.startTurn({ conversationId: conv.id, question: "Q" }, sendEvent)).done;

  const completed = events.find((e) => e.type === "completed");
  assert.equal(completed.data.status, "completed", "no key must not mean no answer");
  assert.equal(completed.data.provider, "local");
  const gap = events.find((e) => e.type === "gap" && e.data.type === "provider_fallback");
  assert.ok(gap, "answering with a different model than the reader chose must be said out loud");
  console.log("  ok: a selected-but-unreachable provider answers locally and reports the downgrade");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eochat-tally-test-"));
  try {
    testUsageArithmetic();
    testCostEstimates();
    testAnthropicMessageShaping();
    await testSettingsNeverLeakTheKey(dir);
    await testEnvKeyIsRespectedAndNotClobbered(dir);
    await testLocalTurnTallies(dir);
    await testTallyDoesNotDoubleCount(dir);
    await testStoppedTurnStillTallies(dir);
    await testAnthropicTurnReportsTruncationAndThinking(dir);
    await testKeylessAnthropicFallsBackLoudly(dir);
    console.log("ALL TOKEN-TALLY / SETTINGS TESTS PASSED");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
