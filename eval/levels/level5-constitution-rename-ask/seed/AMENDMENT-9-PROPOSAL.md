# Proposed 9th amendment — the fold fidelity test (II.14)

**Status: DRAFT PROPOSAL. Not applied, not yet human-reviewed.** IV.2 — the
assay proposes and checks, it never amends; amendment is a human act. This
document converts items A3 and A4 of
`../eochat/CONSTITUTION-AND-LAWS-AMENDMENTS-PROPOSED.md` (Part A) into a
testable article. Nothing in `CONSTITUTION.md`, `assay/classify.js`, or
`claims/` has been changed by this document.

---

## The defect

Two related failures showed up in real deployment of the fold/compression
organs (`multiAltitudeFold` and its "prompt deeper reading" trigger):

**Overclaiming what compression preserves.** A fold organ can honestly be
called "lossless" in exactly one sense — zero fabrication, every span
traceable to real source offsets — and dishonestly in another: "nothing was
left out," which cannot be true of anything that compresses at all
(compression that keeps everything is not compression). Nothing currently
distinguishes these two senses of the word, so "lossless" as shipped
documentation licenses the reader to assume completeness a fold organ never
provided and was never designed to provide.

**Faking the trigger for "show more."** The mechanism that decides whether a
reader should be shown a deeper, unfolded view exists to replace
flooding-by-keyword-occurrence with a real significance signal. A first draft
of the probe for this mechanism used `text.includes(needle)` as its own
trigger — the exact failure the fold architecture exists to prevent, merely
relocated from the model's context into the harness that tests it. It was
rebuilt on `summary/spine.js`'s real forward-surprise, which found a genuine
narrative turning point unprompted by any keyword.

## Why no existing article catches this

- **II.6 (the book test)** refuses a surrogate that stands in for the source —
  but a fold that is honestly labeled "compressed, here is the drill-down" is
  not a surrogate; it is the constitution's own permitted altitude view. II.6
  does not reach the *labeling* question of what "lossless" is allowed to
  mean once a fold is built.
- **II.8 (difference)** and **II.9 (revision)** ask whether the mechanism
  weights the present or scores the arrival alone. A keyword-search trigger
  passes both: it perturbs nothing, and it can be paired with a perfectly
  sound significance organ underneath — the defect is specifically that the
  *trigger surfaced to the reader* is not the organ that was actually
  measured, which no article currently checks.
- **II.2 (giver)** requires material knowledge to name its giver, but a
  fabrication claim about a fold organ is not material knowledge — it is a
  claim about the organ's own behavior, which sits outside every existing
  routing test.

## Proposed article

> **II.14 The fold fidelity test.** *Does a compression organ's own claim
> about itself distinguish fabrication from completeness, and does its
> "show me more" trigger use the same signal that governs the compression it
> triggers on?* A fold, summary, or altitude organ is not refused for
> compressing — that is its function (II.6 already permits the honest
> altitude view). It is refused for two specific overclaims:
>
> - **"Lossless" means zero fabrication, verified against real source
>   offsets — never completeness.** A fold organ's own documentation, and any
>   claim proposing its placement, must say which sense is meant. A claim that
>   asserts completeness for a mechanism that compresses is refuted regardless
>   of tier.
> - **A drill-down trigger is driven by the same significance organ that
>   governs the fold, never by a keyword or substring match against the
>   compressed content.** A trigger built on `text.includes` or an equivalent
>   occurrence check is the flooding-by-occurrence failure the fold
>   architecture exists to replace, relocated rather than solved.

## Proposed enforcement

```js
// assay/classify.js — EVIDENCE_BOOLEANS
"fold_overclaims_completeness",
"drilldown_uses_keyword_trigger",
```

```js
// assay/classify.js — inside `if (placement === "engine")`,
// after the unconditional_null branch (II.10 — the neighboring ground defect)
if (evidence.fold_overclaims_completeness) {
  return {
    verdict: VERDICTS.REFUTE,
    placement,
    reasons: [
      "II.14 — the fold fidelity test: this mechanism claims completeness for output that compresses its source. 'Lossless' means zero fabrication verified against real source offsets, never completeness — compression that keeps everything is not compression",
    ],
  };
}
if (evidence.drilldown_uses_keyword_trigger) {
  return {
    verdict: VERDICTS.REFUTE,
    placement,
    reasons: [
      "II.14 — the fold fidelity test: this mechanism's drill-down trigger is a keyword or substring match against compressed content rather than the organ-computed significance signal that governs the fold. Flooding-by-occurrence relocated into the trigger is not solved",
    ],
  };
}
```

The exemplar claim to add — the shape of the probe's own first draft:

```json
{
  "claim_id": "keyword-drilldown-trigger",
  "what": "a 'show deeper reading' trigger implemented as text.includes(needle) against the folded context, rather than the summary organ's own forward-surprise signal",
  "proposed_placement": "engine",
  "expect": "refute",
  "evidence": {
    "needs_name_or_surface": false,
    "is_material_knowledge": false,
    "giver": "",
    "is_host_knowledge": false,
    "medium_agnostic": true,
    "asserted_agnosticism": false,
    "is_one_off_fix": false,
    "weights_present": false,
    "scores_arrival_alone": false,
    "unconditional_null": false,
    "needs_datacenter_compute": false,
    "fold_overclaims_completeness": false,
    "drilldown_uses_keyword_trigger": true,
    "consumes_source": "direct",
    "host_dependencies": [],
    "level_test": "above"
  }
}
```

## Proposed amendment-log entry (IV.6)

> - **9th — The fold fidelity test (II.14).** A compression organ is not
>   refused for compressing (II.6 already permits the honest altitude view);
>   it is refused for two specific overclaims. "Lossless" means zero
>   fabrication verified against real source offsets, never completeness — a
>   claim of completeness for a mechanism that compresses is refuted in every
>   tier. A drill-down trigger must use the same organ-computed significance
>   signal that governs the fold, never a keyword or substring match against
>   the compressed content, which relocates flooding-by-occurrence rather than
>   solving it. Enforced as `fold_overclaims_completeness` and
>   `drilldown_uses_keyword_trigger`, required on every claim; `true` on
>   either is refuted on an engine placement.

## Source

Drafted from `../eochat/CONSTITUTION-AND-LAWS-AMENDMENTS-PROPOSED.md` items
A3 and A4, whose evidence is `../eochat/ORGAN-STACK-REAL-DEPLOYMENT.md`,
"Follow-on: surf/fold as an actual answering mechanism." Not yet reviewed by
the human who must dispose it (IV.2); whether these are one article or two
(the completeness overclaim and the trigger defect are logically separable)
is an open question for that review.
