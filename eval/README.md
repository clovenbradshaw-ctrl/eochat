# Agentic Coding Capability Eval

Tests whether a **local CPU model** can act like an autonomous coding agent —
plan, write code, run it, read the failure, and iterate to a working result —
with no human and no other model in the loop between task assignment and
completion. Modeled on the Agentic Coding Capability Test Spec's Level 1–7
ladder (single-shot generation → self-correction → real codebases → bug-fix-
from-symptom → cross-file consistency → long-horizon → ambiguous/
underspecified).

**The model under test does ALL the planning and ALL the coding.** This
harness only: sandboxes a working directory, optionally seeds it, hands the
model a tool loop, scores the result against an oracle written independently
of the model (before it ever saw the task), and records what happened. There
is no step anywhere in `eval/agent/` where this harness or I write the
solution — only the local model does, via tool calls.

## Quick start

```bash
# 1. Fast, offline, zero-cost check that the harness itself works (no model,
#    no network — a fixed scripted "adapter" stands in for the model):
node eval/run.mjs --dry-run

# 2. A real run against a local Ollama model:
ollama serve &                     # if not already running
ollama pull qwen2.5-coder:7b       # or any other Ollama model
node eval/run.mjs --model qwen2.5-coder:7b

# 3. Just Level 1:
node eval/run.mjs --model qwen2.5-coder:7b --level 1
```

Every run is recorded to `eval/results/runs/<timestamp>__<model>.jsonl` (one
JSON object per task, full detail) and folded into `eval/results/
scoreboard.md` (a human-readable, append-only history, newest first).

## Architecture — reusing this codebase's own organs, not a bespoke framework

The redirect that shaped this design: don't build a generic ReAct scaffold
from scratch — build the agent out of primitives this codebase already has.

- **`agent/tools.mjs`** — the agent's "organs": `read_file`, `write_file`,
  `edit_file`, `run_shell`, `finish`, each bound to one sandbox directory.
  This is a fixed, hand-grown set for now (see "Future direction" below).
  `edit_file` (old_string/new_string, unique-match-or-refuse — the same
  discipline this very harness's own editing tool uses) was grown once
  real, larger files entered the picture at Level 3+: `write_file` requires
  retyping the COMPLETE file, which is fine for a 20-line script but
  physically does not fit a CPU-bound model's per-step token budget once the
  file is a real few-hundred-line module. Without it, "real codebase" tasks
  were impossible by construction, not a measured capability gap.
- **`agent/react-loop.mjs`** — the actual read-execute-observe-correct loop.
  The model emits exactly one JSON tool call per turn; the tool actually
  runs; the real result (including real errors) is appended as an
  observation; repeat until `finish` or a step cap. No hidden retry — if the
  model never runs its own code, that's a real, measured failure, not
  something this loop papers over.
- **`agent/holon-coder.mjs`** — the **recursive holonic task** wrapper.
  Reuses `server/task-log.js`'s real append-only fold spine (the same one
  `code-longform.js`/`narrative-longform.js`/`holonic-task.js` already
  share) rather than a bespoke tree: a task is proposed, optionally split
  (`SEG`, per `task-log.js`'s own `OPERATOR_BASIS.PRODUCED` discipline — the
  log records which rule fired, never a label applied after the fact) into
  independent sub-tasks, each of which recurses through the same function,
  and results fold back up via `projectTasks`/`foldToWorkingSet`. The
  decomposition decision itself is a model call — planning is the model's
  job too.

  **Nesting is bidirectional, not just a downward split.** `task-log.js`'s
  `deriveLevels()` and eoreader6's `holon_level/index.js` both name a level
  relation as two independent tests, not one — existence-dependency (remove
  the low and the high's ground moves) and possibility-constraint (the
  high's synthesis sits measurably apart from, and biases, the low). The
  first build of this wrapper only had the downward half: a plan was guessed
  once, up front, before any leaf ever ran, and a leaf's real outcome never
  fed back into what the parent believed was possible next — a tree with the
  arrow pointing one way. Two additions close the loop:

  - **low → high, sets POSSIBILITY.** When a direct attempt does not
    converge (hits its step cap, never calls `finish`), the parent may
    replan — but ONLY armed with that attempt's own real last tool
    observation (`distillEvidence`), never a fresh guess. No evidence, no
    retry. This is a genuine predictive-processing correction step: a real
    prediction error (what actually happened) is what earns the right to
    revise the model of the task, recorded as a `SUPERSEDE` entry
    (`revised_because: <the evidence>`) — the same "revise on measured
    residual" discipline `server/longform.js`'s `reviseDraft` already uses.
  - **high → low, sets PROBABILITY.** When a task does decompose — eagerly
    or because a failed attempt earned a retry — each child is handed a
    small, bounded `priorHint`: the parent's goal and how this piece fits
    among its siblings (plus the failure evidence, on a retry). This never
    changes what a leaf *can* do — the tool set and sandbox are identical —
    it only biases which of the possible actions the leaf is likely to try
    first, exactly like a precision-weighted top-down prediction. It is
    prose context, not injected code or a solution, and it is folded to a
    small declared budget (`MAX_HANDOFF_CHARS` in `holon-coder.mjs`) with an
    explicit "N chars withheld" report when it doesn't fit — the same
    never-silently-truncate discipline `foldToWorkingSet` and
    `engineGroundQuery` already use for their own budgets. "We never prompt
    the model with more than it needs" applies to cross-level handoff, not
    only to `surf`.

  Recursion stays bounded exactly as before: the top task spends its one
  split budget (`maxDepth`, default 1) either eagerly or reactively, never
  both, so this is real feedback, not an unbounded retry loop dressed up as
  one. See `eval/agent/holon-coder.test.mjs` for deterministic, offline
  coverage of both directions.
- **`agent/ingest.mjs`** — the **surf and fold** half, applied to a whole
  codebase instead of prose. Clones a repo (or uses a local path), admits
  every source file into a dedicated pool of the *real* engine corpus
  (`@eoreader/host/corpus`, via `server/engine-ground.js`'s
  `engineIngestFile`/`engineGroundQuery` — byte-chunked, lexical-presence
  search, format-agnostic, so source code ingests exactly like prose does),
  and exposes a `surf(query)` research callback that searches broadly and
  folds to a bounded token budget, reporting what got withheld rather than
  silently truncating. This is load-bearing, not decorative: a CPU-bound
  7B model has small, slow, precious context, so bounded surf-then-fold
  retrieval is what makes it possible to act agentically on a codebase
  bigger than its context window at all.
- **`harness.mjs` / `run.mjs`** — orchestration, sandboxing, oracle scoring,
  and result recording. Contains no task-solving logic.

## Directory layout

```
eval/
  agent/            the agent itself — tools, react loop, holonic wrapper, ingest
                    (holon-coder.test.mjs: offline coverage of the bidirectional
                    nesting — run with `node --test eval/agent/holon-coder.test.mjs`)
  adapters/         ollama-adapter.mjs (real), scripted-adapter.mjs (dry-run)
  levels/           Level 1-7 task definitions + independent oracles
    level1-csv-to-json/       task.json, test.mjs
    level1-fizzbuzz/
    level2-csv-quoted-comma/  task.json, seed/check.mjs, test.mjs
    level2-jsonl-quirk/
  results/
    runs/*.jsonl    raw per-run, per-task results
    scoreboard.md   human-readable history, newest first
  tier0/            a SEPARATE, optional constitutional-invariant gate (see below)
  tasks/            earlier Tier1-4 task fixtures (see below) — not part of the main loop
```

## Task shape

Each `levels/<id>/task.json` declares: the prompt handed to the model
verbatim (`taskPrompt`), an optional `seedDir` (files placed in the sandbox
*before* the agent starts — e.g. a `check.mjs` verification script for Level
2's "environment quirk" tasks), and step/token budgets. Each `test.mjs`
exports `evaluate(sandboxDir)`, written independently of the model, run by
the harness *after* the agent finishes, and never shown to the model. Level
2 oracles are deliberately broader than any seeded `check.mjs` (different
fixtures, held-out generalizations) so that narrowly satisfying the seeded
check doesn't register as a real fix — verified by hand against both a
correct and a naively-buggy reference solution for every task before
trusting the oracle (see git history for that verification).

## Metrics recorded per task

- `overallPass` — every independent oracle check passed.
- `metrics.iterationsToGreen` — number of `run_shell` calls (a proxy for
  "did it actually run its own code," the Level 2+ bar).
- `metrics.totalToolCalls` / `toolCallCounts` — raw tool-use footprint.
- `metrics.hitStepCapAnyLeaf` — ran out of steps without finishing (honest
  incompleteness signal).
- `metrics.selfReportMismatch` — the model's own `finish` summary claimed
  success (matched against `/pass|success|works|verified|complete|done|
  fixed/i`) but the independent oracle disagreed. This is the self-report-
  accuracy metric the spec calls out as a leading indicator of trust
  problems.
- `decomposed` — whether `holon-coder.mjs` split the task into sub-tasks,
  eagerly or via an evidence-informed retry (see `retried`).
- `retried` — a direct attempt failed, its own evidence earned a replan, and
  the replan decomposed. `retryConsidered`/`retryDeclined` — the replan ran
  but, even with real failure evidence, still judged the task undecomposable
  (an honest "no," not forced).

## Known scope and honest limitations

- **This session's git/GitHub access is scoped to the `clovenbradshaw-ctrl`
  org only** (verified: `add_repo` on an unrelated public repo was rejected
  with "cross-tier adds are not supported"). `ingest.mjs`'s clone-by-URL
  mechanism is real and general-purpose — verified end-to-end against
  `clovenbradshaw-ctrl/live_priors` — but pulling an arbitrary public GitHub
  repo requires a session that has that repo as an initial source. Level 3+
  tasks against a genuinely arbitrary public repo are therefore scaffolded
  (the ingest/surf machinery works) but not run to completion in this
  session.
- **Level 7 (ambiguous/underspecified) is deliberately deferred, not built.**
  Levels 1-6 all share one property that makes their oracles trustworthy:
  there is a single, independently-checkable correct behavior, discovered
  before the model ever saw the task. Level 7's own premise — the task is
  genuinely ambiguous — breaks that property; scoring it honestly requires
  either accepting multiple interpretations (which needs the oracle to
  parse and validate the model's own stated interpretation, a materially
  weaker and more gameable check than every level below it) or silently
  picking one "correct" interpretation ourselves, which would make the task
  not actually ambiguous and defeats the point. Building a Level 7 task
  with a weak oracle to complete the ladder would produce a number that
  looks like a measurement and isn't one — the same failure shape this
  codebase's own `eo-constitution` repo names explicitly for its own
  deferred work ("a gap is a result"). Left as a stated gap for a future
  session with a specific design for that oracle problem, not a silent
  omission.
- **Level 4 has one real task now** (`level4-constitution-veto-bug`):
  `harness.mjs` clones a real, in-scope repo (`clovenbradshaw-ctrl/eo-
  constitution`) declared by `task.repo`, ingests it into a dedicated `surf`
  pool, seeds the sandbox with a real multi-file project (a genuine ~260-
  line rule-engine module, its real route CLI, its real 30-assertion
  conformance suite, and its real claim fixtures) carrying one deliberately
  injected, isolated regression, and scores against the project's OWN real,
  unmodified test suite — not a test written for this eval. An integrity
  guard fails the task outright if the agent edits the oracle or the claim
  fixtures instead of the actual defect. Levels 3, 5, 6, 7 are still not yet
  written. The architecture (holonic recursion, surf/fold ingest, now a real
  repo-ingest path in `harness.mjs`) is built to support them.
- **`eval/tasks/` and `eval/tier0/`** are earlier work from a prior framing
  of this eval (constitutional-invariant gating and one-shot Tier 1-4
  generation tasks). `tier0/` is real, tested (33 passing assertions against
  the actual eoreader6/eochat modules — no-LLM-on-load-bearing-path,
  append-only fold, five-verdict fidelity, ρ rescale invariance, witness/
  void fidelity) and kept as a **separate, optional safety gate** for a
  future scenario where this agent operates directly on eochat/eoreader6
  itself — it is not part of the Level 1-7 scoring loop.

## Future direction: growing organs constitutionally

The tool set in `agent/tools.mjs` is fixed and hand-built for now. The
intended future direction (not yet implemented) is for the agent to be able
to *propose a new organ* for itself when a task needs a capability it
doesn't have — mirroring `eoreader6/packages/engine/emergence/declaration.js`'s
real discipline: an act by an organ not on the roster "is not in the
record," refused rather than silently allowed. A grown organ would need to
be declared (named, described, logged into the task-log as a real entry —
never silent) and pass a safety/constitutional check before being trusted to
run, before joining the live tool registry. This is deliberately scoped out
of the current build — evolution needs an initial substrate before it has
anything to vary.
