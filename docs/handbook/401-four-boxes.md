# 4.1 — Four Boxes

**Why this matters:** Part III showed you an engine that measures things
very carefully and refuses to speak past its evidence. This chapter is
about why that engine is kept so deliberately narrow — and where everything
it *doesn't* do is supposed to live instead.

## Every claim gets sorted into exactly one of four places

This whole project — the engine (Part III), the priors it receives (Chapter
3.2), and the chat application that puts it in front of a reader (Part V) —
is governed by one document that decides, for any given piece of behavior,
which of exactly four places it belongs:

- **The engine.** This is the measurement itself — the current, continually
  re-earned implementation of everything Part I and Part III described. It
  is deliberately built to have no clock, no ability to read or write
  files, no randomness it doesn't declare, and no memory of any specific
  text. Anything that would only make sense for one particular deployment,
  or one particular piece of material, doesn't belong here.
- **Priors.** This is the ground, in the sense Chapter 3.2 already gave
  you: knowledge that cannot be measured and has to be received instead,
  always with a named giver.
- **Applications.** These are the thin, surface-level programs a reader
  actually touches — a chat interface, a proxy, anything with a user
  interface. This is where the clock lives, where files get read and
  written, where a specific model gets called. The governing rule for this
  box is stated as a direct test: **deleting an application must change no
  engine reading.** If removing the chat interface entirely would somehow
  alter what the engine measures, something has leaked across the wall
  that isn't supposed to exist.
- **Legacy.** Earlier versions of this project, kept as a frozen historical
  record rather than a living codebase. Nothing gets carried over from
  legacy just because it worked there — every organ has to re-earn its
  place in the current engine, from scratch, on its own evidence. The
  record of what was tried and failed in legacy is treated as just as
  load-bearing as anything that succeeded.

## Why keep the engine so deliberately empty

It would be more convenient, in the short term, for the engine to just know
things — to cache a fact about a specific book, or adjust its behavior
based on which application is calling it. The reason it doesn't is the same
reason Chapter 0.4 gave for distrusting a language model that blends
"what's in the document" with "what it already knew" into one
inseparable mechanism: the moment the engine starts absorbing anything
specific to one text or one deployment, there's no longer a clean way to
ask what the measurement itself actually established, independent of where
it happened to run or what it happened to be reading. Keeping the box
empty is what keeps the measurement checkable at all.

## What doesn't fit any of the four boxes

The rule for anything that doesn't cleanly land in one of the four is
blunt: **it's a gap, not a fifth category.** The four boxes aren't a menu
of convenient options to pick from — they're presented as the necessary
consequence of what this whole project is actually trying to measure, so a
thing that fits none of them hasn't discovered a new kind of component. It
has surfaced something nobody has figured out how to place yet, and that
gets treated as an open question, not quietly filed away as its own new
box.

**Where this comes from:** `eo-constitution/CONSTITUTION.md`, Article I,
"The domain" — I.1 through I.5, including *"The engine is `eoreader6`...
the current, re-earned implementation of the one operation"*; I.2 on
legacy, *"Their dead-end logs are load-bearing and must be trusted... every
organ is re-earned in eoreader6 or it does not come"*; I.4 on applications,
*"Deleting an application must change no engine reading"*; and I.5, *"No
other domain exists. A thing that fits none of the four is a gap, not a new
category."*
