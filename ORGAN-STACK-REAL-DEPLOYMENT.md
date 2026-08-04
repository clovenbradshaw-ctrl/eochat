# Organ stack on real deployment material — findings

Staged here because `../eo-constitution/` (which owns cross-engine design
invariants — see LAWS.md's opening line) is not reachable from the session
that did this work: not vendored in eochat, not in that session's GitHub
scope, no way to request scope expansion mid-session. This document is
written so anyone with `eo-constitution` access can fold the relevant parts
in directly. Nothing here has been applied there.

## What prompted this

The organ stack (vendor/eoreader5/AGENTS.md's nine organs: cube classifier,
referent presence, associative memory, entity fold, multi-altitude fold,
discourse, spine, reaction channel, relationship graph) had gone from
24/27 to 27/27 cube cells occupied, proven by 42 synthetic tests. The next
question was whether it holds up on real deployment material, not fixtures
tuned to pass — and specifically, given the project's own stated bar
(vendor/eoreader5/AGENTS.md: *"an organ must make sense for a nameless
leitmotif in music, or it is string-thinking"*), whether it holds up
**omnimodally**: not just on a different real English text, but on a
different script (capitalization conventions are language- and
era-specific, not physics) and a different medium entirely (audio, with no
language in it at all).

Two real materials, no synthetic fixtures:
- **Text**: the *Odyssey*, ancient Greek, Perseus Digital Library edition
  (`tlg0012.tlg002.perseus-grc2`, A.T. Murray, 24 books, 538,646 chars).
  Fetched and reproduced by `scripts/probe-organs-real-deployment.mjs`.
- **Audio**: `frankenstein-overture.wav`, already in the eochat repo root —
  185s real mono orchestral recording, zero text, zero names, zero
  capitalization anywhere in the pipeline. Exercised by
  `scripts/probe-organs-real-deployment-audio.mjs`.

Both probes ran organs directly against real material and a **matched
noise control** (same vocabulary/content, order destroyed — word-shuffled
and character-shuffled text; chunk-shuffled and white-noise audio) so that
any difference measured is about structure, not vocabulary. Both scripts
are reproducible (`node scripts/probe-organs-real-deployment*.mjs`, cache
under `memory/corpus-cache/`, no network needed for the audio probe).

## Findings, ranked by severity

### 1. `perceiver/text/surfaces.js` — capitalization-only candidate discovery, plus a script-blind bug on top of it

`extractSurfaces`'s own header states its design goal in one line: *"the
only modality-specific signal: capitalization... no per-language
knowledge."* Two problems, one on top of the other:

- **The bug.** `CAP_SEQ = /\b[\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+)*\b/gu`
  anchors on `\b`, which JS defines over ASCII `\w` even under the `/u`
  flag — it never fires adjacent to a non-Latin letter. Measured: 0
  surfaces on 538K chars of real Greek verse where names are capitalized
  1,060 distinct ways, 3,850 times (`Ὀδυσσεύς` 172×, `Τηλέμαχος` 123×,
  `Ἀθήνη` 88×, ...). Removing the anchor (keeping the already-correct
  `\p{Lu}`/`\p{L}` classes) recovers all of it. One-character fix.
- **The design limit underneath the bug.** Even fixed, this mechanism is
  scoped to **bicameral scripts** (Latin, Cyrillic, Greek, Armenian, a
  handful of others). Most living scripts — Chinese, Japanese, Korean,
  Hebrew, Arabic, Devanagari/Sanskrit (this repo's own fingerprint cache
  has a GRETIL Sanskrit corpus), Thai, Georgian — have no case distinction
  at all. Candidate discovery there is not degraded, it is **absent**,
  independent of any bug fix. The module's comment that "a NAME essentially
  never appears with a lowercase initial" is stated as if it were
  medium-neutral physics; it is a modern-English-and-neighbors orthographic
  convention (contrast 18th-century English and modern German, which
  capitalize common nouns too). Worth correcting the comment as much as the
  code — this project's whole discipline is not dressing up a contingent
  convention as a structural law.

### 2. `emergence/store/index.js` (associative memory) — Latin-alphabet-only tokenizer, undisclosed

`const WORD_RE = /[a-zà-ÿœæ''-]+/gi;` — no `\p{L}`, no Unicode property
escape at all. This is not the same class of bug as #1 (an anchor undoing
otherwise-correct Unicode classes); this tokenizer never had non-Latin
coverage. Verified directly: across both the real and shuffled Greek runs,
**every single token this organ ever saw was this probe's own English
scaffolding** ("book", "the", "odyssey", "murray", ...) — not one word of
the actual epic. `posting`/`edges` on real Greek content are not "the
organ found no structure," they are empty because the organ never read the
text at all.

This is the most severe finding because it is the most quietly wrong. The
module's header is extensive and explicitly grounds itself in real
associative-memory neuroscience — Hebbian encoding ("fire together, wire
together"), dentate-gyrus sparse coding, CA3 pattern completion — with real
citations to measured failures on Frankenstein/War and Peace. Nowhere does
it disclose that its tokenizer is Latin-script-only. Contrast with #3
below, which is equally English-specific but says so.

### 3. `cube/index.js` (terrain classifier) — English lexicon, but it says so

Not a bug. The header states plainly: ported from `eoreader4.2`'s English
wiki-terrain classifier, "KEYWORD-FREQUENCY ESTIMATORS, not readings."
Verified: correctly scores **zero** signal on real Greek (once this
probe's own scaffolding contamination was stripped out — an early pass
here wrongly reported "Field=1.000" on Greek, traced to `[BOOK N]` tags in
the probe's own formatting tripping the English weak-term "book"; that was
a bug in the test, caught and fixed, not a finding about the engine), and
correctly lights up on a real English control. This is the right way to be
language-specific: scoped in the header, not silently assumed. Its other
honest limit: amplitude is order-independent by construction (bag-of-terms
regex scoring), so it cannot itself be a structure-vs-noise detector for
any language, English included — confirmed directly (English real vs.
English word-shuffled score near-identically).

### 4. `emergence/summary/spine.js` (forward-surprise) — a real negative result on Greek specifically

KL-divergence over exact word-frequency distributions (Unicode-safe
tokenization here, unlike #2). On the Odyssey, real-vs-shuffled coefficient
of variation was identical (0.14 both). Diagnosed, not just reported: Greek's
rich inflectional morphology means the same lemma rarely recurs in the exact
same surface form nearby, in *either* order, so almost everything reads as
locally novel regardless of narrative structure. This is a genuine
limitation of exact-token-match statistics on morphologically rich
languages, not a bug — worth knowing before trusting this organ's
significance signal on anything other than English-shaped prose.

## The positive counter-evidence — the principle is achievable, not aspirational

Two organs ran on real Greek/real audio with **zero fixes or workarounds**,
because they were built the way the constitution's own principle asks for:

- **`perceiver/text/text-signal.js`** — explicitly built to mirror the audio
  pipeline: char-3gram hashing over a raw sliding window, no word split, no
  capitalization, no lexicon. Verified: produces real, non-degenerate field
  vectors directly on Greek. It did not distinguish real order from
  character-shuffled noise in this run (adjacent-frame cosine similarity
  0.911 real vs. 0.913 fully character-scrambled) — but for an explainable,
  honest reason: at 128 hash bins this captures coarse alphabet/orthography
  statistics that are homogeneous across a whole document regardless of
  shuffling grain, i.e. it is a stylometric/genre signature (matches its
  actual use in `kind-discovery.mjs`/`train-genre-dictionaries.mjs`), not a
  within-document structure detector. Different job, correctly built,
  script-agnostic from day one.

- **The audio perceiver** (`perceiver/audio/*`) — real 185s orchestral
  recording, real matched noise controls (chunk-shuffled and white-noise).
  Spectral-flux variability and holon separation (`separateHolons`, the
  audio analog of "is there a figure here" — energy-concentration, not a
  name-string) both cleanly separated real structure from no structure at
  all (flux CV ~2.8 real → ~0.03 white noise; white noise correctly gets 0
  holons, not spurious ones — the right abstention). One real methodology
  catch along the way: a fixed 0.5s shuffle grid imposes its own exact
  splice periodicity that an onset/tempo detector reads as *more* regular
  than the real recording, backwards from intended — caught only by adding
  a second, variable-grid control and comparing, not by trusting the first
  result. Lesson for future audio probes here, not a knock on the organ.

## Follow-on: surf/fold as an actual answering mechanism, proven end to end

The organ-by-organ testing above answers "does each piece work." A follow-on
question was posed directly: if the fold really compresses losslessly with
full provenance, can it actually answer questions about the Odyssey without
flooding a model's context window, and drill down on demand the way a real
reader's *surprise* — not a keyword search — would demand? Two more probes,
same discipline (real material, real organs, numbers not assertions):

**`scripts/probe-surf-fold-odyssey.mjs`** — `multiAltitudeFold` run for 4
entities (Odysseus, Telemachus, Athena, Penelope) on the real Odyssey.
Measured, not assumed:

- **Compression is real and steep.** L0 (top-3-scenes-per-entity,
  4 entities combined) is 23,536 chars — 4.4% of the 538,646-char source.
  Even L4 ("dossier, all available scenes," 4 entities) is 81.5%, still less
  than the raw text plus the overhead of asking about 4 entities separately.
- **Provenance verified independently, and a bug in this probe's own first
  attempt is worth recording.** The first version compared each span's raw
  offset-slice against `span.text` byte-for-byte and found 424/424
  "mismatches" — alarming, until traced to `text-organ.js`'s own documented
  behavior: `snapToSentences` collapses interior whitespace to single spaces
  when building `span.text`, and the module *ships its own recovery
  function for exactly this*, `locateRawSpan`, whose header states the
  discipline directly ("neither operation preserves the offset/text pairing
  exactly... locateRawSpan recovers the true `{offset, length}`... i.e. it
  finds the literal raw substring the display text was derived from").
  Fixed to whitespace-normalize before comparing (424/424 now verified) and
  additionally cross-checked a sample directly through `locateRawSpan`
  itself (8/8 verified) — using the actual tool the module provides, not
  only this probe's own comparison logic. This is the same class of finding
  as the `\b`-anchor bug: a real defect, caught by using real material, this
  time in the probe rather than the engine — recorded with the same
  honesty.

**`scripts/probe-surf-fold-odyssey-surprise.mjs` and the second half of
`probe-surf-fold-odyssey.mjs`** — the harder, more important question,
raised directly in review: the first SURF draft used `text.includes(needle)`
as its drill-down trigger, which is exactly the flooding-by-occurrence
problem this exercise exists to get past, just done in miniature. Rebuilt on
what the codebase already has for the real job — `summary/spine.js`'s
`significanceSpine` (forward KL-divergence, read sequentially, forward-only,
in document order, the same primitive spine.js has always used) — with two
follow-on tests of how to make that surprise signal work like a reader's:

- **A genuine outside-the-text prior, tried and found to hurt.** Reader
  surprise is only meaningful against priors from outside the text — so a
  background word-frequency distribution was built from the *Iliad*
  (fetched and cached independently, same author/tradition, never touching
  the Odyssey — the same "prior derived from a DIFFERENT work" discipline
  `scripts/derive-audio-prior.mjs`'s header already states for music).
  Blending it in **measurably worsened** both tests run against it: the
  Odyssey's real disguise-name line (Athena as Mentes, Book 1) ranked in the
  top 7.6% of surprise under the within-text-only mechanism, dropping to top
  23.2% at a 50/50 blend and top 28.4% under the external prior alone; the
  earlier real-vs-word-shuffled CV gap also widened in the wrong direction
  as external weight increased. Diagnosis: the Iliad and Odyssey share the
  same formulaic epic diction too closely (oral-formulaic composition,
  Parry/Lord — the same theory `specs/composition-is-retrieval.md` already
  cites) for a naive linear frequency blend to sharpen anything; it just
  dilutes the local within-text contrast that was already doing real work.
  A useful genre prior would need to be *discriminative* (what's distinctive
  to this text relative to the tradition, not the tradition's raw
  frequencies) — a bigger, different piece of engineering, not attempted
  here, not claimed to work.
- **The validated within-text mechanism, run as the actual trigger.**
  `significanceSpine` over the whole real document, once, forward, in
  reading order — cross-referenced against Athena's own fold range to find
  her highest-surprise moments. It found a real one: Athena "devising
  another plan," going through the city disguised as Telemachus to recruit
  a crew (offset 36905) — narratively genuine, not noise, and not present
  in the compressed L0 context, which is what correctly triggered drill-down
  to the exact quoted line and its surrounding context. Checked honestly
  afterward, *not* used to pick the target: this specific run's #1 peak
  within Athena's range was not the Mentes line (which independently ranks
  at the 92nd percentile document-wide, per the sibling probe, just not
  #1 within this particular scoped-and-ranked subset). Reported as found,
  not substituted — the mechanism is real and the result is real, and they
  are not artificially made to coincide.

Net: this reframes what "lossless compression with full provenance" can
honestly mean for a fold — not information-theoretic losslessness (a
compressed level necessarily omits most of the text; that is the point) but
*zero fabrication in what is surfaced, at any altitude, verified
independently down to the actual byte offset* — and reframes "surf" as
"driven by a real, validated surprise signal, with drill-down triggered by
what that signal finds missing from the compressed context, not by
searching for a word." Both claims are now backed by numbers, not asserted;
the external-prior attempt is recorded as a real, informative negative
result rather than quietly dropped.

## Proposed constitutional-level takeaway

State as a testable principle, the way LAWS.md states laws (a failure it
forbids, a measurement that catches it):

> Any organ or perceiver whose documentation claims omnimodal, universal,
> or medium-neutral behavior must be verified against real deployment
> material in a genuinely different script or medium before that claim is
> trusted — a different real English text is not sufficient evidence.
> Language- or script-specific behavior is legitimate (see cube/index.js)
> **only when it is disclosed in the module's own header**, the way
> cube/index.js does and store/index.js does not. A comment asserting a
> language-contingent orthographic convention (e.g. "a name is never
> lowercase-initial") as if it were "the physics" should be treated as a
> documentation defect with the same seriousness as a code defect — it
> licenses exactly the string-thinking the omnimodal principle exists to
> forbid.

Three more, from the surf/fold follow-on work, each grounded in a measured
result above rather than asserted:

> **"Lossless" claims about a fold or summary organ mean zero fabrication in
> what is surfaced, independently verifiable against real source offsets —
> never information-theoretic completeness.** A compressed altitude
> necessarily omits most of the source; that omission is the entire value
> of compressing. A claim of "lossless fold" is honest only when every
> retained claim, at every altitude, re-slices to real source text at its
> claimed offset (measured here: 424/424, cross-checked two independent
> ways) — and dishonest the moment it is read as "nothing was left out."
> This project already has one hard-won lesson in exactly this shape (the
> corpus-prior dead end, documented in `scripts/derive-audio-prior.mjs`);
> this is the fold-compression sibling of it and deserves the same
> explicit guardrail.

> **A prior sourced from outside the text being read is not automatically
> better than one derived from the text's own preceding context — test it,
> do not assume it.** A background distribution built from a genuinely
> separate work (here: the Iliad, for Odyssey surprise-scoring) measurably
> *worsened* both a real-detail-ranking test and a real-vs-noise
> discrimination test, because the external source shared the target's
> formulaic tradition too closely: a naive linear blend diluted local
> contrast instead of sharpening it. "External" and "useful" are different
> properties; conflating them is the same class of mistake as the corpus-
> prior dead end, just with an easier-to-miss failure mode (it fails
> quietly worse, not obviously broken) — this is a genuine extension of that
> existing principle, not a duplicate of it, and worth being named as its
> own numbered dead-end in whichever document tracks those.

> **A "prompt deeper reading" / drill-down trigger must be driven by a real,
> organ-computed significance signal (surprise, boundary detection, or
> equivalent) — never by searching the compressed context for a specific
> word or phrase.** Keyword-triggered drill-down is the flooding-by-
> occurrence failure mode the fold architecture exists to replace, merely
> relocated to the trigger instead of the context. Measured here:
> `significanceSpine`'s real forward-surprise, run once over the whole
> document forward-only, found a genuine narrative turning point
> unprompted and undirected by any keyword — the correct shape for this
> mechanism, in contrast to this probe's own first draft, which used
> `text.includes()` and was corrected specifically because of this
> principle.

## Reproduction

```
git submodule update --init --recursive
node scripts/link-vendor-workspaces.mjs
node scripts/probe-organs-real-deployment.mjs        # text/Greek — fetches + caches under memory/corpus-cache/
node scripts/probe-organs-real-deployment-audio.mjs  # audio — uses frankenstein-overture.wav already in the repo
node scripts/probe-surf-fold-odyssey.mjs             # surf/fold compression + provenance + spine-triggered drill-down
node scripts/probe-surf-fold-odyssey-surprise.mjs    # external (Iliad) prior experiment — also fetches + caches
```

Video (the third modality named alongside music) was scoped out of this
pass: no real video file was available in the environment this was run in,
and no video decoder (`ffmpeg`/`ffprobe`) was present to produce raw frames
from one — the video perceiver (`perceiver/video/*`) takes decoded frames,
not container files. A synthetic substitute would have broken the
real-material-only discipline this whole exercise depends on, so it was
left undone rather than faked. Worth doing properly in an environment with
both a real video file and a decoder available.
