# Conversational Memory Capability Eval

The "normal chatting" counterpart to `eval/`'s Agentic Coding Capability Eval
— same discipline (mechanical, independently-reasoned oracles; every run
recorded in full; nothing cherry-picked), aimed at a different question:
**does the holonic-task machinery this codebase already proved on long-form
generation (`server/task-log.js`'s spine, `foldToWorkingSet`, the surf/fold
discipline in `eval/agent/react-loop.mjs`) actually make ORDINARY multi-turn
chatting better, not just single-document generation?**

The honest answer this eval's first run gives: **yes, on the specific
failure mode it targets.** eochat already built the relevant machinery for
normal chat — `server/conversation-memory.js`'s "desk" (a small, bounded,
always-injected, verbatim fact ledger — the chat-turn analogue of
`foldToWorkingSet`'s "mouth") and `server/conversation-holon.js` (turn
promotion via real existence-dependency, not text classification) — but
nothing before this eval actually measured the marginal difference the desk
makes against the plain windowed-history baseline a normal chat completion
endpoint gives you. This eval measures exactly that, using the real
functions, not reimplementations.

## Quick start

```bash
node eval/chat/run.mjs
```

Deterministic, offline, no model, no network — every run reproduces
identically. Results land in `results/runs/<timestamp>.jsonl` and fold into
`results/scoreboard.md`, same convention as the coding eval.

## What is actually being compared

Two context-assembly pipelines (`pipelines.mjs`), both built from the SAME
real production functions `server/turn-controller.js` itself calls for a
real turn — never a reimplementation, for the same reason
`buildGroundedSystemMessage` and `buildWebSystemMessage` are module-level
exports in that file already: a harness that reimplements the thing under
test stops testing it the moment the two drift.

- **baseline** — `buildHistoryMessages()` only: the last `HISTORY_TURNS` (6)
  raw exchanges, nothing else. This is "normal chatting" in the sense that
  matters here — it is what a plain `/v1/chat/completions`-shaped passthrough
  gives a model once a conversation runs long: whatever fell out of the
  window is simply gone, not summarized, not disclosed as withheld.
- **holonic** — the identical window, PLUS `buildMemoryMessage()` over a desk
  state advanced turn-by-turn by the real `applyTurn()`.

Both conditions replay the IDENTICAL scripted conversation. The four
scenarios in `scenarios/` each isolate one property:

| Scenario | What it proves |
|---|---|
| `long-thread-recall` | A single fact stated once survives being asked about after enough filler turns to genuinely fall out of the 6-turn window (verified by first showing the baseline HAS lost it — not assumed). |
| `multi-fact-recall` | Two distinct facts, stated apart, both stay independently addressable — the desk holds more than a single scalar "the last important thing." |
| `recall-denial-resistance` | Runs the REAL `checkRecallDenial()` against a real multi-turn desk: catches a false denial of a recorded fact, and — just as important — does NOT flag a denial about something genuinely never discussed. Both directions matter; a guard that fires on every "I don't know" is worse than no guard. |
| `silent-truncation-disclosure` | Pushes more distinct facts than `FACTS_MAX` and checks the real eviction against the real rendered message: the desk is allowed to forget under pressure, but the message it sends must never claim to hold more than it actually kept. |

`context-model.mjs` provides a deterministic "context-bound" stand-in
answerer used by two of the scenarios: it answers only from what is
literally present in the assembled context, case-insensitively. It makes no
claim about how a real LLM reasons — it isolates the one property this eval
needs to test in a scripted run: **whether the fact reached the prompt at
all.** Whether a real local model then makes good use of it is a separate,
harder question this scripted run does not answer (see "Honest limits"
below).

## First real run (scripted, this session)

4/4 scenarios pass, 17/17 individual checks (see `results/scoreboard.md` for
the full, append-only history). One real defect was found and fixed during
this eval's own construction, in the SCENARIO SCRIPT, not the production
code under test: `multi-fact-recall`'s second fact was originally placed at
turn index 2, which is still inside the real 6-turn window once the
conversation ends at 8 turns — the baseline pipeline correctly still had it,
and the scenario's own assumption was wrong, not the desk. Moving both facts
to the very start of the script (indices 0–1) made both genuinely fall
outside the window, which is the same "verify the baseline actually failed
for the reason you think it did, don't assume" discipline this codebase's
other domains already apply to their own oracles.

## Honest limits — what this does NOT prove

- **No real local model was run.** This sandbox has no Ollama binary
  installed. `eval/adapters/ollama-adapter.mjs` (already built for the
  coding eval) is reusable here unchanged — `contextBoundAnswer()` in
  `context-model.mjs` could be swapped for a real `adapter.generate(...)`
  call against either pipeline's messages — but that real-model run is
  deferred, scoped honestly, not built prematurely on a claim it would
  behave identically. The scripted result proves the CONTEXT ASSEMBLY is
  correct and measurably different between conditions; it does not prove a
  real 3B-CPU model reliably exploits that difference the way the coding
  eval measured real, sometimes-surprising model behavior (e.g. a model
  inventing a plausible-but-wrong class name despite being told the correct
  one). Treat this scripted run as necessary, not sufficient — the same
  status `eval/run.mjs --dry-run` has relative to a real `--model` run.
- **No L1 ("no dead air") streaming timing was measured here** — that would
  require driving the real HTTP/SSE surface in `server/proxy.js`, not just
  the pure context-assembly functions this eval isolates. Out of scope for
  this eval; LAWS.md's own "Known violations" section is the source of
  truth for streaming-latency compliance.
- **The desk's OWN unit-level correctness** (fact extraction, eviction
  ordering, denial-sentence detection in isolation) is already covered by
  `scripts/test-conversation-memory.mjs` and is not re-tested here. This eval
  exists one level up: the end-to-end, side-by-side comparison against the
  naive baseline, which nothing before it measured.
