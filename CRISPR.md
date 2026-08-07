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
5. **Corpus search** (only if 3–4 miss). GitHub code search (the GitHub MCP
   tools already available to this agent — `search_code`, `search_repositories`)
   and/or Software Heritage, clustered Aroma-style rather than taking the
   first hit.
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
10. **Retain.** Write source, revision/SWHID, license, induced kind, cube
    address, and verification result to the semantic ledger. The next task
    at the same address finds this instead of re-searching — and if steps
    3–7 all missed and eoCode genuinely had to hand-code something new, step
    10 still fires on that result, so the same kind is never solved twice
    even the first time it's real.

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

## 6. Recommended first step

Don't build the cube/kind/ledger machinery first. Wire steps 3–4 only (local
registry, then package registry) in front of eoCode's existing hand-coding
path, log every hit and miss, and measure — empirically, on real eoCode
sessions — how often "search first" would have skipped hand-coding entirely.
That's the same real-material-before-theory discipline
`ORGAN-STACK-REAL-DEPLOYMENT.md` already insists on for the engine; there's
no reason CRISPR should get a pass on it just because it's new.

## Sources

- [Aroma: Code Recommendation via Structural Code Search (arXiv:1812.01158)](https://arxiv.org/abs/1812.01158)
- [Voyager: An Open-Ended Embodied Agent with Large Language Models (arXiv:2305.16291)](https://arxiv.org/abs/2305.16291)
- [Automated Design of Agentic Systems (arXiv:2408.08435)](https://arxiv.org/abs/2408.08435)
- [Retrieval, reuse, revision and retention in case-based reasoning — Knowledge Engineering Review](https://www.cambridge.org/core/journals/knowledge-engineering-review/article/abs/retrieval-reuse-revision-and-retention-in-casebased-reasoning/832332507628AE30DB2486FD75651C7A)
- [Krueger, "Software Reuse," ACM Computing Surveys 24 (1992)](https://dl.acm.org/doi/10.1145/130844.130856)
- [Doe v. GitHub, Microsoft, and OpenAI — Wikipedia](https://en.wikipedia.org/wiki/Doe_v._GitHub,_Microsoft,_and_OpenAI)
- [GitHub Copilot litigation case updates — Joseph Saveri Law Firm](https://githubcopilotlitigation.com/case-updates.html)
- [SoftWare Heritage persistent IDentifiers (SWHID)](https://docs.softwareheritage.org/devel/swh-model/persistent-identifiers.html)
