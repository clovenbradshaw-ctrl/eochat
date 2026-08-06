#!/usr/bin/env node
// check-laws.mjs — mechanical enforcement of ../LAWS.md.
//
// A principle nobody measures drifts into a slogan within one refactor. This
// script is the reason the laws are laws: it triggers real work against a live
// proxy, times the silence, walks a citation to its source bytes, and exits
// non-zero when either fails.
//
// It is deliberately end-to-end rather than unit-level. L1 is about what the
// reader perceives between press and response, and L2 is about whether a quote
// can be followed home — neither survives being mocked. The cost is that this
// needs a running proxy; that is the correct trade for the thing being checked.
//
//   node scripts/check-laws.mjs [--proxy http://localhost:11435] [--json] [--keep]
//
// Every source it ingests is deleted and purged on the way out, including on
// failure — a test that litters the reader's sources rail has broken the thing
// it was verifying.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_ENGINE_ROOT, UI_DIR } from "../server/paths.js";
import { formatTerrainReport } from "../server/terrain-report-format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(REPO_ROOT, "..");
const HOME = os.homedir();

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const PROXY = flag("proxy", process.env.EOCHAT_PROXY || "http://localhost:11435");
const AS_JSON = argv.includes("--json");
const KEEP = argv.includes("--keep");

// L1 budgets. The 100/1000ms split is the classic perception boundary: under
// 100ms reads as instantaneous, under a second preserves flow, past a second
// the reader starts wondering whether anything happened. See LAWS.md L1.
const TTFS_INSTANT_MS = 100;
const TTFS_BUDGET_MS = 1000;

// Documents spanning three orders of magnitude, plus a JSON case because JSON
// tokenizes badly (keys and braces are most of the bytes) and is where chunking
// costs diverge from raw size. Missing files are skipped, not fatal — not every
// checkout has War and Peace sitting in ~/Downloads.
const CANDIDATE_DOCS = [
  { label: "tiny/md", file: path.join(REPO_ROOT, "AGENTS.md") },
  { label: "small/md", file: path.join(REPO_ROOT, "essay.md") },
  { label: "medium/md", file: path.join(WORKSPACE, "eo-constitution", "CONSTITUTION.md") },
  { label: "large/md", file: path.join(REPO_ROOT, "UX-DESIGN.md") },
  { label: "large/json", file: path.join(REPO_ROOT, "vendor", "eoPriors", "priors", "corpus-prior.json") },
  { label: "book/txt", file: path.join(WORKSPACE, "pg84.txt") },
  { label: "epic/txt", file: path.join(HOME, "Downloads", "pg2600.txt") },
];

const findings = [];
// Sources present before the run. Cleanup deletes the *difference* rather than
// a list of things we think we made: the chat probes trigger web search, which
// ingests pages nobody explicitly asked for, and a cleanup that only knows
// about its own uploads leaves those behind forever.
let baseline = new Set();
let sawViolation = false;

function record(law, clause, status, detail, metrics = {}) {
  const f = { law, clause, status, detail, ...metrics };
  findings.push(f);
  if (status === "VIOLATION") sawViolation = true;
  if (!AS_JSON) {
    const mark = status === "PASS" ? "  ok  " : status === "VIOLATION" ? " FAIL " : " skip ";
    console.log(`[${mark}] ${clause.padEnd(5)} ${detail}`);
  }
  return f;
}

const ms = (n) => `${n.toFixed(0)}ms`;

// ── L1: time to first signal ───────────────────────────────────────────────
//
// TTFS is measured at the first *byte the client can attribute to this
// trigger*, not at response completion. For a blocking JSON endpoint those are
// the same instant, which is exactly the finding — a blocking endpoint cannot
// obey L1, and the number proves it rather than asserting it.

async function timedFetch(url, opts = {}) {
  const t0 = performance.now();
  const res = await fetch(url, opts);
  // Headers have arrived. For a streaming endpoint the body is still open, so
  // this is a genuine first-signal moment; for a blocking one the server has
  // already finished the work and this lands at the end.
  const ttfb = performance.now() - t0;
  const body = await res.text();
  const total = performance.now() - t0;
  return { res, body, ttfb, total };
}

// First SSE *event*, not first byte: a chunk of whitespace or a comment frame
// is not a signal under L1e. Returns which event name arrived first so the
// report can show whether the app acknowledged or merely finished.
//
// Records the payload of every event too (not just its name), because L1c —
// "long work reports progress, not just start and end" — is a claim about
// what happened BETWEEN the first and last event, and a caller that only
// knows event names can't tell a real progress signal from decoration.
async function collectSSE(url, payload, { timeoutMs = 120000 } = {}) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      return { error: `HTTP ${res.status}`, ttfs: performance.now() - t0, events: [] };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let firstEvent = null;
    let ttfs = null;
    const events = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const nameM = frame.match(/^event:\s*(\S+)/m);
        const dataM = frame.match(/^data:\s*(.*)$/m);
        const name = nameM ? nameM[1] : "message";
        let data = null;
        try { data = dataM ? JSON.parse(dataM[1]) : null; } catch {}
        if (!firstEvent) {
          firstEvent = name;
          ttfs = performance.now() - t0;
        }
        events.push({ name, data });
        if (name === "done" || name === "error") {
          reader.cancel().catch(() => {});
          return { firstEvent, ttfs, events, total: performance.now() - t0 };
        }
      }
    }
    return { firstEvent, ttfs, events, total: performance.now() - t0 };
  } catch (err) {
    return { error: err.name === "AbortError" ? "timeout" : err.message, ttfs: performance.now() - t0, events: [] };
  } finally {
    clearTimeout(timer);
  }
}

// Thin wrapper over collectSSE for callers that only care about event names,
// not payloads — the shape checkChatLatency already reported.
async function firstSSEEvent(url, payload, opts) {
  const r = await collectSSE(url, payload, opts);
  return { ...r, events: r.events.map((e) => e.name) };
}

function verdictFor(ttfs) {
  if (ttfs <= TTFS_INSTANT_MS) return "PASS";
  if (ttfs <= TTFS_BUDGET_MS) return "PASS";
  return "VIOLATION";
}

async function checkIngestLatency() {
  section("L1 — no dead air: document ingest");
  const docs = CANDIDATE_DOCS
    .filter((d) => fs.existsSync(d.file))
    .map((d) => ({ label: d.label, ext: path.extname(d.file), content: fs.readFileSync(d.file, "utf8") }));
  if (!docs.length) {
    record("L1", "L1a", "SKIP", "no candidate documents present on this machine");
    return;
  }

  // Every checked-in fixture admits in single-digit milliseconds, so L1c —
  // the clause about work long enough to need intermediate signals — SKIPPED
  // on every run, and the heartbeat that exists to satisfy it was never once
  // exercised by the check that supposedly enforces it. A progress path no
  // check has ever seen fire is not a fix, it is an intention. Synthesizing
  // one deliberately large document gives the clause something real to
  // measure without depending on what happens to be on the machine.
  docs.push({
    label: "synthetic/large",
    ext: ".txt",
    content: "The quick brown fox jumps over the lazy dog near the river bank at dawn.\n".repeat(24000),
  });

  // `stream: true` opts into the SSE progress path (LAWS.md L1c fix) — the
  // plain JSON response, exercised separately by checkConcurrentLoad below,
  // stays a single blocking round trip for callers that never ask to stream.
  let sawLongEnoughForL1c = false;
  for (const doc of docs) {
    const content = doc.content;
    const bytes = Buffer.byteLength(content);
    // Unique name per run so a re-run never collides with its own leftovers.
    const name = `lawcheck-${doc.label.replace(/\//g, "-")}-${process.pid}${doc.ext}`;

    const r = await collectSSE(`${PROXY}/api/ingest`, {
      content, name, session: `lawcheck-${process.pid}`, stream: true,
    }, { timeoutMs: 60000 });

    const kb = (bytes / 1024).toFixed(0);
    if (r.error) {
      record("L1", "L1a", "VIOLATION",
        `ingest ${doc.label} (${kb}KB): no signal — ${r.error} after ${ms(r.ttfs)}`,
        { doc: doc.label, bytes, error: r.error, streamed: true });
      continue;
    }

    const doneEvent = r.events.find((e) => e.name === "done");
    const chunks = doneEvent?.data?.chunks ?? "?";
    const status = verdictFor(r.ttfs);
    record("L1", "L1a", status,
      `ingest ${doc.label} (${kb}KB → ${chunks} chunks): first signal "${r.firstEvent}" at ${ms(r.ttfs)}, total ${ms(r.total)}`,
      {
        doc: doc.label, bytes, chunks: doneEvent?.data?.chunks ?? null,
        ttfs_ms: Math.round(r.ttfs), total_ms: Math.round(r.total),
        first_event: r.firstEvent, events: r.events.map((e) => e.name),
        streamed: true,
      });

    // L1c — "if the operation can exceed the attention budget, it must emit
    // intermediate signals." Measured, not asserted: only a document whose
    // ingest actually ran past the budget is expected to have shown more
    // than start+end. A doc that finished in 8ms has nothing to report.
    if (r.total > TTFS_BUDGET_MS) {
      sawLongEnoughForL1c = true;
      const eventNames = r.events.map((e) => e.name);
      const hasProgress = eventNames.some((n) => n !== "started" && n !== "done" && n !== "error");
      record("L1", "L1c", hasProgress ? "PASS" : "VIOLATION",
        hasProgress
          ? `ingest ${doc.label}: ${eventNames.length} events over ${ms(r.total)} (${eventNames.join(", ")}) — reported progress, not just start→end`
          : `ingest ${doc.label}: ran ${ms(r.total)} showing only "${eventNames.join(", ")}" — start→end is dead air with punctuation`,
        { doc: doc.label, total_ms: Math.round(r.total), events: eventNames });
    }
  }

  if (!sawLongEnoughForL1c) {
    record("L1", "L1c", "SKIP",
      `no ingest in this run exceeded the ${TTFS_BUDGET_MS}ms budget — nothing long enough to prove progress reporting against`);
  }
}

// ── L3: no silent truncation ───────────────────────────────────────────────

async function checkSilentTruncation() {
  section("L3 — no silent truncation");

  // This check used to look for a checkout-local file bigger than the old
  // 500,000-character admission cap and SKIP when it found none — which is
  // every machine without War and Peace in ~/Downloads. The violation it
  // existed to catch was real the whole time and went unmeasured, because the
  // check could not reach the only condition that triggers it. A law whose
  // check silently skips is not enforced.
  //
  // The cap is gone now: documents are admitted whole rather than cut and
  // reported. So the assertion changes with it, and gets stronger. Reporting a
  // cut was always the consolation prize — the dropped remainder was still
  // unsearchable, and the reader was still without the thing they asked for.
  // What is measured now is that nothing was dropped at all, and the proof is
  // not a flag in the response (a flag can lie) but the tail of the document
  // coming back out of the corpus by search.
  const OLD_CAP = 500000;
  const marker = "ZANZIBARQUIXOTROPIC";
  const filler = "Paragraph filler: the quick brown fox jumps over the lazy dog near the river bank at dawn.\n";
  // Comfortably past the old cap, so a reintroduced 500k cut cannot pass.
  let content = filler.repeat(Math.ceil((OLD_CAP * 1.4) / filler.length));
  const submittedChars = content.length + marker.length + 40;
  content += `\nThe sentinel ${marker} appears only in the last line of this document.\n`;

  const name = `lawcheck-wholeness-${process.pid}.txt`;
  const { res, body } = await timedFetch(`${PROXY}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, name, session: `lawcheck-${process.pid}` }),
  });
  let parsed = {};
  try { parsed = JSON.parse(body); } catch {}
  if (!res.ok) {
    record("L3", "L3a", "VIOLATION",
      `a ${(content.length / 1024).toFixed(0)}KB ingest was refused outright (HTTP ${res.status}) — the document is neither cut nor admitted`);
    return;
  }

  // The response must not claim a cut, because there is not supposed to be one.
  const claimsCut = parsed.truncated === true || parsed.capped === true ||
    parsed.droppedChars > 0 || parsed.dropped_bytes > 0;
  record("L3", "L3a", claimsCut ? "VIOLATION" : "PASS",
    claimsCut
      ? `a ${(content.length / 1024).toFixed(0)}KB document came back marked truncated=${JSON.stringify(parsed.truncated)} — admission is capping again`
      : `a ${(content.length / 1024).toFixed(0)}KB document (past the retired ${OLD_CAP}-char cap) is admitted whole: truncated=${JSON.stringify(parsed.truncated)}, ${parsed.chunks} chunks`,
    { submitted_chars: content.length, chunks: parsed.chunks ?? null,
      reported_truncated: parsed.truncated ?? null });

  // The real test, and the one a response flag cannot fake: the LAST line of
  // the document has to be findable. Under the old cap this sentinel sat in
  // the discarded remainder, so searching for it returned "no passage" — the
  // corpus asserting, in its own voice, that the book does not contain what
  // was cut out of it.
  const hit = await fetch(`${PROXY}/api/verbatim?q=${encodeURIComponent(marker)}&limit=3`)
    .then((r) => r.json()).catch(() => null);
  const passages = hit?.passages || [];
  const found = passages.some((p) => String(p.text || "").includes(marker));
  record("L3", "L3a", found ? "PASS" : "VIOLATION",
    found
      ? `the document's final line is retrievable by search — the tail past the retired cap really is in the corpus, not merely reported as admitted`
      : `the document's final line is NOT retrievable (${passages.length} passage(s) returned) — the tail was dropped, and the corpus now answers "no passage" for text the reader supplied`,
    { sentinel: marker, passages_returned: passages.length, submitted_chars: submittedChars });

  // A document that fits must not claim it was cut either. "Always say
  // truncated" would be as useless as never saying it.
  const small = filler.repeat(20);
  const { body: smallBody } = await timedFetch(`${PROXY}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: small, name: `lawcheck-small-${process.pid}.txt`, session: `lawcheck-${process.pid}` }),
  });
  let smallParsed = {};
  try { smallParsed = JSON.parse(smallBody); } catch {}
  const clean = smallParsed.truncated === false || smallParsed.truncated == null;
  record("L3", "L3a", clean ? "PASS" : "VIOLATION",
    clean
      ? `a ${small.length}-character document reports no truncation`
      : `a ${small.length}-character document claims truncated=${JSON.stringify(smallParsed.truncated)} — the flag cannot be trusted if it is always set`,
    { submitted_chars: small.length, reported_truncated: smallParsed.truncated ?? null });

  // Refusal is not truncation, but it must still be loud. Nothing may be
  // dropped on the floor: a body too large to hold is answered, not destroyed.
  const ceiling = await fetch(`${PROXY}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "x".repeat(300 * 1024 * 1024), name: "lawcheck-overceiling.txt" }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
    .catch((e) => ({ status: 0, err: e.message }));
  const loud = ceiling.status === 413 && ceiling.json?.ingested === false;
  record("L3", "L3a", loud ? "PASS" : ceiling.status === 0 ? "SKIP" : "VIOLATION",
    loud
      ? `a body past the transport ceiling is refused with HTTP 413 naming the limit — a refusal that says so, not a silent drop`
      : ceiling.status === 0
        ? `could not probe the transport ceiling (${ceiling.err})`
        : `a body past the transport ceiling answered HTTP ${ceiling.status} — an oversized upload must be refused out loud, never dropped`,
    { status: ceiling.status });
}

// Shared by the idle baseline (checkChatLatency) and the under-load run
// (checkConcurrentLoad) so both are measured and tagged identically — the
// only difference between "the app is fine" and "the app is fine under
// load" must be what else is running, never how the check itself scores it.
async function chatProbes(context) {
  const suffix = context ? ` (${context})` : "";
  const probes = [
    { label: "grounded", q: "What does this document say about design?" },
    { label: "ungrounded", q: "What is the airspeed velocity of an unladen swallow?" },
  ];
  const results = [];
  for (const p of probes) {
    const r = await firstSSEEvent(`${PROXY}/api/chat/tools`, {
      messages: [{ role: "user", content: p.q }],
      session: `lawcheck-${context ? context.replace(/\W+/g, "-") : "idle"}-${process.pid}`,
      stream: true,
    });
    results.push(r);
    if (r.error) {
      // A trigger that never gets a signal at all — the deepest form of L1
      // violation LAWS.md names under L1d: the process had no moment to
      // speak, so the silence never resolves into either progress or failure.
      record("L1", "L1d", "VIOLATION", `chat/${p.label}${suffix}: no signal — ${r.error} after ${ms(r.ttfs)}`,
        { probe: p.label, context, ttfs_ms: Math.round(r.ttfs), error: r.error });
      continue;
    }
    const status = verdictFor(r.ttfs);
    record("L1", "L1a", status,
      `chat/${p.label}${suffix}: first signal "${r.firstEvent}" at ${ms(r.ttfs)}, ${r.events.length} events, total ${ms(r.total)}`,
      { probe: p.label, context, ttfs_ms: Math.round(r.ttfs), total_ms: Math.round(r.total),
        first_event: r.firstEvent, events: r.events, streamed: true });

    // L1b: the first event must carry information about this work. A bare
    // "done" means the reader waited the whole turn with nothing on screen.
    const informative = r.firstEvent && !["done", "message"].includes(r.firstEvent);
    record("L1", "L1b", informative ? "PASS" : "VIOLATION",
      informative
        ? `chat/${p.label}${suffix}: first event "${r.firstEvent}" names the work`
        : `chat/${p.label}${suffix}: first event "${r.firstEvent}" carries no description of what is happening`,
      { probe: p.label, context, first_event: r.firstEvent });
  }
  return results;
}

async function checkChatLatency() {
  section("L1 — no dead air: asking a question");
  await chatProbes(null);
}

// L1d's known violation was never really about ingest OR chat alone — it was
// that a large admitChunked() call has no yield point, so while one runs
// nothing else on the process can be acknowledged, chat included. The only
// way to prove that is fixed is to actually run both at once: fire ingest
// load and never await it before firing the chat probes, the same shape as
// LAWS.md's own measurement ("immediately after a run of large ingests, both
// chat probes emitted nothing for 120s").
async function checkConcurrentLoad() {
  section("L1d — no dead air under load: ingest and chat fired concurrently");
  const candidates = CANDIDATE_DOCS.filter((d) => fs.existsSync(d.file));
  const big = candidates.sort((a, b) => fs.statSync(b.file).size - fs.statSync(a.file).size)[0];
  if (!big) {
    record("L1", "L1d", "SKIP", "no document present to generate real concurrent ingest load");
    return;
  }
  const content = fs.readFileSync(big.file, "utf8");
  const kb = (Buffer.byteLength(content) / 1024).toFixed(0);

  // Three concurrent ingests on the plain (non-streaming) JSON path — the
  // worst case for L1d, since that path's own response can't emit anything
  // until admission finishes. Fired and left unawaited: the chat probes
  // below race them, not follow them.
  const ingestLoad = [1, 2, 3].map((i) => fetch(`${PROXY}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      name: `lawcheck-load-${i}-${process.pid}${path.extname(big.file)}`,
      session: `lawcheck-${process.pid}`,
    }),
  }).catch((e) => ({ ok: false, error: e.message })));

  if (!AS_JSON) console.log(`  firing 3× ${kb}KB ingest(s) of ${big.label} concurrently with the chat probes...`);
  await chatProbes(`under load: 3× ${kb}KB ingest`);
  await Promise.all(ingestLoad);
}

// ── L2: audit is local ─────────────────────────────────────────────────────
//
// The round trip. Each hop is a separate clause because each fails differently:
// a missing endpoint is unreachable evidence (L2b), a byte mismatch is
// unfalsifiable evidence (L2f), and the second is far worse.

async function checkAuditRoundTrip() {
  section("L2 — audit is local: citation round trip");

  const sources = await fetch(`${PROXY}/api/sources?pool=corpus`).then((r) => r.json()).catch(() => []);
  const mine = (Array.isArray(sources) ? sources : []).filter((s) => s.name?.startsWith("lawcheck-"));
  if (!mine.length) {
    record("L2", "L2a", "SKIP", "no ingested source to audit (ingest stage produced none)");
    return;
  }

  // Query with a word drawn from the real text, so a miss means retrieval is
  // broken rather than that the probe was unlucky.
  const probe = "design";
  const search = await fetch(`${PROXY}/api/verbatim?q=${encodeURIComponent(probe)}&limit=5`)
    .then((r) => r.json()).catch((e) => ({ error: e.message }));
  const spans = search?.passages || [];
  if (!spans.length) {
    record("L2", "L2a", "VIOLATION",
      `verbatim search for "${probe}" returned no passages — nothing to audit${search?.error ? ` (${search.error})` : ""}`);
    return;
  }

  const span = spans[0];
  const spanId = span.span_id;
  const sourceRef = span.source;
  record("L2", "L2a", spanId && sourceRef ? "PASS" : "VIOLATION",
    spanId && sourceRef
      ? `passage carries provenance: ${spanId.slice(0, 28)}… from ${String(sourceRef).slice(0, 46)}`
      : `passage is missing ${!spanId ? "span_id" : "source"} — cannot be traced`,
    { span_id: spanId || null, source: sourceRef || null,
      byte_start: span.byte_start ?? null, byte_end: span.byte_end ?? null });

  // L2b — each hop reachable in one step from the artifact itself.
  const hops = [
    { clause: "L2b", what: "read the span", url: `${PROXY}/api/verbatim/read?span_id=${encodeURIComponent(spanId)}` },
    { clause: "L2b", what: "read its context", url: `${PROXY}/api/verbatim/context?span_id=${encodeURIComponent(spanId)}` },
  ];
  for (const hop of hops) {
    const r = await fetch(hop.url).then(async (x) => ({ ok: x.ok, status: x.status, body: await x.text() }))
      .catch((e) => ({ ok: false, status: 0, body: e.message }));
    // HTTP 200 is not evidence. These routes return {error} with a 200 on a
    // failed read, and an earlier version of this check passed them for it —
    // the audit hop was broken and the harness said "ok". Judge the payload:
    // a hop that carries no text delivered no evidence, whatever the status.
    let payload = null;
    try { payload = JSON.parse(r.body); } catch {}
    const errMsg = payload?.error;
    const gotText = typeof payload?.text === "string" && payload.text.length > 0;
    const good = r.ok && !errMsg && gotText;
    record("L2", hop.clause, good ? "PASS" : "VIOLATION",
      good
        ? `${hop.what}: reachable in one step, ${payload.text.length} bytes of evidence`
        : `${hop.what}: ${errMsg ? `error "${String(errMsg).slice(0, 90)}"` : r.ok ? "HTTP 200 but no text in the response" : `HTTP ${r.status}`} — audit path is broken here`,
      { url: hop.url.replace(PROXY, ""), http: r.status, error: errMsg || null, bytes: gotText ? payload.text.length : 0 });
  }

  // L2f — the round trip closes. Read the raw source at the span's own byte
  // offsets and confirm the text the citation showed is really there. This is
  // the check that separates a citation from a decoration.
  if (span.byte_start != null && span.byte_end != null && sourceRef) {
    const url = `${PROXY}/api/source/text?source=${encodeURIComponent(sourceRef)}` +
      `&start=${span.byte_start}&end=${span.byte_end}`;
    const r = await fetch(url).then(async (x) => ({ ok: x.ok, status: x.status, body: await x.text() }))
      .catch((e) => ({ ok: false, status: 0, body: e.message }));
    if (!r.ok) {
      // Show the server's reason. An earlier version printed only the status,
      // which said the round trip was broken but not where — and the whole
      // point of L2 is that a failure you cannot inspect is the actual defect.
      let why = r.body.slice(0, 110);
      try { why = JSON.parse(r.body).error ?? why; } catch {}
      record("L2", "L2f", "VIOLATION",
        `raw source bytes unreachable (HTTP ${r.status}): "${String(why).slice(0, 110)}" — citation cannot be falsified`,
        { http: r.status, error: why });
    } else {
      let payload = null;
      try { payload = JSON.parse(r.body); } catch {}
      if (payload?.error) {
        record("L2", "L2f", "VIOLATION",
          `raw source bytes unreadable: "${String(payload.error).slice(0, 110)}" — citation cannot be falsified`,
          { error: payload.error });
        return;
      }
      const raw = payload?.text ?? payload?.content ?? r.body;
      const norm = (s) => String(s).replace(/\s+/g, " ").trim();
      const quoted = norm(span.text || "").slice(0, 120);
      const closes = quoted.length > 0 && norm(raw).includes(quoted);
      record("L2", "L2f", closes ? "PASS" : "VIOLATION",
        closes
          ? `round trip closes: quoted text found at bytes ${span.byte_start}–${span.byte_end} of its source`
          : `round trip BROKEN: bytes ${span.byte_start}–${span.byte_end} do not contain the quoted text — citation is unfalsifiable`,
        { byte_start: span.byte_start, byte_end: span.byte_end, quoted_len: quoted.length });
    }
  } else {
    record("L2", "L2f", "VIOLATION", "span carries no byte range — the quote cannot be checked against its source");
  }

  // L2d — more than one route to the same activity. Which question occurs to
  // the reader is not knowable, so a single index is a single point of failure.
  section("L2 — audit is local: independent routes in");
  const routes = [
    { by: "by source", url: `${PROXY}/api/sources?pool=corpus` },
    { by: "by content", url: `${PROXY}/api/verbatim?q=${encodeURIComponent(probe)}&limit=1` },
    { by: "by time", url: `${PROXY}/api/web-history` },
    { by: "by conversation", url: `${PROXY}/api/discourse/context?session=lawcheck-${process.pid}` },
    { by: "by deletion", url: `${PROXY}/api/recycle-bin` },
    { by: "by prior", url: `${PROXY}/api/priors` },
  ];
  let reachable = 0;
  for (const rt of routes) {
    const ok = await fetch(rt.url).then((x) => x.ok).catch(() => false);
    if (ok) reachable++;
    record("L2", "L2d", ok ? "PASS" : "VIOLATION",
      `${rt.by}: ${ok ? "reachable" : `unreachable (${rt.url.replace(PROXY, "")})`}`,
      { route: rt.by, ok });
  }
  record("L2", "L2d", reachable >= 3 ? "PASS" : "VIOLATION",
    `${reachable}/${routes.length} independent audit routes reachable`, { reachable, total: routes.length });
}

async function checkGapIsAuditable() {
  section("L2e — absence is auditable");
  // A query that shares no content word with any ingested text. The engine must
  // say so in a way a reader can inspect, rather than returning an empty list
  // that reads identically to "we did not look".
  const nonsense = "zzyzx quixotropic bandersnatch";
  const r = await fetch(`${PROXY}/api/verbatim?q=${encodeURIComponent(nonsense)}&limit=3`)
    .then(async (x) => ({ ok: x.ok, json: await x.json().catch(() => null) }))
    .catch((e) => ({ ok: false, json: null, err: e.message }));
  if (!r.ok) {
    record("L2", "L2e", "VIOLATION", "a no-match query errored instead of reporting a gap");
    return;
  }
  const j = r.json || {};
  const passages = j.passages || [];
  if (passages.length) {
    record("L2", "L2e", "SKIP", "nonsense probe unexpectedly matched — cannot test the gap path");
    return;
  }

  // Two separable questions, because they fail independently.
  //
  // Did it say what it looked for? Echoing the query back proves the search
  // ran on what the reader meant, not on a mangled or dropped string.
  const echoesQuery = j.query != null && j.total != null;
  record("L2", "L2e", echoesQuery ? "PASS" : "VIOLATION",
    echoesQuery
      ? `no-match search echoes what it searched (query + total), so the reader can tell it ran`
      : `no-match search does not report what it searched — indistinguishable from "we did not look"`,
    { keys: Object.keys(j) });

  // Did it name the absence? The response carries a `gaps` field precisely so
  // a miss can be described. Leaving it null on a zero-result search is the
  // gap going unnamed: the reader learns nothing about WHY the corpus was
  // silent, only that it was, which is the ambiguity L2e exists to remove.
  const named = j.gaps != null && (!Array.isArray(j.gaps) || j.gaps.length > 0);
  record("L2", "L2e", named ? "PASS" : "VIOLATION",
    named
      ? `no-match search names the gap: ${JSON.stringify(j.gaps).slice(0, 120)}`
      : `no-match search returns gaps:${JSON.stringify(j.gaps)} — the field exists to name the absence and is left empty`,
    { total: j.total ?? null, gaps: j.gaps ?? null });

  // Naming the gap is not enough if every silence gets the same name. "You
  // have ingested nothing", "the corpus is still loading" and "your sources
  // were read and do not say this" are three different facts, and a reader who
  // cannot tell them apart cannot act: the first wants an upload, the second
  // wants patience, the third is an answer. The gap must therefore carry a
  // type AND say how much was actually searched.
  const gap = Array.isArray(j.gaps) ? j.gaps[0] : j.gaps;
  const typed = !!(gap && typeof gap === "object" && (gap.type || gap.reason));
  const quantified = !!(gap && typeof gap === "object" && gap.sourcesSearched != null);
  record("L2", "L2e", typed && quantified ? "PASS" : "VIOLATION",
    typed && quantified
      ? `the gap distinguishes which silence it was: type="${gap.type}", ${gap.sourcesSearched} source(s) searched`
      : typed
        ? `the gap is typed ("${gap.type}") but does not say how much was searched — "nothing is loaded" still reads like "nothing was found"`
        : `the gap is untyped (${JSON.stringify(gap).slice(0, 80)}) — an empty corpus and a silent one render identically`,
    { gap_type: gap?.type ?? null, sources_searched: gap?.sourcesSearched ?? null });
}

// ── candidate law: errors do not wear success ───────────────────────────────

// Promoted from LAWS.md's candidate list by writing the check, which is the
// only way a candidate becomes a law here. The failure it forbids: a request
// that produced no evidence answering with a success status, so that every
// client branching on `res.ok` — this harness included, which once passed
// these very routes for exactly that reason — treats a missing passage as a
// delivered one. On an audit hop that is the most damaging possible place for
// it, because the reader following a citation home is told the trip succeeded.
async function checkErrorsDoNotWearSuccess() {
  section("errors do not wear success");
  const ghost = "span:fnv128:0000000000000000000000000000dead";
  const probes = [
    { label: "verbatim/read", url: `${PROXY}/api/verbatim/read?span_id=${encodeURIComponent(ghost)}` },
    { label: "verbatim/context", url: `${PROXY}/api/verbatim/context?span_id=${encodeURIComponent(ghost)}` },
  ];
  for (const p of probes) {
    const r = await fetch(p.url)
      .then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }))
      .catch((e) => ({ status: 0, json: null, err: e.message }));
    const carriesError = !!(r.json && r.json.error);
    // The body saying "unknown span" while the status line says 200 is the
    // violation. Either it found the span (200, no error) or it did not (4xx).
    const honest = !carriesError || (r.status >= 400 && r.status < 500);
    record("L2", "L2b", honest ? "PASS" : "VIOLATION",
      honest
        ? `${p.label}: an unresolvable span answers HTTP ${r.status}, so a client checking res.ok is not misled`
        : `${p.label}: HTTP ${r.status} with body {error:"${String(r.json.error).slice(0, 60)}"} — a failed read wearing a success status`,
      { probe: p.label, status: r.status, carries_error: carriesError });
  }
}

// ── L6: no implied completeness ─────────────────────────────────────────────
//
// Static, not live — the only real check the other laws' style would call
// for is a browser rendering the fold panel against real ingested content,
// which this script has no harness for. What IS checked here is real:
// engine-ground.js's engineFoldSource computes withheld_total (the count
// before its own `limit` truncates the withheld array) specifically so, in
// its own words, "a truncated list cannot be mistaken for the whole one" —
// this verifies that number actually reaches the UI's own "N shown" note
// (ui/index.html's voidCandidateNote) rather than being computed and
// dropped, which was the real, live gap found and fixed in this pass: the
// UI already read withheld_total per-document (`d.withheldTotal`, shown in
// a summary line) but the specific panel listing withheld candidates
// compared only against its own already-engine-truncated array length.
async function checkNoImpliedCompleteness() {
  section("L6: no implied completeness");
  const uiPath = path.join(UI_DIR, "index.html");
  const src = fs.existsSync(uiPath) ? fs.readFileSync(uiPath, "utf8") : "";
  if (!src) {
    record("L6", "L6a", "SKIP", `ui/index.html not found at ${uiPath}`, {});
    return;
  }
  const hasTrueTotal = /withheldTrueTotal\s*=\s*castDocs\.reduce/.test(src);
  const reconciledInNote = hasTrueTotal && /voidCandidateNote\s*=\s*withheldTrueTotal\s*>\s*castWithheld\.length/.test(src);
  record("L6", "L6a", reconciledInNote ? "PASS" : "VIOLATION",
    reconciledInNote
      ? "the withheld-candidates panel reconciles its own display note against the engine's true withheld_total, not just its own already-truncated array"
      : "the withheld-candidates panel's \"N shown\" note does not check the engine's real withheld_total — a document where the ENGINE itself capped withheld candidates below the real count would show as complete when it is not",
    { checked: uiPath, static_check: true });
}

// ── L7: no silent degradation across language or medium ────────────────────
//
// Real, not mocked: this imports formatTerrainReport directly (the exact
// function server/proxy.js's terrain_report handler calls — extracted to
// its own module specifically so it is unit-testable without a live proxy
// or a model round-trip, see server/terrain-report-format.js's header) and
// runs the REAL cube classifier (vendor/eoreader5, via buildReadingFromBytes)
// against real Greek text and real English text, checking both directions:
// the scope-ambiguity disclosure must appear when no signal is detected
// (measured: real Greek scores exactly this) and must NOT appear when the
// classifier does find real signal, so the check also catches the caveat
// becoming permanently-on noise, not just permanently-off.
async function checkNoSilentDegradation() {
  section("L7: no silent degradation across language or medium");
  const dispatchPath = path.join(LEGACY_ENGINE_ROOT, "packages", "engine", "perceiver", "dispatch.js");
  if (!fs.existsSync(dispatchPath)) {
    record("L7", "L7a", "SKIP", `eoreader5 perceiver not present at ${dispatchPath} — run git submodule update --init --recursive`, {});
    return;
  }
  const { buildReadingFromBytes } = await import(pathToFileURL(dispatchPath).href);

  // Real Greek (Odyssey, Book 1 opening line — no fetch needed, short enough
  // to inline) — the cube classifier's English-only lexicon (cube/index.js,
  // discloses its own scope) has no terms that fire on this at all.
  const greekBytes = Buffer.from(
    "ἄνδρα μοι ἔννεπε, μοῦσα, πολύτροπον, ὃς μάλα πολλὰ πλάγχθη, ἐπεὶ Τροίης ἱερὸν πτολίεθρον ἔπερσεν·",
    "utf8"
  );
  const greekReading = await buildReadingFromBytes(greekBytes);
  const greekText = formatTerrainReport(greekReading.terrain_report, greekReading.born_gate, "test:greek");
  const greekHasCaveat = greekText.includes("this classifier's terrain lexicon is English-only");
  record("L7", "L7a", greekHasCaveat ? "PASS" : "VIOLATION",
    greekHasCaveat
      ? "real Greek text (no signal detected) discloses the classifier's English-only scope rather than reading as a considered Void finding"
      : "real Greek text scored no signal with NO scope disclosure — reads as \"this source has no structure\" rather than \"outside this classifier's competence\"",
    { medium: greekReading.terrain_report?.medium, signal_detected: !!greekReading.born_gate?.signalDetected });

  // Real English with real terrain-lexicon hits — the caveat must be absent
  // here, or it has become noise attached to every result instead of a
  // signal attached to the ambiguous ones.
  const englishBytes = Buffer.from(
    "She felt a deep and troubling grief, a sorrow that welled up like tears she could not explain, " +
    "an atmosphere of sadness hanging over the empty house.",
    "utf8"
  );
  const englishReading = await buildReadingFromBytes(englishBytes);
  const englishText = formatTerrainReport(englishReading.terrain_report, englishReading.born_gate, "test:english");
  const englishHasCaveat = englishText.includes("this classifier's terrain lexicon is English-only");
  const englishSignal = !!englishReading.born_gate?.signalDetected;
  record("L7", "L7b", (englishSignal && !englishHasCaveat) ? "PASS" : "VIOLATION",
    (englishSignal && !englishHasCaveat)
      ? "real English text with real terrain signal renders cleanly, without the scope caveat cluttering a genuine finding"
      : `unexpected: signal_detected=${englishSignal}, caveat_present=${englishHasCaveat} — either the fixture stopped triggering real signal or the caveat is firing when it should not`,
    { medium: englishReading.terrain_report?.medium, signal_detected: englishSignal });

  // L7c — terrain_report was not the only place this conflation lived.
  // ingest_file's terrain summary and search_memory's terrain hint both had
  // the identical unqualified "Void" string. Both are small ternaries
  // embedded inside large, stateful proxy.js handlers (store.ingest side
  // effects, session state) — not pulled into their own pure module the way
  // formatTerrainReport was, so this checks the real shipped source text
  // directly rather than importing proxy.js (which starts a server as a
  // side effect of module load; see terrain-report-format.js's header).
  const proxyPath = path.join(REPO_ROOT, "server", "proxy.js");
  const proxySrc = fs.existsSync(proxyPath) ? fs.readFileSync(proxyPath, "utf8") : "";
  const ingestFixed = /Terrain: Void, or outside this English-only classifier's scope/.test(proxySrc);
  const searchHintFixed = /\[terrain: Void\/out-of-scope\]/.test(proxySrc);
  record("L7", "L7c", (ingestFixed && searchHintFixed) ? "PASS" : "VIOLATION",
    (ingestFixed && searchHintFixed)
      ? "ingest_file's terrain summary and search_memory's terrain hint both disclose the same scope ambiguity terrain_report does, not just the tool handler that was checked first"
      : `unqualified "Void" still present: ingest summary fixed=${ingestFixed}, search hint fixed=${searchHintFixed}`,
    { checked: proxyPath, static_check: true });
}

// ── cleanup ────────────────────────────────────────────────────────────────

async function listSourceKeys() {
  const j = await fetch(`${PROXY}/api/sources?pool=corpus`).then((r) => r.json()).catch(() => []);
  // The same value under two names, now carried on both surfaces — take
  // whichever is present so this works against either spelling.
  return new Set((Array.isArray(j) ? j : []).map((s) => s.path || s.sourceId).filter(Boolean));
}

async function cleanup() {
  if (KEEP) {
    if (!AS_JSON) console.log(`\ncleanup: skipped (--keep)`);
    return;
  }
  const now = await listSourceKeys();
  const added = [...now].filter((k) => !baseline.has(k));
  let removed = 0;
  for (const key of added) {
    const ok = await fetch(`${PROXY}/api/sources?source=${encodeURIComponent(key)}`, { method: "DELETE" })
      .then((r) => r.ok).catch(() => false);
    if (ok) removed++;
  }
  // Soft-delete parks them in the recycle bin, which is itself a left-panel
  // surface — purge, or the check leaves exactly the clutter it came to police.
  await fetch(`${PROXY}/api/recycle-bin`, { method: "DELETE" }).catch(() => {});
  // A timed-out chat probe leaves its web search running server-side, and that
  // search ingests its pages after we have already swept. One settle-and-resweep
  // catches the stragglers; without it the check quietly grows the sources rail
  // every run, which is precisely the mess it exists to police.
  await new Promise((r) => setTimeout(r, 1500));
  const stragglers = [...(await listSourceKeys())].filter((k) => !baseline.has(k));
  for (const key of stragglers) {
    const ok = await fetch(`${PROXY}/api/sources?source=${encodeURIComponent(key)}`, { method: "DELETE" })
      .then((r) => r.ok).catch(() => false);
    if (ok) removed++;
  }
  if (stragglers.length) await fetch(`${PROXY}/api/recycle-bin`, { method: "DELETE" }).catch(() => {});

  const leftover = [...(await listSourceKeys())].filter((k) => !baseline.has(k));
  if (!AS_JSON) {
    console.log(`\ncleanup: removed ${removed} source(s) this run added` +
      `${stragglers.length ? ` (${stragglers.length} landed after the first sweep)` : ""}, purged recycle bin`);
    if (leftover.length) console.log(`  WARNING — ${leftover.length} could not be removed: ${leftover.slice(0, 4).join(", ")}`);
  }
}

function section(title) {
  if (!AS_JSON) console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  // L6 and L7 need neither a live proxy nor a model — one is a static source
  // check, the other imports the real formatting function and the real
  // vendored classifier directly. Run first, unconditionally, so they still
  // report in any environment, including one with no proxy running at all.
  await checkNoImpliedCompleteness();
  await checkNoSilentDegradation();

  const up = await fetch(`${PROXY}/health`).then((r) => r.ok).catch(() => false);
  if (!up) {
    if (!AS_JSON) console.log(`\nno proxy at ${PROXY} — skipping L1/L2/L3 (live-proxy checks); start it with \`npm start\` to run those too`);
    const violations = findings.filter((f) => f.status === "VIOLATION");
    if (AS_JSON) console.log(JSON.stringify({ proxy: null, findings, summary: { pass: findings.filter((f) => f.status === "PASS").length, violation: violations.length, skip: findings.filter((f) => f.status === "SKIP").length } }, null, 2));
    process.exit(sawViolation ? 1 : 0);
  }
  if (!AS_JSON) console.log(`\ncheck-laws — proxy ${PROXY}\nbudget: first signal ≤ ${TTFS_BUDGET_MS}ms (instant ≤ ${TTFS_INSTANT_MS}ms)`);

  baseline = await listSourceKeys();
  if (!AS_JSON) console.log(`baseline: ${baseline.size} source(s) already loaded — these are left untouched`);

  try {
    await checkIngestLatency();
    await checkSilentTruncation();
    await checkChatLatency();
    await checkConcurrentLoad();
    await checkAuditRoundTrip();
    await checkGapIsAuditable();
    await checkErrorsDoNotWearSuccess();
  } finally {
    await cleanup();
  }

  const violations = findings.filter((f) => f.status === "VIOLATION");
  if (AS_JSON) {
    console.log(JSON.stringify({
      proxy: PROXY,
      budget: { instant_ms: TTFS_INSTANT_MS, budget_ms: TTFS_BUDGET_MS },
      findings,
      summary: {
        pass: findings.filter((f) => f.status === "PASS").length,
        violation: violations.length,
        skip: findings.filter((f) => f.status === "SKIP").length,
      },
    }, null, 2));
  } else {
    const byLaw = {};
    for (const v of violations) byLaw[v.clause] = (byLaw[v.clause] || 0) + 1;
    console.log(`\n\x1b[1msummary\x1b[0m  ${findings.filter((f) => f.status === "PASS").length} pass · ` +
      `${violations.length} violation · ${findings.filter((f) => f.status === "SKIP").length} skip`);
    if (violations.length) {
      console.log(`violations by clause: ${Object.entries(byLaw).map(([c, n]) => `${c}×${n}`).join(", ")}`);
      console.log(`\nA violation is not a reason to soften the law. Record it in LAWS.md and fix the code.`);
    }
  }
  process.exit(sawViolation ? 1 : 0);
}

main().catch((err) => {
  console.error(`check-laws: ${err.stack || err.message}`);
  cleanup().finally(() => process.exit(2));
});
