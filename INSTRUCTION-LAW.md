# Instruction Law

**The universal rules for instruction sets and the gate that serves them.**

An instruction set is a manual the model must follow — the eochat corpus
(`instruction-set/`), the Aurora support manual (`instruction-set-support/`),
and any **project's own instructions**, written by a reader through the app and
compiled to folds by `server/project-instructions.js`. It differs from a source
document in one essential way: a source is read *to be quoted faithfully*; an
instruction is read *to be obeyed*. That is what makes a mis-served instruction
dangerous. A wrong quote wastes a turn; a wrong rule produces an answer that
*was correct according to the manual it followed* — correct about the manual,
wrong for the reader.

These rules bind reader-authored instructions exactly as they bind the
checked-in corpora, which is why project instructions are segmented rather than
summarized (R1), why every segment declares the terms that surface it (R3), and
why a section with no distinctive terms is promoted to always-on rather than
becoming a wall nothing can reach. The one thing a reader-authored manual can
do that a checked-in one cannot is *outgrow its budget without anyone noticing
at review time*, so the gate additionally reports which folds matched a turn
and were crowded out (`crowdedOutIds`) — "matched but did not fit" is a
different fact from "nothing matched", and R2's whole point is that two
different facts must not render alike.

These rules are universal across every corpus the gate serves. They are not
app laws (LAWS.md) and not the constitution (`../eo-constitution/`, which
decides placement). They are what the constitution's invariants require of any
mechanism that feeds instructions into a model, cross-referenced to the
articles that ground them.

A law is not a preference. It states a failure it forbids, and it names the
measurement that catches the failure. Each rule below is enforced by
`node scripts/check-instruction-laws.mjs` (no model, no server — pure
structure and accounting).

---

## R1 — Verbatim, or not at all

**An instruction that is in force is handed to the model word for word. A
folded instruction is a pointer, never a surrogate.**

The whole point of gating is that the model obeys the *actual page*. The moment
an active fold is paraphrased, summarized, or embedded into a vector, the model
is obeying something that was not written — a secondhand rule that carries the
author's edits, the summarizer's judgment, and none of the manual's precision.

Folding to a one-line fingerprint is legal *only* for instructions not in force
this turn. A fingerprint is an index entry: it names what exists so absence
stays auditable. It is never the substance.

**Measurement.** For every probe turn, every surfaced fold's body must be a
substring of the block the model receives. A surfaced fold that cannot be found
verbatim in the block is a violation. Check: `R1a`.

**Ground.** II.6 (no surrogate for the source), II.8 (never weight or compress
what is present).

---

## R2 — A missing fold is a named gap, never a silence

**When no instruction matches — or the manual simply does not cover the
reader's subject — the block says so, in its own section.**

Silence at this point is not neutral, it is a lie by omission: the model,
obliged to answer, will answer from general knowledge *as if it were policy*.
Measured, not predicted: a support turn about replacement shipping times
produced the invented figure "3–5 business days" because the shipping page did
not surface. The manual had a real number; the silence erased it and the model
supplied a plausible one.

The gap section is the constitution's typed gap applied to instructions: the
model is told the active folds are the complete and only rules in force, and
that a subject they do not cover gets an honest "that rule is not in front of
me, I will confirm" — never an improvised policy.

The gap fires only for a real corpus. A missing instruction set is a no-op gate
that changes nothing.

**Measurement.** A no-match probe turn must set the gate's `gap` flag and carry
the `NO FOLD SURFACED THIS TURN` marker in the block. Check: `R2a`.

**Ground.** III.3 (typed gap, never a silently wrong number), L2e (absence is
auditable).

---

## R3 — Relevance is declared, machine-routable, and one mechanism

**Every fold names the terms that surface it, in its own front matter. A fold
that can never be surfaced is a wall the gate refuses to build.**

Relevance must be a claim the fold itself makes — the giver of every surfacing
decision visible and inspectable in the cue. And it must be *one* mechanism: one
`scoreFold` shared by every fold. A per-corpus classifier, a learned reranker, a
model that decides relevance — any of these is a mechanism that fixes one thing
and is therefore a convergence-test debt. Signal lists are declared data, legal
because instructions live in the app domain, where the particular is honest; the
machinery that consumes them is shared and singular.

A conditional fold that declares no signals can never surface. It is not a
latent capability waiting for a better question; it is a hole in the manual
that never reports itself. Loading it silently is the exact corruption this
mechanism exists to refuse.

**Measurement.** Loading a fold with an empty signal list throws at boot, like
a missing id. The check proves the throw fires (`R3a`) and that both corpora
load clean.

**Ground.** II.2 (a missing giver is a wall), II.5 (type error before null),
II.7 (no mechanism that fixes one thing).

---

## R4 — The set NOT in force is as visible as the set in force

**Every folded instruction is listed in the block, named, fingerprinted, and
marked NOT active.**

Folding is lossy by design. What keeps it honest is that the loss is *named*:
the model — and the audit trail — can always see which pages existed and were
deliberately kept out. An unlisted folded page is indistinguishable from a page
that was never written, and that collapse is the L2e failure: absence mistaken
for evidence of nothing.

**Measurement.** Every fold declares a fingerprint (`R4b`), and the block's
folded index names every out-of-force fold with the NOT-active marker (`R4c`).

**Ground.** L2e, II.4 (named absence).

---

## R5 — Fit the model that exists

**The block, plus the conversation, plus room for the answer, must fit the
deployed context window. Instructions dropped by the window are silent
truncation.**

A manual can always outgrow a window; that is why the gate exists. What is
never acceptable is a manual that overflows and gets *cut*, because the cut
takes the top — the identity and honesty folds — and the model answers with the
middle of the manual and no persona. Measured: an ungated 9 248-token manual
sent to an 8 192-token window was silently reduced to 7 953 tokens; the
persona/identity folds were dropped and nothing reported it.

The budget is a knob set for the model that exists, never a fictional one. The
check's fit line is the constitution's local test applied to instructions:
`block + history + question + output reserve ≤ num_ctx`, and the block itself
must stay within its own budget (`overflow = 0`).

**Measurement.** Every probe turn's full prompt fits the window with an output
reserve (`R5a`). The ungated baseline in `probe-support-gate.mjs` prints a
violation verdict when `prompt_eval_count` is below the corpus's full size.

**Ground.** II.12 (the datacenter is a fiction; nothing is deployed for a
fiction), L3 (no silent truncation).

---

## R6 — The reader's priors weigh as much

**The cue is what the reader brought — their language, their tone, their own
prior turns — and the gate must serve the readers the corpus names.**

The reader's framing is half the encounter. A support manual that serves
French and Spanish readers must surface the language and privacy folds when the
reader writes in those languages; a privacy question in French answered by an
English-only gate is the manual's coverage silently absent. Measured: the French
privacy turn produced a deletion claim that contradicted the real retention
policy, because `privacy-data` never surfaced.

This is enforced by *authoring signals for the readers the corpus serves* and
by *probing those readers* — the non-English probe turns are part of the
assay, not decoration.

**Measurement.** Corpus probes include non-English turns whose expected folds
must surface (`R6a`, `R7a`). A corpus that serves no foreign reader may skip
the language probes; a corpus that serves them may not.

**Ground.** II.6 ("bring your priors and let them be adjusted"), II.3 (reader
and host knowledge → app).

---

## R7 — An instruction change changes the test, visibly

**A fold edit is a hypothesis the probe must confirm or refute. An edit no
probe exercises did not happen.**

The constitution's amendment rule, applied to instructions: a change must
change the test — surfacing, block size, or a sample answer — observably. The
probes *are* the test, so they are part of the assay: the expectation lists in
the probe scripts must reference folds that actually exist, or a typo'd id
makes the probe pass vacuously and the amendment test goes blind.

**Measurement.** Every probe turn's expected folds must surface (`R7a`), and
every fold id the probe scripts expect must exist in a corpus (`R7b`).

**Ground.** IV.1 (amendments change the test, visibly).

---

## R8 — Two facts that differ must not read alike

**"This policy covers it" and "no policy covers it" must read differently. Active
folds are never blended into a plausible average.**

When two folds both apply, the specific one governs; when none does, the gap
marker (R2) says so. What is forbidden is the middle: an answer that reads as
policy without any policy fold being in force, or a blend of two folds into a
policy neither wrote. The agent never says "according to our policy" when no
policy was surfaced.

**Measurement.** The R2 gap marker + the always-on honesty fold are the
enforcement; the probe's no-policy turn checks the model does not fabricate a
number. (Gap structure is checked by `R2a`; the no-policy model behavior is
exercised in `probe-support-gate.mjs`.)

**Ground.** II.8 (no averaging of grounds; disagreement is the finding).

---

## R9 — Content against the instructions is not given out

**A request the instructions forbid is refused, plainly, and the refusal is
verified — not hoped for. The answer that ships is one that was reviewed.**

The gate gives the model the folds that are in force. That is not the same as
the model obeying them: a small model, given an escalation fold, still invented
a manager's name rather than refuse; a gate can surface a shipping fold and the
model still quote the wrong window. Instruction-serving needs a second moment —
a mechanical check on the *output*, comparing what was said to what was handed
to the model — so a violation of the manual is caught before it reaches the
reader.

Three failures the review exists to catch:

- **Ungrounded facts.** The answer asserts a number, window, duration, or named
  person that is not in any active fold or passage the model was given (R1/R5
  applied to the output).
- **Compiled refusal.** The reader asked for content the manual forbids — the
  hidden folds, a bypass or override, an out-of-policy refund, a fabricated
  record — and the answer gave it instead of refusing.
- **Mechanism leak.** The answer names the gate: the folds it surfaced, the
  markers it drew, the machinery that decided (R4 applied to the output).

The review is mechanical and reports findings; it is not a learned judge and
does not silently swallow a bad answer. The server corrects a flagged answer by
re-asking the model to fix only the flagged violations, then re-reviews, with a
bounded loop (≤2) so a stubborn answer ships flagged, never hidden.

**Measurement.** Every served answer is reviewed against that turn's folds and
evidence; a flagged verdict is emitted as `review_report` and persisted on the
answer, with `corrected` and iteration count. The check (`R9a`) proves the
reviewer flags an ungrounded claim, a refusal-compiled request, and a mechanism
leak, and passes a grounded compliant answer.

**Ground.** III.3 (honesty is not optional and is a mechanism, not a mood), and
the always-on honesty + refusal folds.

---

## What measurement actually showed

Writing the check found one real defect before it could do any damage:

- **A generic phrase signal killed the gap.** `product-info` declared the
  phrase signal `"what is the"` — a question opener that matches nearly every
  turn. It made a conditional fold effectively always-on, bloated every block,
  and made gap turns almost impossible for the entire corpus, which defeated R2
  at the source. Removed; the fold's intent signals (`specifications`,
  `"which should i buy"`, `"difference between"`, `"does it have"`) carry its
  relevance. The check's probe set now detects a fold matching every turn as a
  `R7a`/`R2a` anomaly.

- **The probe expectations were verified against the corpora.** `R7b` confirmed
  every fold id the support probes expect actually exists, so a renamed fold
  cannot silently blind the amendment test.

The first version of this check had a bug of its own — `Set.prototype.add`
called with a spread array adds only the first element — which produced a false
R7b violation. Fixed. The check, like the system it audits, reports its own
failures loudly.

## Running the check

```
node scripts/check-instruction-laws.mjs        # both corpora, all rules
node scripts/check-instruction-laws.mjs --json # machine-readable
npm run check:instructions
```

No model, no server: it loads both corpora through the real gate and checks
R1–R9 against probe turns. It exits non-zero on violation, so it can gate a
commit. Model-behavior probes (`probe:support-gate`, `probe:support-conversation`)
extend it where a mechanical check cannot reach.

A violation is not a reason to soften the rule. Record it here as a known
violation with its number, and fix the corpus or the gate.
