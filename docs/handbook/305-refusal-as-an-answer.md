# 3.5 — Refusal as an Answer

**Why this matters:** most systems treat "I don't know" as a failure to
hide or smooth over. This chapter is about why this system treats a
refusal as a real, countable, typed piece of output — a result, not an
absence of one — and why that design choice is one of the most load-bearing
in the whole project.

## A gap is a result

Chapter 1.3 already told you the system may perceive more than it says.
This chapter names what happens to everything that doesn't clear the
witness gate: it doesn't vanish silently. It becomes a **gap**, and gaps
come with a *type* — a specific, named reason the refusal happened, not a
generic shrug.

Three real gap types, and what each one actually means in plain terms:

- **`degenerate_ground`** — the freshly-built comparison baseline itself
  came out too thin or too uniform to compare anything against
  meaningfully. Not "no answer was found" — "there wasn't a real ground to
  measure against in the first place."
- **`exceeds_witness`** — something genuinely stood out, more than the
  system's resolution can even place precisely. The size of the standout is
  real and reportable; exactly *where* within that range it falls is not.
  This is worth sitting with, because it's a report of "too much," not "not
  enough" — a gap that names an excess is a different fact than a gap that
  names an absence, and this system is careful never to blur the two.
- **`unreceived_origin`** — a claim depended on a starting point that was
  never actually handed in with a named giver, the way Chapter 3.2 requires.
  The system refuses to quietly assume one just to keep going.

## Watching it happen in a real answer

Chapter 3.1's Frankenstein reading gave you this in action, and it's worth
looking at again with this chapter's vocabulary. The answer's own "What
this leaves out" section reported that one retrieved passage was dropped
because "90% of its content words were not carried by its evidence" — a
witness-gate refusal, reported by name, on a whole candidate passage rather
than a single fact. It also reported that thirteen matched passages
"exceeded the fold budget and were dropped, not truncated" — a different,
explicitly distinguished kind of gap: not "this failed a check," but "there
was more than the space available, and rather than quietly trimming it
down to fit, the system is telling you it was left out whole."

That distinction — dropped whole versus truncated — is itself the same
discipline as the three gap types above, applied to a resource limit
instead of an evidence check: **not printed, rather than printed
unsupported.** A system willing to trim things silently to fit a budget is
making a choice that looks identical to running out of room, from the
outside, right up until it quietly starts asserting things it never
checked. This system refuses that shortcut by naming the limit instead of
hiding it.

## Two tiers of refusal, and why the order matters

There's a strict pecking order to how a refusal happens, and it's meant to
save the system from wasting effort on the wrong kind of check: **a type
error is caught before a null ever gets built.** If a claim is simply
malformed or nonsensical on its face — the kind of thing basic bookkeeping
already catches — the system refuses it right there, without ever spending
a real, expensive measurement on checking whether it's *also* backed by
evidence. Measurement is reserved for claims that are at least well-formed
enough to be worth measuring. Never spend a measurement on what the algebra
already caught for free.

**Where this comes from:** the three gap types are named in `eoreader6/
CUBE.md`, lines 95-97, as "this same act at different grains, not three
unrelated failure modes." The two-tier refusal rule ("type error before
null... never spend a measurement on what the algebra catches") is
`eoreader6/SEED.md`, "What follows," clause 7. The worked example is
`eochat/essay.md`, "What this leaves out" — including the exact phrase "not
printed rather than printed unsupported."
