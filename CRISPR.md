# CRISPR — snip-and-splice organ synthesis for eoCode

**Status: proposal, unbuilt, unmeasured.** Nothing in this document has been
run. It is written in the same spirit as `CONSTITUTION-AND-LAWS-AMENDMENTS-
PROPOSED.md` — a testable design, not a finished feature — and it inherits
`ORGAN-STACK-REAL-DEPLOYMENT.md`'s discipline: real material before theory,
proxies validated against outcomes before trusted, findings reported at the
confidence they actually earned. Where this document asserts something as
already true, it is a fact about the existing codebase, cited to a file. Where
it proposes something new, it says so.

## 0. The gap this closes

`server/eocode-agent.js` already states the thesis plainly: eoCode is "an
interactive agentic-coding surface built on the SAME organs eval/agent/
already grew" — it does not reimplement tool use or the react loop, it reuses
them. The organs it reuses are hand-authored and hand-registered
(`server/content-index.js`'s `ENTITY_NAMES` map is a literal, hand-maintained
list). That is fine for the nine organs that already exist. It is not fine as
a standing policy: every task that falls outside those nine still gets
hand-coded from scratch, even if the exact same shape of task — the same
*kind* — was already solved five minutes ago, or was already solved years ago
by someone else and published.

The theory to test: eoreader's own machinery already recognizes that two
different surface mentions are "the same kind" without being told
(`entity-kinds induction`, `server/content-index.js:64`) and already has a
fixed, checkable coordinate space for what a piece of structure *is*
(`server/eo-cube.js`'s 27-cell operator/terrain/stance algebra). If that
recognition works on entities in text, does it work on tasks in code? If a
task's "kind" can be induced and addressed the same mechanical way, then
"have I solved this before" and "has anyone solved this before" become
lookups, not guesses — and eoCode never has to hand-code the same kind twice.

## 1. Why "CRISPR" earns the name, not just borrows it

This repo is strict about metaphor: an organ name has to hold up
structurally, or it is "string-thinking" — the exact bar
`ORGAN-STACK-REAL-DEPLOYMENT.md` quotes from `vendor/eoreader5/AGENTS.md`:
*"an organ must make sense for a nameless leitmotif in music, or it is
string-thinking."* So before using CRISPR as scaffolding, it's worth checking
whether the biology actually maps, not just sounds good.

It does, closer than expected. CRISPR-Cas9 is a bacterium's acquired immune
system, and it already runs a retrieve → reuse → revise → retain cycle in wet
biology, independent of anyone naming that cycle in software:

| CRISPR-Cas9 (biology) | Mechanism | eoCode analog |
|---|---|---|
| Spacer array (immune memory) | A growing record of previously-seen invader sequences | The organ registry (`content-index.js`) + a new provenance ledger, below |
| Guide RNA | A short sequence that finds complementary matches elsewhere | `entity-kinds induction`, run over the *task*, not text — produces a kind signature |
| PAM site requirement | A short adjacent motif Cas9 also demands before cutting — guide-RNA complementarity alone is not enough; this is what prevents indiscriminate, off-target cuts | A confirmation check against `eo-cube.js`'s fixed address space — used only to *check* a candidate address, never to infer one from content, exactly as the module's own header already insists |
| Cas9 nuclease | Cuts only when both checks pass — mechanical, not judgment-based | A deterministic match score (kind signature + cube address + license), never "the model liked this result" |
| Repair/ligation machinery | Splices the cut sequence into the host genome | Wrapping a verified candidate in the standard organ interface before it enters eoCode's own code |
| New spacer added to the array | The organism's memory grows from this encounter | A provenance-ledger entry recorded regardless of outcome |

The mapping holds at the level that matters: two independent, mechanical gates
(sequence match *and* an adjacent structural check) before an irreversible
action, plus a permanent record of what happened — not a vague gesture at
"cutting and pasting code."

## 2. Prior art — what already exists, so none of this gets reinvented

The user's own instinct here was right: check first. Every stage below has
real, working precedent; the honest claim for this proposal is not "a new
mechanism" but "a specific composition of existing mechanisms, using this
codebase's own kind/cube theory as the specificity gate that most of them
lack."

- **Package registries (npm, PyPI, crates.io).** The industry's actual,
  boring, already-solved answer to "don't write this twice": a name, a
  semver range, an install command. Cheapest possible check, zero novel
  infrastructure, and it should run *before* anything else in this document —
  most tasks that feel like they need a bespoke organ are actually a missing
  `npm install`.
- **Krueger, "Software Reuse," ACM Computing Surveys 24 (1992).** The
  foundational taxonomy of reuse mechanisms — abstraction, selection,
  specialization, integration — across generator-based, scavenging, and
  component-based reuse. Useful here for classification, not novelty: what's
  proposed below is scavenging/component reuse with an automatic *selection*
  step (kind induction), which keeps it consistent with this repo's existing
  stance in `server/sonata.js:18` — *"DO NOT BUILD A PLAY-GENERATOR. BUILD A
  PLAY-PERMITTER"* — a generator invents; CRISPR only ever selects and
  confirms something that already exists.
- **Case-based reasoning — Aamodt & Plaza's retrieve/reuse/revise/retain
  cycle.** The general, decades-old formalization of "solve it by finding a
  past solution and adapting it," predating both the software-specific and
  the biological framing. CRISPR as proposed here is a CBR system whose case
  library is code and whose domain-specific retrieval step is kind induction
  over the cube, rather than a generic similarity metric.
- **Code clone detection, specifically Type-4 (semantic) clones** — the
  standard four-type taxonomy (Type-1 textual through Type-4 semantically
  equivalent but syntactically unrelated code) is exactly the recognition
  problem the guide-sequence step depends on, and 20+ years of clone-detection
  research (AST/graph/embedding-based Type-4 detectors) are candidate
  implementations for it — this does not need to be invented from scratch as
  a research problem.
- **Aroma (Luan et al., Facebook, 2019 — arXiv:1812.01158).** A working
  reference for the corpus-search stage: index a large real code corpus, take
  a partial snippet, cluster and intersect the matches to recommend the
  common, load-bearing core rather than one contributor's idiosyncrasies.
  Directly reusable pattern for "search GitHub-scale code," not something to
  redesign.
- **Software Heritage and SWHID (ISO/IEC 18670).** The correct substrate for
  "snip from any source," ahead of raw ad hoc GitHub search: it archives full
  version-control history at global scale and issues a persistent,
  cryptographically intrinsic identifier per artifact, with origin/license
  context recorded by design. This is the natural upstream source for the
  provenance ledger's "source" field — GitHub is a good discovery surface, but
  a GitHub URL rots; a SWHID doesn't.
- **Voyager (Wang et al., 2023 — arXiv:2305.16291).** The closest full-system
  precedent that already exists: an LLM agent maintaining an ever-growing,
  vector-indexed skill library, retrieving and composing verified prior
  skills before writing new code, and appending newly-verified skills back to
  the library on success. Structurally this *is* "organs that get created
  once and reused forever," minus the kind/cube/altitude theory and minus a
  provenance ledger.
- **ADAS — Automated Design of Agentic Systems (Hu et al., 2024 —
  arXiv:2408.08435).** The same discipline one level up: a meta-agent
  programs candidate agents, tests them, archives the survivors, and
  searches that archive before designing new ones. Confirms the pattern
  generalizes past code snippets to whole agent designs.

None of these individually is CRISPR. What none of them has is this
codebase's fixed, checked coordinate space (the cube) as a mechanical
specificity gate, or an omnimodal kind-induction organ that doesn't have to
be written specifically for code — the same organ already used on text and
audio, pointed at a task instead.

## 3. Provenance is not optional — it's an existing law, extended

This was the missing piece in an earlier pass of this design, and it's the
right correction: **every snip retains full provenance**, unconditionally,
whether or not it gets spliced in. This is not a new principle for this
repo — it is `LAWS.md`'s **L2** applied to borrowed code instead of borrowed
prose:

> **L2a — Every artifact carries its provenance.** A displayed passage knows
> its source, its byte range, and how it was selected. Rendering strips none
> of this.

Read literally onto code: a spliced organ knows its source repository or
package, its exact revision (commit SHA or, preferably, a SWHID — see §2),
its license, the induced kind and cube address it was matched against, the
verification it passed, and the date it was retrieved. `L2c` ("audit never
mutates") and `L2e` ("absence is auditable") extend cleanly too: looking up
an organ's provenance must never re-fetch or re-derive it, and a *failed*
search — no candidate found, hand-coded instead — is itself a record, not a
silent fallthrough.

This ledger is not new infrastructure to invent: `content-index.js:82`
already names a `ledger/index.js` → *"semantic ledger"* organ in the engine's
own registry. The proposal is to use it for this, not to build a second one.

**Why this gate is not cosmetic:** license contamination from AI-assisted
code reuse is live litigation, not a hypothetical. *Doe v. GitHub, Microsoft,
and OpenAI* — the GitHub Copilot suit — had its DMCA §1202(b) claim dismissed
at the district court in July 2024 on the theory that Copilot's outputs were
modifications rather than verbatim copies; that dismissal is now on appeal,
with the Ninth Circuit hearing oral argument on February 11, 2026 over
whether §1202(b) requires an identical copy at all. The suit's open-source
license-violation and breach-of-contract claims remain live regardless of how
that appeal resolves. The practical takeaway for this design: a candidate
splice with an unknown or incompatible license must fail closed — refused
before it is ever a code-quality question — the same way `L2` treats an
unfalsifiable citation as the more serious failure than a missing one.

## 4. The pipeline

1. **Task ingestion.** What is eoCode actually being asked to build — already
   captured as the operator+grain address `eo-cube.js`'s header describes
   task-log.js as supplying.
2. **Kind induction (guide sequence).** Run entity-kinds induction (or a
   code-domain analog of it — open question, §5) over the task, at an
   altitude chosen by multi-altitude fold, producing a kind signature.
3. **Local search.** Check the organ registry and the eochat/eoreader
   codebase itself first — cheapest, most trusted, "have I already built
   this."
4. **Package-registry search.** npm/PyPI/crates against the kind signature.
   If there's a real, maintained hit, the pipeline ends here: install a
   dependency, don't write or splice anything. This is Krueger's already-
   solved layer and should absorb most tasks before anything below runs.
5. **Corpus search** (only if 3–4 miss) — but not one search, two, at two
   different grains, a distinction the first buildable increment did not
   originally draw and real testing surfaced. GitHub code search (the GitHub
   MCP tools already available to this agent — `search_code`,
   `search_repositories`) and/or Software Heritage, clustered Aroma-style
   rather than taking the first hit, answers "is there a reusable
   *component* for this" — still roughly package-grain. A separate question,
   one grain coarser, is "is the *whole task* a known archetype" — "build a
   website that looks like Reddit" should find a real, working
   implementation to adapt, not get assembled function-by-function from
   npm packages, which structurally cannot answer that question (they index
   libraries, not applications). Validated with real queries before being
   built (`eval/agent/crispr-search.mjs`'s `searchAppArchetype`): GitHub
   repository search for "reddit clone" (+`stars:>100`) returns 16 real
   implementations (`breadit`, 1,114 stars, Next.js/TypeScript down through
   Java/Spring, Python/Flask, plain JS); "trello kanban board"
   (+`stars:>50`) returns 12, including `react-trello` (2,258 stars,
   literally "pluggable kanban board component"). More useful than either
   hit alone: two negative controls — a nonsense query and a real but
   non-archetype technical task — both returned a clean 0, which searchNpm's
   own nonsense-query test did *not* (5 loosely-related hits; npm's
   full-text search is generous even on garbage input). The star-count
   floor is doing real work here, not just cosmetic noise reduction — it is
   what makes this altitude's hit/miss signal trustworthy where npm's isn't.
   Kept as a standalone function, not wired to a live tool yet: a match here
   implies cloning and adapting a whole third-party application, a much
   bigger license/provenance decision (§3) than snipping one function, and
   whether/how to expose it to a live agent is an open decision on its own.
6. **Specificity gate (the PAM check).** Confirm the candidate occupies the
   same cube address as the task — mechanical, not similarity-by-vibes. This
   is `LAWS.md` L8 ("selection over a navigation index is mechanical, never
   model-steered") extended from search results to code candidates.
7. **License and provenance gate.** Refuse anything without a clear,
   compatible license. Log the attempt either way — a refusal is retained
   too, per L2e.
8. **Verification (Revise).** The candidate must pass the same tests,
   types, and lint the hand-coded alternative would have needed. This step,
   not the search, is the actual permit.
9. **Splice.** Wrap the verified candidate in the standard organ interface —
   the same "must make sense for a nameless leitmotif" bar applies here: a
   snippet that only works framed as this one task's hack does not become an
   organ, it stays a one-off.
10. **Coherence gate — built and validated, not just proposed
    (`eval/agent/coherence-check.mjs`).** Verification (stage 8) proves each
    spliced piece works in isolation; it says nothing about whether multiple
    snipped pieces actually relate to each other the way the source
    implementation did, or just sit next to each other because they
    compiled. This is the check none of §6's market/research prior art has:
    not "does it pass tests," but "do these pieces form a real holon, or an
    incoherent pile." Built on `server/task-log.js`'s `deriveLevels()`,
    which mechanically determines whether one thing is genuinely *above*
    another — a real existence-dependency relation — or merely a *peer*,
    with peer reported as an honest, first-class result rather than a forced
    hierarchy. `checkCoherence(dir)` builds a REAL import/require graph over
    a snipped set of files and runs it through that same test, flagging any
    file with zero earned relation to the rest as `isolated`.

    Validated against real, freshly-cloned material, not fixtures — the
    same real-repo discipline `ORGAN-STACK-REAL-DEPLOYMENT.md` insists on:
    cloned `d11z/asperitas` (a real Reddit clone from §6) and ran three
    snips through it. `controllers/posts.js` + its two real model imports
    (`models/post.js`, `models/user.js`) correctly reports `coherent: true`
    — a clean core with every file earning a real edge. Adding
    `controllers/comments.js` to that same snip correctly flags it
    `isolated`: it has zero *import* edges to anything else, even though
    it's functionally coupled to posts at runtime through Express
    middleware (`req.post.comments`) — a real, honest limitation surfaced
    by real material, not a hypothetical one: static import analysis alone
    misses coupling that only exists through the framework's own request
    lifecycle. A third, adversarial test mixed real asperitas files with
    two files from an entirely unrelated codebase (this repo's own
    `eo-cube.js`, `web-search.js`) in the same directory; the checker
    correctly isolated exactly the two unrelated files while still finding
    the real relations among the actually-related ones in the same run —
    proof this discriminates rather than defaulting to "coherent."

    Wired as a live tool (`check_coherence`, `addCoherenceCheckTool` in
    `server/eocode-agent.js`) so eoCode itself can run it on anything it
    just copied in, before calling `finish`.

    **Real, current gap, not a detail to gloss over:** the theory
    `deriveLevels()` cites (`docs/holon-level.md`, referenced in
    `task-log.js` and `holonic-task.js`) names *two* tests —
    existence-dependency and possibility-constraint ("A constrains what B
    may be") — but only existence-dependency is implemented, here and
    everywhere else in this codebase. `possibility-constraint` is named in
    three places and built in none of them. Until it exists, this gate can
    confirm two pieces are unrelated, or related by a real import edge; it
    cannot yet confirm the fuller claim that a real edge is wired
    *correctly*, or catch coupling that exists at runtime but not in the
    import graph (as `comments.js` showed) — it inherits the same honesty
    this document already insists on elsewhere: report what's actually
    checked, not what the theory eventually promises.
11. **Retain.** Write source, revision/SWHID, license, induced kind, cube
    address, verification result, and coherence-gate result to the semantic
    ledger. The next task at the same address finds this instead of
    re-searching — and if steps 3–7 all missed and eoCode genuinely had to
    hand-code something new, step 11 still fires on that result, so the
    same kind is never solved twice even the first time it's real.

**A constraint that binds every stage above, carried over from day one:
never inflate the local model's prompt window.** eoCode drives a small
local model (`server/eocode-agent.js`'s default is `qwen2.5-coder:1.5b`),
and `react-loop.mjs` already documents the real cost of forgetting this —
n_tokens measured climbing past 3400 within half a dozen steps because
every tool observation was replayed in full every turn. Its fix,
`DEFAULT_FOLD_K`, only bounds *tool results* after they age out of the
recent window; the *system prompt* — every tool's description — is resent
verbatim on every single turn for the whole run, unfolded, forever. So a
tool description belongs in this pipeline only if it earns a permanent,
per-turn tax, and any stage that returns candidates (steps 3–5 especially,
once corpus search is real and each hit can carry a much longer blob than
an npm registry entry) must cap and truncate before returning, not after.
The first buildable increment (§6, `eval/agent/crispr-search.mjs`) already
holds to this — short tool description, `MAX_CANDIDATES`-capped and
truncated results — specifically so this doesn't have to be relearned the
expensive way once the corpus-search stage is real.

## 5. Open questions — genuinely unresolved, not rhetorical

- **Does entity-kinds induction work on code unmodified**, the way
  `text-signal.js`'s char-3gram approach turned out to generalize to Greek
  with zero changes (`ORGAN-STACK-REAL-DEPLOYMENT.md`), or does code need its
  own perceiver the way audio and video got their own? Untested either way.
- **Cheap-proxy risk, already learned the hard way in this exact repo.**
  `select-best-priors.mjs` found that a fast lexical-overlap proxy for "is
  this prior any good" looked clean at 3 data points and collapsed to
  statistically indistinguishable from zero correlation at 13. The same
  caution applies directly here: an embedding-similarity shortcut for "is
  this candidate the same kind" must be validated against real verification
  outcomes before being trusted, not assumed to work because it's plausible.
- **License-compatibility checking is its own nontrivial problem**
  (SPDX matching, dual licensing, the "no license file" default, license
  compatibility direction — MIT-into-GPL is fine, the reverse isn't). Likely
  deserves its own dedicated check, not an inline heuristic.
- **GitHub vs. Software Heritage as the citation unit.** A live GitHub URL
  can change or vanish; a SWHID can't. Worth deciding early whether GitHub is
  only ever a *discovery* surface and Software Heritage is the thing actually
  cited in the ledger.

## 6. Where this sits against the market — not just the research literature

§2 checked this against research: CBR, Krueger, clone detection, Aroma,
Software Heritage, Voyager, ADAS. That is the right prior art for the
*mechanism*. It says nothing about whether the mechanism is what the market
already does when the exact same problem — "the user described a whole app,
don't hand-code it from zero" — is a live commercial category today. Checked
directly, the answer sharpens the recommendation rather than confirming it.

- **v0.app, Bolt.new, and Lovable — the current "describe an app, get an
  app" market leaders — do not search a live code corpus and adapt what
  they find.** They generate fresh code in a curated, consistent idiom
  (v0.app specifically: shadcn/ui + Tailwind + Next.js) plus a small number
  of hand-authored starter templates (Bolt ships curated templates for
  landing pages, SaaS, dashboards). None of the public descriptions of any
  of them mention retrieving and adapting an arbitrary GitHub repository at
  generation time. That omission from three well-funded, heavily-used
  products is itself evidence: a curated in-house library is the model the
  market converged on, not live web-scale retrieval — most plausibly
  because it sidesteps exactly the license/attribution exposure §3 already
  treats as a hard gate, and gives consistent quality a scavenged clone
  repo can't promise.
- **Wix ADI is the closest real precedent for archetype-level "recognize
  the kind, pick the template"** — ask a few questions about the business,
  select a matching template, customize it. Worth noting plainly: it has
  already been discontinued, folded into "Wix AI Website Builder." Even the
  product that pioneered pure template-selection judged it insufficient on
  its own and moved toward more generative methods.
- **Retrieval-augmented code generation is real, validated research ground
  — at a narrower grain than a whole app.** RepoCoder and the broader RACG
  survey retrieve similar code from *within the same repository* to
  complete the current file; this supports §4's component/utility-grain
  stages (3–4), not `searchAppArchetype`'s whole-app grain, which sits
  outside what this literature actually tests.
- **Screenshot-to-code is a different, competing paradigm for "make it
  look like Reddit," not a variant of this one.** Instead of inducing a
  kind from a text description and searching for matching source, it
  perceives the target's actual appearance (a screenshot or a URL) and
  generates matching code via a vision model — no kind induction, no
  search, no provenance question at all, because nothing is reused, only
  observed. If "looks like Reddit" is meant visually rather than
  functionally, this sidesteps CRISPR's whole mechanism and may simply be
  the more direct tool for that framing. eoreader already has perceiver
  architecture for text, audio, and video (`perceiver/text`,
  `perceiver/audio`, `perceiver/video`, per `content-index.js`'s
  `ENTITY_NAMES`); a live-webpage/screenshot perceiver would be a new, real,
  currently-missing organ — arguably a more honest unlock for the literal
  "looks like X" framing than an archetype text-search is.
- **Yeoman and Cookiecutter confirm "organs as generators" is not a new
  idea — it is a roughly 15-year-old, now-declining product category.** A
  Yeoman generator already is a named, reusable unit that produces a
  standardized thing, hand-authored and hand-registered exactly the way
  `content-index.js`'s `ENTITY_NAMES` is today. The ecosystem's own
  retrospective is blunt about where that leads unmaintained: "Yeoman and
  Cookiecutter are dead; long live Copier." A kind registry that goes stale
  without upkeep is not a hypothetical risk unique to this proposal — it is
  the documented fate of the last two serious attempts at exactly this
  idea.

**The honest verdict:** almost every individual mechanism this document
proposes already exists somewhere, and where it competes directly with a
mature product (app generation) or a mature research area (repo-level
retrieval), that prior art mostly argues *against* the piece of CRISPR built
most recently — live external search as the primary mechanism — and
*toward* the piece designed first and tested least: an internal, growing,
license-clean organ registry (the Retain step, §4 stage 11 — the same
shape as Voyager's skill library and Yeoman's generator ecosystem, minus
their staleness problem, if kind induction keeps it self-maintaining
instead of hand-curated). What genuinely does not already exist elsewhere,
checked against all of the above: automatic kind induction (no product
surveyed here asks a *model* to recognize the archetype — Wix ADI asks the
*user*), a checked coordinate space for what got matched (the cube), and
mandatory per-reuse provenance enforced as a law rather than left to each
generator author's discretion. That is the actual, narrower claim this
proposal can make — not "search GitHub before you code," which the market
has already quietly tried adjacent versions of and moved past.

## 7. Recommended first step

Don't build the cube/kind/ledger machinery first. Wire steps 3–4 only (local
registry, then package registry) in front of eoCode's existing hand-coding
path, log every hit and miss, and measure — empirically, on real eoCode
sessions — how often "search first" would have skipped hand-coding entirely.
That's the same real-material-before-theory discipline
`ORGAN-STACK-REAL-DEPLOYMENT.md` already insists on for the engine; there's
no reason CRISPR should get a pass on it just because it's new.

**Revised after §6.** The step above was built and validated
(`eval/agent/crispr-search.mjs`, tested live against `qwen2.5-coder:1.5b` on
a real task) before §6 was written. Given what §6 found, the next
investment should not be expanding external search further (more corpus
stages, more registries) — it should be strengthening stage 11, Retain:
turning every verified splice and every genuine hand-coded solution into a
permanent, license-clean entry in eoCode's own organ registry, so external
search stays a cold-start fallback for a kind eoCode has never seen, not
the steady-state mechanism. That is the shape every product and research
precedent in §6 that actually works at scale converged on independently.

## Sources

- [Aroma: Code Recommendation via Structural Code Search (arXiv:1812.01158)](https://arxiv.org/abs/1812.01158)
- [Voyager: An Open-Ended Embodied Agent with Large Language Models (arXiv:2305.16291)](https://arxiv.org/abs/2305.16291)
- [Automated Design of Agentic Systems (arXiv:2408.08435)](https://arxiv.org/abs/2408.08435)
- [Retrieval, reuse, revision and retention in case-based reasoning — Knowledge Engineering Review](https://www.cambridge.org/core/journals/knowledge-engineering-review/article/abs/retrieval-reuse-revision-and-retention-in-casebased-reasoning/832332507628AE30DB2486FD75651C7A)
- [Krueger, "Software Reuse," ACM Computing Surveys 24 (1992)](https://dl.acm.org/doi/10.1145/130844.130856)
- [Doe v. GitHub, Microsoft, and OpenAI — Wikipedia](https://en.wikipedia.org/wiki/Doe_v._GitHub,_Microsoft,_and_OpenAI)
- [GitHub Copilot litigation case updates — Joseph Saveri Law Firm](https://githubcopilotlitigation.com/case-updates.html)
- [SoftWare Heritage persistent IDentifiers (SWHID)](https://docs.softwareheritage.org/devel/swh-model/persistent-identifiers.html)
- [Lovable vs Bolt vs v0: AI app builder comparison, 2026](https://particula.tech/blog/lovable-vs-bolt-vs-v0-ai-app-builders)
- [The evolution from Wix ADI to Wix Harmony](https://www.wix.com/blog/wix-artificial-design-intelligence)
- [Retrieval-Augmented Code Generation: A Survey with Focus on Repository-Level Approaches (arXiv:2510.04905)](https://arxiv.org/abs/2510.04905)
- [RepoCoder: Repository-Level Code Completion Through Iterative Retrieval and Generation](https://openreview.net/forum?id=q09vTY1Cqh)
- [screenshot-to-code (open source)](https://github.com/abi/screenshot-to-code)
- [Yeoman and Cookiecutter are dead; long live Copier!](https://recallstack.gitlab.io/en/2020/04/18/yeoman-and-cookiecutter-are-dead-long-live-copier/)
