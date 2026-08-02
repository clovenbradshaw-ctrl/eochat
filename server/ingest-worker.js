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

    parentPort.postMessage({
      id,
      ok: true,
      chunks: result.chunks,
      admitted: result.admitted,
      docId,
      doc,
      spans: [...session.spans.entries()],
      provenance: [...session.provenance.entries()],
      provenanceTick: session.provenance.tick,
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
