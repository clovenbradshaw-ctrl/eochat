# 2.5 — Why All Three Have to Agree

**Why this matters:** you've now met three different nine-cell grids —
operators, terrains, stances — built from the same three underlying axes.
This chapter shows what happens when they're combined carelessly, using a
real, documented mistake from an earlier version of this project. It's the
clearest single lesson in this book about what "coherence" actually buys
you, because you get to watch it catch a real error.

## One coordinate, three views of it

Here's the thing worth holding onto from the last three chapters: an
operator, a terrain, and a stance are not three separate facts about an
act. They're three different two-out-of-three views of the *same*
underlying coordinate — which mode, which domain, which grain. An operator
tells you mode and domain. A terrain tells you domain and grain. A stance
tells you mode and grain. Put an operator and a terrain together, and the
stance isn't a fourth thing you get to pick — it's already determined,
because domain and grain, between them, pin down mode too.

That means grain gets named twice in a full description of an act — once by
the terrain, once by the stance — and those two namings had better agree.
If they don't, you haven't found a new kind of act. You've found a
contradiction: a description that claims to be about, say, a fresh
baseline (Ground grain, from the terrain) while also claiming to be a
posture that only makes sense once something has already earned
pattern-status (Pattern grain, from the stance). Those can't both be true
of the same act.

## A real one, caught, from an earlier version of this project

This isn't hypothetical. An earlier generation of this project
(`eoreader5`) built two different implementations of the same cube idea,
and they disagreed with each other. One built its cells the coherent way —
computing a terrain's stance from the shared mode and grain, so a mismatch
was structurally impossible. The other **hand-listed** nine cells as a
fixed table, written down by a person rather than derived from the
underlying axes. Checked against the coherent version's own rule, five of
those nine hand-listed cells turned out to be exactly the kind of
contradiction described above — grain named one way by the terrain half of
the label, and a different way by the stance half. One of the five was
`SEG · Field · Dissecting`: `Field` is a Ground-grain terrain, but
`Dissecting` is a Figure-grain stance. Written down and used as though it
were one coherent act, that label was quietly asserting two different
things about which grain the act belonged to.

Nobody caught this by feeling — it's the kind of mismatch that reads
perfectly plausibly in prose. It was caught because there's an actual rule
(operator + terrain fixes the stance, no exceptions) that a hand-written
list can violate without anyone noticing until it's checked mechanically
against that rule. That's the entire value of "over-determination" — naming
grain twice isn't redundant bookkeeping, it's what makes a bad label
*catchable* instead of merely sounding a little off.

## What this rules out, and what it doesn't resolve

This isn't presented in the source material as a tidy, fully-closed case.
One of the five contradictory hand-listed cells was the project's own name
for a specific, real design idea it cared about — and the source material
records, honestly, that this is *still unresolved*: either the hand-list
was reaching for something true that the coherent algebra hasn't caught up
to yet, or the hand-list's intuition was simply wrong. Both are live
possibilities, and the record refuses to pretend otherwise.

What the whole episode does settle, though, is the discipline itself: a
cube used to *classify* real content by deriving its cell from what's
actually written was measured directly and refuted — shuffling the words
inside thousands of real paragraphs left the vast majority of cell
assignments completely unchanged, which means the assignment was tracking
something other than the content's actual meaning. So the cube is never
used that way here. It's used the way you've used it these last four
chapters: as an instrument builders hold a proposed idea up against, to
check whether it's internally coherent — never as a machine that looks at
real material and decides what category it belongs to.

**Where this comes from:** the coherence rule and the worked contradiction
are both from `eoreader6/CUBE.md`. The over-determination principle is
lines 50-53: *"Terrain and stance both carry grain, so grain is claimed
twice — and that redundancy is the whole point. Over-determination is what
makes an address falsifiable."* The `eoreader5` contradiction, including
`SEG · Field · Dissecting` and the four other mismatched cells, and the
still-unresolved status of one of them, is "A known contradiction in the
prior engine," lines 148-166. The cube's own refutation as a content
classifier is lines 10-14.
