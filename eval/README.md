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
  `run_shell`, `finish`, each bound to one sandbox directory. This is a fixed,
  hand-grown set for now (see "Future direction" below).
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
- `decomposed` — whether `holon-coder.mjs` split the task into sub-tasks.

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
- **Levels 3–7 task definitions are not yet written.** Only Levels 1–2 (4
  tasks) are built and scored. The architecture (holonic recursion, surf/
  fold ingest) is built to support them; the task content is not yet there.
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
