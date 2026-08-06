#!/usr/bin/env node
// Integration test for prosify-cue.js wired into turn-controller.js.
//
// The properties that matter, exercised through the real controller (mocked
// Ollama + engineGroundQuery, same harness as test-turn-controller.mjs):
//
//   - when configured and triggered, the expanded cue — not the raw message —
//     is what reaches retrieval and the instruction gate;
//   - the raw message is what the talker model is told the reader said, and
//     what the desk records as a stated fact, REGARDLESS of prosify;
//   - unconfigured (no deps.prosifyModel) is a true no-op: no extra request,
//     raw question used everywhere, same as before this feature existed;
//   - a self-contained question never triggers a rewrite call;
//   - a failed rewrite degrades to the raw question, not a broken turn.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { ConversationStore } from "../server/conversation-store.js";
import { createTurnController } from "../server/turn-controller.js";

function encode(obj) { return new TextEncoder().encode(JSON.stringify(obj) + "\n"); }

const PROSIFY_MODEL = "tiny-prosify:latest";

// Routes by request shape: the prosify call is { model: PROSIFY_MODEL, stream:
// false }; everything else streams the talker's answer. `onProsifyCall` lets a
// test observe or fail that specific call without touching the talker path.
function makeMock({ talkerText = "Answer [1].", prosifyText = "expanded", onProsifyCall } = {}) {
  const requests = [];
  const fetchMock = async (url, opts) => {
    let parsed = null;
    try { parsed = JSON.parse(opts.body); } catch { /* keep null */ }
    requests.push({ url, body: parsed });
    if (parsed?.model === PROSIFY_MODEL && parsed.stream === false) {
      if (onProsifyCall) return onProsifyCall();
      return { ok: true, json: async () => ({ message: { content: prosifyText } }) };
    }
    if (parsed && parsed.stream === false) {
      return { ok: true, json: async () => ({ message: { content: "" } }) }; // cross-turn correction, unused here
    }
    let i = 0;
    const chunks = [{ message: { content: talkerText } }, { done: true }];
    const signal = opts.signal;
    return {
      ok: true,
      body: { getReader() { return { async read() {
        if (signal?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
        if (i >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: encode(chunks[i++]) };
      } }; } },
    };
  };
  return { fetchMock, requests };
}

const GROUNDED_RESULT = {
  context: "[1] The creature demands a companion of Victor.",
  citations: [{ span_id: "s1", source_id: "source:/pg84.txt:chunk-9", byte_start: 100, byte_end: 180, score: 0.91, text: "The creature demands a companion of Victor." }],
  retrieved: [{ rank: 1, span_id: "s1", source_id: "source:/pg84.txt:chunk-9", kept: true, citation: 1 }],
  total: 1, folded: 1, tokens: 40, budget: 3000, dropped: 0, gaps: [], priorWidening: null,
};

async function withController({ fetchMock, groundQuery, extra = {} }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eochat-prosify-test-"));
  globalThis.fetch = fetchMock;
  const conversationStore = new ConversationStore({ dir });
  const groundCalls = [];
  const gq = (query, opts) => { groundCalls.push({ query, opts }); return groundQuery ? groundQuery(query, opts) : GROUNDED_RESULT; };
  const controller = createTurnController({
    conversationStore, groundQuery: gq,
    target: "http://mock-ollama", numCtx: 8192,
    modelRouter: null, heuristicModel: () => "mock-model:latest",
    latencyBudgetMs: 8000, isWarming: () => false,
    ...extra,
  });
  return { conversationStore, controller, groundCalls };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

await test("unconfigured (no prosifyModel): raw question everywhere, zero extra requests", async () => {
  const { fetchMock, requests } = makeMock();
  const { conversationStore, controller, groundCalls } = await withController({ fetchMock });
  const conv = await conversationStore.create({ title: "t" });
  const events = [];
  await (await controller.startTurn({ conversationId: conv.id, question: "read it again" }, (t, d) => events.push({ type: t, data: d }))).done;

  assert.equal(groundCalls[0].query, "read it again", "retrieval must see the raw question when prosify is unconfigured");
  const talkerReq = requests.find((r) => r.body?.stream === true);
  assert.ok(talkerReq.body.messages.some((m) => m.role === "user" && m.content === "read it again"));
  const stored = await conversationStore.get(conv.id);
  const answer = stored.turns[0].answers[0];
  assert.equal(answer.prosify.reason, "disabled");
  assert.equal(answer.prosify.changed, false);
});

await test("configured + terse referent-bearing follow-up: cue drives retrieval and the gate, raw question drives the talker + desk", async () => {
  const { fetchMock, requests } = makeMock({ prosifyText: "Re-read the Frankenstein creation scene just discussed." });
  const { conversationStore, controller, groundCalls } = await withController({ fetchMock, extra: { prosifyModel: PROSIFY_MODEL } });
  const conv = await conversationStore.create({ title: "t" });
  const events = [];
  await (await controller.startTurn({ conversationId: conv.id, question: "read it again" }, (t, d) => events.push({ type: t, data: d }))).done;

  assert.equal(groundCalls[0].query, "Re-read the Frankenstein creation scene just discussed.", "retrieval must see the prosified cue");

  const talkerReq = requests.find((r) => r.body?.stream === true);
  assert.ok(
    talkerReq.body.messages.some((m) => m.role === "user" && m.content === "read it again"),
    "the talker must still be told the reader's literal words, not the rewritten cue",
  );
  const gateSystem = talkerReq.body.messages.find((m) => m.role === "system" && /EO INSTRUCTION GATE/.test(m.content));
  assert.ok(gateSystem, "gate system block must be present");

  const stored = await conversationStore.get(conv.id);
  const turn = stored.turns[0];
  assert.equal(turn.question, "read it again", "the desk/turn record must keep the raw question, never the cue");
  const answer = turn.answers[0];
  assert.equal(answer.prosify.raw, "read it again");
  assert.equal(answer.prosify.cue, "Re-read the Frankenstein creation scene just discussed.");
  assert.equal(answer.prosify.changed, true);
  assert.equal(answer.prosify.reason, "expanded");
});

await test("configured + self-contained question: no rewrite call, cue equals raw", async () => {
  const question = "What does Victor Frankenstein feel toward the creature he made?";
  const { fetchMock, requests } = makeMock();
  const { conversationStore, controller, groundCalls } = await withController({ fetchMock, extra: { prosifyModel: PROSIFY_MODEL } });
  const conv = await conversationStore.create({ title: "t" });
  await (await controller.startTurn({ conversationId: conv.id, question }, () => {})).done;

  assert.equal(requests.filter((r) => r.body?.model === PROSIFY_MODEL).length, 0, "a self-contained question must not trigger a rewrite call");
  assert.equal(groundCalls[0].query, question);
  const stored = await conversationStore.get(conv.id);
  assert.equal(stored.turns[0].answers[0].prosify.reason, "self-contained");
});

await test("configured + rewrite call fails: falls back to the raw question, turn still completes", async () => {
  const { fetchMock, requests } = makeMock({ onProsifyCall: () => { throw new Error("mock: model unreachable"); } });
  const { conversationStore, controller, groundCalls } = await withController({ fetchMock, extra: { prosifyModel: PROSIFY_MODEL } });
  const conv = await conversationStore.create({ title: "t" });
  const events = [];
  await (await controller.startTurn({ conversationId: conv.id, question: "make it shorter" }, (t, d) => events.push({ type: t, data: d }))).done;

  assert.equal(groundCalls[0].query, "make it shorter", "a failed rewrite must fall back to the raw question, not block retrieval");
  const completed = events.find((e) => e.type === "completed");
  assert.ok(completed, "the turn must still complete despite the rewrite failure");
  const stored = await conversationStore.get(conv.id);
  const prosify = stored.turns[0].answers[0].prosify;
  assert.equal(prosify.reason, "error");
  assert.equal(prosify.cue, "make it shorter");
});

console.log(`\n${passed} test(s) passed`);
