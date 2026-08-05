# EOChat Laws

Not the constitution. `../eo-constitution/` decides *what goes where* — engine,
priors, app, legacy. These decide *how this app must behave* once placement is
settled. They bind the host: clock, I/O, routing, UX. They can never license a
change to engine reading.

Instructions are governed separately: [INSTRUCTION-LAW.md](INSTRUCTION-LAW.md)
is the universal law for instruction sets and the surf-and-fold gate, enforced
by `node scripts/check-instruction-laws.mjs`.

A law is not a preference. It states a failure it forbids, and it names the
measurement that catches the failure. A principle you cannot fail is a slogan.
Each law below ends with the check that enforces it, run by
`node scripts/check-laws.mjs`.

Laws are numbered for citation in review ("this violates L1b"), not ranked.

---

## L1 — No dead air

**Between a trigger and its first visible consequence there is no silence.**

The reader pressed something. Until the interface answers, they cannot tell
whether the system is working, hung, or never heard them. Those are three very
different situations that look identical from outside, and the reader resolves
the ambiguity the only way they can: by assuming the worst and pressing again.

This is not a law about speed. It is a law about the *silence window*. A
90-second ingest that reports each chunk as it lands obeys L1. A 3-second
ingest that shows nothing until it returns violates it, and violates it worse,
because the reader learns that this interface goes blank under load and will
distrust the next long operation too.

Speed is not a defence. Fast work still has to announce itself, because the
reader cannot know in advance that this particular trigger was the fast one.

### Clauses

- **L1a — Acknowledge before working, not after.** The first signal is emitted
  when the trigger is received, before the expensive work begins. A signal
  emitted on completion is a result, not an acknowledgement.
- **L1b — Say what is happening, not that something is happening.** "Reading
  pg84.txt — 12 of 60 chunks" is a signal. A spinner is not: it would look
  identical if the work had never started, so it carries no evidence.
- **L1c — Long work reports progress, not just start and end.** If the
  operation can exceed the attention budget, it must emit intermediate signals.
  Start-then-silence-then-end is dead air with punctuation.
- **L1d — Failure is a signal.** A trigger that dies quietly violates L1 more
  severely than one that is slow, because the silence never resolves. Every
  path that can fail must emit on failure.
- **L1e — The signal is specific to this work.** A signal that would appear
  whether or not the work started is decoration. It must be caused by the work
  it reports.

### Measurement

**TTFS** — time to first signal — is the interval from trigger to the first
byte the client can observe and attribute to this trigger. Dead air *is* TTFS:
they are the same number seen from the two sides.

- TTFS ≤ 100 ms — instantaneous; the reader perceives no wait.
- TTFS ≤ 1000 ms — acceptable; flow is preserved.
- TTFS > 1000 ms — **violation.** Record it, do not round it away.

The budget is on the *signal*, never on the work. Work may take as long as it
takes, provided L1c keeps reporting.

### What measurement actually showed

The first draft of this law assumed document *size* drove dead air. Three runs
of the check say otherwise, and the real finding is worse.

Ingest TTFS, same seven documents, three consecutive runs (ms):

| doc | size | run 1 | run 2 | run 3 |
|---|---|---|---|---|
| tiny/md | 0.4 KB | 8 | 1538 | 208 |
| small/md | 1 KB | 3 | 66 | **39160** |
| medium/md | 15 KB | 5 | **15971** | 109 |
| large/md | 18 KB | 7 | 52 | 22 |
| large/json | 90 KB | 15 | 24 | 70 |
| book/txt | 438 KB | 175 | 258 | 462 |
| epic/txt | 3281 KB | 255 | 386 | 724 |

Size barely matters: a 3.3 MB book ingests in under a second. What matters is
**contention** — ingest is synchronous and shares a process with LLM calls, so
a 1 KB file took 39 seconds while a chat turn held the runtime. The worst case
is not the biggest document, it is the smallest one that happened to arrive at
a busy moment, and nothing about the request predicts which.

This is the case for L1 in its strongest form. "It is usually fast" is not a
defence, because the reader cannot know which request is the usual one. An
interface that is silent for 8 ms and silent for 39 s in the same way has told
them nothing either time.

### Known violations (open)

- **L1a — under load, ungrounded chat still misses budget, narrowly.**
  Profiled 2026-08-04 with real timers at each candidate stage (JSON.parse,
  `mergeIngestResult`, the worker round trip), not guessed. The two probes
  take the same code path — `chatProbes()` fires them sequentially, grounded
  first, so ungrounded's request always lands later in wall-clock time,
  closer to whatever the concurrent ingests are doing by then. That ruled out
  "the ungrounded path is structurally slower" as the explanation; both were
  measured identical up to `tools_available`.

  What the timers found instead: `JSON.parse` of a 3.3MB ingest body and
  `mergeIngestResult`'s per-span merge loop were both directly measured
  under 15ms in every run, including under load — neither is the cost. An
  `setInterval`-based event-loop-lag probe (fires every 50ms, logs when the
  gap exceeds 30ms) found real blocking of 300ms–1.7s specifically during
  the 3-concurrent-ingest window, with **zero** such blocking during a solo
  ingest of the same document — confirming the worker-thread isolation
  itself works (a lone 3.3MB admission never once stalled the main thread's
  ability to accept a fresh request), and narrowing the remaining cost to
  the WORKER'S RESULT TRANSFER: `ingest-worker.js` returned each admission's
  spans, document, and provenance as one `postMessage`, and Node's
  structured-clone deserialization of that payload on the receiving side is
  synchronous work that happens *before* the `message` event's callback
  runs — invisible to a timer placed inside that callback, on either side.

  Fixed by batching: the worker now sends spans and provenance in ~200-entry
  chunks, each its own `postMessage`, reassembled by the client
  (`ingest-worker-client.js`) before resolving — the event loop gets a tick
  between transfers instead of absorbing one large one. Measured effect
  across three runs, same probe, same load, only the transfer shape changed:
  **1399ms → 1612ms → 1740ms (worsening across runs, pre-fix) → 1027ms
  (post-fix)** — roughly halved from the worst pre-fix run, and within 3% of
  the 1000ms budget rather than 74% over it. Still a real, open violation:
  27ms over budget is not zero, and this class of adversarial load (three
  full-book concurrent admissions racing two chat probes) is harder than
  anything an ordinary reader produces, but the law does not grade on the
  curve of how the failure was found. Left for a future pass: yielding
  *inside* a single admission's own transfer earlier (smaller batches, or a
  batch size scaled to document size rather than a flat 200), or reducing
  what crosses the worker boundary at all rather than chunking it.

### Fixed under this law

- **L1c — ingest now reports progress.** `POST /api/ingest` streams SSE
  (`started` → `progress` × N → `done`) instead of one blocking
  request/response. Measured 2026-08-04: a 3.3MB ingest emitted 18 events
  over 5.1s. Confirmed by `scripts/check-laws.mjs`'s L1c check, which was
  itself failing before this shipped.
- **L1d — the acknowledgement is reachable again.** The prior measurement
  found the acknowledgement was not late, it was *unreachable*: synchronous
  engine work held the event loop, so no SSE header could flush until an
  ingest finished — both chat probes went silent for 120s under load and hit
  the checker's timeout, the deepest form of an L1 violation, because no care
  at the call site could fix it. `server/ingest-worker.js` moved the real
  admission call (`admitChunked`) off the main thread into a worker; its own
  header cites the root cause measured here by name — profiling `pg2600.txt`
  (3.3MB) showed 9–17s with no yield points on the thread that also answers
  HTTP. `proxy.js`'s ingest handler now writes the SSE header and a `started`
  event before calling `performIngest` at all (L1a), and streams a heartbeat
  tied to the outstanding promise while the worker runs (L1c, above).

  Re-measured 2026-08-04 under the same concurrent-load shape: the grounded
  chat probe's first signal now arrives in 528ms, not 120s of nothing. This
  is not a full close of L1d — see the L1a violation above, newly visible
  now that the total-silence failure is gone — but the specific failure
  recorded here, an unreachable acknowledgement, is fixed and reproducibly
  so.

- `/api/verbatim/context` accepted only `id` while the docs published

- `/api/verbatim/context` accepted only `id` while the docs published
  `span_id`, so the second hop of every documented audit path returned 400.
  Now accepts both, as `/read` already did.

See also the thinking surface: async work shows live inline feedback and is
never gated behind a click. That is L1 applied to one surface; this is the
general form.

---

## L2 — Audit is local

**Anything the reader can doubt, they can inspect from where they doubt it.**

Auditability is not a page. A log viewer in a corner of the app satisfies an
engineer and fails a reader, because it demands they already know the activity
happened, already know what it was called, and already know to go looking. The
question does not form there. It forms at the artifact — at the citation that
looks too convenient, at the number that seems too round, at the passage that
does not sound like the book.

"From anywhere it might occur to us" is the operative phrase and it is a claim
about *routes*, not about *coverage*. One exhaustive audit trail reachable by
one path is not compliant. The reader who wonders "where did this come from"
and the reader who wonders "what did it do at 4pm" and the reader who wonders
"what has it ever said about Frankenstein" are three different questions that
must all land on the same record.

### Clauses

- **L2a — Every artifact carries its provenance.** A displayed passage knows
  its source, its byte range, and how it was selected. Rendering strips none of
  this.
- **L2b — One step from the artifact.** The path to evidence begins at the
  thing in question, not at a menu. If the reader must first learn the app's
  filing system, the audit has failed.
- **L2c — Audit never mutates.** Inspecting an activity does not alter it,
  re-run it, or change what a later audit will see. Read-only or it is not an
  audit.
- **L2d — More than one route in.** The same activity is reachable by time, by
  source, and by entity, because which of these occurs to the reader is not
  knowable in advance.
- **L2e — Absence is auditable.** A gap is a finding and must be inspectable —
  what was searched, what was not found, why the answer is thin. An empty space
  where evidence should be is the single easiest thing to mistake for evidence
  of nothing.
- **L2f — The round trip closes.** A quoted passage can be followed to its
  source bytes and those bytes match the quote. An audit path that leads
  somewhere unverifiable is decoration.

### Measurement

The check walks a real citation end to end: search → span id → read the span →
read its surrounding context → read the raw source bytes at the span's own
offsets → compare. Every hop must exist, and the final bytes must contain the
quoted text.

A hop that 404s is an L2b violation. A byte mismatch is an L2f violation, and
the more serious of the two: it means the citation is unfalsifiable, which is
the failure this whole application exists to prevent.

### Fixed under this law

Writing the check broke the round trip open on the first run. Both defects made
every citation from a reader-attached document unverifiable — the exact failure
mode this app exists to prevent, sitting in the code unnoticed because nothing
had ever followed a quote all the way home.

- **Chunk ids never resolved to documents.** A passage reports its source as
  `source:book.txt:1699:chunk-7`; the catalog holds `source:book.txt:1699`.
  `resolveDocument` compared them literally and matched nothing, so reading a
  quote's bytes or its surrounding text failed for every source. Now the chunk
  suffix — a position *within* a document, not a different document — is
  stripped in the one resolver every reader shares.
- **Byte readers assumed a file on disk.** They indexed `doc.path` directly,
  which works only for file-ingested sources. Everything a reader attaches
  through the UI is ingested as *content* and carries a synthetic id no
  filesystem can stat, so raw-byte reads returned ENOENT. They now fall back to
  the text the engine already retains, through a Buffer-backed index shared
  with the file path so both produce byte-identical offsets.

Both were invisible while the app auto-loaded three books from disk. Removing
that boot ingest did not cause the bug; it removed the only sources that
happened to work around it.

### Also fixed under this law

- **L2e — the gap is not named.** A no-match search returned `gaps: null`, so
  an empty corpus, a corpus still warming, a source filter that excluded
  everything, and a corpus that genuinely does not discuss the query all
  produced byte-identical responses. Measured before the fix: with nothing
  ingested at all, `/api/verbatim?q=…` answered `{total: 0, gaps: null}` — the
  same bytes it returns for a book that simply does not mention the query.

  `describeAbsence()` (proxy.js) now names which silence it was, as a typed gap
  in the shape the UI already renders: `no_sources_ingested`,
  `corpus_warming`, `source_filter_matched_nothing`, or `no_evidence_matched`,
  each carrying `sourcesSearched` so "nothing is loaded" cannot read as
  "nothing was found". The engine's own gap still wins when it has one.

  The same gap is emitted on the two grounding paths a reader actually meets —
  the `grounding` SSE event and `/api/ground` — where the fixed banner text
  ("No matching passage in your sources") asserted that a library had been
  consulted even when no source existed. An ungrounded turn with an empty
  corpus now says so and says what to do about it.

- **Errors do not wear success** (promoted from the candidate list by writing
  its check). `/api/verbatim/read`, `/segment` and `/context` wrapped the
  engine's helpers — which report a failed read by *returning* `{error}` rather
  than throwing — in an unconditional `writeHead(200)`. An unknown span id was
  answered "HTTP 200: unknown span_id, search first", so every client branching
  on `res.ok` treated a missing passage as a delivered one, on the audit hop
  where that is most damaging. `sendVerbatim()` now sends 404 when the body
  carries an error.

---

## L3 — No silent truncation

**Where output is cut, the cut is reported.**

A capped result that does not announce its cap reads as a complete one. The
reader draws conclusions from a whole they never received, and the system has
no way to tell them the difference — every "the text does not mention X" about
the discarded remainder is confidently, invisibly wrong.

This is the same sin as L1's silence and L2e's unnamed gap, at the level of
content rather than time: two different situations rendered identically.

### Clauses

- **L3a — A truncated response says so,** in the response, not in the docs.
- **L3b — It says how much was lost,** because "some was dropped" does not tell
  the reader whether to re-ask.

### Fixed under this law

`POST /api/ingest` capped content at 500 000 characters
(`content.slice(0, 500000)`) and returned no field recording it. Reproduced
before the fix: a 700 106-character document was accepted, silently reduced to
500 000, and reported back as a successful ingest of 250 chunks. A sentinel
placed past the cap was then unfindable — and the search for it returned
`total: 0, gaps: null`, which is exactly how the corpus reports a phrase a book
genuinely does not contain. The two failures compounded: the reader was told
the whole book was loaded, and then told, in the corpus's own voice, that the
book does not mention what was cut out of it.

**The cap is gone. Documents are admitted whole.**

Reporting the cut was the first fix and it was the wrong ceiling to settle on.
An announced truncation is still a truncation: the dropped six sevenths of the
book are still unsearchable and still uncitable, and a reader told so is still
without the thing they asked for. Honesty about a loss is not a substitute for
not losing it. Every ingest surface now admits the full text — plain JSON, SSE,
the project-scoped route, and the web-search ingest alike.

`truncated: false` is still on every ingest response, as a positive assertion
of completeness rather than a field that appears only when something went
wrong. `admitWhole()` is the one place that assertion is made, so a
reintroduced cap has to come back through it, and the UI that would display it
is already wired.

Two related silent cuts went with it:

- **The client cut first.** `ui/index.html` sliced to 500 000 characters
  *before* sending, which put the truncation on the one side of the wire that
  could never report it — the server received a 500 000-character document,
  saw nothing unusual, and answered honestly. The whole text is sent now.
- **The attachment sidecar was shorter than the corpus.** `fetch_attachment`
  reads a sidecar file that was itself capped, which would have made the
  drill-down path quietly blinder than the search path over the very same
  source. It is stored whole, matching admission.

What remains bounded, deliberately, is the **transport ceiling**
(`INGEST_MAX_BODY`) — and it is a refusal, not a truncation. Nothing is cut and
nothing is admitted: a body too large to hold in memory is answered with a 413
naming the limit, because the alternative is a heap failure that takes the
process down and loses the document anyway. An oversized upload used to be
answered by destroying the socket, which is L1d's "dies quietly" in its purest
form.

One announced cut is left, and it is not the corpus: `fetch_attachment` returns
at most 15 000 characters of a document into a single tool result, because that
result has to fit the model's context window alongside everything else — an
unbounded one would overflow `NUM_CTX` and produce an answer that reads like a
retrieval failure when retrieval was fine. It says so in its own return value
and points at `verbatim_search` for the rest. That is a bound on one model
call, not on what the corpus holds.

### Measurement

`checkSilentTruncation` used to look for a checkout-local file bigger than the
cap and SKIP when it found none, which is what happened on every machine
without War and Peace in `~/Downloads` — the violation above was real the whole
time and went unmeasured, because the check could not reach the only condition
that triggers it. **A law whose check silently skips is not enforced.**

The document is synthesized now rather than hoped for, and because the cap is
gone the assertion is stronger than it was. The check no longer asks whether a
cut was *declared*; it asks whether anything was cut at all, and it does not
take the response's word for it. A sentinel is placed in the **last line** of a
700 KB document — the position that sat in the discarded remainder under the
old cap — and the check requires that sentinel to come back out of
`/api/verbatim`. A flag can lie; a retrieved passage cannot.

It also holds three edges: a document that fits must not claim it was cut
(otherwise "always report truncated" would pass), and a body past the transport
ceiling must be refused with a 413 that names the limit rather than dropped on
the floor.

---

## L4 — Format compliance is always enforced

**Format rules apply to every answer, regardless of what the surf mechanism
surfaced.**

The surf mechanism decides which *content* folds are active this turn — which
topics, which facts, which policies. But format rules define *how* to answer,
not *what* to answer. A manual that says "output format: Research note with 4
sections" or "do not add headers" is a meta-rule that applies to every response,
whether or not the format fold was surfaced by the gate.

The failure this prevents: a format fold with low relevance scores gets folded
by the surf mechanism, and the model produces prose when the manual requires
structured sections. The review sees no format fold in the active set and passes
the answer. The reader gets the wrong structure and has no way to know the
manual specified one.

### Clauses

- **L4a — Format directives are detected from all folds, not just active ones.**
  The review checks the answer against format patterns found in *any* fold's
  body — output format, section structure, source line format, formatting rules.
  A folded format fold is still a format rule; folding means "not surfaced to the
  model this turn," not "does not exist."
- **L4b — Format violations are flagged like any other R9 violation.** The
  `format_violation` flag type carries the specific issue (too few lines, missing
  evidence bullets, section headers present) so the correction pass can fix it.
- **L4c — Cross-turn correction passes format flags forward.** When a turn is
  flagged for format violations, the next turn receives the flags as correction
  context. The model sees "your previous answer was flagged" and fixes only the
  flagged violations. This is the same correction mechanism R9 uses for content
  violations, applied to format.

### Measurement

`checkFormatCompliance()` (output-review.js) detects format directives from all
folds and checks the answer against them. A format fold excluded from activeIds
but present in the fold array is still enforced. The check returns `{ ok, issues,
directives }` and each issue becomes a `format_violation` flag.

### What measurement actually showed

The two-pass test (frankenstein-part-*.txt + two-pass-manual.md) measured this:

1. **First pass**: model produces 5 lines, no section structure. Format fold
   `proj-002-output-format-research-note` was FOLDED by the surf mechanism.
   Review: FLAGGED (format_violation: too few lines). Without the format fix,
   this would have been PASS — the format fold was not in the active set.

2. **Second pass** (with correction context): model produces 9 lines with
   section headers, 2 quotes, correct source line. Format check: FAIL (headers
   present, claim on wrong line). The model *tried* to fix the format but added
   headers the manual forbids.

3. **Key finding**: the model improves with correction context but needs
   iteration to get format right. The cross-turn correction mechanism works —
   flags are passed forward and the model attempts to fix them. The format
   compliance check catches violations that the surf mechanism would have
   missed.

---

## L5 — Draft transparency is auditable

**The reader knows which model produced the draft and which model corrected it.**

When a fast model drafts an answer and a better model corrects it, the reader
sees both. This is not decoration — it is the audit trail the reader needs to
judge the answer's reliability. A fast model that drafts and a slow model that
corrects are two different confidence levels, and collapsing them into one hides
the correction history.

### Clauses

- **L5a — The draft model is named.** The `draft_info` SSE event carries the
  model that produced the first draft. The `completed` event carries the final
  model. When they differ, the reader knows correction happened.
- **L5b — The correction model is named.** When the correction loop uses a
  different model than the draft, the `draft_info` event carries both
  `draftModel` and `correctionModel`. The answer's persisted record includes
  both fields.
- **L5c — The correction pipeline is logged.** Each correction iteration is
  recorded: the flags that triggered it, the model that corrected, the result.
  The `review` field on the answer carries `corrected` and `iterations`. The
  `cross_turn_correction` event logs when flags pass across turns.

### Measurement

Every answer's persisted record includes `draftModel`, `correctionModel`,
`model` (the final model), and `review` with `corrected`/`iterations`. The
`draft_info` SSE event is emitted before the correction loop, so the reader
sees the draft model immediately. The `completed` event carries the final model.

### What this enables

The fastest model that's "good enough" drafts the answer. If it gets format or
content wrong, the correction loop fixes it with a better model. The reader
sees: "Drafted by qwen3:8b (3 tok/s). Corrected by phi4-mini." They can
decide whether to trust the draft or wait for correction.

---

## Candidate laws

Observed as consistent practice but not yet enforced by a check. Promote by
writing the check first; a law without one is a slogan.

- **Typed gap over silent wrong answer.** Missing evidence produces a named,
  inspectable gap, never a plausible number. Already the rule for coref priors
  and holonic citations; not yet mechanically verified across all surfaces.
  Enforced for instruction sets as R2 (INSTRUCTION-LAW.md).
- **Content against the instructions is not given out.** A forbidden request is
  refused, and the refusal is mechanically verified — a small model, shown the
  escalation fold, invented a manager's name rather than refuse. Enforced for
  instruction sets as R9: every served answer is reviewed against the folds
  that were in force, and a flagged answer is corrected (bounded) or ships
  flagged, never hidden (INSTRUCTION-LAW.md).
- **Two facts that differ must not read alike.** "Still loading" and "your
  sources do not say this" are different, and an interface that renders them
  identically is lying by collapse. The `corpusWarmup` flag exists for exactly
  this distinction. Enforced for instruction sets as R8 (INSTRUCTION-LAW.md),
  and now partially enforced here: L2e's check requires a no-match search to
  report *which* silence it was, so an empty corpus and a silent one can no
  longer render identically.

### Promoted

- **One name per thing.** `/api/ingest` returned `sourceId`; `/api/sources`
  called the same value `path`, so a reader following an id between surfaces
  found it renamed — and `path` is not a filesystem path at all for anything
  ingested as content. Both names are carried on both surfaces now, identical
  in value, so neither direction requires knowing the other spelling. Not yet
  enforced by a check of its own; the cleanup sweep in check-laws.mjs reads
  either spelling.
- **Errors do not wear success.** Promoted by writing its check
  (`checkErrorsDoNotWearSuccess`) and then fixing what the check found. See
  L2's "also fixed" above. An earlier version of check-laws.mjs passed these
  routes for exactly the reason the law names — the harness believed the
  status line.

---

## Running the checks

```
node scripts/check-laws.mjs                 # against a running proxy on :11435
node scripts/check-laws.mjs --json          # machine-readable
```

The check ingests documents across three orders of magnitude, measures TTFS for
each trigger, walks the audit round trip, and removes every source it created.
It exits non-zero on violation, so it can gate a commit.

A violation is not a reason to soften the law. Record it here as a known
violation with its number, and fix the code.
