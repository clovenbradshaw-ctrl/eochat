// Thin RPC client for ingest-worker.js — the main thread's only handle on
// the worker that now does admission (see ingest-worker.js for why).
//
// One worker, reused across calls: spawning a fresh worker per ingest would
// pay Node's worker-thread startup cost (module resolution, a new V8
// isolate) on every request, and admission is CPU-bound in the worker
// either way, so a second concurrent ingest gets no benefit from a second
// worker beyond the parallelism a single core doesn't have. What the worker
// buys is not concurrency between ingests — it's the main thread staying
// free to accept and answer OTHER requests while any one ingest runs.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "ingest-worker.js");

let worker = null;
let nextId = 1;
const pending = new Map();

function spawn() {
  const w = new Worker(WORKER_PATH);
  w.on("message", (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;

    // A batch message — accumulate and wait for the final one. Each batch is
    // its own message-port delivery, so the event loop gets a tick between
    // them instead of one giant structured-clone transfer (ingest-worker.js
    // header: this is the fix for the residual L1a stalls JSON.parse and
    // mergeIngestResult were both measured innocent of).
    if (msg.batch === "spans") { p.spans.push(...msg.chunk); return; }
    if (msg.batch === "provenance") { p.provenance.push(...msg.chunk); return; }

    pending.delete(msg.id);
    if (msg.ok) p.resolve({ ...msg, spans: p.spans, provenance: p.provenance });
    else p.reject(new Error(msg.error || "ingest worker reported an error"));
  });
  const failAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (worker === w) worker = null;
  };
  w.on("error", failAll);
  w.on("exit", (code) => {
    if (worker === w) worker = null;
    if (code !== 0) failAll(new Error(`ingest worker exited with code ${code}`));
  });
  return w;
}

function ensureWorker() {
  if (!worker) worker = spawn();
  return worker;
}

/**
 * Run one admission call in the ingest worker.
 * msg is one of:
 *   { kind: "text", text, sourceId }
 *   { kind: "file", filePath }
 * Resolves with { chunks, admitted, docId, doc, spans, provenance, provenanceTick } —
 * spans/provenance arrive as a series of batched messages (see spawn() above)
 * and are reassembled here before resolving, same shape as before batching.
 */
export function runIngestInWorker(msg) {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, spans: [], provenance: [] });
    w.postMessage({ id, ...msg });
  });
}

/** Graceful shutdown hook — terminates the worker so the process can exit. */
export async function terminateIngestWorker() {
  if (!worker) return;
  const w = worker;
  worker = null;
  await w.terminate().catch(() => {});
}
