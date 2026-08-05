// Ingest worker — runs the engine's real admission call off the main thread.
//
// Measured root cause of the L1d violation in ../LAWS.md: admitChunked() in
// @eoreader/host/corpus is a single synchronous pass with no yield points —
// profiling pg2600.txt (3.3MB) here showed it take 9-17 SECONDS on the main
// thread. During that call nothing else can run: no new connection is
// accepted, no pending request's data/end event fires, no SSE header for a
// concurrent chat turn can flush. That is L1d exactly — not slowness, an
// unreachable acknowledgement.
//
// This file is host code (eochat's own), not the engine: it calls
// admitChunked/ingestFile completely unmodified, just inside a worker
// thread's isolated V8 instance instead of the process that also answers
// HTTP. No engine algorithm is reimplemented here.
//
// Worker threads don't share a JS heap, so the admission runs against a
// throwaway session created fresh for this one call, then every piece of
// state admitChunked touched (spans, the document entry, provenance
// entries) is handed back over postMessage. The caller (engine-ground.js's
// mergeIngestResult) splices that into the real, persistent pool session —
// mechanical Map insertion, not a re-derivation of what belongs there.
//
// THE RESULT IS SENT IN BATCHES, not one message. A ~1650-chunk book's spans
// alone structured-clone to a multi-megabyte object graph, and Node's
// structured-clone deserialization on the RECEIVING side is itself
// synchronous main-thread work that happens before the `message` event's
// callback even runs — invisible to any timer in that callback, and
// measured (LAWS.md L1a, 2026-08-04) as the residual cause of occasional
// sub-2-second event-loop stalls under concurrent ingest load, after
// JSON.parse and mergeIngestResult were both directly measured at under
// 15ms and ruled out. Splitting one large transfer into many small ones
// does not reduce the total bytes moved; it gives the event loop a tick
// between batches to run whatever else is waiting — the same fix in spirit
// as the worker itself, one level down.
const SPAN_BATCH = 200;

import { parentPort } from "node:worker_threads";
import { createSession, admitChunked, ingestFile } from "@eoreader/host/corpus";

parentPort.on("message", (msg) => {
  const { id, kind, text, filePath, sourceId } = msg;
  try {
    // Unbounded span cap: mirrors pool()'s createSession call in
    // engine-ground.js exactly, so admission here behaves identically to
    // admission on the main thread.
    const session = createSession({ spanCap: Number.MAX_SAFE_INTEGER });
    const result = kind === "file"
      ? ingestFile(session, filePath)
      : admitChunked(session, { text, sourceId });

    // ingestFile derives its own sourceId ("source:<path>") internally —
    // read it back from the session rather than reconstructing the engine's
    // naming convention here, so this file never has to track that format.
    const docId = kind === "file" ? [...session.documents.keys()][0] : sourceId;
    const doc = session.documents.get(docId) || null;
    const spans = [...session.spans.entries()];
    const provenance = [...session.provenance.entries()];

    for (let i = 0; i < spans.length; i += SPAN_BATCH) {
      parentPort.postMessage({ id, batch: "spans", chunk: spans.slice(i, i + SPAN_BATCH) });
    }
    for (let i = 0; i < provenance.length; i += SPAN_BATCH) {
      parentPort.postMessage({ id, batch: "provenance", chunk: provenance.slice(i, i + SPAN_BATCH) });
    }

    parentPort.postMessage({
      id,
      ok: true,
      done: true,
      chunks: result.chunks,
      admitted: result.admitted,
      docId,
      doc,
      spanCount: spans.length,
      provenanceCount: provenance.length,
      provenanceTick: session.provenance.tick,
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, done: true, error: err.message });
  }
});
