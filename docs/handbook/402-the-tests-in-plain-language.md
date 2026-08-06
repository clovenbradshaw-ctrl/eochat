# 4.2 — The Tests, in Plain Language

**Why this matters:** Chapter 4.1 told you every claim gets sorted into one
of four boxes. This chapter is about the actual checklist used to do the
sorting — a real, named sequence of questions, each one closing off a
specific way a claim could sneak into the wrong box. Knowing them by their
plain-language versions means you'll recognize the same move in later
chapters even when nobody spells out which numbered test it is.

## The order itself matters

The checklist is asked in a fixed order, and the order is the point:
**is this a gift someone has to name? Then is it something only an
application would know? Then, whatever's left over, is engine.** A claim
gets routed by the *first* question that actually answers it, not by
whichever one seems most interesting.

## Would a symphony have this problem?

This is the first check, and it's a filter against mechanisms that secretly
only make sense for one medium. If a proposed piece of the engine only
works because it can see a specific word, a specific text surface, a
specific language's grammar, ask whether the same underlying problem shows
up somewhere with none of that — a symphony has no words, no subjects, no
verbs, and if the *same* structural problem the mechanism claims to solve
would still show up there, then the mechanism has to be about something
more general than words. If it wouldn't, the mechanism was never general
to begin with.

## Who gave you that?

Chapter 3.2's whole chapter, restated as a routing question. Knowledge
about the specific material being read — who a name actually refers to,
what a specific fact means — is a gift, and it has to be received with a
named giver, not derived as though the engine had figured it out on its
own.

## What does the answer look like where getting it right is actually rewarded?

This is the check against building something too narrow. A mechanism that
only fixes one specific problem, in one specific case, is treated as a debt
to be paid off later, not a real piece of the engine — unless it's the
general shape that keeps showing up wherever getting the underlying problem
right is actually rewarded. Chapter 1.1's *E. coli* comparison is this test
in miniature: a bacterium re-comparing against a rebuilt baseline is the
same shape you'd find in a community re-discovering a handful of general
principles rather than one rule per situation. If a mechanism doesn't
generalize the way that comparison does, it hasn't earned a place in the
measurement — it's a patch.

## Does this build a nothing, or lean on what's already there?

Chapter 0.4's whole argument, as a formal check. A mechanism that forms its
output as a weighted mix of what's already present — rather than measuring
against a freshly rebuilt ground — is refused outright, wherever it would
be doing the actual measuring. This is stated as an absolute veto, not a
preference: the canonical example named directly is the mechanism ordinary
language models use to blend everything they've seen into one answer.

## Did anything actually move, or did something just look unusual?

A companion to the test above, and a subtler trap. Something can be
statistically rare, acoustically odd, or visually novel without that
oddity ever *mattering* — Chapter 1.2 already drew this exact line for you.
This test makes sure a mechanism doesn't quietly substitute "this looked
strange" for "this actually revised what the reader now believes." A cheap
way of flagging something odd is fine as a nomination — it's a problem the
moment it gets treated as the verdict itself.

## Does the null actually match the question being asked?

When you build a comparison baseline to test something against, that
baseline has to differ from the real observation in exactly one respect —
the one thing you're actually testing — and nothing else. A comparison that
quietly changes more than that one axis isn't a stricter test. It's a
different question wearing the original one's clothes, and it fails
invisibly rather than loudly, which is exactly what makes it dangerous.

## Is medium-independence measured, or just claimed?

Saying a mechanism works "regardless of medium" is not the same as
actually having tested it against more than one medium and shown it holds
up. This test refuses the difference between an assertion and a checked
fact — a mechanism only earns "engine" status here once an actual
cross-medium check has been run, not merely proposed.

## Does this only work with a datacenter behind it?

The last test in this set is about honesty about resources. A mechanism
whose correctness secretly depends on far more computing power than a
single ordinary machine actually has doesn't get to count as part of the
measurement, no matter how well it performs somewhere it was never
supposed to have to run. If the check itself can't be run on the same
machine doing the reading, it isn't a real check — it's a claim about a
machine that doesn't exist for this project's purposes.

**Where this comes from:** all eight tests are Article II of
`eo-constitution/CONSTITUTION.md` — the omnimodal test (II.1), the giver
test (II.2), the convergence test (II.7), the difference test (II.8, *"Does
this mechanism build a nothing, or weight what is present?"*), the revision
test (II.9, *"Does this mechanism measure a property of the arrival, or a
revision of the reader?"*), the commensurability test (II.10), the
omnimodal earning test (II.11), and the local test (II.12). The routing
order itself is Article II's opening line: *"Ask in this order. Prior? →
App? → what remains is engine."*
