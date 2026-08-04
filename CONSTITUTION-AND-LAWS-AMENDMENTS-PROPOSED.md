# Proposed amendments — PARTIALLY DISPOSED 2026-08-04

Every item below originated as a proposal only. As of 2026-08-04, both parts
have a disposition, recorded here so this file stops being the last word on
either:

- **Part A → drafted into `eo-constitution` as formal amendment proposals,
  not yet applied.** A1/A2/A7 became `AMENDMENT-8-PROPOSAL.md` (the script
  earning test, II.13); A3/A4 became `AMENDMENT-9-PROPOSAL.md` (the fold
  fidelity test, II.14); A5/A6/A8 became `AMENDMENT-10-PROPOSAL.md` (the
  validation discipline test, II.15 — the least shovel-ready of the four,
  its enforcement shape is still open); A9 became `AMENDMENT-11-PROPOSAL.md`
  (the surprise-disambiguation test, II.16). Each drafts the raw finding
  below into the constitution's own testable-article format (IV.1), but per
  IV.2 an agent proposes and a human still has to dispose — none of these
  four are applied. Read them in `../eo-constitution/`, not this file, for
  the current wording.
- **Part B → folded into `LAWS.md`'s Candidate laws, not promoted to a
  numbered law.** Both L6 and L7 name a real, defensible principle, but
  neither has a live surface a check can exercise yet: L6's `multiAltitudeFold`
  is not wired into any reader-facing surface in this app, and L7's
  distinguishing signal (why a perceiver found no signal) would have to come
  from `vendor/eoreader5`, a submodule this checkout does not vendor in. Per
  this file's own rule — "a law without one [a check] is a slogan" — they sit
  in Candidate laws until a check can be written, with the exact promotion
  condition recorded there for each.

The findings themselves, and the original per-item proposed wording, are kept
below unchanged as the record those dispositions were drawn from — do not
edit the analysis to match the disposition; edit the disposition if the
analysis turns out to be wrong instead.

Source: the full investigation in `ORGAN-STACK-REAL-DEPLOYMENT.md` (real
Greek/audio deployment material run through the organ stack) and its
follow-ons (surf/fold compression+provenance, external-prior selection,
audio forward-surprise). Each item below cites the section of that
document it's drawn from, so the evidence is one click away, not asserted
here fresh.

Two documents get amendments, because the findings split cleanly along the
line `LAWS.md` itself already draws: `eo-constitution` decides engine
design; `LAWS.md` decides how eochat itself (the host) must behave. Almost
everything found is about engine design — Part A. Two items are genuinely
about how eochat should behave toward a user and belong in Part B instead.

---

## Part A — Proposed amendments to `eo-constitution`

Stated in the constitution's own apparent register (a testable principle,
not a slogan) and, where `LAWS.md`'s convention applies cleanly, in that
exact shape: a failure it forbids, a measurement that catches it.

### A1 — Omnimodal/universal claims require real cross-script or cross-medium verification

**Forbids:** trusting an organ's or perceiver's documentation when it
claims omnimodal, universal, or medium-neutral behavior, without having
run it against real material in a genuinely different script or medium.
A different real English text is not sufficient evidence for a claim
about language-neutrality; a different real text in the same medium is
not sufficient evidence for a claim about medium-neutrality.

**Measurement:** `perceiver/text/surfaces.js` and `emergence/store/
index.js` both claimed generality. Real Greek deployment material (not a
synthetic fixture) found the first broken by an ASCII-only `\b` anchor and
the second built on a Latin-alphabet-only character class with no Unicode
support at all — see ORGAN-STACK-REAL-DEPLOYMENT.md, "Findings, ranked by
severity," #1 and #2.

### A2 — Language/script-scoped behavior is legitimate only when disclosed in the module's own header

**Forbids:** a module being legitimately scoped to one language or script
(which is fine) while its own documentation stays silent about that scope,
or worse, states a language-contingent convention as if it were universal.

**Measurement:** `cube/index.js` discloses its English-lexicon scope in
its own header and correctly, honestly returns no signal on real Greek.
`emergence/store/index.js` is equally English/Latin-scoped but discloses
nothing — an extensive header grounding it in general associative-memory
neuroscience with no mention that its tokenizer cannot see a non-Latin
letter. The second is the more severe defect precisely because it fails
silently instead of announcing its scope. See ORGAN-STACK-REAL-DEPLOYMENT.md,
findings #2 and #3.

**Corollary, same severity as a code defect:** a comment asserting a
language-contingent orthographic convention (e.g. "a name is never
lowercase-initial") as if it were medium-neutral physics licenses exactly
the string-thinking the omnimodal principle already forbids, and should be
corrected with the same priority as the code itself.

### A3 — "Lossless" claims about a fold or summary organ mean zero fabrication, verified against real source offsets — never completeness

**Forbids:** describing a fold/summary/compression organ as "lossless"
without specifying which sense is meant, and treating "nothing was left
out" as a legitimate reading of the word for any organ that compresses at
all (compression that keeps everything is not compression).

**Measurement:** every span at every altitude of `multiAltitudeFold`, for
4 real entities on the real Odyssey, independently re-verified against the
raw source file two ways (whitespace-normalized re-slicing: 424/424;
cross-checked via the module's own `locateRawSpan`: 8/8) — that is what
was actually proven, and it is a claim about fabrication, not completeness.
See ORGAN-STACK-REAL-DEPLOYMENT.md, "Follow-on: surf/fold as an actual
answering mechanism."

### A4 — A "prompt deeper reading" / drill-down trigger must be driven by a real, organ-computed significance signal — never by searching content for a keyword

**Forbids:** implementing "when should the reader be shown more" as a
substring or keyword match against the compressed context. That is the
flooding-by-occurrence failure mode the fold architecture exists to
replace, merely relocated from the context to the trigger.

**Measurement:** `probe-surf-fold-odyssey.mjs`'s first draft used
`text.includes(needle)` as its trigger and was rebuilt on
`summary/spine.js`'s real forward-surprise, which found a genuine
narrative turning point (Athena disguised as Telemachus, recruiting a
crew) unprompted by any keyword. See ORGAN-STACK-REAL-DEPLOYMENT.md,
same section.

### A5 — No single cheap relatedness proxy is known to reliably predict whether an external prior will help or hurt — do not ship one as if it were validated

**Forbids:** selecting or recommending an external prior for a task based
on a cheap heuristic (lexical overlap, genre similarity, "how related does
this seem") without having validated that heuristic against real, varied
ground truth for the actual task at hand.

**Measurement:** tested at N=3 (Iliad, Herodotus, a 13-work aggregate),
lexical overlap looked like a clean, monotonic predictor of entity-level
surprise-ranking performance. Tested properly at N=13 (every candidate
individually), the Spearman correlation was **-0.022** — statistically
indistinguishable from no relationship. The best performer (Thucydides,
9.6% overlap) and the worst (Demosthenes, 9.1% overlap) have almost
identical measured overlap. See ORGAN-STACK-REAL-DEPLOYMENT.md, "Building
a reusable 'which priors to activate' tool."

**What remains valid:** running the actual task against each real
candidate and ranking by real measured outcome (`select-best-priors.mjs`
used this way, and the ensemble-consensus approach in `read-odyssey-
ensemble-surprise.mjs`, which scores every unit against every available
real prior and looks for agreement across signals rather than trusting
any one). The cheap shortcut is what failed to validate, not the general
idea of using priors.

### A6 — Three data points, even monotonic ones, are not a validated relationship

**Forbids:** generalizing a claim about a relationship (X predicts Y) from
fewer real data points than are actually obtainable, and treating a
clean-looking small sample as confirmation rather than as what it is —
too small to license the claim.

**Measurement:** this document's own A5 above is the concrete example, not
a hypothetical one — its 3-point version and its 13-point version are
different findings, not two levels of detail on the same finding. See
ORGAN-STACK-REAL-DEPLOYMENT.md, same section, and the constitutional
principle already recorded there in nearly these words.

### A7 — Structural surprise is a real, medium-general mechanism — implemented in each medium's own native vocabulary, not by forcing one medium's exact math onto another

**Forbids:** assuming a mechanism validated in one medium (e.g. discrete
KL-divergence over word-count distributions) needs to be ported
byte-for-byte to another medium to prove the underlying principle
generalizes, or conversely assuming it can't generalize just because the
literal computation must change.

**Measurement:** text's `significanceSpine` (discrete KL-divergence, a
sentence is naturally a bag of word-tokens) and this investigation's new
audio-native forward-surprise detector (a continuous local Gaussian
model / diagonal Mahalanobis distance, because a single audio frame is one
continuous vector, not a bag of anything) are architecturally the same
mechanism — sequential, forward-only, scored against a decaying local
window — expressed in each medium's own native mathematical vocabulary.
Both were validated against real material and real noise controls. See
ORGAN-STACK-REAL-DEPLOYMENT.md, "Music's own forward-surprise."

### A8 — A probe's (or any verification tool's) own calibration is exactly as fallible as the engine it tests, and needs the same discipline applied to itself

**Forbids:** trusting a test/probe/verification script's output without
checking its own parameters, comparisons, and edge-case handling against
ground truth or against the actual production call sites it claims to
mirror — a bug in the verifier is indistinguishable from a real finding
about the engine until checked, and can silently invert a conclusion.

**Measurement:** at least six self-caught instances in this investigation
alone: a book-splitting regex that assumed one TEI attribute order/case
and silently broke on a second real source; a `classifyAmplitudes` result
field accessed under the wrong name; a naive whitespace-sensitive
provenance comparison that reported 424 false mismatches; a structural
boundary-detection threshold that didn't match the actual production call
site and would have reported the opposite conclusion; an audio surprise
scorer with no cold-start guard that produced a 29,000x outlier; the same
scorer using one variance floor across dimensions of incompatible scale.
Every one was caught by checking the probe against real ground truth or
real call sites before trusting its output, not by inspection alone.

### A9 — "Surprising relative to a prior" is not one claim, and a consumer of a surprise signal must be told which claim it's making

**Forbids:** presenting a high surprise/divergence score against an
external prior as if it always meant "this moment is narratively or
structurally unique," without checking whether it instead means "this
is recognizably distinctive OF THE GENRE the prior doesn't share" — a
different, weaker, and often much more mundane claim that a naive
consumer of the score cannot tell apart from the first without it being
labeled.

**Measurement:** `read-odyssey-ensemble-surprise.mjs`, run as a genuine
14-signal consensus reading of the real Odyssey (1 within-text baseline +
13 individually-validated real external priors, agreement counted rather
than any single signal trusted), surfaced a real, mixed top-25: most
entries were real, independently-recognizable narrative moments (Athena's
arrival to Telemachus in Book 1; the swallow-transformation and a
suitor's mistaken-identity moment during the Book 22 slaying; the golden-
wand recognition scene in Book 16; Penelope's formal entrances) — and
three were the same Homeric formula (a stock hospitality-scene line)
recurring verbatim across four different books, scoring high only because
it reads as distinctively epic against non-epic external priors, not
because it is narratively unique. An automatic recurrence check (does
this exact text appear elsewhere in the source?) distinguished the two
cleanly once added — 3/25 tagged `FORMULA` with their other real
locations listed, 22/25 tagged `unique` — and caught a fourth real
occurrence of the formula that hadn't itself scored into the top 25,
which manual inspection of the ranked list alone would have missed.

**What this settles, and what it leaves open:** a consensus/ensemble
reading over many real priors (A5's "what remains valid," applied at
scale) surfaces a genuinely useful top-N, materially better than trusting
any single prior — but "surprising" still conflates at least two distinct
properties (narrative novelty vs. genre-distinctiveness) that any
consumer-facing surface built on this class of signal must either
separate automatically (as done here) or disclose as unseparated, not
silently blend.

---

## Part B — Proposed new entries for `LAWS.md` (eochat host behavior)

Narrower in scope than Part A on purpose — `LAWS.md` binds the host (clock,
I/O, routing, UX) and explicitly cannot license a change to engine reading.
These two are about how eochat communicates to a user, not about organ
design.

### Proposed L6 — No implied completeness

**Between showing a reader a compressed or folded view of a source and
showing them the source itself, the interface never implies the compressed
view is everything.**

A fold, summary, or altitude view necessarily omits most of the source —
that is its function, not a defect. But a reader who cannot tell "this is
a deliberate, navigable compression" from "this is the whole story" will
eventually be burned by the first case while trusting it like the second.
Every compressed view eochat shows a reader must carry a visible, honest
signal of its own incompleteness and a real path to the fuller material
underneath it — not a footnote, an affordance.

**Check (proposed):** any UI surface that renders `multiAltitudeFold` (or
any future fold/summary organ) output at less than its maximum altitude
must render a visible drill-down affordance in the same view, not a
separate settings toggle a reader has to already know to look for.

### Proposed L7 — No silent degradation across language or medium

**When an organ produces no signal because the content is outside what it
can read (wrong script, wrong medium, wrong register), the interface says
so — it never presents an empty or zero result as if it were a considered
finding.**

`cube/index.js` correctly returns no terrain signal on Greek because it is
an English lexicon. That is the right ENGINE behavior. It is the wrong APP
behavior to show a reader "Terrain: none detected" without distinguishing
it from "Terrain: Field" — the first is `refuses to guess outside its
competence`, the second is a real reading, and a reader cannot tell them
apart from the same-shaped empty result.

**Check (proposed):** any UI surface presenting an organ's output must be
able to render a distinct "outside this organ's scope" state, sourced from
that organ's own documented scope (see A2 above), separately from a
genuine null/negative finding.

---

## What this file is not

Not a decision. Not a merge. Not evidence anything above is correct beyond
what its cited measurement actually showed — several items above (A5, A6)
exist specifically because an earlier, smaller-sample version of this same
document was wrong, and stayed wrong until tested further. Treat every
item the same way: as a claim that should be checked again before being
trusted permanently, not as a conclusion.
