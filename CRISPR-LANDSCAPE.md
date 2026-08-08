# CRISPR, checked against what already ships — a follow-up

This assumes `CRISPR.md` — the CRISPR-Cas9 mapping, the organ/kind theory,
the pipeline, the license-and-provenance gate. It doesn't re-explain any of
that. What it does instead: take the two pieces that actually got built —
`search_prior_art` (npm + this repo's own organ registry) and
`searchAppArchetype` (GitHub, star-gated, standalone, unwired) — and ask a
question CRISPR.md's own research-literature pass in §2 couldn't answer:
does the wider *market*, not just the research literature, already do this,
and does it do it better?

The short answer is uncomfortable in a useful way. Almost every piece of
CRISPR already exists somewhere. Where it competes head-on with something
that ships at scale, the market's own choices argue against the half of
CRISPR that got built most recently.

## The market didn't build a search engine — it built a library

Three products currently define "describe an app, get an app": v0.app,
Bolt.new, and Lovable. None of them, per their own public descriptions,
search a live code corpus and adapt whatever they find. v0.app generates in
one fixed, curated idiom — shadcn/ui components, Tailwind, Next.js,
specifically — rather than reaching for whatever styling convention a
matched GitHub repo happens to use. Bolt ships a small number of
hand-authored starter templates for known shapes (landing pages, SaaS,
dashboards) rather than searching for one. Lovable's own materials describe
"templates" as a curated starting foundation, not a retrieval result.

That omission, from three well-funded, heavily-used products that all face
the exact same underlying problem CRISPR is trying to solve, is itself
evidence. A curated in-house library beat live web-scale retrieval as the
industry's converged answer, and the reason isn't hard to reconstruct: it
sidesteps the license and attribution exposure CRISPR.md's §3 already
treats as a hard gate, and it gives consistent quality that a scavenged
clone repository — someone's weekend project, abandoned at 200 stars,
written to no particular standard — cannot promise. Searching the wild
internet for a matching implementation is not a mechanism the market
rejected out of ignorance. It looks more like a mechanism the market tried
the easy version of and moved past.

## The one real precedent for archetype-selection already retired itself

Wix ADI is the closest thing that exists to what `searchAppArchetype` is
reaching for: ask a few questions about what kind of thing this is, select
a matching template, customize it, done. It is a real, deployed,
multi-year-run system built on exactly the premise CRISPR.md's cube theory
formalizes — that "kind" can be recognized and mapped to an existing
implementation mechanically. It has also already been discontinued, folded
into "Wix AI Website Builder." The company that pioneered pure
archetype-to-template selection judged it insufficient on its own merits
and moved toward more generative methods. That's not proof the mechanism is
wrong — Wix ADI never had kind induction in CRISPR's sense; it had a
questionnaire, answered by a human, not a model recognizing anything. But
it is a real data point that archetype-selection alone, without generation
underneath it, hit a ceiling in production.

## The academic ground under this is real, but it's the wrong grain

Retrieval-augmented code generation is not speculative — RepoCoder and the
broader survey literature on repository-level retrieval are validated,
working research, and RepoCoder specifically improves on non-retrieval
completion baselines by a real, measured margin. This is genuine support
for CRISPR's pipeline, but it supports stages 3 and 4 — component and
utility-grain reuse, the same grain as the LRU-cache test that actually
worked — not `searchAppArchetype`'s whole-application grain. Every RACG
paper checked retrieves similar code *within the same repository* to
complete the file currently being written. None of it retrieves an entire
external application to clone. The "reddit clone" test sits genuinely
outside what this literature has tested, for better or worse: there may be
no academic ground under that half of the theory at all yet, just the four
manually-validated queries in `crispr-search.mjs`'s own header comment.

## A different tool already solves "make it look like X" more directly

Screenshot-to-code is not a variant of CRISPR — it's a different paradigm
answering a similar-sounding request. Instead of inducing a kind from a
text description and searching for source code that matches it, it
perceives the *actual target's appearance* — a screenshot, a URL — and
generates matching code from a vision model. There is no kind induction
step, no search step, no provenance question, because nothing is retrieved
or reused; only observed. If "build a website that looks like Reddit" is
ever meant literally — pixel layout, not feature set — this sidesteps
CRISPR's entire mechanism and may simply be the more honest tool for that
specific framing.

This is worth taking seriously rather than dismissing as a different
product category, because eoreader's own architecture already has the
shape for it and is missing exactly this piece. `content-index.js`'s
`ENTITY_NAMES` names real, working perceivers for text, audio, and video
(`perceiver/text`, `perceiver/audio`, `perceiver/video`). It has nothing for
a live webpage or a screenshot. A visual perceiver would not be a bolt-on
feature borrowed from a competing paradigm — it would be the same
architecture this whole project already commits to (perceive a modality,
extract structure, fold it) applied to a fourth modality it currently
can't touch at all. That's a concrete, differentiated unlock CRISPR's own
search-and-splice theory does not provide and was never going to.

## The two generator ecosystems that already tried this are both declining

Yeoman and Cookiecutter confirm that "organs as generators" — named,
reusable units that produce a standardized thing — is not new. It is
roughly a fifteen-year-old product category, and its own community's
retrospective on where it ended up is blunt: "Yeoman and Cookiecutter are
dead; long live Copier." The specific failure mode matters more than the
verdict itself: a hand-authored, hand-registered library of generators
needs continuous human curation to stay current, and when that curation
lapses, the registry doesn't fail loudly — it just quietly stops matching
what people are actually building, until someone notices it's been dead for
years. `content-index.js`'s `ENTITY_NAMES` is exactly this kind of
hand-maintained registry today. If CRISPR's kind induction actually works —
if the registry can grow and reorganize itself from what eoCode
successfully verifies, rather than waiting on a person to add an entry —
that is the one structural difference that would keep this from following
Yeoman's and Cookiecutter's exact trajectory. If kind induction turns out
not to work well enough for that, this ends up as a slower-built version of
a tool the ecosystem already tried twice and retired.

## What's left that's actually new

Strip out everything the market and the literature already do better or
equally well, and three things remain that nothing surveyed here has, in
combination:

- **Automatic kind induction.** Every archetype-recognition system checked
  — Wix ADI most directly — puts a human in that seat. Nothing here asks a
  model to recognize what kind of thing is being requested and act on that
  recognition without being told in advance what the categories are.
- **A checked coordinate space for what got matched.** The cube gives a
  fixed, mechanical way to confirm a candidate actually occupies the same
  address as the task, rather than trusting a similarity score. None of
  the retrieval systems surveyed have an equivalent structural check
  independent of the retrieval mechanism itself.
- **Provenance as a law, not a feature.** `LAWS.md`'s L2, extended to
  borrowed code: every reuse — successful or refused — is retained,
  unconditionally. This is a discipline choice, not a technical one, and
  none of the commercial builders publish anything like it.

None of that is "search GitHub before you code." That specific piece — the
one built most recently, tested honestly, and kept deliberately unwired —
is the piece the market has already tried adjacent versions of and moved
past. The parts of CRISPR worth continuing to invest in are the ones nobody
else surveyed here is actually doing.

## What this changes about the roadmap

`CRISPR.md`'s original recommended first step — local registry, then
package registry, in front of hand-coding — was built and validated before
this check happened, and nothing here argues against it; it works at
exactly the grain the research literature (RACG, RepoCoder) supports. What
this check does argue against is treating external search as the mechanism
to keep expanding. The next real investment is the Retain step: turning
every verified splice and every genuinely novel hand-coded solution into a
permanent, license-clean entry in eoCode's own organ registry, so external
search — npm, GitHub, eventually Software Heritage — stays what every
product surveyed here actually uses it for: a cold-start fallback for a
kind nobody here has ever solved before, not the steady-state answer to
"don't build the same thing twice."

## Sources

- [Lovable vs Bolt vs v0: AI app builder comparison, 2026](https://particula.tech/blog/lovable-vs-bolt-vs-v0-ai-app-builders)
- [The evolution from Wix ADI to Wix Harmony](https://www.wix.com/blog/wix-artificial-design-intelligence)
- [Retrieval-Augmented Code Generation: A Survey with Focus on Repository-Level Approaches (arXiv:2510.04905)](https://arxiv.org/abs/2510.04905)
- [RepoCoder: Repository-Level Code Completion Through Iterative Retrieval and Generation](https://openreview.net/forum?id=q09vTY1Cqh)
- [screenshot-to-code (open source)](https://github.com/abi/screenshot-to-code)
- [Yeoman and Cookiecutter are dead; long live Copier!](https://recallstack.gitlab.io/en/2020/04/18/yeoman-and-cookiecutter-are-dead-long-live-copier/)
- [Doe v. GitHub, Microsoft, and OpenAI — Wikipedia](https://en.wikipedia.org/wiki/Doe_v._GitHub,_Microsoft,_and_OpenAI)
