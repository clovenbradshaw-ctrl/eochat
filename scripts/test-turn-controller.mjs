// Standalone smoke test for turn-controller.js. Mocks the two real external
// dependencies it has (engineGroundQuery and Ollama's streaming /api/chat) so the
// full turn pipeline — retrieval -> grounded prompt -> streamed answer -> citation
// verification -> persistence -> SSE events — can be exercised without the real
// eoreader6 engine or a running Ollama daemon (neither is available in this
// sandbox). Real end-to-end behavior still needs a manual pass in an environment
// with both.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { ConversationStore } from "../server/conversation-store.js";
import { createTurnController, HISTORY_TURNS } from "../server/turn-controller.js";

function encode(obj) { return new TextEncoder().encode(JSON.stringify(obj) + "\n"); }

// A fetch mock that streams the given NDJSON chunks, honoring AbortSignal.
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
              if (signal?.aborted) {
                const e = new Error("aborted"); e.name = "AbortError"; throw e;
              }
              if (i >= chunks.length) {
                if (neverEnds) {
                  // Block until aborted — simulates a slow/streaming model.
                  await new Promise((resolve, reject) => {
                    const onAbort = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
                    if (signal) signal.addEventListener("abort", onAbort, { once: true });
                  });
                }
                return { done: true, value: undefined };
              }
              const value = encode(chunks[i++]);
              return { done: false, value };
            },
          };
        },
      },
    };
  };
}

async function withController(dir, fetchMock, groundResult, extra = {}) {
  globalThis.fetch = fetchMock;
  const conversationStore = new ConversationStore({ dir });
  const groundCalls = [];
  const groundQuery = (query, opts) => {
    groundCalls.push({ query, opts });
    return typeof groundResult === "function" ? groundResult(query, opts) : groundResult;
  };
  const controller = createTurnController({
    conversationStore,
    groundQuery,
    target: "http://mock-ollama",
    numCtx: 8192,
    modelRouter: null,
    heuristicModel: () => "mock-model:latest",
    latencyBudgetMs: 8000,
    isWarming: () => false,
    ...extra,
  });
  return { conversationStore, controller, groundCalls };
}

function collectEvents() {
  const events = [];
  const sendEvent = (type, data) => events.push({ type, data });
  return { events, sendEvent };
}

const GROUNDED_RESULT = {
  context: "[1] The creature demands a companion of Victor.",
  citations: [{ span_id: "s1", source_id: "source:/pg84.txt:chunk-9", byte_start: 100, byte_end: 180, score: 0.91, text: "The creature demands a companion of Victor." }],
  retrieved: [{ rank: 1, span_id: "s1", source_id: "source:/pg84.txt:chunk-9", kept: true, citation: 1 }],
  total: 1, folded: 1, tokens: 40, budget: 3000, dropped: 0, gaps: [], priorWidening: null,
};

async function testNormalTurn(dir) {
  const { conversationStore, controller } = await withController(
    dir,
    makeFetchMock([{ message: { content: "The creature demands " } }, { message: { content: "a companion [1]." } }, { done: true }]),
    GROUNDED_RESULT,
  );
  const conv = await conversationStore.create({ title: "Frankenstein" });
  const { events, sendEvent } = collectEvents();
  const { turnId, answerId, done } = await controller.startTurn({ conversationId: conv.id, question: "What does the creature demand?" }, sendEvent);
  await done;

  assert.ok(events.find(e => e.type === "accepted"));
  assert.ok(events.find(e => e.type === "retrieval_started"));
  assert.ok(events.find(e => e.type === "witnesses_selected" && e.data.sourceCount === 1));
  assert.ok(events.filter(e => e.type === "answer_delta").length === 2, "both deltas must stream before completion");
  const verified = events.find(e => e.type === "citation_verified");
  assert.ok(verified && verified.data.resolved === true && verified.data.byteStart === 100);
  const completed = events.find(e => e.type === "completed");
  assert.equal(completed.data.status, "completed");
  assert.equal(completed.data.text, "The creature demands a companion [1].");
  assert.equal(completed.data.summary, "1 passages · 1 sources");

  const stored = await conversationStore.get(conv.id);
  const turn = stored.turns.find(t => t.id === turnId);
  const answer = turn.answers.find(a => a.id === answerId);
  assert.equal(answer.status, "completed");
  assert.equal(answer.citations[0].resolved, true);
  console.log("  ok: normal grounded turn streams, verifies citation, persists");
}

async function testAllSourcesDisabled(dir) {
  const { conversationStore, controller, groundCalls } = await withController(
    dir,
    makeFetchMock([{ message: { content: "No sources enabled." } }, { done: true }]),
    { ...GROUNDED_RESULT, context: null, citations: [], retrieved: [], total: 0, folded: 0 },
  );
  const conv = await conversationStore.create({ title: "All off", sourceScope: [] });
  const { events, sendEvent } = collectEvents();
  await (await controller.startTurn({ conversationId: conv.id, question: "Anything?" }, sendEvent)).done;

  assert.deepEqual(groundCalls[0].opts.source, [], "empty scope must reach the engine as [] (match nothing), never null/undefined");
  const gap = events.find(e => e.type === "gap" && e.data.type === "no_evidence_matched");
  assert.ok(gap, "an ungrounded turn must report a gap, not a silent answer");
  console.log("  ok: all-sources-disabled scope reaches engine as [], never widens to everything");
}

async function testUnresolvedCitationGap(dir) {
  const { controller, conversationStore } = await withController(
    dir,
    makeFetchMock([{ message: { content: "This cites [1] and a fake [9]." } }, { done: true }]),
    GROUNDED_RESULT,
  );
  const conv = await conversationStore.create({ title: "Bad citation" });
  const { events, sendEvent } = collectEvents();
  await (await controller.startTurn({ conversationId: conv.id, question: "Q" }, sendEvent)).done;

  const completed = events.find(e => e.type === "completed");
  assert.match(completed.data.text, /no source 9/, "a bracket beyond the real citation table must be visibly marked, not left looking real");
  const gap = events.find(e => e.type === "gap" && e.data.type === "unresolved_citation");
  assert.ok(gap);
  console.log("  ok: fabricated citation number produces a visible gap, not a fake-looking [9]");
}

async function testStopInterrupts(dir) {
  const { controller, conversationStore } = await withController(
    dir,
    makeFetchMock([{ message: { content: "Partial answer before " } }], { neverEnds: true }),
    GROUNDED_RESULT,
  );
  const conv = await conversationStore.create({ title: "Stoppable" });
  const { events, sendEvent } = collectEvents();
  const { turnId, done } = await controller.startTurn({ conversationId: conv.id, question: "Long one" }, sendEvent);

  // Give the first delta a moment to land, then stop.
  await new Promise(r => setTimeout(r, 20));
  const stopped = controller.stopTurn(conv.id, turnId);
  assert.equal(stopped, true, "stopTurn must find the in-flight generation");
  await done;

  const completed = events.find(e => e.type === "completed");
  assert.equal(completed.data.status, "interrupted");
  assert.equal(completed.data.text, "Partial answer before ");
  const stored = await conversationStore.get(conv.id);
  const turn = stored.turns.find(t => t.id === turnId);
  assert.equal(turn.answers[0].status, "interrupted");
  assert.equal(turn.answers[0].text, "Partial answer before ", "the partial text actually streamed must be persisted, not dropped");
  assert.equal(turn.question, "Long one", "stopping must never lose the user's turn");
  console.log("  ok: stop leaves a valid, persisted, interrupted partial turn");
}

async function testRegenerateCreatesVariant(dir) {
  const { controller, conversationStore } = await withController(
    dir,
    makeFetchMock([{ message: { content: "First answer [1]." } }, { done: true }]),
    GROUNDED_RESULT,
  );
  const conv = await conversationStore.create({ title: "Regen" });
  const { sendEvent: send1 } = collectEvents();
  const { turnId, done: done1 } = await controller.startTurn({ conversationId: conv.id, question: "Q" }, send1);
  await done1;

  globalThis.fetch = makeFetchMock([{ message: { content: "Second answer [1]." } }, { done: true }]);
  const { events: events2, sendEvent: send2 } = collectEvents();
  const { done: done2 } = await controller.regenerateTurn({ conversationId: conv.id, turnId }, send2);
  await done2;

  const stored = await conversationStore.get(conv.id);
  const turn = stored.turns.find(t => t.id === turnId);
  assert.equal(turn.answers.length, 2, "regenerate must add a variant, not overwrite");
  assert.equal(turn.answers[0].text, "First answer [1].", "the original answer must survive regenerate");
  assert.equal(turn.answers[1].text, "Second answer [1].");
  assert.equal(turn.activeAnswerId, turn.answers[1].id, "the new variant becomes active");
  assert.ok(events2.find(e => e.type === "accepted" && e.data.regenerate === true));
  console.log("  ok: regenerate retains the user turn and adds a new assistant variant");
}

// A fetch mock that, in addition to streaming canned deltas, records the
// `messages` array each call was actually invoked with — so a test can
// inspect what the model saw on turn N of a long-running conversation,
// not just what got persisted.
function makeRecordingFetchMock(replyText, sentMessages) {
  return async (url, opts) => {
    sentMessages.push(JSON.parse(opts.body).messages);
    return makeFetchMock([{ message: { content: replyText } }, { done: true }])(url, opts);
  };
}

// Ungrounded (ordinary conversational, ["everything ranks the same" logic
// doesn't matter here — GROUNDED_RESULT is reused purely so the mock has a
// consistent shape]) ~30-turn thread — well past HISTORY_TURNS (6) — run
// with no real LLM, checking two things a multi-hundred-turn run on a small
// local model would otherwise have to discover the hard way: (1) the
// messages sent to the model stay bounded (recent turns are capped, not
// accumulated without limit) instead of growing every turn, and (2) turns
// older than the recent window are folded into a summary rather than simply
// vanishing with no trace. Runs against DiscourseStore's real fold shape
// (turn-controller.js's foldOlderTurns), not a re-derivation of it.
async function testLongThreadFoldsAndBoundsContext(dir) {
  const sentMessages = [];
  const conversationStore = new ConversationStore({ dir });
  const groundQuery = () => ({ ...GROUNDED_RESULT, context: null, citations: [], retrieved: [], total: 0, folded: 0 });
  const controller = createTurnController({
    conversationStore, groundQuery,
    target: "http://mock-ollama", numCtx: 8192, modelRouter: null,
    heuristicModel: () => "mock-model:latest", latencyBudgetMs: 8000, isWarming: () => false,
  });

  const conv = await conversationStore.create({ title: "Long chat" });
  const TURN_COUNT = 30;
  for (let i = 0; i < TURN_COUNT; i++) {
    globalThis.fetch = makeRecordingFetchMock(`Reply about topic${i} number ${i}.`, sentMessages);
    const { sendEvent } = collectEvents();
    const { done } = await controller.startTurn(
      { conversationId: conv.id, question: `Tell me about topic${i}, item ${i}.` },
      sendEvent,
    );
    await done;
  }

  assert.equal(sentMessages.length, TURN_COUNT);

  // Once the conversation is past the fold threshold, the message-array
  // shape stops growing with conversation length: persona + grounding +
  // one fold summary + a fixed HISTORY_TURNS window + current question is
  // the same size whether this is turn 10 or turn 300 — the recent window
  // is what's fixed-size, not the whole history.
  const justPastFold = sentMessages[HISTORY_TURNS + 1].length;  // first turn with a fold summary present
  const wayPastFold = sentMessages[TURN_COUNT - 1].length;      // many more turns later
  assert.equal(wayPastFold, justPastFold, `message count must stay bounded once folding is active, not keep growing with conversation length (turn ${HISTORY_TURNS + 2}: ${justPastFold}, turn ${TURN_COUNT}: ${wayPastFold})`);

  const lastCallMessages = sentMessages[TURN_COUNT - 1];
  assert.equal(lastCallMessages[0].role, "system");
  assert.match(lastCallMessages[0].content, /warm, direct conversational assistant/, "default persona must be injected by default");

  const foldMsg = lastCallMessages.find((m) => m.role === "system" && /Earlier in this conversation/.test(m.content));
  assert.ok(foldMsg, "turns older than the recent window must be folded into a summary, not silently dropped");
  assert.match(foldMsg.content, /Topics discussed:/);
  // Something from an early, now-folded turn must still be traceable in the
  // summary — folding must compress, not erase.
  assert.match(foldMsg.content, /topic0/, "content from a folded-away early turn must survive into the summary");

  const userTurnsInPrompt = lastCallMessages.filter((m) => m.role === "user").length;
  assert.ok(userTurnsInPrompt <= HISTORY_TURNS + 1, `raw user turns in the prompt must stay capped at HISTORY_TURNS+current, got ${userTurnsInPrompt}`);

  console.log(`  ok: ${TURN_COUNT}-turn thread stays bounded (${justPastFold} msgs once folding starts, still ${wayPastFold} at turn ${TURN_COUNT}), older turns folded not dropped, persona present throughout`);
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eochat-turn-test-"));
  try {
    await testNormalTurn(dir);
    await testAllSourcesDisabled(dir);
    await testUnresolvedCitationGap(dir);
    await testStopInterrupts(dir);
    await testRegenerateCreatesVariant(dir);
    await testLongThreadFoldsAndBoundsContext(dir);
    console.log("ALL TURN-CONTROLLER TESTS PASSED");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
