# 4.4 — One Amendment, Start to Finish

**Why this matters:** the last three chapters described the constitution's
amendment machinery from above. This chapter walks one real amendment all
the way through it, so the abstract rules from 4.3 land as something that
actually happened to actual words in an actual file.

## A note on where this example actually lives

One honest correction before starting: the clearest, most self-contained
worked amendment in this whole project isn't recorded inside
`CONSTITUTION.md` itself — it's recorded inside `SEED.md`, the engine's own
governing document. That's not a mismatch worth glossing over. Recall
Chapter 4.1's four boxes: the engine is its own domain, governed by the
constitution's rules but keeping its own amendment log for changes specific
to what it measures. So this chapter is really showing you Chapter 4.3's
machinery at work one level down — the same discipline, the same "an
amendment is a changed test, not a change of heart," applied inside a
sibling document rather than the constitution itself.

## What the number used to be, and why it changed

A single measurement in the engine — the spread of a freshly-rebuilt
ground's own samples, used as a running vital sign (you met it properly in
Chapter 1.5) — used to be called `ananda`. That word means bliss. And the
amendment that renamed it doesn't quarrel with the *math* at all: the
measurement itself, what it computed, how it was calculated, is stated
plainly to be exactly the same before and after. What changed was only the
name.

## Why a name change counts as a real amendment at all

Here's the part worth sitting with. Chapter 4.3 said an amendment has to
correspond to a changed test, not just a change of heart. A rename sounds
like the purest possible example of "just a change of heart" — nothing
computational shifted. But the amendment's own argument is that the *name*
was itself making a claim, separate from the number underneath it: calling
a plain interquartile-width measurement "bliss" asserted, every time
someone read the code, that the number told you something about the
system's actual state — as though a wide, healthy-looking reading meant
the system was, in some real sense, content. Nothing about the measurement
had ever established that. So the fix wasn't cosmetic. It was correcting an
overclaim that had been quietly riding along on a variable name, for
exactly as long as nobody thought to ask whether the name was earning its
keep.

## What happened, concretely

The identifier was changed everywhere it appeared — well over two hundred
occurrences across dozens of files, including the script that runs the
measurement — to `aperture`, a word that names an opening and asserts
nothing about a state. The old name wasn't deleted from the record; the
amendment itself preserves it, dated, with the reason attached, exactly the
discipline Chapter 4.3 described. And the amendment goes further than
fixing its own one case — it states the rule this generalizes to, so the
next person naming a new measurement has something to check against:
*ancestors may be cited in a comment; they may not name a quantity.* You're
allowed to write, in a header, that an idea traces back to a particular
thinker or a particular field. You are not allowed to let a variable's own
name assert more than the number underneath it has actually earned.

## What didn't change, stated plainly

The amendment is careful to record what this rename does *not* touch. The
underlying math: unchanged. The system's actual test results: identical
before and after, down to the same two pre-existing failures. Even one
piece of older prose that had used the old word to mean something else
entirely — describing the reach of the present, a completely different
concept — got tracked down and corrected separately, so the same word
wouldn't quietly mean two different things in two different places. Nothing
about this was treated as too small to bother getting exactly right.

**Where this comes from:** `eoreader6/SEED.md`, Amendment XVII, "A
quantity's name is a claim about what it is" — *"`ananda` is now `aperture`,
everywhere: 252 occurrences across 36 files... The measurement did not
change... Ananda means bliss. The identifier therefore asserted that an
interquartile width is a state of the system, and no null in this repo
establishes that... Ancestors may be cited in comments. They may not name
quantities."* The preserved old name is recorded in "The sign of health,"
the section the amendment corrects: *"This quantity was called `ananda`
until 2026-08-04. The name is superseded, not erased."*
