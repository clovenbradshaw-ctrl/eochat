# 3.4 — Turns and Memory

**Why this matters:** Chapter 1.1 said a ground gets rebuilt fresh every
time — never kept as a permanent fixture. So how does this system have a
conversation at all, across separate turns, without either dragging along
a pile of everything that ever happened, or forgetting everything the
moment a turn ends? This chapter is the answer, and it's a genuinely small
one.

## Not a history. A single handoff.

When one turn of reading finishes, it doesn't hand the next turn a
transcript of everything that happened. It hands over one small thing,
called a **register**: essentially, the closing warmth of the ground it
ended with, plus the specific choice of comparison method it used to get
there. The next turn opens with exactly that — not a summary, not a log,
just the same small package a fresh ground would need to pick up where the
last one left off, by identity, the same way one region inside a single
reading already opens with the region right before it.

That's the entire mechanism. No accumulating pile of history to re-read, no
growing burden as a conversation goes on. Just a small, constant-sized
object passed from one turn to the next.

## What this earns, and what it still can't promise

Because turns now hand off a register, the system can tell the difference
between a turn that's a genuine continuation and one that's opening cold —
a turn that received nothing simply says so, rather than quietly pretending
to be a continuation it isn't. That's a real, earned guarantee: *this*
engine now holds a sequence, locally, at the boundary between one turn and
the next.

What it still can't do is vouch for the thing one level up: whether this
was truly the very first reading anyone ever did, with nothing coming
before it at all. The engine has no way to know that a caller didn't
already read something earlier through some other channel entirely — that
question belongs to whoever's actually running the sequence of turns, not
to the engine measuring any one of them. This isn't a loose end left
lying around by accident. It's the same discipline from Chapter 3.2, run
on the conversation itself: the engine will tell you honestly what it can
verify about its own sequence, and will not quietly claim more than that.

## Why this avoids Chapter 3.3's watching problem

You might notice this sounds close to `frame`'s job from the last chapter —
keeping a trail — and wonder if handing a register between turns is
secretly the same self-watching regress `frame` refused to build. It isn't,
and the reason is precise: the register is one single closing number plus
one declared choice, never a rollup of everything that happened. It doesn't
accumulate, and it never gets fed back into a ground it was itself computed
from. It's a handoff, not a growing ledger — which is exactly what keeps
this small enough to avoid becoming the regress `frame` already refused to
build.

**Where this comes from:** `eoreader6/SEED.md`, Amendment IX, "Firstness,
partially earned: the turn holds a sequence" — *"`runTurn` now receives a
`register`... and hands its own back, so the engine holds the sequence
locally at the turn boundary... What is still not earned is the enforcement
that a genuinely-first ground is *received* — the engine cannot know that
the caller read nothing before... The register is one closing scalar plus a
declared choice, never a rollup of the trail."*
