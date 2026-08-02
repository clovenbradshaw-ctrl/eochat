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

- **L1c — ingest reports no progress.** `POST /api/ingest`
  ([proxy.js](server/proxy.js)) is a single blocking request/response. Under
  contention that is a 39-second void. Fix: stream ingest the way chat already
  streams SSE — the transport exists in this file.
- **L1d — under load the app cannot even acknowledge.** Idle, a chat turn's
  first SSE event arrives in 244 ms. Immediately after a run of large ingests,
  both chat probes emitted *nothing* for 120 s and hit the check's timeout —
  while Ollama answered `/api/tags` in 0.12 s with its models resident, so the
  upstream was healthy throughout.

  The acknowledgement is not late, it is *unreachable*: synchronous engine work
  holds the event loop, so the server cannot flush an SSE header until the
  ingest finishes. This is the deepest form of L1 violation, because no amount
  of care at the call site fixes it — the process has no moment in which to
  speak. Fix: move engine work off the request path, or yield often enough that
  the acknowledgement can be written before the work begins (L1a exists to make
  this ordering explicit).

### Fixed under this law

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

### Known violation (open)

- **L2e — the gap is not named.** A no-match search returns `gaps: null`. The
  response echoes the query and a `total` of 0, so the reader can tell the
  search ran, but the field that exists to describe *why* the corpus was silent
  is left empty.

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

### Known violation (open)

`POST /api/ingest` caps content at 500 000 characters
(`content.slice(0, 500000)`) and returns no field recording it. Measured: a
3216 KB book was accepted, silently reduced to 488 KB, and reported back as a
successful ingest of 250 chunks. The reader believes the whole book is loaded.
Every later answer about the missing six sevenths is unfalsifiably wrong.

---

## Candidate laws

Observed as consistent practice but not yet enforced by a check. Promote by
writing the check first; a law without one is a slogan.

- **Typed gap over silent wrong answer.** Missing evidence produces a named,
  inspectable gap, never a plausible number. Already the rule for coref priors
  and holonic citations; not yet mechanically verified across all surfaces.
  Enforced for instruction sets as R2 (INSTRUCTION-LAW.md).
- **Two facts that differ must not read alike.** "Still loading" and "your
  sources do not say this" are different, and an interface that renders them
  identically is lying by collapse. The `corpusWarmup` flag exists for exactly
  this distinction. Enforced for instruction sets as R8 (INSTRUCTION-LAW.md).
- **Content against the instructions is not given out.** A forbidden request is
  refused, and the refusal is mechanically verified — a small model, shown the
  escalation fold, invented a manager's name rather than refuse. Enforced for
  instruction sets as R9: every served answer is reviewed against the folds
  that were in force, and a flagged answer is corrected (bounded) or ships
  flagged, never hidden (INSTRUCTION-LAW.md).
- **One name per thing.** `/api/ingest` returns `sourceId`; `/api/sources`
  calls the same value `path`. Every caller must know both, and a reader
  following an id between surfaces finds it renamed.
- **Errors do not wear success.** `/api/verbatim/context` returns HTTP 200 with
  an `{error}` body on a failed read. An earlier version of check-laws.mjs
  passed it for exactly that reason — the harness believed the status line.

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
