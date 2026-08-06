# The EO Reader 6 / EO Chat Handbook

This directory is the handbook itself. `HANDBOOK-SPEC.md` is the outline and
the contract every chapter here follows — read it first if you haven't. This
file is the table of contents and a running status of what's actually
written.

## Status

Per §8 of the spec ("Suggested next step"), Part 0 and Part I are written in
full as the sample to review against the pedagogical contract (§3) before
the rest is generated. Nothing past Part I exists yet.

## Part 0 — Before You Start

- [0.1 What this book is and isn't](001-what-this-book-is-and-isnt.md)
- [0.2 A ten-minute grammar and meaning primer](002-grammar-and-meaning-primer.md)
- [0.3 A ten-minute ontology and epistemology primer](003-ontology-and-epistemology-primer.md)
- [0.4 What a language model is, in plain terms, and why this project keeps its distance from one](004-what-a-language-model-is.md)

## Part I — The One Idea Everything Is Built On

- [1.1 Noticing](101-noticing.md)
- [1.2 The difference that makes a difference](102-the-difference-that-makes-a-difference.md)
- [1.3 Witness](103-witness.md)
- [1.4 The two deaths](104-the-two-deaths.md)
- [1.5 Three numbers and a vital sign](105-three-numbers-and-a-vital-sign.md)

## Parts II–VIII — not yet written

See `HANDBOOK-SPEC.md` §6 for the planned content of every remaining part,
and §7 for the open questions (Q1–Q5) that should be revisited before
committing to the full ~35-chapter scope.

## Decisions made to produce this sample, provisionally

Writing even this much required taking a position on two of the five open
questions in the spec. Both are reversible — nothing below is meant to
foreclose the discussion the spec asked for:

- **Q1 (location):** chapters live here, in `eochat/docs/handbook/`, matching
  where the spec itself already sits.
- **Q3 (format):** one file per chapter, numbered `NNN-slug.md`, mirroring
  `eochat/instruction-set/`'s convention. The numbering leaves a block of ten
  per part (`0XX` for Part 0, `1XX` for Part I, and so on) so later insertions
  don't require renumbering existing chapters.

**Q2 (is Part VII in scope), Q4 (full ~35-chapter depth vs. Parts 0–III
first), and Q5 (how fast-moving citations like Part III.6 and Part VI.2
should be anchored and re-checked)** are untouched by this sample and still
need a decision before work continues past Part I.
