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
import { fileURLToPath } from "node:url";

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
  const docs = CANDIDATE_DOCS.filter((d) => fs.existsSync(d.file));
  if (!docs.length) {
    record("L1", "L1a", "SKIP", "no candidate documents present on this machine");
    return;
  }

  // `stream: true` opts into the SSE progress path (LAWS.md L1c fix) — the
  // plain JSON response, exercised separately by checkConcurrentLoad below,
  // stays a single blocking round trip for callers that never ask to stream.
  let sawLongEnoughForL1c = false;
  for (const doc of docs) {
    const content = fs.readFileSync(doc.file, "utf8");
    const bytes = Buffer.byteLength(content);
    // Unique name per run so a re-run never collides with its own leftovers.
    const name = `lawcheck-${doc.label.replace(/\//g, "-")}-${process.pid}${path.extname(doc.file)}`;

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
  const CAP = 500000; // proxy.js: content.slice(0, 500000)
  const big = CANDIDATE_DOCS.map((d) => d.file).find(
    (f) => fs.existsSync(f) && fs.statSync(f).size > CAP * 1.5
  );
  if (!big) {
    record("L3", "L3a", "SKIP", `no document larger than the ${CAP}-char ingest cap available to test with`);
    return;
  }

  const content = fs.readFileSync(big, "utf8");
  const name = `lawcheck-truncation-${process.pid}${path.extname(big)}`;
  const { res, body } = await timedFetch(`${PROXY}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, name, session: `lawcheck-${process.pid}` }),
  });
  let parsed = {};
  try { parsed = JSON.parse(body); } catch {}
  if (!res.ok) {
    record("L3", "L3a", "VIOLATION", `oversized ingest failed HTTP ${res.status}`);
    return;
  }

  // The reader handed over a whole book and got back part of one. Whether the
  // cap is right is a separate question — the law is only that the response
  // must say it happened, because a silently shortened source produces
  // confidently wrong "the text does not mention X" answers about the part
  // that was dropped.
  const declared = parsed.truncated ?? parsed.capped ?? parsed.dropped_bytes ?? parsed.original_length;
  const reported = declared != null;
  record("L3", "L3a", reported ? "PASS" : "VIOLATION",
    reported
      ? `oversized ingest reports the cap (${JSON.stringify(declared)})`
      : `${(content.length / 1024).toFixed(0)}KB ingested, silently cut to ${(CAP / 1024).toFixed(0)}KB — response has no truncation field, so the reader believes the whole text is loaded`,
    { submitted_chars: content.length, cap: CAP, dropped_chars: content.length - CAP,
      response_keys: Object.keys(parsed) });
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
}

// ── cleanup ────────────────────────────────────────────────────────────────

async function listSourceKeys() {
  const j = await fetch(`${PROXY}/api/sources?pool=corpus`).then((r) => r.json()).catch(() => []);
  // `path` on read, `sourceId` on write — the same value under two names. Take
  // whichever is present so this keeps working if they are ever reconciled.
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
  const up = await fetch(`${PROXY}/health`).then((r) => r.ok).catch(() => false);
  if (!up) {
    console.error(`check-laws: no proxy at ${PROXY} — start it with \`npm start\``);
    process.exit(2);
  }
  if (!AS_JSON) console.log(`check-laws — proxy ${PROXY}\nbudget: first signal ≤ ${TTFS_BUDGET_MS}ms (instant ≤ ${TTFS_INSTANT_MS}ms)`);

  baseline = await listSourceKeys();
  if (!AS_JSON) console.log(`baseline: ${baseline.size} source(s) already loaded — these are left untouched`);

  try {
    await checkIngestLatency();
    await checkSilentTruncation();
    await checkChatLatency();
    await checkConcurrentLoad();
    await checkAuditRoundTrip();
    await checkGapIsAuditable();
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
