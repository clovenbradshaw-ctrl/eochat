#!/usr/bin/env node
// Tests for ui/webllm-client.js — specifically that stopping a generation
// actually stops it, and leaves the engine able to run the next one.
//
// What makes this worth a test file of its own: WebLLM serializes every
// request to a model behind an FCFS lock (mlc-ai/web-llm#549).
// chatCompletion() acquires that lock BEFORE returning the streaming
// iterator, and the iterator releases it at the bottom of its own body, with
// no try/finally around it. So a caller that walks away from the iterator —
// break, early return, dropping it on abort — leaves the lock held forever,
// and the next generation blocks on acquire() with nothing left to wake it.
// The symptom is not an error; it is a "Stop, then ask again" that never
// answers, which reads as a random hang.
//
// The fake engine below reproduces exactly that lock discipline (see
// makeFakeEngine), with one deliberate difference: a create() that would
// block forever throws instead, so the failure shows up as a failed
// assertion rather than a test run that hangs. Every test here would pass
// trivially against an engine with a forgiving lock — the point is that they
// pass against an unforgiving one.
//
// Nothing here downloads a model or touches WebGPU: the behaviour under test
// is entirely what this module does with the iterator it is handed.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(HERE, "..", "ui", "webllm-client.js");
const WORKER_PATH = path.join(HERE, "..", "ui", "webllm-worker.js");

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

// ── Browser stubs ─────────────────────────────────────────────────────────
// The module assigns window.EOWebLLM on import and reads localStorage for the
// stored model id (already inside try/catch, so leaving it absent is fine).
globalThis.window = globalThis.window || {};

await import(pathToFileURL(CLIENT_PATH).href);
const client = globalThis.window.EOWebLLM;
assert.ok(client, "importing webllm-client.js should set window.EOWebLLM");

const tick = () => new Promise((r) => setTimeout(r, 0));

// A stand-in for MLCEngine with WebLLM's real lock semantics:
//   - create() takes the lock and hands back a generator
//   - the lock is released at the END of the generator body, and nowhere else
//     (no try/finally — abandoning the generator strands it, as upstream)
//   - interruptGenerate() sets the flag the decode loop checks
//
// `honorInterrupt: false` models an engine that has stopped responding to the
// interrupt flag, to check we don't hang on it forever.
function makeFakeEngine({ tokens = ["one ", "two ", "three ", "four "], honorInterrupt = true, firstChunkDelayMs = 0 } = {}) {
  const state = { locked: false, interruptCalls: 0, chunksProduced: 0, generatorsCompleted: 0 };
  let interruptSignal = false;

  const engine = {
    chat: {
      completions: {
        create: async () => {
          // Upstream this blocks forever; throwing turns the deadlock this
          // whole file exists to prevent into a legible failure.
          assert.ok(!state.locked, "create() was called while the model lock was still held — the previous generation was abandoned without releasing it");
          state.locked = true;
          interruptSignal = false;
          return (async function* () {
            let first = true;
            for (const t of tokens) {
              if (interruptSignal && honorInterrupt) break;
              if (first && firstChunkDelayMs) await new Promise((r) => setTimeout(r, firstChunkDelayMs));
              else await tick();
              first = false;
              state.chunksProduced++;
              yield { choices: [{ delta: { content: t } }] };
            }
            state.locked = false;
            state.generatorsCompleted++;
          })();
        },
      },
    },
    interruptGenerate: async () => {
      state.interruptCalls++;
      interruptSignal = true;
    },
    unload: async () => {},
  };
  return { engine, state };
}

// Put the singleton into the one state stream() will actually talk to an
// engine in. Returns the fake's observable state.
function useEngine(opts) {
  const { engine, state } = makeFakeEngine(opts);
  client.engine = engine;
  client.status = "ready";
  return state;
}

const MESSAGES = [{ role: "user", content: "hello" }];

// ── The version pin ───────────────────────────────────────────────────────

await test("the web-llm CDN import is pinned to an exact version", async () => {
  const clientSrc = fs.readFileSync(CLIENT_PATH, "utf8");
  const workerSrc = fs.readFileSync(WORKER_PATH, "utf8");
  const pinned = /@mlc-ai\/web-llm@(\d+\.\d+\.\d+)/;
  const inClient = clientSrc.match(pinned);
  const inWorker = workerSrc.match(pinned);
  assert.ok(inClient, "webllm-client.js should import @mlc-ai/web-llm at a pinned version, not the floating latest");
  assert.ok(inWorker, "webllm-worker.js should import @mlc-ai/web-llm at a pinned version, not the floating latest");
  assert.ok(
    !/@mlc-ai\/web-llm(?!@)/.test(clientSrc.replace(/^\s*\/\/.*$/gm, "")),
    "webllm-client.js still has an unversioned @mlc-ai/web-llm specifier outside comments",
  );
  assert.ok(
    !/@mlc-ai\/web-llm(?!@)/.test(workerSrc.replace(/^\s*\/\/.*$/gm, "")),
    "webllm-worker.js still has an unversioned @mlc-ai/web-llm specifier outside comments",
  );
});

await test("client and worker pin the SAME web-llm version", async () => {
  // Two different builds of web-llm in one page means the worker handler and
  // the main-thread engine disagree about the RPC protocol and the prebuilt
  // model catalog. The strings are duplicated (the worker's import is static
  // on purpose — see the comment there), so this is the thing keeping them
  // honest.
  const clientVersion = fs.readFileSync(CLIENT_PATH, "utf8").match(/@mlc-ai\/web-llm@(\d+\.\d+\.\d+)/)[1];
  const workerVersion = fs.readFileSync(WORKER_PATH, "utf8").match(/@mlc-ai\/web-llm@(\d+\.\d+\.\d+)/)[1];
  assert.strictEqual(workerVersion, clientVersion, "webllm-worker.js pins a different web-llm version than webllm-client.js");
});

// ── Baseline: an uninterrupted stream ─────────────────────────────────────

await test("a stream read to the end releases the lock without an interrupt", async () => {
  const state = useEngine();
  let text = "";
  for await (const d of client.stream(MESSAGES)) text += d;
  assert.strictEqual(text, "one two three four ");
  assert.strictEqual(state.locked, false, "lock still held after a completed stream");
  assert.strictEqual(state.interruptCalls, 0, "a stream that finished on its own should not be interrupted");
  assert.strictEqual(state.generatorsCompleted, 1);
});

// ── The three ways a caller stops early ───────────────────────────────────

await test("aborting mid-stream interrupts the engine and releases the lock", async () => {
  const state = useEngine();
  const ctrl = new AbortController();
  let text = "";
  for await (const d of client.stream(MESSAGES, { signal: ctrl.signal })) {
    text += d;
    if (text.includes("two")) ctrl.abort();
  }
  assert.ok(state.interruptCalls > 0, "abort should have called interruptGenerate()");
  assert.strictEqual(state.locked, false, "lock still held after an aborted stream — the next generation would block forever");
  assert.strictEqual(state.generatorsCompleted, 1, "the engine's generator should have been drained to completion, not abandoned");
});

await test("the deltas produced before a stop are kept", async () => {
  // Stop is not a discard: index.html leaves the partial answer in place and
  // the server records it as an interrupted turn, so the client half must
  // hand back what it already had rather than unwinding it.
  useEngine();
  const ctrl = new AbortController();
  let text = "";
  for await (const d of client.stream(MESSAGES, { signal: ctrl.signal })) {
    text += d;
    if (text.includes("two")) ctrl.abort();
  }
  assert.strictEqual(text, "one two ");
});

await test("breaking out of the loop releases the lock", async () => {
  // No AbortController at all — just a caller that stops reading. `for await`
  // calls .return() on our generator here, which must still reach the
  // interrupt-and-drain rather than dropping the engine's iterator.
  const state = useEngine();
  let count = 0;
  for await (const _d of client.stream(MESSAGES)) {
    if (++count === 2) break;
  }
  assert.ok(state.interruptCalls > 0, "an abandoned stream should still interrupt the engine");
  assert.strictEqual(state.locked, false, "lock still held after breaking out of the stream");
});

await test("returning from inside the loop releases the lock", async () => {
  // The shape webllm-longform.js's drainTextStream uses on a deadline.
  const state = useEngine();
  await (async () => {
    for await (const _d of client.stream(MESSAGES)) return;
  })();
  assert.strictEqual(state.locked, false, "lock still held after an early return from the stream");
});

await test("a second stream runs normally after the first was stopped", async () => {
  // The actual reported symptom: Stop, retype, hang. Both generations here go
  // through the same engine and therefore the same lock.
  const state = useEngine();
  const ctrl = new AbortController();
  for await (const _d of client.stream(MESSAGES, { signal: ctrl.signal })) ctrl.abort();

  let text = "";
  for await (const d of client.stream(MESSAGES)) text += d;
  assert.strictEqual(text, "one two three four ", "the generation after a stop did not run to completion");
  assert.strictEqual(state.locked, false);
});

await test("regenerating after a stop reuses the same engine", async () => {
  // Regenerate goes down the identical path as a fresh send, so it is the
  // other half of the same failure; asserted separately because it is the
  // case a reader hits by reflex after stopping a bad answer.
  const state = useEngine();
  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController();
    for await (const _d of client.stream(MESSAGES, { signal: ctrl.signal })) ctrl.abort();
  }
  assert.strictEqual(state.locked, false);
  assert.strictEqual(state.generatorsCompleted, 3, "each stopped generation should have wound itself down");
});

// ── Timing: the interrupt should not wait for the next chunk ───────────────

await test("an abort during a slow prefill interrupts without waiting for a chunk", async () => {
  // The abort listener exists for exactly this: the first chunk is 200ms out,
  // and a stop that only got noticed at the next chunk boundary would let the
  // reader watch text keep arriving after they clicked Stop.
  const state = useEngine({ firstChunkDelayMs: 200 });
  const ctrl = new AbortController();
  const consume = (async () => {
    for await (const _d of client.stream(MESSAGES, { signal: ctrl.signal })) { /* discard */ }
  })();
  await tick();
  ctrl.abort();
  await tick();
  assert.ok(state.interruptCalls > 0, "interruptGenerate() should fire on the abort event, not at the next chunk");
  assert.strictEqual(state.chunksProduced, 0, "no chunk had been produced yet when the interrupt was sent");
  await consume;
  assert.strictEqual(state.locked, false);
});

await test("aborting before the first read still releases the lock", async () => {
  const state = useEngine();
  const ctrl = new AbortController();
  ctrl.abort();
  for await (const _d of client.stream(MESSAGES, { signal: ctrl.signal })) { /* discard */ }
  assert.strictEqual(state.locked, false, "lock still held after a stream aborted before it was read");
});

// ── Standby is untouched by any of this ───────────────────────────────────

await test("standby mode still answers and never touches the engine", async () => {
  const state = useEngine();
  client.status = "standby";
  client.standby.reason = "no WebGPU here";
  let text = "";
  for await (const d of client.stream([{ role: "user", content: "hello" }])) text += d;
  assert.ok(text.length > 0, "standby should still produce a reply");
  assert.strictEqual(state.locked, false);
  assert.strictEqual(state.interruptCalls, 0);
  client.status = "ready";
});

// Not covered here: the drain timing out (INTERRUPT_DRAIN_TIMEOUT_MS) and
// dropping to standby. Exercising it honestly means waiting out the full
// timeout, which is not worth 30s on every run — the fake engine's
// honorInterrupt:false switch is there for anyone who wants to reproduce it
// by hand.

client._clearStandbyRetry();
client.engine = null;
console.log(`\n${passed} passed`);
