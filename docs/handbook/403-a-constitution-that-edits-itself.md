# 4.3 — A Constitution That Edits Itself

**Why this matters:** every rule in Chapter 4.2 is written in a document
that explicitly allows itself to be changed. This chapter is about how that
change actually happens — because "we can edit our own rules" is easy to
say and easy to abuse, and this project has a specific, narrow mechanism
for doing it that's designed to make abuse hard.

## A rule can only change by breaking a test, on purpose, in the same breath

Here's the load-bearing constraint: **an amendment has to be expressible as
a test that used to pass and now fails, changed in the very same edit that
changes the rule.** If a proposed change to the rules can't be pinned to an
actual test flipping from green to red, it isn't an amendment — it's just
an exception, and this project doesn't have a category for those. This
keeps a change from being merely a change of heart in prose. It has to
correspond to something a machine can check.

## Agents propose. A human decides.

Whoever — or whatever — drafts a proposed amendment, the actual decision to
adopt it is reserved, explicitly, for a human. A draft can sit in the
repository, fully written out in the same format as an adopted rule,
without being in force yet — and the source material is careful to mark
that difference on the document itself rather than trust context to carry
it. A drafted-but-not-yet-decided proposal says so, plainly, at the top:
not applied, not yet reviewed. Only once a human actually disposes of it
does it take effect.

## Nothing gets renumbered to hide a gap

Amendments are numbered in the order they actually change a test — not in
the order someone thought them up, and not re-numbered later to close a
gap. If the tenth proposed amendment stalls — drafted, but never
adopted — the eleventh keeps its own number rather than sliding down to
fill the hole. The gap stays visible on purpose: a missing amendment number
is itself a small, honest record that something was proposed and hasn't
been decided, rather than smoothed over so the sequence looks unbroken.

## Old text is corrected, not rewritten

When a rule turns out to have been wrong or incomplete, the fix is
recorded as an amendment *to* the original clause — the original wording
stays on the page, and the amendment says plainly what it changes and why.
This project draws that same distinction everywhere, not only in its own
governing document: a measurement whose name overstated what it had
actually earned wasn't quietly renamed and forgotten — the old name is
still on the record, dated, next to the reason it no longer applies. A
document that corrects itself by deleting the mistake isn't actually
keeping a history of being wrong. It's just hiding one.

## An honest tension, worth naming rather than smoothing over

This book's own rule — never hide a gap — applies to what this chapter just
told you. Several amendments in this project's own log are written up with
the same confident, settled-sounding language as amendments that have
already taken effect, complete with exactly which parts of the codebase
they changed. But the standalone proposal documents for some of those same
amendments say, plainly, at the top: *draft proposal, not applied, not yet
human-reviewed.* Both things are true at once, in the same repository, and
this book isn't going to pretend the tension isn't there. Reading a
polished amendment entry as settled fact, without checking whether its own
proposal file still calls itself a draft, is exactly the kind of mistake
this whole project's discipline is built to catch — which makes it worth
naming here as a live example, not just an abstract risk.

**Where this comes from:** `eo-constitution/CONSTITUTION.md`, Article IV,
"Amendment" — IV.1 (*"An amendment... that cannot be expressed as a changed
failing test is not an amendment, it is an exception"*), IV.2 (*"Agents
propose, humans dispose"*), and IV.6 (*"Amendments are numbered in the
order they change the test"*), together with the closing footnote
preserving the tenth amendment's number even though it "remains a draft
proposal... and is not entered here." The renaming discipline is
`eoreader6/SEED.md`, Amendment XVII (*"The name is superseded, not
erased"*). The draft-vs-applied tension is visible by comparing
`CONSTITUTION.md`'s own amendment log (lines 333-359) against
`AMENDMENT-8-PROPOSAL.md`, `AMENDMENT-9-PROPOSAL.md`, and
`AMENDMENT-11-PROPOSAL.md`, each headed *"Status: DRAFT PROPOSAL. Not
applied, not yet human-reviewed."*
