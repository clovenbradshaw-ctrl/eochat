# 3.6 — How the Engine Is Allowed to Grow

**Why this matters:** everything you've read so far describes the engine as
it stands. This chapter is about how it's allowed to change — and the rule
turns out to be strict enough that it has refused the project's own best
result at least once. Watching that happen, and watching a second, still-
unfinished case in progress, is worth more than any description of the
rule in the abstract.

## The rule

**An organ joins the engine only when a formal test says it clearly
outperforms the existing baseline.** Landing in between — no better, or
genuinely unclear — means it waits. And here's the part with real teeth:
**a module that nothing in the engine actually depends on isn't "early." It
is refused**, on the same footing as something that was tried and failed
outright. Nothing gets carried over from an earlier version of this project
just because it worked there. Every organ re-earns its place here, or it
doesn't come — including the ones that were already good.

## Case one, closed: a careful refusal that caught its own mistake first

A script proposed several candidate detection methods for turbulence data —
new pairings of an existing statistic with an existing way of scrambling
the data for comparison. Before testing any of them against real material,
the script ran a **negative control**: the same candidates, against pure
noise that should show nothing. That control caught a real bug immediately
— several candidates were manufacturing positive results on noise alone,
traced to a fallback path that had been quietly substituting a fixed
resolution limit for an actual statistical comparison. The bug was fixed,
and only then did the real test run: all seven candidates, checked against
actual turbulence data, were refused on a straightforward majority vote.
None of them earned a place.

The story doesn't end at "refused," though. Digging into *why* three of the
seven were refused turned up something more interesting than the headline
result: it wasn't that the candidates were bad. It was that the baseline
comparison method they were being measured against — scrambling the data —
turns out to be measurably unable to represent how extreme a real, spatially
coherent burst gets, on the majority of the material tested. That's a
finding about the *yardstick*, surfaced only because the growth rule
insisted on asking "why" before accepting a refusal at face value, instead
of stopping at the vote.

## Case two, open: watching the rule apply in real time

A second, current line of work is tackling a much older problem: telling
apart *who did what to whom* in a sentence when the grammatical position of
a word doesn't reliably tell you its actual role (you'll meet the person
who named this problem, fifty-eight years ago, properly in Part VI.2). The
first real attempt used the most obvious approach — a fixed grammatical
pattern, subject-verb-object — and it was tested directly against
real, independently-judged text. It lost 87% of what human-style judgment
said was actually there. Not a rough edge: a wrong-in-the-way-Fillmore-
predicted failure, measured rather than assumed.

The fix that actually worked changed the *order* the clustering happens in.
Every earlier attempt had pooled candidate words across every verb it found
before ever clustering — asking, from the very start, for a general pattern
across the whole vocabulary. The successful version instead clustered each
verb's own typical company **separately**, one verb at a time, before ever
pooling anything across verbs. That reordering is explicitly borrowed —
this is the point where this book needs to be precise about what "borrowed"
actually means. The engine's own working notes cite research on how
children actually acquire language, which found that children build
narrow, per-verb frames — a separate sense of "who cuts what" and "who
draws what" — long before they generalize anything across verbs at all.
**What was borrowed is the strategy — cluster narrow before you pool wide —
not a model of child language acquisition itself.** Nothing here simulates
how a child learns to talk. The engine took one specific, checkable finding
from that research and used it to decide what order to ask its own,
unrelated clustering question in, then tested whether that reordering
actually helped its own real data. It did: nearly every single-verb cluster
that had failed when pooled succeeded once isolated.

A second technique, used to find candidate word-groups in the first place,
borrows in the same precise way from a completely different body of
research: work on how infants segment continuous, spoken speech into
word-like chunks with no grammar and no labels at all, using nothing but
where the statistical likelihood of "what comes next" dips. Applied here to
written text instead of an infant's ear, the same signature — a local dip
in that likelihood — is used to mark where one candidate chunk ends and
the next begins, replacing a fixed-width window that had been cutting
chunks arbitrarily. Again: the borrowed thing is a *statistical signature*
that turned out to transfer, not a claim that reading text and acquiring
spoken language are the same process.

A separate citation in this same body of work is worth naming for contrast,
because it's a different *kind* of borrowing than either of the two above.
Before running the clustering at all, the working notes cite a documented,
predicted limit of pure distributional clustering — that it groups things
by whether they're substitutable in a sentence, not by what they actually
are, and will happily lump people, horses, and cities into one bin without
something else supplying the boundary. That citation isn't inspiration for
a mechanism. It's a warning, checked against, used to explain a limitation
the engine's own results were already showing.

The result, so far: a cross-lingual test found that the clustering method
itself reaches real structure at similar rates across English, French,
German, and Finnish — the part doing the actual clustering isn't
language-specific. What *is* language-specific, and breaks predictably in
German, is the earlier step that spots candidate words in the first place —
a genuine mouth-versus-organ split, not a uniform success or a uniform
failure.

**What this second case is not, yet.** The whole arc is explicitly marked,
in its own working files, as **experimental and unwired** — sitting in a
scripts-and-experiments folder, not inside the engine itself, exactly where
the growth rule says anything not yet re-earned belongs. And the honest
ceiling is stated plainly rather than smoothed over: what's been found so
far is two unlabeled, position-shaped clusters per verb — not yet the
actual named roles (agent, instrument, and so on) the fifty-eight-year-old
objection was really about. Real progress, clearly short of the goal,
stated as one sentence rather than two different impressions.

**Where this comes from:** the growth rule itself is `eoreader6/SEED.md`,
"The growth rule" — *"An organ joins only when the level test returns
`above` against the core... Unwired is failing."* The turbulence case is
Amendments XIV and XV in the same file. The role-fold arc is drawn from
`eoreader6/scripts/experiments/README.md` and `FINDINGS.md` (PRs #44–48):
the 87% recall-loss figure and its source golden (`goldens/agency-civic/`,
PR #44); the verb-island reordering and its citation of Tomasello's
usage-based acquisition research (`role-fold-verb-island.mjs`, README.md);
the transitional-probability chunking and its citation of Saffran, Aslin &
Newport's infant speech-segmentation work (`role-fold-tp-chunk.mjs`,
README.md); the citation of Mintz (2003) on the limits of pure
distributional clustering; the cross-lingual result (PR #48, "the mouth is
language-specific by construction, the organ isn't"); and the explicit
"EXPERIMENTAL. Unwired. Not a golden, not a certified organ" status note at
the top of README.md.
