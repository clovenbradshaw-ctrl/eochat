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
import { CabinetStore } from "../server/cabinet-store.js";
import { createTurnController } from "../server/turn-controller.js";

function encode(obj) { return new TextEncoder().encode(JSON.stringify(obj) + "\n"); }

// A fetch mock that streams the given NDJSON chunks, honoring AbortSignal.
// The pipeline's holonic planning step (defineAnswerSpec) makes its own,
// separate non-streaming `stream: false` call before the real answer call —
// answered here with a fixed riff/no-units plan so it never eats into
// `chunks`, which every caller of this mock writes to be consumed by the
// real (streaming) answer generation only.
function makeFetchMock(chunks, { neverEnds = false } = {}) {
  return async (url, opts) => {
    let parsedBody = null;
    try { parsedBody = JSON.parse(opts.body); } catch { /* not JSON */ }
    if (parsedBody && parsedBody.stream === false) {
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              kind: "factual question", lookup: true, form: "reply",
              reason: "mock planner reply — riff, no units", units: [],
              compliance: { minWords: 10, require: [], forbid: [] },
            }),
          },
        }),
      };
    }
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

// A fetch mock that records every request body (so a test can assert what the
// model was actually told) AND serves both call shapes the pipeline makes:
// the streaming /api/chat call and the non-streaming correction call.
function makeRecordingFetchMock(chunks, { correctionText = "" } = {}) {
  const requests = [];
  const fetchMock = async (url, opts) => {
    let parsed = null;
    try { parsed = JSON.parse(opts.body); } catch { /* keep null */ }
    requests.push({ url, body: parsed });
    if (parsed && parsed.stream === false) {
      return { ok: true, json: async () => ({ message: { content: correctionText } }) };
    }
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
              if (i >= chunks.length) return { done: true, value: undefined };
              const value = encode(chunks[i++]);
              return { done: false, value };
            },
          };
        },
      },
    };
  };
  return { fetchMock, requests };
}

function systemMessagesOf(request) {
  return (request?.body?.messages || []).filter((m) => m.role === "system").map((m) => m.content);
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

  // The invariant is "what the reader last saw is what gets saved", so it is
  // asserted against the last delta the reader actually received rather than
  // against a string literal. The literal form of this assertion expected the
  // model's raw chunk including its trailing space, but every `answer_delta`
  // carries `formatOutput(text)` — which trims — so that space was never shown
  // to anyone. The test was asserting a string the implementation had no
  // reason to produce and the reader never saw; comparing the two surfaces to
  // each other cannot drift the way a literal can.
  const lastDelta = events.filter(e => e.type === "answer_delta").pop();
  assert.ok(lastDelta, "an interrupted turn must still have streamed something");
  assert.equal(completed.data.text, lastDelta.data.text,
    "the interrupted answer must be exactly what was last streamed to the reader");
  assert.ok(completed.data.text.startsWith("Partial answer before"),
    `the streamed partial must be preserved, got ${JSON.stringify(completed.data.text)}`);

  const stored = await conversationStore.get(conv.id);
  const turn = stored.turns.find(t => t.id === turnId);
  assert.equal(turn.answers[0].status, "interrupted");
  assert.equal(turn.answers[0].text, completed.data.text,
    "the partial text actually streamed must be persisted, not dropped");
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

async function testVerbatimSnippets(dir) {
  const { controller, conversationStore } = await withController(
    dir,
    makeFetchMock([{ message: { content: "The creature demands a companion [1]." } }, { done: true }]),
    GROUNDED_RESULT,
  );
  const conv = await conversationStore.create({ title: "Snippets" });
  const { events, sendEvent } = collectEvents();
  const { turnId, answerId, done } = await controller.startTurn({ conversationId: conv.id, question: "What does the creature demand?" }, sendEvent);
  await done;

  const snippet = events.find(e => e.type === "verbatim_snippet");
  assert.ok(snippet, "a resolved [1] must produce a verbatim_snippet event");
  assert.equal(snippet.data.num, "1");
  assert.equal(snippet.data.text, GROUNDED_RESULT.citations[0].text, "the snippet text must be byte-identical to the engine's own citation record, never model prose");
  assert.equal(snippet.data.sourceId, GROUNDED_RESULT.citations[0].source_id);
  assert.equal(snippet.data.byteStart, GROUNDED_RESULT.citations[0].byte_start);

  const completed = events.find(e => e.type === "completed");
  assert.equal(completed.data.snippets.length, 1);
  assert.equal(completed.data.snippets[0].text, GROUNDED_RESULT.citations[0].text);

  const stored = await conversationStore.get(conv.id);
  const answer = stored.turns.find(t => t.id === turnId).answers.find(a => a.id === answerId);
  assert.equal(answer.snippets.length, 1, "the verbatim snippet must be persisted on the answer");
  assert.equal(answer.snippets[0].text, GROUNDED_RESULT.citations[0].text);
  console.log("  ok: a resolved citation produces a byte-identical verbatim snippet, streamed and persisted");
}

async function testUnresolvedCitationProducesNoSnippet(dir) {
  const { controller, conversationStore } = await withController(
    dir,
    makeFetchMock([{ message: { content: "This cites a fake [9]." } }, { done: true }]),
    GROUNDED_RESULT,
  );
  const conv = await conversationStore.create({ title: "No snippet for fake citation" });
  const { events, sendEvent } = collectEvents();
  await (await controller.startTurn({ conversationId: conv.id, question: "Q" }, sendEvent)).done;

  assert.equal(events.filter(e => e.type === "verbatim_snippet").length, 0, "an unresolved bracket must never produce a snippet card");
  console.log("  ok: an unresolved citation produces no verbatim snippet");
}

async function testNeedleInHaystack(dir) {
  // The failure this suite exists to prevent, end to end: a fact the reader
  // stated early is planted, the assistant acknowledges it ("Noted."), eight
  // unrelated turns push it out of the HISTORY_TURNS=6 sliding window, and a
  // much later probe ("what is the vault access code?") must STILL be answered
  // from the desk — the persisted conversation memory that is injected on
  // every turn regardless of the window. Without the desk, the probe would
  // reach the model with no trace of the code and it would deny, as it did.
  const CODE = "X9-Falcon-42";
  const stream = (answer) => makeRecordingFetchMock([{ message: { content: answer } }, { done: true }]).fetchMock;

  const { conversationStore, controller } = await withController(dir, stream("Noted."), GROUNDED_RESULT);
  const conv = await conversationStore.create({ title: "Needle" });
  const events = [];
  const sendEvent = (t, d) => events.push({ type: t, data: d });
  const run = (question) => controller.startTurn({ conversationId: conv.id, question }, sendEvent);

  await (await run(`The vault access code is '${CODE}'.`)).done;
  for (let i = 0; i < 8; i++) {
    // A neutral acknowledgment, never the code — the probe's history window
    // must be free of any trace of it.
    await (await run(`Distractor ${i + 1}: discuss the orchard harvest and the harbour ledger for the autumn quarter.`)).done;
  }

  const { fetchMock: probeFetch, requests } = makeRecordingFetchMock([{ message: { content: `The code is ${CODE}.` } }, { done: true }]);
  globalThis.fetch = probeFetch;
  await (await run("What is the vault access code?")).done;

  // The probe's request must have carried the code in a system message, even
  // though the code left the history window turns ago. Excludes the
  // planner's own non-streaming DEFINE call — its synthetic user prompt
  // ("Question: <question>\n...") also contains the question text, but it
  // carries no desk/memory injection at all and isn't "the model answering",
  // so matching on stream !== false picks the real chat completion instead.
  const probeRequest = requests.find((r) => r.body?.stream !== false && r.body?.messages?.some((m) => m.role === "user" && m.content?.includes("What is the vault access code?")));
  assert.ok(probeRequest, "the probe must have reached the model");
  const injected = systemMessagesOf(probeRequest).join("\n");
  assert.ok(injected.includes(CODE), `the desk was not injected into the probe turn:\n${injected}`);

  const completed = events.filter((e) => e.type === "completed" && e.data.status === "completed").pop();
  assert.ok(completed.data.text.includes(CODE), `the needle was lost — the model answered: ${completed.data.text}`);

  const stored = await conversationStore.get(conv.id);
  const fact = (stored.memory?.facts || []).find((f) => f.text.includes(CODE));
  assert.ok(fact, "the code fact must be persisted in the conversation's memory");
  assert.equal(fact.confirmed, true, "an acknowledged fact must be recorded as confirmed");

  const report = events.find((e) => e.type === "discourse_report");
  assert.ok(report, "a discourse_report must be emitted");
  assert.ok(report.data.facts >= 1);
  console.log("  ok: needle-in-haystack survives 8 distractor turns via the desk, persisted and injected");
}

async function testDenialIsCorrected(dir) {
  // The other half of the failure: even when a model denies a recorded fact,
  // the mechanical recall-denial review must catch it and the correction loop
  // must fix it — not ship a confident "never given" as the answer.
  const CODE = "X9-Falcon-42";
  const stream = (answer, correctionText = "") =>
    makeRecordingFetchMock([{ message: { content: answer } }, { done: true }], { correctionText }).fetchMock;

  const { conversationStore, controller } = await withController(dir, stream("Noted."), GROUNDED_RESULT);
  const conv = await conversationStore.create({ title: "Denial" });
  const events = [];
  const sendEvent = (t, d) => events.push({ type: t, data: d });

  await (await controller.startTurn({ conversationId: conv.id, question: `The vault access code is '${CODE}', it changes monthly.` }, sendEvent)).done;

  const denial = "I was never given any vault access code in this conversation.";
  globalThis.fetch = stream(denial, `The vault access code is '${CODE}', as noted earlier.`);
  const probe = await controller.startTurn({ conversationId: conv.id, question: "What is the vault access code?" }, sendEvent);
  await probe.done;

  const review = events.find((e) => e.type === "discourse_review");
  assert.ok(review, "a denial of a recorded fact must be mechanically reviewed");
  assert.equal(review.data.wasFlagged, true);
  assert.equal(review.data.corrected, true);
  assert.ok(JSON.stringify(review.data.flags).includes(CODE), "the flag must name the denied fact");

  const completed = events.filter((e) => e.type === "completed").pop();
  assert.ok(completed.data.text.includes(CODE), `the correction must restore the fact: ${completed.data.text}`);
  console.log("  ok: a denial of a recorded fact is flagged and corrected by the review loop");
}

async function testCabinetAcrossConversations(dir) {
  // The desk is per-conversation; the cabinet is per-project. A fact confirmed
  // in one conversation of a project must be retrievable in a LATER, fresh
  // conversation of the same project — the desk of the second conversation is
  // empty, so only the cabinet can answer the probe.
  const CODE = "X9-Falcon-42";
  const stream = (answer) => makeRecordingFetchMock([{ message: { content: answer } }, { done: true }]).fetchMock;
  const cabinet = new CabinetStore({ dir: path.join(dir, "cabinet") });

  const { conversationStore, controller } = await withController(dir, stream("Noted."), GROUNDED_RESULT, { cabinetStore: cabinet });
  const convA = await conversationStore.create({ title: "Cabinet A", pool: "p-needle" });
  const eventsA = [];
  await (await controller.startTurn({ conversationId: convA.id, question: `The vault access code is '${CODE}' and it rotates monthly.` }, (t, d) => eventsA.push({ type: t, data: d }))).done;

  const convB = await conversationStore.create({ title: "Cabinet B", pool: "p-needle" });
  const { fetchMock: probeFetch, requests } = makeRecordingFetchMock([{ message: { content: `The code is ${CODE}.` } }, { done: true }]);
  globalThis.fetch = probeFetch;
  const eventsB = [];
  await (await controller.startTurn({ conversationId: convB.id, question: "What is the vault access code?" }, (t, d) => eventsB.push({ type: t, data: d }))).done;

  const probeRequest = requests.find((r) => r.body?.messages?.some((m) => m.role === "user" && m.content === "What is the vault access code?"));
  assert.ok(probeRequest, "the probe must reach the model");
  const injected = systemMessagesOf(probeRequest).join("\n");
  assert.ok(injected.includes("PROJECT CABINET"), `the cabinet block must be injected in the second conversation:\n${injected}`);
  assert.ok(injected.includes(CODE), "the cross-conversation memo must be retrieved");

  const completedB = eventsB.filter((e) => e.type === "completed").pop();
  assert.ok(completedB.data.text.includes(CODE), `the second conversation lost the fact: ${completedB.data.text}`);

  const persisted = await cabinet.get("p-needle");
  assert.ok(persisted && persisted.memos.some((m) => m.text.includes(CODE)), "the memo must be persisted in the cabinet store");
  assert.ok(persisted.memos.some((m) => m.accessCount >= 1), "using the memo must strengthen its trace");
  console.log("  ok: a fact confirmed in one conversation is retrieved in another via the project cabinet");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eochat-turn-test-"));
  try {
    await testNormalTurn(dir);
    await testAllSourcesDisabled(dir);
    await testUnresolvedCitationGap(dir);
    await testStopInterrupts(dir);
    await testRegenerateCreatesVariant(dir);
    await testVerbatimSnippets(dir);
    await testUnresolvedCitationProducesNoSnippet(dir);
    await testNeedleInHaystack(dir);
    await testDenialIsCorrected(dir);
    await testCabinetAcrossConversations(dir);
    console.log("ALL TURN-CONTROLLER TESTS PASSED");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
