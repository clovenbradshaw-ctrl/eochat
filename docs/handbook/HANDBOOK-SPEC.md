# The EO Reader 6 / EO Chat Handbook — a specification

**Status:** draft v0.2, structure and scope only. No chapter content is written
yet. This document is the outline to review before anyone writes prose against
it.

**Purpose of this file:** decide, on paper, what the handbook teaches, in what
order, to whom, using what material — before spending the effort to write it.
It follows the same discipline the rest of this lineage asks of everything
else: declare the shape, checkpoint it, then build.

**v0.2 changelog (this update):** `eoreader6` shipped a real, dated piece of
research since v0.1 — the "role-fold" arc (PRs #44–48), attacking Fillmore's
case-role problem directly and closing with a measured cross-lingual result.
Part VI.2 is rewritten around it, Part III.6 gets it as a second, currently-
live growth-rule example alongside the earlier turbulence-candidate case, and
a new open question (Q5) addresses how the handbook should handle citing work
this fresh. `eochat` also merged a discourse-continuity feature (#39), folded
into Part V.6's worked example.

---

## 1. Who this is for, stated precisely

Not a developer onboarding doc. Not a marketing page. A reader with:

- no machine learning or LLM background — doesn't know what a "model,"
  "token," "embedding," or "hallucination" means going in;
- a loose, everyday grasp of grammar ("subjects and verbs," roughly) and no
  formal semantics;
- no ontology or epistemology vocabulary — doesn't know the words "ontology"
  or "epistemology," let alone the distinctions inside them;
- genuine curiosity about how EO Reader 6 and EO Chat actually work, not just
  what they're for.

That reader has to end the book able to hold the real internal vocabulary of
this project — ground, figure, pattern, witness, terrain, stance, operator,
organ, prior, growth rule — as *load-bearing concepts they understand*, not as
words they've learned to recognize. Every one of those words is used
precisely and technically inside this codebase; the handbook fails if it
teaches the reader to nod at them instead of use them.

## 2. What makes this hard, named honestly

Three things compound:

1. **The theory is genuinely original vocabulary layered on genuinely
   old ideas.** "Ground," "figure," "witness," "aperture" are not standard
   CS or philosophy terms — they're this project's own coinages, chosen for
   specific reasons, and sometimes *renamed* mid-project when the old name
   turned out to claim more than the measurement earned (`aperture` was
   `ananda` until the project's own authors decided that name was a
   dishonesty). A handbook has to teach the *current* vocabulary while being
   honest that some of it has a history and some of it is still unsettled.
2. **The system doesn't explain itself by analogy to an LLM, because it
   isn't one and is partly a rebuttal of what LLMs do.** You cannot teach
   "why ground-construction matters" by saying "it's like attention, but—"
   to a reader who doesn't know what attention is. The primer has to build
   just enough of a mental model of *ordinary* language models — plain
   next-word prediction, fluent but with no ledger — for the contrast to
   land, without turning into an ML course.
3. **The project's own writing style is a teaching asset and a trap.** The
   source documents (`SEED.md`, `CONSTITUTION.md`, the prior-art essay) are
   extraordinarily well-written — precise, declarative, unafraid of a hard
   sentence — but they're written *for people already inside the project*.
   They assume you already know what a "null," a "conditional null," or
   "shuffling" mean. The handbook borrows their voice and their honesty
   (stating open problems as open problems, never smoothing over a gap) but
   cannot borrow their assumed audience.

## 3. The pedagogical contract (rules the handbook itself must follow)

These bind every chapter, the same way `LAWS.md` binds every route in
eochat. Each is a promise, and a chapter that breaks one is a defect in the
handbook, not a stylistic choice.

- **P1 — Define before you use.** No technical term appears before the
  chapter (or an earlier chapter) has defined it in plain language first.
  A glossary at the back is a lookup aid, not a substitute for teaching the
  word where it's first needed.
- **P2 — Plain language first, formal statement second.** Every concept gets
  an everyday-language version before its precise version. "The system only
  speaks when something it checked actually surprised it" comes before
  "witness requires `pattern.moved === true`."
- **P3 — One running example, revisited, not a new example every time.**
  Abstractions (the nine operators, the three faces, the cube) get taught
  through the *same* two or three worked examples throughout, so the reader
  builds one mental model instead of re-orienting every chapter. See §5.
- **P4 — Never hide a gap.** Where the source material says "not yet
  earned," the handbook says so too, in the same place, not in a footnote.
  This is not just intellectual honesty for its own sake — it is the single
  clearest teaching device this project already has for showing a reader
  what "real" claims look like versus aspirational ones.
- **P5 — Every chapter answers "why should I care" before "how it works."**
  A one- or two-sentence stakes statement opens every chapter.
- **P6 — Provenance travels with the content.** Every chapter ends with a
  "where this comes from" line pointing at the real source files (repo +
  path), so a reader who wants to go deeper — or check the handbook's own
  claims — always has a real citation, not a paraphrase standing in for the
  source. This is the book applying its own subject's ethic (Article II.6,
  the book test) to itself.

## 4. Overall arc

Eight parts. Parts 0–II teach the *general* theory (true of the whole
lineage, not tied to any one repo). Parts III–V teach the *specific* systems
(the eoreader6 engine, the eo-constitution governance, eochat the
application). Part VI steps back and explains why any of this exists, in
plain historical terms. Part VII is optional/gated (see §7). Part VIII is
reference material the rest of the book points into rather than repeats.

```
Part 0   Before You Start           — foundations the reader is assumed not to have
Part I   The One Idea               — ground / figure / pattern / witness
Part II  The Grammar of Everything  — the nine operators, the cube, the three faces
Part III How EO Reader 6 Reads      — the engine
Part IV  Why the Rules Are Rules    — the constitution
Part V   Where You Meet It          — EO Chat
Part VI  Where This Sits in History — prior art, told honestly
Part VII Building With It           — the construction language (SCOPE TBD, see §7)
Part VIII Reference                 — glossary, tables, provenance map
```

## 5. The running examples (decided once, used everywhere)

Two examples, chosen because they are *already real artifacts in the repos*
— nothing invented for the book, which matters for P6.

**Example A — the Frankenstein reading.** `eochat/essay.md` is a real,
short, already-produced answer from the running system: a one-paragraph
answer to "What does Victor Frankenstein feel toward the creature he made?",
with a real citation, a real byte range, and a "what this leaves out"
section naming exactly what was dropped and why. It is short enough to
quote in full and rich enough to illustrate citations, gaps, withheld
evidence, and refusal all in one artifact. Used throughout Part III and
Part V.

**Example B — the domain-invariant triad.** For the abstract structural
material (operators, terrains, stances, the cube) that has nothing to do
with text specifically, reuse the three domains the `writing-code-in-eo`
reference already committed to for exactly this reason: a hospital ward, a
neighborhood mutual-aid map, a reading group. Carrying the *same* three
domains through Part II keeps the abstraction visibly domain-agnostic
instead of accidentally text-flavored.

A third, smaller device: **the two deaths** (confabulation and sclerosis)
get a single memorable human-scale framing introduced in Part I and
referred back to every time a failure mode is discussed later — "talking
without evidence" and "no longer able to be surprised."

## 6. Part-by-part breakdown

Each entry: what it teaches, why it sits where it does, and which real files
it is drawn from.

### Part 0 — Before You Start (4 chapters)

- **0.1 What this book is and isn't.** Sets expectations, names the running
  examples, states the pedagogical contract as a promise to the reader.
- **0.2 A ten-minute grammar and meaning primer.** Syntax vs. semantics vs.
  pragmatics, taught with two or three ordinary sentences ("the dog bit the
  man" / "the man bit the dog" — same words, different structure, different
  meaning). Enough that "grain," "terrain," and "stance" don't land as
  jargon later.
- **0.3 A ten-minute ontology and epistemology primer.** What it means to
  ask "what kind of thing is this" (a person vs. a category of people vs. a
  relationship between people) and what it means to ask "how do you know,
  and what would change your mind" (evidence, revision, falsifiability).
  These become, almost verbatim, the *terrain* and *stance* axes in Part II
  — the primer is written so that connection is obvious in hindsight.
- **0.4 What a language model is, in plain terms, and why this project
  keeps its distance from one.** Next-word prediction, fluency without a
  ledger, what "hallucination" means without jargon. Not an ML course —
  just enough that Part VI's history and the constitution's Article II.8
  ("the engine never weights what is present") land as a real design
  choice instead of an assertion.

  *Sources:* none directly — this part is original exposition, written to
  service Parts I–VI. 0.4 draws its contrast points from `eo-constitution/
  CONSTITUTION.md` Article II.8 and `eoreader6/prior-art-teachable-
  language-comprehender.md` §VI.

### Part I — The One Idea Everything Is Built On (5 chapters)

- **1.1 Noticing.** Ground and figure, built from an everyday intuition
  ("how do you tell that something is unusual?") before naming *E. coli*'s
  methylation reset as the biological version of the same move.
- **1.2 The difference that makes a difference.** Pattern, Bateson's
  phrase, explained plainly: not "the same thing happened again" but "what
  happened *changed what could happen next*."
- **1.3 Witness.** Why the system refuses to say something unless the
  pattern actually moved — introduces "a difference that made no difference
  is not information" as the chapter's one sentence to remember.
- **1.4 The two deaths.** Confabulation (talking without evidence) and
  sclerosis (nothing can surprise it anymore) as the two failure modes
  everything else in the book is a defense against.
- **1.5 Three numbers and a vital sign.** `draws`, `reseeds`, `window`
  explained as "how fine a distinction can be drawn," "how many times it
  redoes the comparison," and "how much of the recent past counts as now" —
  then `aperture` as the one health signal, explicitly *not* a score or a
  gate, "the warmth you check for."

  *Sources:* `eoreader6/SEED.md` (the whole chapter is a plain-language
  translation of this file's first two-thirds, through "The sign of
  health"); Amendments VI and XVII for aperture's history and rename.

### Part II — The Grammar of Everything That Happens (5 chapters)

- **2.1 Nine verbs.** The operators (NUL, SIG, INS / SEG, CON, SYN / DEF,
  EVA, REC), each taught with one instance from each of Example B's three
  domains, so the reader sees the same verb doing the same *kind* of thing
  across a hospital, a neighborhood map, and a reading group before any
  glyph or abbreviation is introduced.
- **2.2 The order things happen in.** The helix — why you can't bond two
  things that don't exist yet, why you can't restructure a frame you never
  tested. Framed as a dependency chain a reader already intuits ("you can't
  edit a rule you haven't checked yet") before naming it formally.
- **2.3 Nine kinds of "where."** The terrains — this chapter is where
  Part 0.3's ontology primer gets cashed in directly: Entity vs. Kind vs.
  Field is "a specific patient" vs. "the category of patients" vs. "the
  unwritten culture of the ward," made concrete before the 3×3 grid is
  shown.
- **2.4 Nine kinds of "how."** The stances — where Part 0.3's epistemology
  primer gets cashed in: Dissecting vs. Tending vs. Making as different
  *postures* toward the same thing, not different topics.
- **2.5 Why all three have to agree.** Coherence and grain-mixing, the
  desert cell (why "synthesizing a whole from pure ambient nothing" is a
  sentence no human language has ever needed), and why the cube in this
  project's own repos is explicitly *not* a machine that classifies content
  — it's a diagram the builders hold ideas up against, and the difference
  matters enough that a whole file (`CUBE.md`) exists to say so after the
  earlier version was tried and refuted.

  *Sources:* `eoreader6/CUBE.md` in full; `writing-code-in-eo` skill,
  Layers 1–2, for the plain-language operator/terrain/stance tables and the
  domain-invariant teaching convention this Part borrows. **Open question**
  — see §7 — about how much weight this second source should carry, since
  it documents a construction *language* (EOT, contracts, rooms) that may
  belong to a different product generation than the current eoreader6
  engine, which uses the cube only as a design instrument, never a runtime.

### Part III — How EO Reader 6 Reads (6 chapters)

- **3.1 A reading, from the inside.** Walks the Frankenstein example
  (Example A) through one full pass: what "reading" means act by act, what
  gets perceived, what ground gets built, what counts as a figure.
- **3.2 Gifts, not guesses.** Priors — why every piece of outside knowledge
  has to name who gave it, why "the origin is a wall, not a hard problem,"
  and Amendment IV's rule that a prior earns standing only by lowering
  surprise, never by resembling the material.
- **3.3 A guided tour of the organs.** Plain-language job descriptions for
  `nul` (perceiving by difference), `frame` (keeping its own trail),
  `temporality` (finding order and direction), the binding/link organ
  (finding relationships without reading a single word), `discourse`,
  `formation`, `verdict`, `cascade`. One organ per short section, each with
  a one-line "what it refuses to do."
- **3.4 Turns and memory.** How a reading carries a small amount of state —
  the "register" — from one turn to the next without ever accumulating a
  pile of history it has to re-read.
- **3.5 Refusal as an answer.** Typed gaps, why "I don't know, and here is
  exactly why" is a designed, countable output rather than an error state —
  ties back to the Frankenstein example's own "what this leaves out"
  section.
- **3.6 How the engine is allowed to grow.** The growth rule — "unwired is
  failing," nothing is ported, every organ is re-earned — and two worked
  examples at opposite ends of the process. First, a proposal tested and
  refused (Amendment XIV/XV, the turbulence candidate), to show the rule has
  teeth. Second, a proposal *currently in flight* (the "role-fold" arc,
  `eoreader6` PRs #44–48): several early attempts landed on "unstable" and
  were abandoned outright, one attempt (clustering each verb's company
  separately before ever pooling across verbs) reached certified structure,
  and the whole thing is still explicitly marked "experimental, unwired" —
  sitting in `scripts/experiments/`, not yet in the engine, exactly where
  the growth rule says an unearned organ belongs. Pairing a closed case with
  an open one shows the reader the rule is a process they could watch
  happen, not just a historical verdict.

  *Sources:* `eoreader6/SEED.md` (Amendments I–XX, selectively), `eochat/
  essay.md` as the first worked example, `eoreader6/scripts/experiments/
  {README.md,FINDINGS.md}` and PRs #44–48 as the second, `eo-constitution/
  README.md`'s domain map for organ vocabulary.

### Part IV — Why the Rules Are the Rules (4 chapters)

- **4.1 Four boxes.** Engine, priors, applications, legacy — why keeping
  the measurement pure and the interface "thin" is a design decision with a
  reason, not bureaucracy.
- **4.2 The tests, in plain language.** Each routing test translated:
  "would a symphony have this problem?" (omnimodal), "who gave you that?"
  (the giver test), "read the actual book, not a summary of it" (the book
  test), "don't fix just this one thing — zoom out" (convergence), "the
  engine measures by difference, never by weighing what's already there"
  (the difference test), phrased so a reader with no CS background
  understands *why* each test exists, not just what it checks.
- **4.3 A constitution that edits itself.** How amendments work, why an
  amendment has to come with a changed failing test, why the document keeps
  its own history of being wrong instead of quietly rewriting itself.
- **4.4 One amendment, start to finish.** A single worked example (a good
  candidate: Amendment XVII, the `ananda` → `aperture` rename, since it's
  short, self-contained, and makes the stakes of "a name is a claim" vivid
  without requiring any of the harder math from other amendments).

  *Sources:* `eo-constitution/CONSTITUTION.md` in full, `eo-constitution/
  README.md`.

### Part V — EO Chat: Where You Meet It (6 chapters)

- **5.1 A thin front door.** What eochat is and, as importantly, what it
  deliberately is *not* — "deleting an application must change no engine
  reading."
- **5.2 Instructions all the way down.** How the chat's behavior — identity,
  modes (chat/surf/think), tone, refusal, the citation law — is itself a
  layered, versioned set of documents, not a hidden prompt.
- **5.3 Four promises to the reader, in plain language.** No dead air (you
  always know it's working), audit is local (you can check any claim from
  where you doubt it, not from a menu), no silent truncation (a cut is
  always announced, and now mostly just doesn't happen), no implied
  completeness (a summary never pretends to be everything). Each promise
  illustrated with the real measured failure that motivated it (LAWS.md
  keeps these on record, including the numbers).
- **5.4 A citation you can actually check.** Walks the full round trip from
  a quoted passage in an answer back to the real bytes it came from, using
  Example A again.
- **5.5 Writing something long without losing the thread.** The task-log
  spine and the "good watchmaker" rule — small validated pieces, never one
  long unchecked sequence — shown working across five different kinds of
  output (an essay, a story, a piece of code, a diagram) so the reader sees
  it's one mechanism, not five.
- **5.6 Senses, memory, and borrowed models.** Multimodal input, how a
  conversation remembers itself, and how the application calls outside
  language models as *hosts* calling a tool they don't own — never as the
  measurement itself. Worked example: the always-running discourse summary
  (`eochat` #39) — a small, cheap, separate model call folds each finished
  turn into a bounded rolling summary of topic/flow/entities, injected only
  once a conversation outgrows the verbatim history window. A good concrete
  case for "thin host, not the intelligence": the summary is generated by a
  borrowed model, capped in size, and explicitly gated off on short
  conversations after testing showed an always-on summary could anchor a
  fresh question to a stale topic — an application-layer decision, with
  nothing about it touching how the engine itself reads.

  *Sources:* `eochat/LAWS.md`, `eochat/INSTRUCTION-LAW.md`, `eochat/
  instruction-set/*`, `eochat/DEVELOPMENT-STATE.md`, `eochat/UX-DESIGN.md`,
  `eochat` PR #39 (`server/conversation-summary.js`).

### Part VI — Where This Sits in History (4 chapters)

- **6.1 A short history of machines that were said to read.** Condensed,
  plain-language retelling of the prior-art essay's four redefinitions of
  "reading" (paraphrase → template-filling → span-selection → human
  preference) and how each got gamed by the field that built it.
- **6.2 The fifty-year-old objection, and where the project is actually
  chipping at it.** Fillmore's case-role problem, told simply: the same
  sentence position can mean different things ("the hammer broke the
  window" vs. "John broke the window"). This chapter no longer stops at
  "still unsolved" — as of the "role-fold" arc (`eoreader6` PRs #44–48,
  live in `scripts/experiments/`) there is real, measured, in-progress work
  on exactly this problem, and it makes a better teaching example than the
  abstract objection alone: an early attempt using a grammar pattern
  (subject-verb-object) failed hard on real text (87% recall loss against
  human-annotated ground truth) for precisely the reason Fillmore predicted
  in 1968. The fix that actually worked — clustering each verb's typical
  company separately before ever pooling across verbs, an idea borrowed
  from child-language-acquisition research (Tomasello) — unlocked real
  structure where every pooled attempt had found none. A follow-on test
  found the front end that spots candidate words is language-specific and
  breaks predictably on German, while the underlying clustering statistic
  holds up across English, French, German, and Finnish. Still explicitly
  short of Fillmore's actual goal (named semantic roles like agent/
  instrument, not just two unlabeled position-shaped clusters per verb) —
  stated as plainly in the source material as the progress is, which is
  the point: a live example of P4 in the pedagogical contract, not a
  historical one.
- **6.3 What's actually new here.** Typed refusal as a normal output,
  provenance on every individual claim, tests built from the material's own
  statistics instead of fixed thresholds, a growth rule that has actually
  refused its own author's best result, and — folding in 6.2's example —
  a genuinely fresh, dated result (the cross-lingual "mouth vs. organ"
  split) rather than only citing older, settled findings.
- **6.4 The honest gap list.** What Part III's organs don't yet do
  (an integration/settling step, suppression of a resolved choice's
  runner-up, several of Zwaan and Radvansky's five situation-model
  dimensions, and 6.2's own named ceiling: position-based clusters are not
  yet semantic case roles) — stated the way the source material states it:
  as a map of what's next, not a flaw to hide.

  *Sources:* `eoreader6/prior-art-teachable-language-comprehender.md` in
  full for 6.1, 6.3, 6.4; `eoreader6/scripts/experiments/{README.md,
  FINDINGS.md}` and PRs #44 (the measured SVO-regex failure), #45–46 (the
  verb-island and TP-chunk mechanisms, citing Tomasello and Saffran/Aslin/
  Newport respectively), #48 (the cross-lingual mouth/organ test) for 6.2.

### Part VII — Building Something With It (SCOPE NOT YET DECIDED — see §7)

- **7.1 A construction language.** Rooms, links, surfaces, contracts — the
  EOT syntax as a way to describe an application in a form a kernel checks.
- **7.2 The watchmaker's discipline.** Why every app is assembled in small,
  independently-checkable pieces, never as one long unvalidated sequence.
- **7.3 A worked build, start to finish.** One of the appendix examples
  from the `writing-code-in-eo` reference (the school attendance tracker,
  or the public/private neighborhood map), walked from request to working
  app.

  *Sources:* the `writing-code-in-eo` skill document, in full.

### Part VIII — Reference (4 sections, not chapters — built incrementally as
earlier parts are written, not up front)

- **8.1 Glossary.** Every technical term, plain-language definition first,
  formal definition second, with a pointer back to the chapter that taught
  it.
- **8.2 Quick-reference tables.** The nine operators, the 27-cell grid, the
  routing tests, the three (four?) declared numbers.
- **8.3 Provenance map.** Every claim in the book traced to its real source
  file — the handbook's own audit trail, matching L2's discipline
  ("anything the reader can doubt, they can inspect from where they doubt
  it") applied to itself.
- **8.4 Index of worked examples.** Where Example A and Example B recur,
  so a reader can follow one thread across the whole book.

## 7. Open questions — need a decision before writing starts

**Q1 — Where does this live?** I put this spec in `eochat/docs/handbook/`
because eochat is the repo explicitly responsible for "the surfaces of
encounter" (`eo-constitution` Article I.4) — a handbook is, in that
framing, part of the interface. But it could equally live in
`eo-constitution` (the one place all three repos are already discussed
together) or as its own thing. Worth confirming before more content is
written against a path.

**Q2 — Is Part VII in scope?** `writing-code-in-eo` describes a
construction language (EOT: rooms, contracts, catalog surfaces) that reads
as its own product layer — the doc's own header ties it to `eoreader4.1`
`core/operators.js` and `core/faces.js`, not to anything I found in
`eoreader6`. `eoreader6/CUBE.md` is explicit that the cube is "an
instrument, not a runtime" and was tried and refuted once already as a
content classifier. Before writing Part VII, I need to know: is EOT/the
room-and-surface model a real, current part of what EO Reader 6 / EO Chat
does today, a different (earlier or later) generation's product, or
something else entirely? If it's a different generation, Part VII either
gets cut, or gets reframed explicitly as "a related but separate project,"
which is itself an honest and teachable distinction (P4 above) rather than
a reason to hide it.

**Q3 — Format.** One long document, or one file per chapter under
`docs/handbook/` with an index? Given every other doc in these three repos
is plain markdown with no site generator, I'd default to one file per
chapter (mirrors `eochat/instruction-set/`'s numbered-file convention) —
but confirming before generating ~35 chapter files.

**Q4 — Depth.** This spec assumes real, correct content at handbook depth —
teaching the actual mechanisms, not a marketing gloss. That's a lot of
writing (roughly 35 chapters). Worth confirming the intended scope before
committing to write all of it versus, say, Parts 0–III first as a
standalone "how it works" volume and the rest later.

**Q5 — How does the handbook handle a codebase that changes several times a
day?** `eoreader6` alone shipped roughly fifteen PRs in the 24 hours around
this spec's first draft. Chapters that cite "current state" — 3.6's
growth-rule example and 6.2's Fillmore example especially, both now pointing
at PRs that are still open or only just merged — will drift out of date
faster than the rest of the book. Two things worth deciding: (a) whether
every such chapter carries an explicit "as of `<commit-sha>`, `<date>`"
anchor so drift is visible rather than silent (matches P6 and the project's
own "no implied completeness" discipline), and (b) whether these chapters
get flagged for a standing re-check on some cadence rather than treated as
done once written, since their whole teaching value is that the reader is
watching something real happen, not reading a museum piece.

## 8. Suggested next step

Write Part 0 and Part I in full as a sample — the foundations primer plus
the ground/figure/pattern/witness chapters — since they're the highest-risk
part to get the pedagogy right on, and everything else in the book leans on
them. Review that sample against the pedagogical contract in §3 before
generating the rest.
