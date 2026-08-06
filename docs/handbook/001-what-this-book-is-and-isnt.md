# 0.1 — What This Book Is, and Isn't

**Why this matters:** if you come in expecting a developer manual or a product
brochure, every chapter after this one will feel like it's answering the wrong
question. This book has one job — to teach you what actually happens, in
plain language, when EO Reader 6 reads something and EO Chat shows it to
you — and it will not do the other two jobs instead.

## What this isn't

It isn't a guide to installing or operating anything. It isn't written to
persuade you these tools are good. It assumes nothing about your background:
not machine learning, not linguistics, not philosophy. If a word like
"model," "token," or "ontology" doesn't mean anything to you yet, that's the
expected starting point, not a gap you're supposed to fill in beforehand.

## What this is

This project — across the engine that does the reading (EO Reader 6), the
document that governs how it's allowed to change (the constitution), and the
application you actually talk to (EO Chat) — uses a set of words in a very
particular, load-bearing way: *ground*, *figure*, *pattern*, *witness*,
*terrain*, *stance*, *operator*, *organ*, *prior*, *growth rule*. These
aren't decoration. Whether the system says something or refuses to, and why,
comes down to those words having exact meanings.

This book's one goal is that by the end, you can use those words the way the
people who built this system use them — not just recognize them when you see
them again.

## Two examples, used again and again

Rather than invent a new illustration every chapter, this book leans on two
real artifacts, over and over, so you build one mental picture instead of
re-orienting constantly.

**The Frankenstein reading.** At some point, EO Chat was asked a plain
question — "What does Victor Frankenstein feel toward the creature he
made?" — and it gave a real, short, already-produced answer: one paragraph,
a citation with an exact location in the source text, and a section
explicitly listing what got left out and why. It's short enough to read in
full and rich enough to show you citations, gaps, and refusal all at once.
You'll meet it properly in Part III.

**Three ordinary places.** For ideas that have nothing specifically to do
with text — the shapes of *how* something can be looked at and *what* is
being looked at — this book uses three settings you already understand
without any technical background: a hospital ward, a neighborhood mutual-aid
map, and a reading group. You'll meet these properly in Part II.

## A device you'll see again: the two deaths

There are exactly two ways a system like this can fail, and this book names
them once, early, so it can just point back at them later instead of
re-explaining. One is **talking without evidence** — saying something that
sounds right but isn't actually backed by anything. The other is **no
longer being able to be surprised** — becoming so settled in its own view
that nothing new could ever change it. Chapter 1.4 introduces both properly;
after that, whenever a later chapter says a design choice exists "to guard
against the two deaths," you'll know exactly what it means.

## The promise this book is making you

Every chapter in this book follows the same six rules, and a chapter that
breaks one of them is a mistake in the book, not a stylistic choice:

1. **A word is explained before it's used.** Never the other way around.
2. **Plain language always comes before the precise version.** You get the
   everyday sentence first, the exact statement second.
3. **The same handful of examples get reused**, instead of a fresh one every
   time, so the ideas accumulate instead of resetting.
4. **A gap is never hidden.** Where the people who built this admit something
   isn't finished, or isn't proven, this book says so in the same place —
   because watching an honest "not yet" is one of the best ways to learn what
   a *real* claim looks like.
5. **Every chapter tells you why you should care before it tells you how
   something works.**
6. **Every chapter ends by pointing at exactly which real file it came
   from**, so nothing you read here has to be taken on faith — you can go
   check it.

**Where this comes from:** this chapter states the pedagogical contract set
out in `eochat/docs/handbook/HANDBOOK-SPEC.md` §3, and previews the running
examples decided in §5 (Example A: `eochat/essay.md`; Example B: the
domain-invariant triad from the `writing-code-in-eo` reference) and the two
deaths named in `eoreader6/SEED.md`, "The entelechy."
