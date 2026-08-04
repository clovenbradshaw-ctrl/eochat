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

## Does the external prior fare better at the structural level than the entity level?

The entity-level result raised an obvious follow-on question, asked
directly: maybe an external genre prior is the wrong tool for one
character's one sentence, but the right tool for something coarser —
finding real structural boundaries (book/scene divisions) or
differentiating large content-zones, rather than local narrative surprise.
`scripts/probe-external-prior-structure-level.mjs` tests this with real
ground truth: the Odyssey's own 24 real book-boundary markers (from the
source TEI structure, not invented), and `text-organ.js`'s own
`detectBoundaries` (frame-to-frame KL-divergence, z-scored against a local
window — text-organ.js's existing structural-boundary organ, unmodified as
the baseline, then re-run with the external distribution as the background
instead of the local window, same z-scoring shell, so any difference is
attributable to that one change).

**One self-caught calibration bug worth recording before the result.** The
first run of this probe used `detectBoundaries`'s own default
`zThreshold=2.5` and found the baseline detecting **zero** boundaries at
all — which would have made the external prior look like a clear win purely
by comparison to a broken baseline. Checked before trusting it: `grep` of
`multi-altitude-fold.js` and `entity-fold.js` shows production actually
calls `detectBoundaries(frames, { zThreshold: 1.8 })`, not the function's
own default. Re-run at the production threshold, the baseline finds real
structure perfectly reasonably (17 boundaries, 6/24 real book-starts
matched, 25.0% recall / 35.3% precision — against a ~4.5% base rate for 24
true positives among 539 frames, a real signal). This is the third
self-caught methodology bug in this investigation (after the TEI
attribute-order regex and the provenance whitespace-normalization miss),
and it mattered here specifically because trusting the first run would have
reported the *opposite* conclusion from the corrected one.

**At the corrected threshold, the external prior is worse at structure too,
not better:** 25 boundaries detected, only 4/24 matched (16.7% recall,
16.0% precision — precision roughly halved versus baseline). A 50/50 blend
performs almost identically to the external-only version (16.7% recall,
14.3% precision). The hypothesis that a same-tradition external prior would
help at a coarser grain, even though it hurt at the sentence-entity grain,
does **not** hold up empirically for this construction of "external prior"
— it is worse at both granularities tested so far.

A second, exploratory (no comparable hard ground truth) check: ranking all
24 books by KL-divergence of their own vocabulary against the external
Iliad prior. Book length and divergence score correlate at only -0.469 (not
close to ±1, so the ranking is not simply a length artifact), which is a
mild positive sign for the measure being real, even though it didn't help
boundary detection. One independent spot-check — Book 11 (the Nekyia,
widely noted in Homeric scholarship as stylistically distinct) — ranks 10th
of 24 by this measure, not conspicuously high, reported as-is rather than
adjusted to fit the expectation that raised the check in the first place.

**Combined verdict across both probes:** a whole-corpus external prior from
a work in the same formulaic tradition underperforms the existing
within-text mechanism at every grain tested here — entity-level sentence
surprise, structural boundary detection, and (more weakly, exploratory)
macro content-zone differentiation.

## Does a genuinely UNRELATED prior fare differently than a same-tradition one?

Asked directly, and worth testing rather than assuming either answer:
`scripts/probe-unrelated-prior.mjs` repeats both the entity-level and
structure-level tests with a third, genuinely unrelated real source —
Herodotus's *Histories*, 5th-century Ionic PROSE history (fetched from the
same trusted Perseus source, its own TEI paragraph structure handled on its
own terms rather than forced through the Odyssey/Iliad verse extractor) —
against the same Odyssey subject text and the same real ground truth.
"Unrelated" is measured, not asserted: lexical overlap with the Odyssey
(Jaccard over each corpus's top 2000 words) is 13.0% for Herodotus vs. 36.6%
for the Iliad.

One architectural correction made before running this, worth stating on its
own: the earlier probes' 50/50 "blend" condition averaged the external
prior and the local within-text window into one hybrid distribution before
scoring — letting the content-pass (recent real text) leak into what should
be a clean, independent read of "surprising relative to genre." This probe
computes local-surprise and external-surprise as two separate,
independently derived numbers, never merged into a shared distribution. A
prior's role stays strictly on the scoring side in both probes — it has
never touched or altered any span's literal content, which has always
stayed pure, verified source text — but keeping the *scores* themselves
uncontaminated by each other turned out to matter for interpretability too.

**Result: the unrelated prior clearly beats the same-tradition one at both
grains, and nearly matches the baseline at the structural grain — but still
does not clearly surpass the within-text baseline outright.**

| | entity-level rank (disguise line) | boundary recall | boundary precision |
|---|---|---|---|
| within-text baseline | top 7.6% | 25.0% | 35.3% |
| Iliad (same-tradition, 36.6% overlap) | top 28.3% | 16.7% | 16.0% |
| Herodotus (unrelated, 13.0% overlap) | top 11.4% | 25.0% | 30.0% |

This refines rather than overturns the earlier finding: the problem was
never "external priors are inherently bad," it was specifically that the
Iliad's high lexical/formulaic overlap with the Odyssey caused a naive
frequency comparison to dilute local contrast instead of sharpening it. A
genuinely distant source doesn't carry that same dilution — at the
structural grain it comes close enough to the specialized within-text
mechanism (identical recall, comparable precision) to call it competitive,
even though it still didn't clearly win either test outright.

## Does turning on ALL the literature priors do even better?

Asked directly: if a single unrelated work helps more than a single
same-tradition one, does broadening to a genuinely large, multi-genre
sample of Greek literature help more still? `scripts/probe-all-literature-
prior.mjs` builds one aggregate prior from 13 real works across 9
attested genres — epic (Iliad), didactic epic (Hesiod x2), tragedy
(Aeschylus, Sophocles, Euripides), comedy (Aristophanes), philosophy
(Plato's *Republic*), history (Herodotus, Thucydides), oratory
(Demosthenes), prose memoir (Xenophon), lyric (Pindar) — 4,177,263 chars
total, all fetched from the same trusted Perseus source, using a simpler
generic tag-stripping extractor since bulk vocabulary for a background
distribution doesn't need the clean structural boundaries the Odyssey's
own ground truth required.

**It does not win. It lands between the two single-work priors already
tested, tracking lexical overlap almost exactly:**

| prior | lexical overlap w/ Odyssey | entity-level rank | boundary recall | boundary precision |
|---|---|---|---|---|
| within-text baseline | — | top 7.6% | 25.0% | 35.3% |
| Iliad alone (same-tradition) | 36.6% | top 28.3% | 16.7% | 16.0% |
| **all 13 works, 6 genres** | **23.1%** | **top 17.7%** | **25.0%** | **27.3%** |
| Herodotus alone (unrelated) | 13.0% | top 11.4% | 25.0% | 30.0% |

Overlap 13.0% → 23.1% → 36.6% tracks entity-rank 11.4% → 17.7% → 28.3%
almost monotonically. The aggregate's overlap sits *between* the two
single-work priors, not below both, because it still *contains* the
Iliad's high-overlap vocabulary as part of the mix — averaging in eleven
genuinely distant works does not cancel out one highly-similar source
dragging the net relatedness back up. At the structural grain the
aggregate ties the baseline's recall (as Herodotus alone did) but with
lower precision than Herodotus alone.

**The finding this sharpens: net relatedness to the subject text is the
lever, not corpus size or genre breadth.** A single, well-chosen distant
source (Herodotus, 620K fewer chars than the aggregate) outperformed a
4.2-million-character, 13-work, 6-genre sample, because that sample's
average relatedness was higher, not lower, than the single best choice.
"Turn on more priors" is not the same claim as "turn on the right prior,"
and this is a measured instance of the difference, not an assumption
about it.

## Building a reusable "which priors to activate" tool — and a real correction to the finding above

Asked directly: package the relatedness finding as a reusable tool that
tells you, for any subject text and any pool of candidate priors, which
ones are actually worth activating — not specific to Greek, not specific
to this investigation. `scripts/select-best-priors.mjs` does this in two
parts: a cheap proxy (`distributionOverlap`, the same Jaccard-over-top-2000
measure used throughout this section) computable in milliseconds with no
scoring pass, and `rankPriorCandidates()`, a small, genuinely reusable
function — subject signature and candidate signatures in, ranked
recommendation out, no text- or Greek-specific code in it at all.

**Validating it properly (13 real candidates individually, not 3
data points) overturns the clean story told above, rather than confirming
it.** Every earlier claim in this section about relatedness being "the
lever" was built from exactly three data points (Iliad, Herodotus, the
13-work aggregate) that happened to line up in a monotonic-looking pattern.
Run against all 13 candidates individually — Iliad, Herodotus, both
Hesiod works, three tragedians, Aristophanes, Plato, Thucydides,
Demosthenes, Xenophon, Pindar — the Spearman rank correlation between
measured lexical overlap and actual entity-level surprise-ranking
performance is **-0.022**: statistically indistinguishable from no
relationship at all. The best-performing candidate at the entity grain,
Thucydides (top 5.0%, beating the within-text baseline's top 7.6%), has
9.6% overlap — barely different from Demosthenes' 9.1%, the *worst*
performer (top 27.7%, nearly as bad as the Iliad). Cheap-proxy ranking
matched the real outcome ranking's exact position only 2 times out of 13.
The correlation with structural boundary-detection precision is real but
moderate (-0.451), not the clean signal the 3-point sample suggested;
correlation with recall is weak (-0.192).

**This does not mean the tool fails at its actual job — it means the cheap
shortcut inside it does not work as well as 3 points suggested, and the
tool's real, validated value is as a proper evaluation harness, not a free
lookup.** `rankPriorCandidates()`, run as a full scoring pass rather than a
lexical-overlap shortcut, reliably tells you the best candidate — it
already did, three times over, at N=13, N=3-with-a-flawed-comparison-fixed,
and N=1-aggregate. What is not yet found is a cheap proxy that predicts
that outcome without running the real test. That is a genuine open
problem, not a solved one, and reporting it as solved after 3 points would
have been exactly the kind of undersampled overclaim this whole
investigation exists to catch — including, this time, in its own most
recent finding.

**Omnimodal generalization, demonstrated rather than only claimed:**
`scripts/select-best-priors-audio.mjs` runs the identical
`rankPriorCandidates()`/`distributionOverlap()` code, unmodified, against
signatures built from real audio field vectors (`perceiver/audio/reading
.js`'s chroma+timbre+moments, quantized into the same `Map<token,
probability>` shape `wordFrequencies()` produces for text) instead of word
frequencies. Scope stated plainly: only one real audio file was available
in this environment (no second real musical work to fetch — the network
policy blocked every audio-hosting domain tried earlier this session, and
there is no decoder for a compressed download), so this demonstrates the
code runs unmodified on real audio-derived signatures (segmenting the one
real recording into 6 honest, non-overlapping real segments), not that the
proxy is validated as predictive for any real audio task the way the text
side was validated against real ground truth. That is a narrower claim
than the text section supports, and is reported as narrower, not inflated
to match it.

## Music's own forward-surprise: completing the omnimodal parity, not just claiming it

Asked directly: why should "structural surprise" be a text-only question?
Every earlier audio result in this document used organs built for other
jobs (spectral-flux variability, holon separation, onset/tempo) as
indirect evidence that audio *could* support real/noise discrimination —
this investigation never built audio's own version of the actual
mechanism, `significanceSpine` itself: sequential, forward-only, scored
against a decaying local window of recent context, never looking ahead.
`scripts/probe-audio-forward-surprise.mjs` does that directly.

Text's `forwardScore` uses discrete KL-divergence because a sentence is a
bag of many word-tokens. A single audio frame (~186ms) is one continuous
30-dimensional vector (12 chroma + 13 timbre + 5 moments), not a bag of
anything — so the faithful analog is a local Gaussian model: track each
dimension's running mean/variance over the last ~28s of frames, score a
new frame's surprise as its summed per-dimension squared deviation
(a diagonal Mahalanobis distance), same question ("how much does this
depart from what recent context predicted"), asked in the vocabulary a
continuous signal actually has.

**Two real bugs caught in this new code before trusting any result from
it — the same discipline as every other probe in this document, now
applied to a mechanism built mid-conversation rather than to the engine.**
The first run scored beginning at 5 frames of history and produced a "top
peak" 29,000x larger than the second-ranked one — a cold-start artifact
exactly analogous to what `significanceSpine`'s own header already warns
against and guards with a `minHistory` parameter, which this new code
initially lacked. It also used one shared epsilon variance-floor across
all 30 dimensions despite those dimensions having wildly different
natural scales (spectral flux runs in the hundreds; a chroma bin does
not), letting a low-variance dimension's z-score blow up and dominate the
summed score. Fixed: a real warm-up guard (60 frames, ~11s) before any
score is trusted, and a per-dimension variance floor set relative to that
dimension's own variance over the whole recording rather than one
constant for all of them.

**Corrected result: real audio shows meaningfully higher local-surprise
variability than every noise control, in a sensible gradient** — real
CV=1.76, fixed-grid shuffle CV=0.66, variable-grid shuffle CV=0.75, white
noise CV=0.31. The top peaks check out against acoustic features never
used to build the score: t=67.0s shows a real 4.5x RMS jump (a genuine
loud entrance); t=21.8s shows RMS dropping to near-silence relative to
its recent context (a sudden hush, not a loud moment) — the mechanism
catches large deviation in *either* direction because it scores squared
deviation, not signed change, which is architecturally correct and
happened to surface a musically real, qualitatively different category of
surprise (a compositional pause) without being built to look for one.

This is the omnimodal claim completed rather than only argued for: text
has a validated forward-surprise mechanism (with real, documented limits
on a morphologically rich language); audio now has its own, built with
the same architecture, validated against the same kind of real/noise
controls, and caught making the same class of self-inflicted measurement
errors this whole investigation has repeatedly found and corrected in
itself as readily as in the engine under test.

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
> do not assume it — and when it underperforms, measure WHY before
> concluding external priors don't work at all.** A background distribution
> built from a work in the same formulaic tradition as the subject text
> (here: the Iliad, for Odyssey surprise-scoring) measurably *worsened*
> every test run against it — entity-level sentence surprise, real
> structural boundary detection (checked against 24 real book markers, not
> invented ground truth), and more weakly macro content-zone
> differentiation. Retested with a genuinely unrelated source (Herodotus,
> 13.0% lexical overlap vs. the Iliad's 36.6%, measured not assumed): the
> unrelated prior clearly outperformed the same-tradition one at every
> grain, and matched the within-text baseline's recall exactly at the
> structural grain, though it still did not clearly surpass the baseline
> outright at either grain. Tested a third way — a 13-work, 6-genre,
> 4.2-million-character aggregate prior — and it did NOT do better still:
> it landed BETWEEN the single-work priors, tracking measured lexical
> overlap (13.0% / 23.1% / 36.6%) almost monotonically with performance,
> because the aggregate still contained the high-overlap source as part of
> its mix. The general lesson is sharper for having tested three
> constructions, not one: **relatedness to the subject text — not
> "external vs. internal," not corpus size, not genre breadth — is the
> variable that determines whether a prior helps or hurts, and averaging
> in many distant sources does not cancel out one closely related source
> pulling net relatedness back up.** "External" and "useful" are different
> properties; so are "more data" and "the right data." Conflating any of
> these is the same class of mistake as the corpus-prior dead end already
> documented in `derive-audio-prior.mjs`, worth naming as its own numbered
> dead-end (with this relatedness caveat attached) in whichever document
> tracks those. A related, purely architectural correction from the same
> chase: a prior must be kept on the scoring side only, as an
> independent surprise signal — never blended into a shared distribution
> with the local within-text window (an early version of this test did
> exactly that), and never allowed to touch or alter the literal content of
> any span, which must always stay pure, independently-verifiable source
> text. Also worth recording: the first structure-level run mis-set the
> comparison itself (a boundary-detection threshold that did not match what
> production code actually uses) and would have reported the *opposite*
> conclusion had it not been checked against the real call site before
> being trusted — a reminder that a probe's own calibration is exactly as
> fallible as the engine it is testing, and needs exactly the same
> discipline.

> **Three data points are not a validated relationship, even when they line
> up monotonically — the same finding stated after N=3 and after N=13 was
> a different finding, not a more detailed version of the same one.** The
> relatedness-predicts-performance claim above held cleanly across Iliad,
> Herodotus, and a 13-work aggregate; run against all 13 individual
> candidates, the correlation collapsed to statistically indistinguishable
> from zero for the primary task. Nothing about the earlier 3-point test was
> methodologically wrong on its own terms — it is simply too small a sample
> to license the general claim it was used to support, and the failure mode
> is dangerous precisely because 3 monotonic points feel like confirmation
> rather than like what they are. Any finding in this document (or
> elsewhere) built from fewer real candidates than are actually available
> should be treated as provisional until checked against the fuller set,
> and this document's own earlier, now-superseded 3-point claim is the
> concrete example, not a hypothetical one.

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
node scripts/probe-external-prior-structure-level.mjs  # same experiment at structure/macro grain, real ground truth
node scripts/probe-unrelated-prior.mjs               # same-tradition (Iliad) vs. unrelated (Herodotus) prior, both grains
node scripts/probe-all-literature-prior.mjs          # 13-work, 6-genre aggregate prior — fetches ~4.2MB, slower
node scripts/select-best-priors.mjs                  # validates the cheap-proxy tool against all 13 individually, ~5min
node scripts/select-best-priors-audio.mjs            # same tool, unmodified, on real audio field-vector signatures
node scripts/probe-audio-forward-surprise.mjs        # audio's own significanceSpine analog, real vs. noise controls
```

Video (the third modality named alongside music) was scoped out of this
pass: no real video file was available in the environment this was run in,
and no video decoder (`ffmpeg`/`ffprobe`) was present to produce raw frames
from one — the video perceiver (`perceiver/video/*`) takes decoded frames,
not container files. A synthetic substitute would have broken the
real-material-only discipline this whole exercise depends on, so it was
left undone rather than faked. Worth doing properly in an environment with
both a real video file and a decoder available.
