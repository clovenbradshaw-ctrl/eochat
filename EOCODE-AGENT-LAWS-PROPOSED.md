# Proposed laws from building eoCode's CRISPR organs — staged for later disposition

Written the same way `CONSTITUTION-AND-LAWS-AMENDMENTS-PROPOSED.md` was:
staged here because `../eo-constitution/` is not reachable from this session
(not vendored in eochat, not in this session's GitHub scope), so this
document is written for anyone with `eo-constitution` access to fold the
relevant parts in directly. Nothing here has been applied anywhere.

**A disposition question worth flagging before the content, not after —
the same genuine disagreement that document already recorded once.** These
five came from building and testing eoCode's own agent loop
(`eval/agent/react-loop.mjs`, `server/eocode-agent.js`), not from engine
reading behavior. By `LAWS.md`'s own dividing line — "the constitution
decides *what goes where*... [LAWS.md] decides *how this app must
behave*... bind the host: clock, I/O, routing, UX" — an agent loop is host
behavior, not engine design, which argues these belong in `LAWS.md` as new
numbered laws (it currently runs through L10) rather than in the
constitution. Written here in the constitution's testable-article
register per what was actually asked; a human disposing of these should
feel free to route them to `LAWS.md` instead if that reading holds.

Every claim below is measured, not asserted — each cites the real run and
commit where the failure actually happened. `eval/agent/react-loop.mjs`,
`eval/agent/repo-fetch.mjs`, `eval/agent/splice-tools.mjs`,
`eval/agent/coherence-check.mjs`, and `server/eocode-agent.js` are the
enforcement surface for all five; none of them are hypothetical.

---

## Proposed L-A — An agent's action surface is mechanized where precision has been measured to fail, not where it merely could

**A multi-step action a small model must construct freely (shell commands,
disambiguated string matches) is replaced by one deterministic tool the
instant a real run shows the model getting the free-form version wrong —
not left as a "the model should be able to figure this out" assumption.**

This is `server/sonata.js`'s "DO NOT BUILD A PLAY-GENERATOR. BUILD A
PLAY-PERMITTER" principle, generalized from content generation to tool
design itself: a tool surface that requires an agent to correctly
improvise a sequence (`git clone` to the right place, `mkdir -p`, `cp`,
each with exactly right paths and quoting) is asking the model to
generate a procedure, when the host could instead permit/perform one
fixed, correct procedure directly.

### Clauses

- **L-Aa — A measured free-form failure is fixed with a tool, not a
  clearer prompt.** A real eoCode run (commit `be96728`) asked a model to
  clone a repo and edit the result; it invented tool names ("mkdir", "cp")
  that do not exist and cycled through the same four failing calls for 36
  of 40 steps. The fix was `fetch_repo_files` — one call, no shell
  construction required — not a longer explanation of `run_shell`'s
  syntax.
- **L-Ab — Uniqueness-requiring edits are not the tool for global
  renames.** The same lineage of runs (commit `073c173`) showed a model
  fail three consecutive uniqueness-checked edits trying to rename a
  field appearing 8 times in one file, then abandon the task rather than
  construct a more specific match. `replace_in_file` (a global, non-unique
  replace) is the correct tool for "rename this everywhere"; a
  unique-match edit tool is correct for "make one surgical change,"
  and conflating the two is what produced the failure.

### Measurement

Any capability added to an agent's tool surface that chains two or more
free-form tool calls to accomplish one conceptual action must be checked
against a real run before being accepted as sufficient: if a real model
gets the chaining wrong in a way a single mechanized tool would prevent,
the mechanized tool is required, not optional. `eval/agent/repo-fetch.mjs`
and `eval/agent/splice-tools.mjs` are the reference implementations this
check was built against.

---

## Proposed L-B — A seeding action never silently overwrites state it did not create this call

**An action whose job is "put X here if it is not already here" must
refuse to overwrite X once it exists, reporting that refusal explicitly —
never treat re-invocation as a reset.**

### Clauses

- **L-Ba — Idempotence is not synonymous with safety.** `fetch_repo_files`
  originally re-copied from its clone cache on every call, which is
  idempotent in the narrow sense (same inputs, same eventual file) but
  unsafe the moment anything else has touched the destination in between.
- **L-Bb — Silent data loss is a more severe failure than a refused
  action.** An error the model can see and react to costs a step; the
  original bug (commit `2fbad2a` fixes it) cost an entire run's remaining
  budget, because the model never knew its edits had been destroyed and
  kept "fixing" a coherence failure by destroying them again.

### Measurement

For any tool that writes to a path also reachable by another tool in the
same session: call it once, mutate the result through a different tool,
call the seeding tool again with identical arguments, and confirm the
mutation survives and the second call reports what it did *not* do
(skipped, not silently succeeded). `eval/agent/repo-fetch.mjs`'s
`fetchRepoFiles` is the passing reference case.

---

## Proposed L-C — Non-progress detection catches any repeating pattern, not only immediate repetition

**A loop-detection mechanism scoped to "the same single call, twice in a
row" is scoped to one failure mode among several equally real ones and
must be generalized to periodic cycles of any bounded length, checked
across both successful and failing calls alike.**

### Clauses

- **L-Ca — Failure is not the invariant; repetition without new
  information is.** The original mechanism
  (`eval/agent/react-loop.mjs`, pre-`be96728`) only counted repeats when a
  call's result contained an error, so a call that succeeds identically
  every time — proven by a real run calling `search_prior_art` with
  unchanged arguments 25 times — was invisible to it.
- **L-Cb — A cycle of different calls is not visible to a same-call
  check.** A second real run (commit `be96728`'s own header, and the
  commit that generalized `detectCycle`) cycled through four distinct
  calls — two invented tool names, a sandbox-boundary error, and a
  wrong-path shell failure — for 36 of 40 steps; no two consecutive calls
  were ever identical, so a period-1-only check could not see it.
- **L-Cc — Type-segregated counters can each individually reset while the
  agent is still stuck.** The same run's malformed-response counter and
  tool-call counter were tracked separately, so an alternating
  malformed/valid cycle reset each counter in turn without either ever
  reaching its own threshold.

### Measurement

Replay a synthetic transcript containing a repeating block of length P for
P = 1 through at least 6, mixing malformed and well-formed entries within
the block, and confirm detection fires within a bounded number of full
cycle repetitions (not merely eventually, before a step cap). Also replay
a transcript with genuinely varying calls and confirm no false abort.
Both are the exact tests `eval/agent/react-loop.mjs`'s `detectCycle` was
verified against.

---

## Proposed L-D — A completion claim is refused, mechanically, until the verification it depends on has actually run and passed

**An agent may not declare a task complete on the strength of its own
narration alone when a specific, nameable check was required first; the
completion action itself must consult the transcript for that check's
real result and refuse if it is missing or negative.**

This is the same discipline `LAWS.md`'s own citation-verification work
already applies to claims about text ("a passage that reads like a
citation is treated as a potential fabrication, not as" ground truth,
`LAWS.md` L2's own findings) — applied here to an agent's claim about its
own work instead of a claim about a document.

### Clauses

- **L-Da — A prompt instruction is not an enforcement mechanism.** A real
  eoCode task explicitly stated "only call finish once check_coherence
  reports coherent: true"; the model copied in code, edited it, and
  called finish having never invoked `check_coherence` at all (the run
  preceding commit `073c173`). The instruction was followed exactly zero
  times across four attempts before the mechanical gate existed.
- **L-Db — A refusal must feed the same non-progress detection as any
  other failure.** A gate that can be repeatedly triggered and ignored is
  itself a new stuck-loop shape; `validateFinish`'s refusal is recorded
  into the identical cycle-detection history as a failed tool call
  (verified: a model that just keeps calling finish unchanged still
  aborts after 4 attempts rather than exhausting the step budget).

### Measurement

Construct a session where the domain-specific completion precondition is
false, attempt to finish, and confirm the session is neither marked
finished nor done; make the precondition true and confirm finish is then
accepted. `server/eocode-agent.js`'s `coherenceGatedValidateFinish` is the
reference implementation and passing test.

---

## Proposed L-E — A diagnostic excludes its own scaffolding from what it diagnoses

**A tool that evaluates a set of artifacts for a caller must not let its
own supporting infrastructure (caches, scratch directories, intermediate
state it created) count as part of what is being evaluated, and must not
require the caller to know to exclude it manually.**

Worth naming as its own article rather than folding into L-B or L-C
because the failure shape is different: this is not about correctness of
the check's answer (the check was right) but about scope — the honest
result to an unintentionally broad question, mistaken for a wrong answer
to the intended one. Adjacent in spirit to `LAWS.md`'s own L6 ("no implied
completeness") but the inverse defect: not silently claiming more was
covered than was, but silently including more than should have been in
scope.

### Clauses

- **L-Ea — A scratch directory a tool creates for itself is its
  responsibility to exclude, not the caller's to route around.** A real
  run pointed `check_coherence` at the whole workspace (`"."`) and always
  received `coherent: false`, correctly, because one file deep inside
  `fetch_repo_files`'s own raw clone cache — never touched by any actual
  splice — has no import edges. The fix (commit `2fbad2a`) excluded the
  cache directory the same way `node_modules`/`.git` were already
  excluded; it was not a fix to the coherence logic itself, which was
  never wrong.

### Measurement

For any tool that both creates scratch/cache state under a directory and
also scans that directory (or a caller-specified ancestor of it) for
evaluation: verify the scan excludes its own scratch paths by construction
in a test that seeds real scratch content alongside real evaluable
content and confirms only the latter appears in the result.

---

## Sources

Every citation above is to this repository's own commit history on
`claude/eocode-organ-generation-m89gl7` (`be96728`, `073c173`, `2fbad2a`,
`bf2f01d`) and the real, reproducible Ollama runs (`qwen2.5-coder:1.5b`,
real `git clone` network calls, real cloned code) those commits describe
— not to any external source. `CRISPR.md` and `CRISPR-LANDSCAPE.md` carry
the fuller design and market-comparison context these laws were distilled
from.
