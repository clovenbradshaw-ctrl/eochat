// Ground-Truth engine bridge: ingests files into the real eoreader5 session,
// searches spans with byte-offset anchors, folds results under a token budget,
// and returns grounded context the LLM can cite.
//
// Sessions are grouped into named POOLS. The default pool ("corpus") holds
// ingested source texts — a chat message about "the creature" after ingesting
// Frankenstein and War and Peace gets interleaved results from both.
//
// A pool is a retrieval boundary, not a label: each pool owns its own engine
// session and span registry, so searchSpans in one pool can never return a
// span from another. That is what keeps the "priors" pool (eoPriors artifacts,
// see priors-source.js) out of corpus grounding — a question about the
// creature must not be answered with lens-ledger JSON. Priors are witness-tier
// knowledge about the corpus; corpus text is evidence from it. Mixing them in
// one retrieval pool would let the former be cited as the latter.
//
// Hosts the impure createSession/ingestFile/searchSpans/foldSpans corpus facade.

import fs from "node:fs";
import path from "node:path";
import {
  CORPUS_API_VERSION,
  createSession,
  admitChunked,
  ingestFile,
  searchSpans,
  spanUnits,
  foldSpans,
  readSpan,
} from "@eoreader/host/corpus";
// The whole-document facade (documentIds/documentText/sessionOutline/
// sessionReferents) arrived in corpus API v2 and backs engineFoldSource only.
// It is reached through a namespace import on purpose: a named import of a
// symbol a v1 host does not export fails at module-LINK time, which would
// replace the readable version guard below with a bare SyntaxError at boot.
// This way a v1 host still links and the fold path reports a typed gap.
import * as corpusFacade from "@eoreader/host/corpus";
import { INDIVIDUATION_TYPES } from "@eoreader/engine/referents";
import { loadCorefPrior, surfaceMatcher, activatePriors } from "./priors-bridge.js";
import { runIngestInWorker } from "./ingest-worker-client.js";

// v2 is additive over v1 — it adds documentIds/documentText/sessionOutline/
// sessionReferents/sessionPivot and changes no signature this bridge calls
// (the only line removed in the v1→v2 diff was the version constant itself).
// Listing known-compatible versions rather than pinning one keeps the guard's
// real job — failing at boot on an incompatible change instead of surfacing a
// wrong answer inside a chat turn weeks later — while not breaking eochat on
// every purely-additive engine release.
const SUPPORTED_CORPUS_API = new Set([1, 2]);
if (!SUPPORTED_CORPUS_API.has(CORPUS_API_VERSION)) {
  throw new Error(
    `@eoreader/host/corpus is API v${CORPUS_API_VERSION}; this bridge supports v${[...SUPPORTED_CORPUS_API].join(", v")}`,
  );
}

// ── Pools & sessions ──

export const DEFAULT_POOL = "corpus";

// poolName -> { name, session, sources: Map<sourceKey, info>, chunkCount }
const pools = new Map();

function pool(name = DEFAULT_POOL) {
  const key = name || DEFAULT_POOL;
  let p = pools.get(key);
  if (!p) {
    p = { name: key, session: createSession({ spanCap: Number.MAX_SAFE_INTEGER }), sources: new Map(), chunkCount: 0 };
    pools.set(key, p);
  }
  return p;
}

export function ensureSession(poolName = DEFAULT_POOL) {
  return pool(poolName).session;
}

export function listPools() {
  return Array.from(pools.keys());
}

// Locate the pool whose span registry holds `spanId`. Span ids are
// content-addressed, so a collision across pools would mean identical bytes
// from an identical source id — the same span by every definition the registry
// has. Reads therefore don't need the caller to know which pool it searched.
function poolForSpan(spanId) {
  for (const p of pools.values()) if (p.session.spans.has(spanId)) return p;
  return null;
}

// ── Ingest ──

// `displayName` is for sources whose id carries no usable filename — an upload
// or a URL — where stripping to the last path segment would yield noise.
// `kind` labels what this source IS ("corpus", "prior-raw", "prior-card"); it
// travels to /api/sources so the UI can pill priors differently from texts.
export function engineIngestText(text, sourceId, displayName, { pool: poolName = DEFAULT_POOL, kind = "corpus" } = {}) {
  const p = pool(poolName);
  const { chunks, admitted } = admitChunked(p.session, { text, sourceId });
  p.chunkCount += chunks;
  const name = displayName || sourceId?.replace(/^.*[/\\]/, "") || "(unnamed)";
  p.sources.set(sourceId || name, { name, chunks, kind, pool: p.name, ingestedAt: Date.now() });
  return {
    sourceId,
    // "One name per thing": /api/sources publishes this same value as `path`.
    path: sourceId,
    chunks,
    pool: p.name,
    entries: admitted.map((a, i) => ({ id: `chunk-${i}`, size: a.byteEnd - a.byteStart })),
  };
}

// Splices the ingest worker's admission result into a real, persistent pool
// session — the counterpart to ingest-worker.js running admitChunked/
// ingestFile against a throwaway one. Mirrors admitChunked's own merge
// behavior exactly (see @eoreader/host/corpus.js): a fresh docId is set
// outright, a docId that already exists gets its chunks/pieces concatenated
// (not its `text`, which is what the real function does too — a quirk this
// preserves rather than "fixes", since fixing it here would mean this host
// diverging from what re-running admitChunked on the main thread would have
// produced).
function mergeIngestResult(p, result) {
  for (const [spanId, span] of result.spans) p.session.spans.set(spanId, span);
  const existingDoc = p.session.documents.get(result.docId);
  if (existingDoc && result.doc) {
    existingDoc.chunks = existingDoc.chunks.concat(result.doc.chunks);
    existingDoc.pieces = existingDoc.pieces.concat(result.doc.pieces);
  } else if (result.doc) {
    p.session.documents.set(result.docId, result.doc);
  }
  for (const [refId, entry] of result.provenance) {
    if (!p.session.provenance.has(refId)) {
      p.session.provenance.set(refId, entry);
      p.session.provenance.tick++;
    }
  }
}

// Off-main-thread counterpart to engineIngestText — see ingest-worker.js for
// why this exists (LAWS.md L1d: a large admitChunked call blocks the whole
// event loop, so no concurrent request, including an unrelated chat turn's
// SSE handshake, can be acknowledged until it returns). Same signature, same
// return shape, same bookkeeping — just awaited, and the expensive part runs
// in a worker thread instead of this one.
export async function engineIngestTextAsync(text, sourceId, displayName, { pool: poolName = DEFAULT_POOL, kind = "corpus" } = {}) {
  const p = pool(poolName);
  const result = await runIngestInWorker({ kind: "text", text, sourceId });
  mergeIngestResult(p, result);
  p.chunkCount += result.chunks;
  const name = displayName || sourceId?.replace(/^.*[/\\]/, "") || "(unnamed)";
  p.sources.set(sourceId || name, { name, chunks: result.chunks, kind, pool: p.name, ingestedAt: Date.now() });
  return {
    sourceId,
    // "One name per thing": /api/sources publishes this same value as `path`.
    path: sourceId,
    chunks: result.chunks,
    pool: p.name,
    entries: result.admitted.map((a, i) => ({ id: `chunk-${i}`, size: a.byteEnd - a.byteStart })),
  };
}

// ── Search ──

// A source filter is either one name or a set of them — the UI's per-source
// toggles hand us the list of sources the reader left switched on. Matching is
// on basename, since callers hold display names while spans hold full ids.
//
// The three states are distinct and must stay so: absent (null/undefined/"")
// means "no filter, every source"; a non-empty set means "only these"; an
// EMPTY ARRAY means the reader switched every source off and must match
// nothing. Collapsing that last case to "everything" would answer from
// sources the reader explicitly excluded.
function sourceMatcher(sourceFilter) {
  if (sourceFilter == null || sourceFilter === "") return null;
  const bases = (Array.isArray(sourceFilter) ? sourceFilter : [sourceFilter])
    .map((x) => String(x).replace(/^.*[/\\]/, ""))
    .filter(Boolean);
  if (!Array.isArray(sourceFilter) && !bases.length) return null;
  return (sp) => !!sp.source_id && bases.some((b) => sp.source_id.includes(b));
}

// ── Prior steering ──
//
// Retrieval is widened by witness-tier coref priors before searchSpans runs.
// A query that names "the creature" activates the pg84-frankenstein prior's
// creature referent, and its OTHER surfaces ("the monster", "the wretch", …)
// are added to the search terms, so a passage that says "the monster" scores
// against a query that said "creature". This is the engine's canonical path
// (presence → referents → per-text priors) exercised through the same bridge
// holonic-task.js uses; nothing here resolves identity itself, and a prior's
// surfaces never appear in any prompt as rules — they only steer which spans
// the engine returns (AGENTS.md: "priors steer retrieval; never model
// context").
//
// Only expansion surfaces join the query — forms already in the query are
// already there. A referent that did NOT match the query contributes nothing,
// so a query about "Pierre" is never widened toward Frankenstein's creature.
// A pool whose sources have no coref priors (or a query that activates none)
// returns the query unchanged, and `priorWidening` is null so a caller can
// tell steering happened from a straight lexical search.
function widenQueryWithPriors(query, poolName) {
  const text = String(query ?? "");
  if (!text.trim()) return { searchQuery: text, priorWidening: null };
  const p = pool(poolName);
  const widening = [];
  for (const [sourcePath, info] of p.sources) {
    const prior = loadCorefPrior(info?.id || sourcePath);
    if (!prior || prior.gap) continue;
    const { activated } = activatePriors(text, prior);
    for (const a of activated || []) {
      if (!a.expansionSurfaces?.length) continue;
      widening.push({
        referentId: a.referentId,
        display: a.display,
        priorId: a.priorId,
        sourceId: sourcePath,
        surfaces: a.expansionSurfaces,
      });
    }
  }
  if (!widening.length) return { searchQuery: text, priorWidening: null };
  return {
    searchQuery: [...text.split(/\s+/).filter(Boolean), ...widening.flatMap((w) => w.surfaces)].join(" "),
    priorWidening: widening,
  };
}

export function engineSearch(query, limit = 10, { maxChars = 800, source: sourceFilter, pool: poolName = DEFAULT_POOL } = {}) {
  const s = ensureSession(poolName);
  const { searchQuery, priorWidening } = widenQueryWithPriors(query, poolName);
  let { spans, gaps } = searchSpans(s, { query: searchQuery, limit: Math.min(limit, 40) });
  const match = sourceMatcher(sourceFilter);
  if (match) spans = spans.filter(match);
  const units = spanUnits(s, spans);
  return {
    query,
    priorWidening,
    pool: poolName,
    total: spans.length,
    passages: spans.map((sp, i) => {
      const full = units[i]?.text ?? sp.preview;
      const cap = Math.max(1, maxChars);
      const truncated = full.length > cap;
      const text = full.slice(0, cap);
      // byte_end must describe what `text` actually covers, never the whole
      // span. A caller reads bytes [byte_start, byte_end) from the source file
      // to VERIFY a citation (UX-DESIGN.md's "citation verifiability: 100% of
      // citations link to exact source") — reporting the full span's byte_end
      // while returning a truncated `text` made every truncated passage's
      // citation promise more than it delivered, and a byte-range read of the
      // file would not equal `text` at all. Truncation is character-count, not
      // byte-count, so the boundary must be re-measured in UTF-8 bytes rather
      // than assumed equal to the character count.
      const byte_end = truncated && sp.byte_start != null
        ? sp.byte_start + Buffer.byteLength(text, "utf8")
        : sp.byte_end;
      return {
        span_id: sp.span_id,
        text,
        truncated,
        source: sp.source_id || "",
        byte_start: sp.byte_start,
        byte_end,
        score: sp.score,
        coverage: sp.coverage,
        phrase: sp.phrase,
        preview: sp.preview,
      };
    }),
    gaps,
  };
}

// ── Fold & ground ──

// Build a context string that includes numbered verbatim citations the LLM
// can actually cite from.  The fold summary (if any) follows below.
// Hard ceiling on how much of one passage reaches the model.
//
// The fold reports a token count, but the emitted context was assembled from
// each span's FULL text, so a grounding that reported ~700 tokens produced a
// 34,208-character system message. Against an 8192-token window that overflows
// and the model receives a prompt truncated mid-passage — it then answered that
// "some parts of the text were not properly" formed and cited nothing, which
// reads exactly like a retrieval failure when retrieval was in fact fine.
//
// Truncation here is explicit and marked, so a shortened passage is visibly
// shortened rather than silently ending mid-sentence.
const MAX_CITATION_CHARS = 1200;

function buildCitedContext(kept, foldResult, gaps) {
  const parts = [];

  // Numbered verbatim citations — these are what the LLM cites with [1], [2]
  if (kept.length > 0) {
    const citationBlock = kept
      .map((c, i) => {
        const src = c.source_id?.replace(/^source:/, "").replace(/:chunk-\d+$/, "") || "?";
        const full = String(c.text ?? "");
        const text = full.length > MAX_CITATION_CHARS
          ? full.slice(0, MAX_CITATION_CHARS) + " […truncated]"
          : full;
        return `[${i + 1}] (${src} @ byte ${c.byte_start}-${c.byte_end})\n${text}`;
      })
      .join("\n\n");
    parts.push(`=== CITED PASSAGES ===\n${citationBlock}`);
  }

  // The fold summary is deliberately NOT sent to the talker.
  //
  // It restates the same spans in unnumbered prose, so it was both the bulk of
  // the prompt (~16K of a 27K system message, dwarfing the 8 capped passages it
  // duplicated) and directly counterproductive: the one thing the talker must
  // do is attach each claim to a NUMBERED passage, and this handed it a large block
  // of citable-looking text carrying no number. The measured result was an
  // answer consisting of the single token "[7]".
  //
  // It remains on the returned object, so the UI can still show the fold — it
  // just is not part of what the model is asked to write from.

  // Gaps
  if (gaps?.length) {
    parts.push(`[Engine gaps: ${gaps.map(g => g.reason || g).join("; ")}]`);
  }

  return parts.join("\n\n");
}

// Search + fold into a single compact context block the LLM can consume.
// Returns the folded summary and the underlying evidence passages so the UI
// can display citations.
//
// Citations returned here carry the engine's full mechanical citation record:
//   span_id, source_id, byte_start, byte_end (allowing verification against
//   the original file), the full verbatim text from the span registry, and
//   score.  The text is the EXACT admitted value — not a preview, not a
//   reconstruction.  Callers that need a shorter snippet truncate explicitly
//   rather than accepting a silently-lossy default.
// searchSpans' score is corpus-wide rarity-weighted coverage (eoreader6
// packages/host/corpus.js), not a fixed-scale probability — but its floor and
// ceiling are measured on the real corpus this bridge serves. A query sharing
// no real content word with the corpus (e.g. "who is neil armstrong" against
// War and Peace) scores ~0.10 — both matched words are near-ubiquitous, so
// their combined weight is small next to the unmatchable rare terms padding
// the denominator. A query that shares even one genuine content word scores
// 0.33+ (measured: "who is Pierre Bezukhov" — "bezukhov" doesn't occur in
// this PG edition at all, yet the surviving "pierre" match alone still clears
// 0.32). 0.2 sits in the measured gap between those two regimes. Below it,
// the fold was about to hand the model a citation number for text NOT worth
// citing — the failure mode this constant exists to close: an off-topic query
// retrieved a real (if irrelevant) span, and the model, told a citation was
// found, invented plot detail and attributed it to that span's number.
const MIN_RELEVANCE_SCORE = 0.2;

export function engineGroundQuery(query, { budget = 2400, maxUnits = 16, limit = 30, minScore = MIN_RELEVANCE_SCORE, source: sourceFilter, pool: poolName = DEFAULT_POOL } = {}) {
  const s = ensureSession(poolName);
  const { searchQuery, priorWidening } = widenQueryWithPriors(query, poolName);
  let { spans, gaps } = searchSpans(s, { query: searchQuery, limit });
  const match = sourceMatcher(sourceFilter);
  if (match) spans = spans.filter(match);
  // Below the floor, a span is noise wearing a citation number, not evidence
  // (see MIN_RELEVANCE_SCORE). Filtered here, before folding, so `retrieved`
  // below still reports these spans (kept: false) for transparency — `total`
  // stays an honest count of everything search found, only the fold's
  // citation numbers get withheld from what didn't earn them.
  let units = spanUnits(s, spans).filter((u) => (u.score ?? 0) >= minScore);

  // When a prior activated, prefer that referent's source on EQUAL score.
  // foldSpans breaks ties by insertion order, and insertion order is
  // ingestion order — so in a pool holding several books, the biggest,
  // first-ingested one won every tie and its noise passages slid into the
  // fold ahead of the source the reader actually named. The reader's words
  // activated a prior whose surfaces are in play; on equal evidence the
  // fold should look there first. This changes NO score — a prior-activated
  // source still must earn its place — it only decides the order the fold
  // visits equal-score passages.
  if (priorWidening?.length) {
    const activatedPaths = priorWidening.map((w) => w.sourceId).filter(Boolean);
    const isActivated = (sourceId) =>
      activatedPaths.some((p) => String(sourceId || "").includes(String(p)));
    units.sort((a, b) => {
      const sc = (b.score || 0) - (a.score || 0);
      if (sc !== 0) return sc;
      return (isActivated(b.meta?.source_id) ? 1 : 0) - (isActivated(a.meta?.source_id) ? 1 : 0);
    });
  }

  const foldResult = foldSpans(s, { units, query, tokenBudget: budget, maxUnits });

  // Extract the full mechanical citation record for every kept span.
  // The span registry holds byte_start/byte_end and the verbatim admitted text.
  const kept = (foldResult.selected || []).map((u) => {
    const spanId = u.meta?.span_id;
    const rec = spanId ? s.spans.get(spanId) : null;
    return {
      span_id: spanId,
      source_id: rec?.source_id ?? u.meta?.source_id ?? u.meta?.source ?? "unknown",
      byte_start: rec?.byte_start ?? null,
      byte_end: rec?.byte_end ?? null,
      score: rec?.score ?? u.meta?.score ?? 0,
      text: rec?.text ?? u.text ?? "",
    };
  });

  // A unit wider than the whole token budget is dropped entire, not trimmed —
  // so a long passage that matched best can leave zero citations behind while
  // `total` still reports a healthy match count. Silently that reads as "the
  // model ignored its evidence"; it is really "the evidence never fit". Report
  // it as a typed gap so the reader sees which it was.
  if (foldResult.dropped > 0) {
    gaps = [...(gaps || []), {
      type: "fold_budget_exceeded",
      dropped: foldResult.dropped,
      budget: foldResult.budget ?? budget,
      reason: `${foldResult.dropped} matched passage(s) exceeded the ${foldResult.budget ?? budget}-token fold budget and were dropped, not truncated${kept.length === 0 ? " — no citation survives for this query" : ""}`,
    }];
  }

  // Build a context that includes verbatim citation text the LLM can cite
  const context = buildCitedContext(kept, foldResult, gaps);

  // The FULL ranked list, not just the survivors. `total: 12, folded: 2` tells
  // a reader that ten passages vanished but not which, nor why — so the fold
  // reads as loss rather than as a decision. Emitting every retrieved span with
  // its rank, its ranking evidence, and whether the fold kept it makes the
  // whole retrieval step inspectable the moment it finishes, before any model
  // has spoken.
  const keptIds = new Set(kept.map((c) => c.span_id));
  const retrieved = spans.map((sp, i) => {
    const citationIndex = kept.findIndex((c) => c.span_id === sp.span_id);
    return {
      rank: i + 1,
      span_id: sp.span_id,
      source_id: sp.source_id,
      byte_start: sp.byte_start,
      byte_end: sp.byte_end,
      score: sp.score,
      coverage: sp.coverage,
      phrase: sp.phrase,
      preview: sp.preview,
      kept: keptIds.has(sp.span_id),
      // The [n] the model will cite this as, when the fold kept it.
      citation: citationIndex >= 0 ? citationIndex + 1 : null,
    };
  });

  return {
    query,
    priorWidening,
    context,
    citations: kept,
    retrieved,
    total: spans.length,
    folded: foldResult.selectedCount,
    tokens: foldResult.tokens,
    budget: foldResult.budget,
    dropped: foldResult.dropped,
    gaps,
  };
}

// The instruction text wrapping a groundResult into a talker-ready system
// message — pulled out of proxy.js's turn handler so a second caller (the
// no-generation /api/ground route, used by any client that runs its own
// model — e.g. a browser-local WebLLM engine — over the same evidence) gets
// the identical wording instead of a hand-copied drift of it. Pure: no I/O,
// no ambient time: everything it needs is already in groundResult/warming.
export function buildUngroundedSystemPrompt({ warming } = {}) {
  return warming
    ? `Answer the reader's question directly, from your own knowledge, as naturally as you would in ` +
      `ordinary conversation. Do not mention an index, a document search, sources, or any retrieval ` +
      `process. Do NOT use bracketed citations like [1] — there are no passages to cite.`
    : `Answer the reader's question directly, from your own knowledge, as naturally as you would in ` +
      `ordinary conversation. Do not preface the answer or otherwise mention that you lack sources, ` +
      `documents, or "source material" — just answer. Do NOT use bracketed citations like [1], [2] — ` +
      `there are no source passages, and a bracket would look like a citation that does not exist.`;
}

// `toolsAvailable` defaults to true (the server's own tool-calling talker
// loop). A caller with no tool loop of its own — e.g. a browser-local model
// that only ever sees this one turn of context — passes it false so the
// prompt does not tell the model to reach for tools it will never receive.
export function buildGroundedSystemPrompt(groundResult, { toolsAvailable = true } = {}) {
  const citationRange = groundResult.citations.length > 0
    ? `You have ${groundResult.citations.length} source passage(s) numbered [1] through [${groundResult.citations.length}]. ` +
      `ONLY cite these numbers. NEVER cite [${groundResult.citations.length + 1}] or higher — those do not exist. `
    : "";

  const toolsParagraph = toolsAvailable
    ? `IMPORTANT: You have access to tools. If the material above is ` +
      `insufficient, use verbatim_search to find more exact passages from ` +
      `ingested documents, or search_memory for relevant context. Do NOT say ` +
      `"no information" without first trying these tools.\n\n`
    : "";

  return `Answer the reader's question using the material below, citing the passages you draw on ` +
    `with bracketed numbers like [1], [2], etc. ` +
    citationRange +
    `Do NOT invent facts beyond what the material contains. If it does not contain the answer, ` +
    `say so plainly — but do not describe your process, and do not refer to "the source material", ` +
    `"the provided text", "your sources", or similar; just answer directly.\n\n` +
    toolsParagraph +
    `--- Material (${groundResult.total} passages found, ${groundResult.folded} folded, ${groundResult.tokens} tokens) ---\n` +
    `${groundResult.context}`;
}

// Read a specific span's verbatim text by span_id.
// Returns { text, source_id, byte_start, byte_end, truncated } or an error.
// The engine's readSpan guarantees the text matches the source file at the
// reported byte range — that's the mechanical citation contract.
export function engineReadSpan(spanId, maxBytes = 4000) {
  const p = poolForSpan(spanId);
  if (!p) return { error: `unknown span_id ${spanId}. Search first.` };
  return { ...readSpan(p.session, { spanId, maxBytes }), pool: p.name };
}

// ── Context snipping: read segments and arbitrary windows ──
//
// OMNIMODAL CONSTRAINT: no hardcoded patterns.  A "segment" boundary is
// discovered dynamically from whatever structure the text actually has —
// Roman numerals, Arabic chapter numbers, all-caps headings, blank-line
// breaks, or content-signal discontinuities.  A symphony movement with no
// names and no text is a valid first-class target; the detector works if
// structural markers exist and degrades gracefully (context window) if they
// don't.

function resolveSourcePath(sourceId) {
  const match = sourceId?.match(/^source:(.+?)(?::chunk-\d+)?$/);
  return match ? match[1] : null;
}

// Byte-accurate view of a file, cached per (path, mtime, size).
//
// Anchors from the engine are UTF-8 BYTE offsets. Reading a file with
// encoding "utf8" and then calling .slice(byteStart, byteEnd) indexes by
// UTF-16 code unit instead, so every anchor past the first non-ASCII
// character in the file comes back shifted — silently, with plausible-looking
// text. That is the unfalsifiable-citation failure corpus.js's header calls
// out, arriving through the back door. Priors made it unmissable: their
// corpus labels are full of Sanskrit and Chinese transliterations, so the
// drift starts within the first few hundred bytes. Everything below therefore
// slices the Buffer and decodes after, never the decoded string.
const lineIndexCache = new Map();

// The index itself, over a Buffer whose provenance is the caller's business.
// Shared by the on-disk and in-memory paths so both produce byte-identical
// offsets — if these two ever diverge, a citation read from memory and the
// same citation read from disk would disagree, which is the one thing a
// verbatim engine may never do.
function bufferIndex(buf, key) {
  const lines = buf.toString("utf8").split("\n");
  // starts[i] is the byte offset of line i. Measured with byteLength, not
  // string length, so it stays true across multi-byte characters.
  const starts = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = at;
    at += Buffer.byteLength(lines[i], "utf8") + 1; // +1 for the \n
  }
  return { key, buf, lines, starts, bytes: buf.length };
}

function fileIndex(filePath) {
  const stat = fs.statSync(filePath);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = lineIndexCache.get(filePath);
  if (hit && hit.key === key) return hit;

  const rec = bufferIndex(fs.readFileSync(filePath), key);
  lineIndexCache.set(filePath, rec);
  return rec;
}

// Byte index for one ingested document — from disk when the source really is a
// file, from the engine's retained text when it is not.
//
// The byte readers were written when the corpus arrived by file ingest, so they
// indexed doc.path directly. But every source a reader attaches through the UI
// is ingested as *content* — an upload, or a fetched URL — and carries a
// synthetic `source:name:timestamp` id that no filesystem can stat. Reading a
// citation's raw bytes therefore failed with ENOENT for exactly the sources
// readers actually create, while working for the bundled books nobody chose.
// Removing the boot-time file ingest made that universal rather than merely
// common. A quote you cannot follow to its source is an unfalsifiable citation,
// which is the failure this application exists to prevent (LAWS.md L2f).
//
// Caching is by document id and text length: retained text for an id does not
// change without a re-ingest, and a re-ingest mints a new id.
const retainedIndexCache = new Map();

function docByteIndex(session, doc) {
  if (doc?.path) {
    try {
      if (fs.statSync(doc.path).isFile()) return fileIndex(doc.path);
    } catch { /* not a real file — fall through to retained text */ }
  }

  const retained = corpusFacade.documentText(session, doc.id);
  const text = retained?.text;
  if (typeof text !== "string") {
    return {
      error: `no readable body for "${doc.base || doc.id}" — not a file on disk, and the engine retained no text for it`,
    };
  }
  const key = `${doc.id}:${text.length}`;
  const hit = retainedIndexCache.get(doc.id);
  if (hit && hit.key === key) return hit;
  const rec = bufferIndex(Buffer.from(text, "utf8"), key);
  retainedIndexCache.set(doc.id, rec);
  return rec;
}

// Index of the line containing `byteOffset` (binary search over starts).
function lineAtByte(idx, byteOffset) {
  let lo = 0;
  let hi = idx.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.starts[mid] <= byteOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const sliceBytes = (buf, start, end) => buf.subarray(start, end).toString("utf8");

// Score a line as a potential structural delimiter.  Returns 0–5.
// Clues: short, followed by blank line, contains numbering or formatting
// that makes it look like a heading rather than a sentence.
function headingScore(line, nextLineBlank) {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return 0;
  // Markdown ATX headings ("# ", "## ", … "###### ") are an unambiguous
  // structural marker — the writer said "this is a heading" in the syntax
  // itself, so this does not need the blank-line-follows/sentence-shape
  // heuristics below, which exist to disambiguate weaker signals (ALL CAPS,
  // "Chapter 1") in prose that carries no such marker. Without this, every
  // prior card (server/priors-source.js::renderCard) and any plain .md
  // source outlines as one unnavigable blob — real "# "/"## " headings never
  // scored above 0.
  if (/^#{1,6}\s+\S/.test(trimmed)) return 5;
  if (!nextLineBlank) return 0;
  // Penalize sentence-like lines (end with ?.! or have multiple capitalized words).
  // Trailing quotation marks are stripped first: a line ending `Bolkónskaya.”`
  // is the tail of a speech, but the raw test only sees the curly quote and
  // waves it through — which is how "Mary Bolkónskaya.”" ended up in the
  // outline of War and Peace as though it were a chapter.
  const unquoted = trimmed.replace(/["'‘’“”]+$/, "");
  if (/[?.!]$/.test(unquoted) && !/^[IVXLCDM]+\.$/.test(unquoted)) return 0;
  // Abbreviation exclusion
  if (/^(M[\. ]|Dr[\. ]|Mr[\. ]|Mme[\. ]|Mlle[\. ]|St[\. ])/i.test(trimmed)) return 0;
  let s = 0;
  if (/^[IVXLCDM]+\.\s/.test(trimmed)) s += 3;
  if (/^\d+[).]\s/ .test(trimmed)) s += 3;
  // A label closed by a bare ordinal \u2014 "Chapter 1", "Letter 4", "Movement 3" \u2014
  // or an ordinal standing alone. The clue below it only fires on a word
  // followed by another CAPITALIZED word, and a digit is not one, so this
  // whole family scored zero: Frankenstein is headed this way from end to end
  // and was arriving as one unnavigable 400KB section.
  // Form, not vocabulary \u2014 nothing here knows what "chapter" means, and it
  // fires identically on a numbered movement in a score with no words at all.
  if (/^[A-Za-z][\w'\u2019]*\s+\d{1,4}$/.test(trimmed) || /^\d{1,4}$/.test(trimmed)) s += 3;
  if (/^[A-Z\s'"\u201c\u201d]{4,}$/.test(trimmed) || /^[A-Z][a-z]+\s+[A-Z]/.test(trimmed)) s += 2;
  if (/[?.!]$/.test(trimmed)) s -= 2;
  return s >= 2 ? s : 0;
}

// Strip a Markdown ATX marker ("## ") from a heading line for display. Offset
// math always runs against the raw line; this only affects the label shown
// to a reader, so "## Declared" reads as "Declared" instead of carrying its
// own syntax as if that were part of the title.
function stripHeadingMarker(label) {
  return label.replace(/^#{1,6}\s+/, "");
}

// Dynamically discover segment boundaries near a byte offset by examining
// all candidate heading lines within a text window and finding the structural
// cluster that contains the anchor.
// Operates on the cached line index, so every position here is a byte offset
// and the anchor comparison is unit-consistent. Previously the line walk
// accumulated `line.length + 1` (characters) and compared it against a byte
// anchor, which drifted apart over any non-ASCII text.
function discoverSegment(idx, nearByte) {
  const radius = Math.min(6000, idx.bytes >> 2);
  const loByte = Math.max(0, nearByte - radius);
  const hiByte = Math.min(idx.bytes, nearByte + radius);
  const firstLine = lineAtByte(idx, loByte);
  const lastLine = lineAtByte(idx, hiByte);
  const anchorIdx = lineAtByte(idx, nearByte);

  const isHeading = (i) => {
    const nextBlank = i + 1 < idx.lines.length && idx.lines[i + 1].trim() === "";
    return headingScore(idx.lines[i], nextBlank) > 0;
  };

  let startIdx = null;
  let endIdx = null;
  for (let i = anchorIdx; i >= firstLine; i--) if (isHeading(i)) { startIdx = i; break; }
  for (let i = anchorIdx + 1; i <= lastLine; i++) if (isHeading(i)) { endIdx = i; break; }
  if (startIdx == null && endIdx == null) return null;
  // No heading behind the anchor within the window: the window edge is where
  // we start reading, but it is NOT a boundary we found. Remembering which of
  // the two it is matters, because the line sitting at an arbitrary offset is
  // mid-sentence, and naming the segment after it reports a fabricated
  // structure — "in her innocence; I knew it. Could the dæmon who had (I did
  // not for a" was being returned as a segment title. A window is a window;
  // say so rather than dressing it as a chapter.
  const startFound = startIdx != null;
  if (!startFound) startIdx = firstLine;

  let headingCount = 0;
  for (let i = firstLine; i <= lastLine; i++) if (isHeading(i)) headingCount++;

  return {
    startByte: idx.starts[startIdx],
    endByte: endIdx != null ? Math.max(idx.starts[startIdx], idx.starts[endIdx] - 1) : hiByte,
    label: startFound ? stripHeadingMarker(idx.lines[startIdx].trim()) : "(context window — no heading precedes this passage)",
    headingCount,
  };
}

// Whole-document outline: the same detector as discoverSegment, run across an
// entire text instead of a window around one anchor.  A reader needs every
// boundary, not just the pair bracketing a citation.
//
// Two deliberate refusals here:
//
//  1. Offsets are UTF-16 code-unit indices into the string passed in, NOT the
//     UTF-8 byte offsets the engine's span anchors use.  The only consumer is
//     a client that already holds this exact string and slices it with
//     String.prototype.slice; handing it bytes would reintroduce the drift
//     fileIndex() exists to prevent.
//  2. No `level`.  Deciding that one heading nests under another is a holon-
//     level claim, and level is discovered from existence-dependency, never
//     inferred from a heading's typographic form.  An all-caps line is not
//     evidence that the numbered line below it is its child.  The outline is
//     therefore flat, and honest about being flat.
//
// Fewer than two boundaries is a typed gap, not a one-entry table of contents:
// a document we found no structure in should say so, not present its whole
// body as a section called "Content".
export function outlineOfText(text, { max = 500 } = {}) {
  const body = String(text ?? "");
  if (!body.trim()) return { headings: [], gap: "empty text" };

  const lines = body.split("\n");
  const starts = new Array(lines.length);
  for (let i = 0, at = 0; i < lines.length; i++) {
    starts[i] = at;
    at += lines[i].length + 1; // +1 for the \n
  }

  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const nextBlank = i + 1 < lines.length && lines[i + 1].trim() === "";
    if (!headingScore(lines[i], nextBlank)) continue;
    candidates.push({
      label: stripHeadingMarker(lines[i].trim()),
      // Where the heading line itself begins, and where its body does. The
      // reader renders the label from `label`, so it slices from bodyStart to
      // avoid printing the heading twice.
      start: starts[i],
      bodyStart: starts[i] + lines[i].length + 1,
    });
  }

  // A book's own printed table of contents is a wall of perfectly heading-
  // shaped lines — on War and Peace it yields 500 of them before the narrative
  // even starts, an outline that navigates nothing but the index. What
  // separates a listing from a structure is not how the line is typeset but
  // what lies under it: a real boundary opens onto a body, a TOC entry opens
  // onto the next TOC entry. So a candidate earns its place by what follows
  // it. The front matter this discards is not lost — it falls into the
  // preamble, which the reader still renders.
  //
  // The same test drops running heads, part-title pages and stray all-caps
  // lines without any of them having to be named.
  const MIN_BODY = 200; // less than a paragraph of substance ⇒ a listing
  const found = [];
  for (let i = 0; i < candidates.length && found.length < max; i++) {
    const to = i + 1 < candidates.length ? candidates[i + 1].start : body.length;
    const substance = body.slice(candidates[i].bodyStart, to).replace(/\s+/g, "");
    if (substance.length >= MIN_BODY) found.push(candidates[i]);
  }

  if (found.length < 2) {
    return {
      headings: [],
      gap: found.length
        ? "only one structural boundary detected — not enough to be an outline"
        : "no structural boundaries detected",
    };
  }

  const headings = found.map((h, i) => ({
    label: h.label,
    start: h.start,
    bodyStart: Math.min(h.bodyStart, body.length),
    end: i + 1 < found.length ? found[i + 1].start : body.length,
  }));
  return {
    headings,
    gap: null,
    truncated: found.length >= max,
    // Text before the first heading is real content (a title page, a preamble)
    // and the reader has to show it; it just has no label of its own.
    preambleEnd: headings[0].start,
  };
}

// Outline of an ingested source, in byte offsets.
//
// outlineOfText indexes a JS string, so its offsets are UTF-16 code units. The
// reader pages through /api/source/text, which is byte-addressed like every
// other anchor in the engine. On an ASCII-ish book the two agree closely enough
// to look correct and drift silently after the first multi-byte character —
// the exact failure fileIndex exists to prevent. So the conversion happens here,
// once, against the same buffer the reader will be served from.
//
// Both offsets are returned: `start`/`end` stay code-unit (what outlineOfText
// measured) and `byte_start`/`byte_end` are what /api/source/text wants. A
// consumer that mixes them is then making a visible mistake, not an invisible one.
export function engineOutlineOfSource(sourceRef, { pool: poolName = DEFAULT_POOL, max = 500 } = {}) {
  const session = ensureSession(poolName);
  const resolved = resolveDocument(session, sourceRef);
  if (resolved.error) return { error: resolved.error };
  const doc = resolved.doc;

  let idx;
  try { idx = fileIndex(doc.path); } catch (e) {
    return { error: `Cannot read ${doc.path}: ${e.message}` };
  }

  const text = idx.buf.toString("utf8");
  const outline = outlineOfText(text, { max });

  // One forward pass over the cut points rather than a byteLength(slice(0,n))
  // per heading, which would re-measure the whole prefix 32+ times.
  const marks = new Set();
  for (const h of outline.headings || []) {
    marks.add(h.start); marks.add(h.bodyStart); marks.add(h.end);
  }
  if (outline.preambleEnd != null) marks.add(outline.preambleEnd);
  const sorted = [...marks].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const byteAt = new Map();
  let cursor = 0, bytes = 0;
  for (const mark of sorted) {
    bytes += Buffer.byteLength(text.slice(cursor, mark), "utf8");
    cursor = mark;
    byteAt.set(mark, bytes);
  }
  const B = (n) => (n == null ? null : byteAt.get(n) ?? null);

  return {
    source: doc.path,
    source_id: doc.id,
    name: doc.base,
    pool: poolName,
    total_bytes: idx.bytes,
    gap: outline.gap ?? null,
    truncated: outline.truncated ?? false,
    preambleEnd: outline.preambleEnd ?? null,
    preamble_byte_end: B(outline.preambleEnd),
    headings: (outline.headings || []).map((h) => ({
      label: h.label,
      start: h.start,
      bodyStart: h.bodyStart,
      end: h.end,
      byte_start: B(h.start),
      body_byte_start: B(h.bodyStart),
      byte_end: B(h.end),
    })),
  };
}

// Read the segment (chapter, section, movement) containing the content
// described by query.  Boundary detection is dynamic and text-agnostic —
// works for CHAPTER I, I. Title, 1. Section, all-caps headings, etc.
export function engineReadSegment(query, maxBytes = 100000, sourceFilter, { pool: poolName = DEFAULT_POOL } = {}) {
  const s = ensureSession(poolName);
  let { spans } = searchSpans(s, { query, limit: 5 });
  if (!spans.length) return { error: `Segment not found: "${query}"` };
  // Optionally filter by source_id prefix
  if (sourceFilter) {
    const sf = sourceFilter.replace(/^.*[/\\]/, "");
    const filtered = spans.filter(sp => sp.source_id && sp.source_id.includes(sf));
    if (!filtered.length) return { error: `Segment not found in "${sourceFilter}"` };
    spans = filtered;
  }

  const best = spans[0];
  const sourcePath = resolveSourcePath(best.source_id);
  if (!sourcePath) return { error: `Cannot resolve source from "${best.source_id}"` };

  let idx;
  try { idx = fileIndex(sourcePath); } catch (e) {
    return { error: `Cannot read ${sourcePath}: ${e.message}` };
  }

  const anchor = best.byte_start || 0;
  const seg = discoverSegment(idx, anchor);
  if (!seg) {
    const from = Math.max(0, anchor - 2000);
    const to = Math.min(idx.bytes, anchor + maxBytes);
    return {
      segment: "(no structural boundary detected)",
      source: sourcePath,
      byte_start: from,
      byte_end: to,
      truncated: false,
      text: sliceBytes(idx.buf, from, to),
    };
  }

  const length = Math.min(seg.endByte - seg.startByte, maxBytes);
  const segText = sliceBytes(idx.buf, seg.startByte, seg.startByte + length);

  return {
    segment: seg.label,
    source: sourcePath,
    byte_start: seg.startByte,
    byte_end: seg.startByte + length,
    truncated: length < (seg.endByte - seg.startByte),
    heading_count: seg.headingCount,
    text: segText,
  };
}

// Read an arbitrary byte range of one ingested source.
//
// The reader needs this and nothing else can serve it. /api/attachments/content
// only knows session uploads, so the corpus ingested at startup — the three
// books — had no readable body at all; verbatim/segment and verbatim/read both
// require a query or a span_id, which a reader paging through a document does
// not have. The unit here is the byte range the fold's divisions already speak
// in, so an outline click and the text it lands on are the same coordinates.
//
// Reads through fileIndex for the same reason engineReadSegment does: the
// engine's anchors are UTF-8 byte offsets, and slicing a JS string by them
// shifts every read past the first multi-byte character.
export function engineReadSourceBytes(sourceRef, { pool: poolName = DEFAULT_POOL, start = 0, end = null, maxBytes = 200000 } = {}) {
  const session = ensureSession(poolName);
  const resolved = resolveDocument(session, sourceRef);
  if (resolved.error) return { error: resolved.error };
  const doc = resolved.doc;

  let idx;
  try { idx = docByteIndex(session, doc); } catch (e) {
    return { error: `Cannot read ${doc.path}: ${e.message}` };
  }
  if (idx.error) return { error: idx.error };

  const total = idx.bytes;
  const from = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, total));
  // No `end` means "from here on", still capped — an unbounded default would
  // hand a whole book to a reader that asked for a page.
  const wantedEnd = end == null ? total : Math.max(from, Math.min(end, total));
  const to = Math.min(wantedEnd, from + maxBytes);

  return {
    source: doc.path,
    source_id: doc.id,
    name: doc.base,
    pool: poolName,
    byte_start: from,
    byte_end: to,
    total_bytes: total,
    truncated: to < wantedEnd,
    text: sliceBytes(idx.buf, from, to),
  };
}

// Read a span with surrounding context (expand before/after to arbitrary byte
// windows). Given a span_id or a { byte_start, byte_end, source }, read N bytes
// before and M bytes after from the source file.
export function engineReadContext(spanRef, { beforeBytes = 0, afterBytes = 0, maxTotal = 50000 } = {}) {
  // Resolve the span: either a span_id (look up across pools) or a direct ref
  let sourceId, byteStart, byteEnd, session;
  if (typeof spanRef === "string") {
    const p = poolForSpan(spanRef);
    const rec = p?.session.spans.get(spanRef);
    if (!rec) return { error: `Unknown span_id "${spanRef}". Search first.` };
    sourceId = rec.source_id;
    byteStart = rec.byte_start;
    byteEnd = rec.byte_end;
    // The span told us which pool it lives in; reading its context from a
    // different pool's session would resolve the wrong document or none.
    session = p.session;
  } else {
    sourceId = spanRef.source;
    byteStart = spanRef.byte_start;
    byteEnd = spanRef.byte_end;
    session = ensureSession(DEFAULT_POOL);
  }

  if (byteStart == null || byteEnd == null) {
    return { error: "Span has no byte offsets" };
  }

  const sourcePath = resolveSourcePath(sourceId);
  if (!sourcePath) return { error: `Cannot resolve source from "${sourceId}"` };

  // Same content-vs-file split as engineReadSourceBytes: a span from an
  // uploaded document has no file behind it, and reading its surroundings is
  // the second hop of the audit round trip (LAWS.md L2b).
  const resolved = resolveDocument(session, sourceId);
  let idx;
  try {
    idx = resolved.doc ? docByteIndex(session, resolved.doc) : fileIndex(sourcePath);
  } catch (e) {
    return { error: `Cannot read ${sourcePath}: ${e.message}` };
  }
  if (idx.error) return { error: idx.error };

  const readStart = Math.max(0, byteStart - beforeBytes);
  const readEnd = Math.min(idx.bytes, byteEnd + afterBytes);
  const length = Math.min(readEnd - readStart, maxTotal);
  const contextText = sliceBytes(idx.buf, readStart, readStart + length);

  return {
    source: sourcePath,
    byte_start: readStart,
    byte_end: readStart + length,
    span_byte_start: byteStart,
    span_byte_end: byteEnd,
    truncated: length < (readEnd - readStart),
    text: contextText,
  };
}

// ── Source tracking ──

export function engineIngestFile(filePath, { pool: poolName = DEFAULT_POOL, kind = "corpus", displayName } = {}) {
  const p = pool(poolName);
  const { chunks, admitted } = ingestFile(p.session, filePath);
  p.chunkCount += chunks;
  const name = displayName || filePath.replace(/^.*[/\\]/, "");
  p.sources.set(filePath, { name, chunks, kind, pool: p.name, ingestedAt: Date.now() });
  return {
    path: filePath,
    sourceId: filePath,
    chunks,
    pool: p.name,
    entries: admitted.map((a, i) => ({ id: `chunk-${i}`, size: a.byteEnd - a.byteStart })),
  };
}

// Off-main-thread counterpart to engineIngestFile — see engineIngestTextAsync
// just above for why. The worker derives `source:<path>` itself (ingestFile's
// own convention); this only needs the resulting docId back to merge it.
export async function engineIngestFileAsync(filePath, { pool: poolName = DEFAULT_POOL, kind = "corpus", displayName } = {}) {
  const p = pool(poolName);
  const result = await runIngestInWorker({ kind: "file", filePath });
  mergeIngestResult(p, result);
  p.chunkCount += result.chunks;
  const name = displayName || filePath.replace(/^.*[/\\]/, "");
  p.sources.set(filePath, { name, chunks: result.chunks, kind, pool: p.name, ingestedAt: Date.now() });
  return {
    path: filePath,
    sourceId: filePath,
    chunks: result.chunks,
    pool: p.name,
    entries: result.admitted.map((a, i) => ({ id: `chunk-${i}`, size: a.byteEnd - a.byteStart })),
  };
}

// Every pool's sources, each tagged with the pool it lives in and what it is.
// Callers that only want ingested texts filter on `kind === "corpus"` rather
// than assuming the list is homogeneous.
//
// LAWS.md candidate law — "one name per thing." The key this map is built on
// is the same value `/api/ingest` hands back as `sourceId`, but this surface
// only ever published it as `path`, so a reader following an id from the
// ingest response to the source list found it renamed, and a reader going the
// other way found a `path` that is not a filesystem path at all for anything
// ingested as content. Both names are carried now, identical in value, so
// neither direction requires knowing the other spelling.
export function engineListSources({ pool: poolName } = {}) {
  const selected = poolName ? [pool(poolName)] : Array.from(pools.values());
  return selected.flatMap((p) =>
    Array.from(p.sources.entries()).map(([path, info]) => ({
      path,
      sourceId: path,
      name: info.name,
      chunks: info.chunks,
      kind: info.kind ?? "corpus",
      pool: p.name,
      ingestedAt: info.ingestedAt,
    })),
  );
}

export function engineStats() {
  const s = ensureSession();
  const all = Array.from(pools.values());
  return {
    sessionActive: !!s,
    ingestedChunks: all.reduce((n, p) => n + p.chunkCount, 0),
    ingestedFiles: all.reduce((n, p) => n + p.sources.size, 0),
    spanCap: s.spanCap ?? 2000,
    sources: Array.from(pool(DEFAULT_POOL).sources.values()).map((x) => x.name),
    deletedSources: recycleBin.size,
    pools: all.map((p) => ({ name: p.name, files: p.sources.size, chunks: p.chunkCount })),
  };
}

// ── Recycle bin ──

const RECYCLE_BIN_PATH = path.join(import.meta.dirname, "recycle-bin.json");

const recycleBin = new Map();

function loadRecycleBin() {
  try {
    if (fs.existsSync(RECYCLE_BIN_PATH)) {
      const data = JSON.parse(fs.readFileSync(RECYCLE_BIN_PATH, "utf8"));
      for (const [key, val] of Object.entries(data)) {
        recycleBin.set(key, val);
      }
    }
  } catch (err) {
    console.error(`[recycle-bin] load failed: ${err.message}`);
  }
}

function saveRecycleBin() {
  try {
    const data = Object.fromEntries(recycleBin);
    fs.writeFileSync(RECYCLE_BIN_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[recycle-bin] save failed: ${err.message}`);
  }
}

loadRecycleBin();

// Does this span belong to the document registered under `sourceKey`?
//
// The two ingest paths key `p.sources` differently — engineIngestFile by the
// bare file path, engineIngestText by a full `source:...` id — while spans
// always carry `<document id>:chunk-N`. Stripping the chunk suffix and
// comparing against both spellings covers each without a substring test.
// The predicate this replaced asked `sourceKey.includes(rec.source_id)`,
// which is backwards: the key is the SHORTER string, so it never matched and
// every "deleted" source kept all of its spans in the retrieval index —
// still searchable, still citable, still answering questions after the reader
// removed it. spansRemoved: 0 on every delete was the visible symptom.
function spanBelongsToSource(spanSourceId, sourceKey) {
  if (!spanSourceId) return false;
  const docId = String(spanSourceId).replace(/:chunk-\d+$/, "");
  return docId === sourceKey || docId === `source:${sourceKey}`;
}

// Resolve a caller's source reference against a pool's registry — the same
// exact-first, ambiguity-is-an-error discipline as resolveDocument, over
// `p.sources` rather than the span-derived catalog (a source whose spans were
// already removed must still be addressable). Callers hold the display name
// /api/sources hands them; the registry is keyed by path or document id.
function resolveSourceKey(p, ref) {
  const wanted = String(ref ?? "").trim();
  if (!wanted) return { error: "missing 'source'" };
  const entries = Array.from(p.sources.entries()).map(([key, info]) => ({
    key,
    info,
    base: key.replace(/^.*[/\\]/, ""),
  }));
  if (!entries.length) return { error: `no sources ingested in pool "${p.name}"` };

  for (const match of [
    (e) => e.key === wanted,
    (e) => e.info.name === wanted,
    (e) => e.base === wanted,
  ]) {
    const hits = entries.filter(match);
    if (hits.length === 1) return { key: hits[0].key, info: hits[0].info };
    if (hits.length > 1) {
      return { error: `ambiguous source "${wanted}": ${hits.map((h) => h.key).join(", ")}` };
    }
  }
  return {
    error: `Source not found: ${wanted}. Known: ${entries.map((e) => e.info.name).join(", ")}`,
  };
}

export function engineDeleteSource(sourceRef, { pool: poolName = DEFAULT_POOL } = {}) {
  const p = pool(poolName);
  const resolved = resolveSourceKey(p, sourceRef);
  if (resolved.error) return { error: resolved.error };
  const { key: sourceKey, info } = resolved;

  const deletedSpans = [];
  for (const [spanId, rec] of p.session.spans) {
    if (spanBelongsToSource(rec.source_id, sourceKey)) {
      deletedSpans.push({ span_id: spanId, source_id: rec.source_id, byte_start: rec.byte_start, byte_end: rec.byte_end, text: rec.text, score: rec.score });
    }
  }

  for (const span of deletedSpans) {
    p.session.spans.delete(span.span_id);
  }
  p.chunkCount -= info.chunks;
  p.sources.delete(sourceKey);

  const deletedEntry = {
    sourceKey,
    info,
    spans: deletedSpans,
    deletedAt: Date.now(),
  };
  recycleBin.set(sourceKey, deletedEntry);
  saveRecycleBin();

  return {
    path: sourceKey,
    name: info.name,
    chunks: info.chunks,
    spansRemoved: deletedSpans.length,
    deletedAt: deletedEntry.deletedAt,
    pool: p.name,
  };
}

export function engineListRecycleBin() {
  return Array.from(recycleBin.values()).map((entry) => ({
    sourceKey: entry.sourceKey,
    name: entry.info.name,
    chunks: entry.info.chunks,
    kind: entry.info.kind ?? "corpus",
    pool: entry.info.pool,
    ingestedAt: entry.info.ingestedAt,
    deletedAt: entry.deletedAt,
    spansCount: entry.spans.length,
  }));
}

// Same resolution as resolveSourceKey, over the recycle bin. A reader who can
// delete "pg84.txt" by name must be able to restore it by the same name; the
// bin is keyed by the internal source key, which the UI never sees.
function resolveDeletedKey(ref) {
  const wanted = String(ref ?? "").trim();
  if (!wanted) return { error: "missing 'source'" };
  const entries = Array.from(recycleBin.values()).map((entry) => ({
    entry,
    base: entry.sourceKey.replace(/^.*[/\\]/, ""),
  }));
  if (!entries.length) return { error: "recycle bin is empty" };

  for (const match of [
    (e) => e.entry.sourceKey === wanted,
    (e) => e.entry.info.name === wanted,
    (e) => e.base === wanted,
  ]) {
    const hits = entries.filter(match);
    if (hits.length === 1) return { entry: hits[0].entry };
    if (hits.length > 1) {
      return { error: `ambiguous source "${wanted}": ${hits.map((h) => h.entry.sourceKey).join(", ")}` };
    }
  }
  return {
    error: `Deleted source not found: ${wanted}. In bin: ${entries.map((e) => e.entry.info.name).join(", ")}`,
  };
}

export function engineRestoreSource(sourceRef, { pool: poolName } = {}) {
  const resolved = resolveDeletedKey(sourceRef);
  if (resolved.error) return { error: resolved.error };
  const { entry } = resolved;
  const sourceKey = entry.sourceKey;

  const p = pool(poolName || entry.info.pool || DEFAULT_POOL);
  p.sources.set(entry.sourceKey, { ...entry.info });
  p.chunkCount += entry.info.chunks;

  for (const span of entry.spans) {
    p.session.spans.set(span.span_id, {
      source_id: span.source_id,
      byte_start: span.byte_start,
      byte_end: span.byte_end,
      text: span.text,
      score: span.score,
    });
  }

  recycleBin.delete(sourceKey);
  saveRecycleBin();

  return {
    path: entry.sourceKey,
    name: entry.info.name,
    chunks: entry.info.chunks,
    spansRestored: entry.spans.length,
    pool: p.name,
  };
}

export function enginePurgeSource(sourceRef) {
  const resolved = resolveDeletedKey(sourceRef);
  if (resolved.error) return { error: resolved.error };
  const { entry } = resolved;
  recycleBin.delete(entry.sourceKey);
  saveRecycleBin();
  return {
    path: entry.sourceKey,
    name: entry.info.name,
    spansDiscarded: entry.spans.length,
  };
}

export function enginePurgeRecycleBin() {
  const count = recycleBin.size;
  recycleBin.clear();
  saveRecycleBin();
  return { purged: count };
}

export function engineRecycleBinStats() {
  return {
    count: recycleBin.size,
    totalChunks: Array.from(recycleBin.values()).reduce((s, e) => s + e.info.chunks, 0),
    totalSpans: Array.from(recycleBin.values()).reduce((s, e) => s + e.spans.length, 0),
    entries: engineListRecycleBin(),
  };
}

// ── Fold projection ──
//
// engineFoldSource answers "what IS this document" — its cast, its divisions,
// how much of it was folded at all — in the shape eoreaderapp/src/app consumes
// (__fixtures__/npr-news-fold.js is the contract, overview-dashboard.js the
// reader). It adds no intelligence: every number below is a wiring of an organ
// that already exists, through the one surface hosts may touch. What it is FOR
// is retiring eochat's buildEntityMatcher — a regex over capitalized words plus
// a stopword list, top-20 by frequency — which is identity-in-a-string, cannot
// represent an emanon at all, and ranks the publisher above the cast.
//
// Three rules govern what this function may emit.
//
//   1. INDIVIDUATION TYPE COMES ONLY FROM THE PRIOR. holon/emanon/protogon/
//      field/apparatus is the output of the Ground→Figure gate
//      (referents/individuation.js), and that gate is not wired to a document:
//      it needs mass, coupling and their Born-null sample distributions, and
//      nothing in the host facade computes them — its only callers today are
//      its own tests. So the type is read from the per-text coref prior, which
//      is witness-tier knowledge injected by a reader (docs/nameless-referent.md:
//      "descriptor coreference is witness-channel knowledge"). A referent the
//      text merely PROPOSED — rankSurfaces capitalization physics, no prior —
//      has been through no gate and had no aliases resolved, so it is withheld
//      rather than typed. Note that `sessionReferents` reports such a candidate
//      as individuation "discovered" and reports a prior that omits the field
//      as "holon"; neither is a gate result, so neither is passed through.
//
//   2. MASS IS NOT SYNTHESIZED. The fixture separates mass (Tapas-
//      concentration) from count (sightings), and only the second exists.
//      Multiplying mentions by frame spread would produce a number that looks
//      like mass, sorts like mass, and is not mass. `mass` is therefore null
//      with a typed gap, and the observables that DO exist — mentions, frames,
//      first/last frame — travel under their own names.
//
//   3. ANCHORS ARE DOCUMENT-SCOPED, AND SCOPED SURFACES ARE NEVER SCANNED.
//      Anchors are byte offsets into THIS document's admitted pieces, built
//      from a real occurrence (see anchorsFor for why pool-wide retrieval was
//      the wrong source and what it cost). Scoped surfaces — narrator spans, a
//      descriptor valid in only one stretch — are excluded entirely: their
//      validity is positional, a whole-document scan has no scope, and "my
//      enemy" inside the Creature's own tale points at Victor. A referent left
//      with no anchor keeps `evidence: []` and is withheld by fold-contract's
//      displayableReferents rather than shown on an unverifiable claim.
//
// Everything the projection cannot fill is a typed gap in `gaps`, never a
// plausible default. That is the whole difference between this and the regex.

export const FOLD_PROJECTION_VERSION = "fold-projection@2";

const GATED_TYPES = new Set(INDIVIDUATION_TYPES);

// A display name that is layout, not a being. Section numbers ("II", "III"),
// page figures ("1987"), and standalone structural headings ("Section",
// "Appendix") recur in running headers and tables of contents, and the
// perceiver's capitalisation detector dutifully casts them as referents.
// They are not entities in any sense a reader can act on, so the fold never
// surfaces them — not in the cast, not in the withheld audit, not as
// highlightable surfaces. Roman numerals are validated (not a character-set
// test) so real words spelled only from Roman letters — "Civil", "Mild",
// "Vivid" — survive.
const STRUCTURAL_HEADINGS = new Set([
  "section", "sections", "chapter", "chapters", "part", "parts", "act", "acts",
  "scene", "scenes", "stave", "movement", "movements", "canto", "cantos",
  "book", "books", "volume", "volumes", "preface", "introduction",
  "prologue", "epilogue", "epigraph", "contents", "appendix", "appendices",
  "bibliography", "index", "glossary", "notes", "footnotes", "endnotes",
  "references", "acknowledgements", "acknowledgments", "dedication", "cover",
  "abstract", "summary", "conclusion", "afterword", "foreword", "title",
]);

const ROMAN_NUMERAL = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;
const BARE_NUMBER = /^\d[\d.,]*$/;
const WORD_NUMBER = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i;

// "SECTION II", "Chapter 3", "Part One" — a structural heading carrying a
// position marker is one token, not a name. The marker must be a numeral or
// spelled-out number, never an arbitrary word ("Section Chief" is a title).
const isHeadingPosition = (s) => {
  const at = s.indexOf(" ");
  if (at <= 0) return false;
  const heading = s.slice(0, at).toLowerCase();
  const rest = s.slice(at + 1);
  if (!STRUCTURAL_HEADINGS.has(heading)) return false;
  return ROMAN_NUMERAL.test(rest) || BARE_NUMBER.test(rest) || WORD_NUMBER.test(rest);
};

export function isStructuralName(name) {
  if (!name || typeof name !== "string") return false;
  // Trailing punctuation ("II.") is the surface's, not the name's.
  const s = name.trim().replace(/[.,;:]\s*$/, "");
  if (!s) return false;
  if (ROMAN_NUMERAL.test(s) || BARE_NUMBER.test(s) || isHeadingPosition(s) || WORD_NUMBER.test(s)) return true;
  // A bare structural heading is layout; a heading inside a title is not.
  return STRUCTURAL_HEADINGS.has(s.toLowerCase());
}

// `tier` says who would have to supply the missing thing: "engine" — an organ
// exists but is unwired; "model" — witness knowledge, only a prior can supply
// it; "host" — this bridge or its caller.
const typedGap = (field, reason, tier) => ({ field, reason, tier });

// The anchor cap is reported on the fold (`anchor_policy`) rather than applied
// silently — a truncated evidence list must not read as a complete one.
//
// There is deliberately NO cap on how many of a referent's surfaces are
// scanned. A cap would make a referent's evidence — and so whether it is shown
// at all — depend on the order its surfaces happen to be listed in the prior,
// which is not a property of the text.
//
// Worked example, and the reason to trust rule 3 rather than a cap (historical:
// the prior has since been corrected, so this no longer reproduces): War and
// Peace's prior once listed Andrei's surfaces in a transliteration this edition
// does not use ("Andrei"/"Bolkonsky" — 0 occurrences; the Maude text says
// "Prince Andrew" and "Bolkónski"). His one surface that did occur, "little
// princess", was SCOPED, and is in fact his wife. Rule 3 excluded it from
// scanning on principle, so he was withheld with "no evidence for any unscoped
// surface" rather than shown on his wife's epithet — the right outcome for the
// right reason, and it held however the prior ordered its surfaces. What a cap
// would have done instead is show him, on Lise.

// Sighting counts are weighted, not integral — presenceByFrame scores a
// first-person hit at 0.5 because a pronoun is a weaker sighting than a name.
// Summing those halves accumulates binary-float noise (1503.0000000000011), so
// counts are trimmed to two places. Rounding to an integer would be the wrong
// fix: it would erase the half-sighting the weighting exists to express.
const roundCount = (n) => Number(Number(n ?? 0).toFixed(2));

function documentCatalog(session) {
  return corpusFacade.documentIds(session).map((id) => {
    const filePath = resolveSourcePath(id) || id;
    const base = filePath.replace(/^.*[/\\]/, "");
    return { id, path: filePath, base, stem: base.replace(/\.[^.]+$/, "") };
  });
}

// Resolve a caller's `?source=` — a document id, an absolute path, a basename
// or a stem — to exactly one document. Ambiguity is an error listing the
// candidates, never a silent pick of the first match: serving one book's cast
// under another book's name is the failure this endpoint exists to end.
function resolveDocument(session, ref) {
  // A span's `source` is the CHUNK it came from — "source:book.txt:1699:chunk-7"
  // — while the catalog holds the document, "source:book.txt:1699". Handing a
  // citation's own source straight back to the resolver therefore matched
  // nothing, and every attempt to read a quote's bytes or its surrounding text
  // failed with an ENOENT for a file that never existed. The chunk suffix is a
  // position within a document, not a different document; strip it here, in the
  // one resolver every reader shares, rather than at each call site.
  const wanted = String(ref ?? "").trim().replace(/:chunk-\d+$/, "");
  if (!wanted) return { error: "missing 'source'" };
  const catalog = documentCatalog(session);
  if (!catalog.length) return { error: "no documents ingested in this pool" };

  for (const key of ["id", "path", "base", "stem"]) {
    const hits = catalog.filter((d) => d[key] === wanted);
    if (hits.length === 1) return { doc: hits[0] };
    if (hits.length > 1) return { error: `ambiguous source "${wanted}": ${hits.map((d) => d.id).join(", ")}` };
  }
  const loose = catalog.filter((d) => d.base.includes(wanted));
  if (loose.length === 1) return { doc: loose[0] };
  if (loose.length > 1) return { error: `ambiguous source "${wanted}": ${loose.map((d) => d.id).join(", ")}` };
  return { error: `unknown source "${wanted}". Known: ${catalog.map((d) => d.base).join(", ")}` };
}

// Surfaces this bridge may hand to searchSpans: unscoped ones only (rule 3).
// A prior entry knows which of its surfaces carry a scope; a discovered
// candidate has exactly one surface, global by construction. The
// `surface@from-to` forms admitReferent mints for narrator spans are
// positional handles, not searchable text, and are dropped.
function globalSurfacesFor(referent, priorEntry) {
  const positional = /@\d+-\d+$/;
  if (priorEntry && Array.isArray(priorEntry.surfaces)) {
    const unscoped = priorEntry.surfaces
      .map((s) => (typeof s === "string" ? { surface: s } : s))
      .filter((s) => s && s.surface && !s.scope)
      .map((s) => String(s.surface));
    const seed = priorEntry.name ? [String(priorEntry.name)] : [];
    return [...new Set([...seed, ...unscoped])].filter((s) => !positional.test(s));
  }
  return (referent.surfaces || []).map(String).filter((s) => !positional.test(s));
}

// Byte-addressed evidence for one referent, read off the document's own
// admitted pieces rather than out of scored retrieval.
//
// searchSpans was the obvious source and is the wrong one: it ranks across the
// WHOLE pool. In a session holding three books the top hits for "the creature"
// are War and Peace's, and filtering them back down to this document left
// Frankenstein's Creature with no anchors and silently withheld — a referent
// the prior had correctly individuated as emanon, dropped because of what else
// happened to be ingested. Measured: 1 survivor alone, 0 survivors alongside
// two other books, from the same file and the same prior.
//
// Pieces carry their byte offset in the SOURCE FILE, so scanning them is both
// exactly scoped to this document and strictly more precise — the anchor lands
// on the occurrence itself rather than on the chunk containing it, and needs
// no verification pass because it is built from a real match.
//
// This is not a string-matching coref substitute. Identity is already fixed by
// the prior; all that happens here is locating where a known referent's known
// surfaces occur, for unscoped surfaces only (rule 3).
// Surfaces are round-robined rather than drained one at a time, so a short
// evidence list spans the alias set instead of showing the first surface three
// times. Which surfaces actually carried is the thing a reader auditing a prior
// needs to see.
function anchorsFor(pieces, docId, surfaces, want) {
  const anchors = [];
  const seen = new Set();
  const cursors = surfaces
    .map((surface) => ({ re: surfaceMatcher(surface), next: 0 }))
    .filter((c) => c.re);

  let progressed = true;
  while (anchors.length < want && progressed) {
    progressed = false;
    for (const cursor of cursors) {
      if (anchors.length >= want) break;
      while (cursor.next < pieces.length) {
        const piece = pieces[cursor.next++];
        const hit = cursor.re.exec(piece.text);
        if (!hit) continue;
        const start = piece.byteStart + Buffer.byteLength(piece.text.slice(0, hit.index), "utf8");
        if (seen.has(start)) continue;
        seen.add(start);
        anchors.push({
          source_id: docId,
          byte_start: start,
          byte_end: start + Buffer.byteLength(hit[0], "utf8"),
          surface: hit[0],
        });
        progressed = true;
        break;
      }
    }
  }
  return anchors;
}

// WHERE a referent occurs, not just how often.
//
// `countAcrossChunks` in @eoreader/host already walks every piece per referent
// and returns mentions/frames/firstFrame/lastFrame — the counts — then discards
// WHICH pieces carried a hit. That set is the only observable in this fold from
// which two beings can be said to be structurally tied at all: co-presence in
// the same frame is measured, whereas "Victor is linked to Elizabeth" from
// mentions alone would be a fabrication. The Explorer's Link and Network
// terrains stand on this and nothing else, so it is computed here rather than
// inferred downstream.
//
// It is recomputed rather than read back from the host because the host's
// return shape is fixed by @eoreader/host's API version and this is the app's
// projection, not the engine's reading.
//
// It deliberately does NOT use `surfaceMatcher` (priors-bridge), which anchorsFor
// uses. That one is `\b`-bounded, and JS `\b` counts `_` as a word character, so
// it misses every occurrence inside Project Gutenberg's italics markup —
// `_Sorrows of Werter_`, `_Plutarch's Lives_`. The frame counts the panel already
// shows come from the host's `occurrenceMatcher` (host/corpus.js), which uses
// Unicode letter/number lookaround and admits a trailing possessive. Presence
// must be counted by the same authority as the count it sits beside, or the
// panel shows "39 frames" next to a presence list of 38 and neither number can
// be trusted. `presenceMatcher` mirrors that matcher exactly.
//
// The consequence is stated rather than hidden: a frame can be present with no
// anchor in it, because anchors are located by the narrower matcher. That is a
// gap in the anchor list, not in the presence set.
//
// NO CROSS-REFERENT ARBITRATION HAPPENS HERE. Each referent is scanned against
// its own unscoped surfaces independently. If two referents share a surface,
// both are recorded present — deciding which one a shared surface "really"
// means is coreference, the engine explicitly refuses to do it without a prior
// (host/corpus.js sessionReferents), and doing it here under a different name
// would be exactly the fabrication the fold projection exists to prevent.
const FRAME_SCAN_BUDGET = 4_000_000; // referent × piece regex tests

// Mirror of @eoreader/host corpus.js `occurrenceMatcher`. Kept byte-identical in
// behaviour on purpose: if it drifts, `frames_present.length` stops agreeing with
// the `frames` the host counted and the divergence check below starts firing on
// every referent instead of on a real disagreement.
const presenceMatcher = (surfaces) => {
  const alts = [...new Set(surfaces.filter(Boolean).map(String))]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!alts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?:['’]s?)?(?![\\p{L}\\p{N}])`, "giu");
};

function framePresenceFor(pieces, referentSurfaces) {
  // referentSurfaces: [{ id, surfaces }] — returns Map(id → number[] frames)
  const ops = referentSurfaces.length * pieces.length;
  if (!pieces.length || !referentSurfaces.length) return { presence: new Map(), skipped: null };
  if (ops > FRAME_SCAN_BUDGET) {
    return {
      presence: new Map(),
      skipped: `frame presence not computed: ${referentSurfaces.length} referent(s) × ${pieces.length} frame(s) = ${ops} scans exceeds the ${FRAME_SCAN_BUDGET} budget`,
    };
  }
  const presence = new Map();
  for (const { id, surfaces } of referentSurfaces) {
    const re = presenceMatcher(surfaces);
    if (!re) { presence.set(id, []); continue; }
    const frames = [];
    for (let i = 0; i < pieces.length; i++) {
      const text = pieces[i].text;
      if (!text) continue;
      re.lastIndex = 0;
      if (re.test(text)) frames.push(i);
    }
    presence.set(id, frames);
  }
  return { presence, skipped: null };
}

// Which of the document's divisions a referent actually occurs in.
//
// The anchors list is capped (3 per referent by default), so placing a being in
// the text by its anchors would be a three-sample estimate presented as a
// location. Frame presence is exhaustive, so section membership derived from it
// is the whole truth about where a name occurs — at frame resolution, which is
// the resolution the fold has.
//
// A frame is assigned to every section its byte range overlaps, not to one:
// frames are a fixed-size chunking and sections are a novelty-curve reading of
// the same bytes, so a frame straddling a section boundary genuinely lies in
// both and picking one would silently drop the other.
function sectionsPresentFor(frames, pieces, sections) {
  if (!sections.length || !frames.length) return [];
  const hit = new Set();
  for (const f of frames) {
    const piece = pieces[f];
    if (!piece) continue;
    const start = piece.byteStart;
    const end = piece.byteStart + (piece.length ?? Buffer.byteLength(piece.text || "", "utf8"));
    for (const sec of sections) {
      const secEnd = sec.byte_start + sec.length;
      if (start < secEnd && end > sec.byte_start) hit.add(sec.index);
    }
  }
  return [...hit].sort((a, b) => a - b);
}

// The document's divisions, as derivations the app's reconcileDivisions can
// vote over. Only ONE derivation exists here, and that is reported honestly:
// sessionOutline's novelty curve (KL against a sliding prior — where the word
// distribution actually turns, not a heading regex). The DOM derivation has no
// meaning for an ingested text file and the strain spine does not exist in the
// engine at all; both are gaps, so the strip shows 1/1 agreement rather than a
// fabricated consensus.
function divisionsFor(session, docId, gaps, zThreshold) {
  const outline = corpusFacade.sessionOutline(session, { sourceId: docId, zThreshold });
  if (outline?.error) {
    gaps.push(typedGap("divisions.derivations", `outline unavailable: ${outline.error}`, "engine"));
    return { derivations: [] };
  }
  const sections = outline.sections || [];
  const last = sections[sections.length - 1];
  const span = last ? last.offset + last.length : 0;
  if (!span) {
    gaps.push(typedGap("divisions.derivations", "document has no measurable extent", "engine"));
    return { derivations: [] };
  }
  // reconcileDivisions clusters cuts on a 0..1 scale; sessionOutline reports
  // character offsets. Section 0 opens at the document head and is not a cut.
  const cuts = sections.slice(1).map((sec) => Number((sec.offset / span).toFixed(4)));
  gaps.push(typedGap("divisions.derivations[dom]", "no DOM perceiver for an ingested text file — the page's own headings do not exist here", "host"));
  gaps.push(typedGap("divisions.derivations[strain]", "no strain/deviation waveform exists in the engine", "engine"));
  return {
    frames: outline.frames ?? null,
    derivations: [{
      id: "novelty",
      beats: sections.length,
      unit: "beats",
      cuts,
      sections: sections.map((sec) => ({
        index: sec.index, offset: sec.offset, byte_start: sec.byteStart, length: sec.length, label: sec.label,
      })),
    }],
  };
}

// How much of the file made it into the fold, measured rather than asserted.
// Admitted pieces carry their byte offset in the SOURCE FILE, so their summed
// length against the file's own size is real accounting: the remainder is
// whatever admitChunked dropped (sub-minChars runs) plus whatever ingestFile
// stripped (Gutenberg boilerplate) before admitting.
//
// The {chrome, dup, nul} attribution the dashboard wants is NOT derivable from
// this — nothing records WHY a byte was dropped. Three plausible percentages
// here would be the exact failure this projection exists to avoid, so `buckets`
// is null with a gap.
function coverageFor(session, doc, chunks, gaps) {
  gaps.push(typedGap("coverage.buckets", "no per-unit discard attribution exists — admitChunked and ingestFile drop bytes without recording chrome/dup/nul", "engine"));
  const pieces = session.documents?.get(doc.id)?.pieces ?? [];
  const foldedBytes = pieces.reduce((n, p) => n + Buffer.byteLength(p.text, "utf8"), 0);

  let totalBytes = null;
  try {
    totalBytes = fileIndex(doc.path).bytes;
  } catch {
    gaps.push(typedGap("coverage.folded_pct", `source file ${doc.path} is not readable — coverage cannot be measured`, "host"));
  }
  if (!totalBytes) {
    return { folded_bytes: foldedBytes, discarded_bytes: null, folded_pct: null, discarded_pct: null, buckets: null, folded_units: chunks, refoldable: true };
  }
  const discardedBytes = Math.max(0, totalBytes - foldedBytes);
  return {
    folded_bytes: foldedBytes,
    discarded_bytes: discardedBytes,
    total_bytes: totalBytes,
    folded_pct: Number(((foldedBytes / totalBytes) * 100).toFixed(1)),
    discarded_pct: Number(((discardedBytes / totalBytes) * 100).toFixed(1)),
    buckets: null,
    folded_units: chunks,
    refoldable: true,
  };
}

/**
 * Project one ingested document into the app's fold shape.
 *
 * @param {string} sourceRef document id, path, basename or stem
 * @param {{pool?: string, limit?: number, anchors?: number, zThreshold?: number}} [options]
 *   `limit` caps the `withheld` audit list only; `anchors` is per referent.
 * @returns {object} the fold, or `{ error }` when the source cannot be resolved
 */
export function engineFoldSource(sourceRef, { pool: poolName = DEFAULT_POOL, limit = 40, anchors: anchorsPerReferent = 3, zThreshold } = {}) {
  const needed = ["documentIds", "documentText", "sessionOutline", "sessionReferents"];
  const missing = needed.filter((name) => typeof corpusFacade[name] !== "function");
  if (missing.length) {
    return { error: `@eoreader/host/corpus is API v${CORPUS_API_VERSION} and has no whole-document facade (missing ${missing.join(", ")}); the fold projection needs v2` };
  }

  const session = ensureSession(poolName);
  const resolved = resolveDocument(session, sourceRef);
  if (resolved.error) return { error: resolved.error };
  const doc = resolved.doc;
  const gaps = [];

  // Witness-tier knowledge. Absent, descriptor coref is simply not done — and
  // the whole cast falls through to `withheld` rather than being typed on
  // capitalization physics.
  const prior = loadCorefPrior(doc.id);
  if (prior.gap) gaps.push(typedGap("prior", prior.gap, "model"));

  const read = corpusFacade.sessionReferents(session, {
    sourceId: doc.id,
    priors: prior.referents,
    limit: Number.MAX_SAFE_INTEGER,
  });
  if (read.error) return { error: read.error };
  for (const g of read.gaps || []) {
    gaps.push(typedGap("referents", typeof g === "string" ? g : (g.reason || JSON.stringify(g)), "engine"));
  }

  // sessionReferents keys a referent `ref:<normalized id>`, so the raw prior
  // entry is recovered through the display string it derived it from
  // (`prior.display ?? prior.name ?? prior.id`). A display two prior entries
  // share resolves to neither — the type would be a coin flip, and a coin flip
  // is a fabrication.
  const priorByDisplay = new Map();
  const ambiguousDisplay = new Set();
  for (const entry of prior.referents || []) {
    const key = entry.display ?? entry.name ?? entry.id;
    if (priorByDisplay.has(key)) ambiguousDisplay.add(key);
    else priorByDisplay.set(key, entry);
  }

  const pieces = [...(session.documents?.get(doc.id)?.pieces ?? [])].sort((a, b) => a.byteStart - b.byteStart);
  const referents = [];
  const withheld = [];
  let sightings = 0;

  for (const r of read.referents || []) {
    // Section numbers and structural headings are not entities; the cast
    // (and the withheld audit, below) drop them before anything reads the fold.
    if (isStructuralName(r.display ?? r.name ?? r.id)) continue;
    sightings += r.mentions || 0;
    const entry = ambiguousDisplay.has(r.display) ? null : priorByDisplay.get(r.display);
    const asserted = entry && typeof entry.individuation === "string" ? entry.individuation : null;
    const type = asserted && GATED_TYPES.has(asserted) ? asserted : (r.individuation || null);

    const surfaces = globalSurfacesFor(r, entry);
    // Anchors are gathered for all referents with evidence, not just prior-typed ones.
    // Universal coref: discovered candidates are valid referents.
    //
    // This used to read `type ? anchorsFor(...) : []`, which contradicted the
    // two lines above it: an untyped referent got no anchors, fell into the
    // universal-coref branch below, and reached the app with an empty
    // `provenance.anchors` — so the entity profile's Anchors list was empty
    // for every discovered referent and there was nothing to click through to
    // in the reader. Locating a known surface is not typing it; the gate was
    // in the wrong place.
    const evidence = anchorsFor(pieces, doc.id, surfaces, anchorsPerReferent);

    const base = {
      id: r.id,
      name: r.display,
      canonicalLabel: r.display,
      surfaceForms: r.surfaces || [],
      globalSurfaces: surfaces,
      count: roundCount(r.mentions),
      mentions: roundCount(r.mentions),
      frames: r.frames ?? 0,
      first_frame: r.firstFrame ?? null,
      last_frame: r.lastFrame ?? null,
      mass: null,
    };

    if (type && evidence.length) {
      referents.push({
        ...base,
        individuation_type: type,
        aliasesResolved: true,
        evidence,
        provenance: {
          anchors: evidence,
          tier: r.fromPrior ? "model" : "engine",
          prior_snapshot: r.fromPrior && prior.priorId ? { identity: prior.priorId, path: prior.priorPath } : null,
          surfaces_scanned: surfaces,
          scoped_surfaces_excluded: Math.max(0, (r.surfaces || []).length - surfaces.length),
        },
      });
      continue;
    }
    // Universal coref: discovered candidates are valid referents.
    // Only withhold if there's genuinely no evidence (no surfaces, no mentions).
    if (!type && !r.fromPrior && r.mentions > 0) {
      // `emanon` — a being the text names and shows but does not individuate
      // into a kind. It is the honest floor for engine-tier discovery, not a
      // classification: name-variant coreference establishes THAT something
      // recurs under a name, never WHICH kind of being it is. Typing it
      // holon/protogon/apparatus would be a fabrication with a nice label.
      const autoType = r.individuation || 'emanon';
      referents.push({
        ...base,
        individuation_type: autoType,
        // Name variants are merged; pronouns and definite descriptions are
        // not, and cannot be without a prior. Saying `true` here claimed a
        // resolution the engine explicitly refuses to make.
        aliasesResolved: false,
        evidence,
        provenance: {
          anchors: evidence,
          tier: "engine",
          prior_snapshot: null,
          surfaces_scanned: surfaces,
          scoped_surfaces_excluded: Math.max(0, (r.surfaces || []).length - surfaces.length),
        },
      });
      continue;
    }
    // Withheld: prior asserted a type but no evidence found, or truly empty.
    if (isStructuralName(r.display ?? r.name ?? r.id)) continue;
    withheld.push({
      ...base,
      individuation_type: null,
      aliasesResolved: false,
      from_prior: !!r.fromPrior,
      withheld_because: !r.fromPrior
        ? "no evidence for this referent"
        : !type
          ? `prior asserted no individuation type${asserted ? ` ("${asserted}" is not one of ${INDIVIDUATION_TYPES.join("/")})` : ""}`
          : "no evidence for any unscoped surface — every surface that occurs in this document is scope-restricted, or none occurs at all",
    });
  }

  // A referent the prior NAMED but that could not be shown is the important
  // one: it means the prior and the text disagree — a mistyped surface, or a
  // prior written against another edition — and it is a bug in witness
  // knowledge that someone can fix. A candidate the text merely proposed is
  // routine, and there are hundreds. Ordering the former first keeps `limit`
  // from burying the actionable case behind the noise.
  withheld.sort((a, b) => (b.from_prior === true) - (a.from_prior === true) || b.mentions - a.mentions);

  const priorUnmatched = withheld.filter((r) => r.from_prior);
  if (priorUnmatched.length) {
    gaps.push(typedGap(
      "prior.referents",
      `the prior asserts ${priorUnmatched.length} referent(s) this document cannot show — ${priorUnmatched.map((r) => `"${r.name}"`).join(", ")}. The prior and the text disagree: check the surfaces against this edition's spelling.`,
      "model",
    ));
  }

  if (withheld.length) {
    gaps.push(typedGap(
      "referents",
      `${withheld.length} referent(s) withheld: no evidence found for these candidates.`,
      "engine",
    ));
  }
  gaps.push(typedGap("referents[].mass", "the Ground→Figure gate (referents/individuation.js) is not wired to a document — it needs mass, coupling and their Born-null samples, which the host facade does not compute. mentions/frames are the observables that do exist.", "engine"));
  gaps.push(typedGap("frame", "frame kind, coupling-dispersion and subject-re-entry are outputs of the same unwired gate", "engine"));
  gaps.push(typedGap("units.passages", "per-passage register/surprise/below-null is not computed for an ingested text", "engine"));
  gaps.push(typedGap("motifs", "recurrence families are not projected by this endpoint", "host"));

  const text = corpusFacade.documentText(session, doc.id);
  const divisions = divisionsFor(session, doc.id, gaps, zThreshold);

  // Structural placement, attached after the cast is settled because it is a
  // projection OF the cast, not part of deciding who is in it. `surfaces_scanned`
  // is the same unscoped surface set anchorsFor located, so presence and anchors
  // are two readings of one scan rather than two opinions.
  const sections = divisions.derivations?.[0]?.sections || [];
  const { presence, skipped: presenceSkipped } = framePresenceFor(
    pieces,
    referents.map((r) => ({ id: r.id, surfaces: r.provenance.surfaces_scanned || [] })),
  );
  if (presenceSkipped) {
    gaps.push(typedGap("referents[].frames_present", presenceSkipped, "host"));
  } else {
    const unexplained = [];
    for (const r of referents) {
      const frames = presence.get(r.id) || [];
      r.frames_present = frames;
      r.sections_present = sectionsPresentFor(frames, pieces, sections);
      // The host counted `frames` over ALL of a prior's surfaces, including the
      // scope-restricted ones; presence is scanned over unscoped surfaces only,
      // because an unscoped scan is the only one whose hits are trustworthy
      // outside the scope (the Creature's narrator "I" is the standing example).
      // So a prior-typed referent with scoped surfaces is EXPECTED to show fewer
      // present frames than counted frames, and the shortfall is named on the
      // referent rather than presented as an error.
      const shortfall = r.frames != null ? r.frames - frames.length : 0;
      r.frames_present_shortfall = shortfall;
      if (shortfall !== 0 && !r.provenance.scoped_surfaces_excluded) {
        unexplained.push(`"${r.name}" (${r.frames} counted, ${frames.length} present)`);
      }
    }
    // Aggregated, not one gap per referent: a gap the reader has to scroll past
    // sixty times is noise, and noise is how a real disagreement gets missed.
    if (unexplained.length) {
      gaps.push(typedGap(
        "referents[].frames_present",
        `${unexplained.length} referent(s) whose presence scan disagrees with the host's frame count for no reason scope can explain — ${unexplained.slice(0, 5).join(", ")}${unexplained.length > 5 ? `, +${unexplained.length - 5} more` : ""}. The two matchers have drifted; Link and Network read the scan.`,
        "host",
      ));
    }
    if (!sections.length) {
      gaps.push(typedGap("referents[].sections_present", "the document has no divisions, so no being can be placed in one — Field has nothing to group by", "engine"));
    }
  }

  return {
    fold_version: FOLD_PROJECTION_VERSION,
    sourceId: doc.id,
    source: {
      id: doc.id,
      path: doc.path,
      name: doc.base,
      medium: "Text",
      words: text ? (text.text.match(/\S+/g) || []).length : null,
      chunks: text ? text.chunks : null,
      // The denominator for `referents[].frames_present`. Without it a presence
      // list is a count with no scale — "in 39 frames" says nothing until you
      // know whether the document has 40 or 4000.
      frames_total: pieces.length,
      publisher: null,
    },
    prior: {
      snapshot: prior.priorId,
      path: prior.priorPath,
      referents_asserted: (prior.referents || []).length,
    },
    // `referents` is never truncated — it is bounded by what the prior
    // asserted, which is small. `withheld` is the audit trail and can run to
    // hundreds, so `limit` applies there; the true count travels beside it so a
    // truncated list cannot be mistaken for the whole one.
    referents,
    withheld: withheld.slice(0, limit),
    withheld_total: withheld.length,
    withheld_truncated: withheld.length > limit,
    sightings: roundCount(sightings),
    survivors: referents.length,
    divisions,
    coverage: coverageFor(session, doc, text ? text.chunks : 0, gaps),
    anchor_policy: {
      anchors_per_referent: anchorsPerReferent,
      surfaces_per_referent: "all unscoped surfaces, round-robined",
      scanned: "this document's admitted pieces only — never pool-wide retrieval",
      searched: "referents a prior typed; withheld candidates are not scanned",
      note: "anchor lists are capped; an empty list means no unscoped surface occurs in this document, not that the referent is absent",
    },
    // What `referents[].frames_present` / `sections_present` are and are not, so
    // a client cannot read a structural claim into them that was never made.
    presence_policy: {
      unit: "frame index into this document's admitted pieces",
      matcher: "word-bounded, case-insensitive, over each referent's unscoped surfaces — the same matcher anchorsFor uses",
      exhaustive: true,
      coreference: "none — referents sharing a surface are each recorded present; which one a shared surface means is not decided here",
      sections: "a frame is assigned to every division its byte range overlaps, because frames are fixed-size and divisions are not",
      derivable: "co-presence in a frame is the only tie between two referents this fold supports; anything stronger is not measured",
    },
    gaps,
  };
}
