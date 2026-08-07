# Paper Trail — narrative-longform test run report

**Model:** hand-authored by Claude this session (no Ollama/model API available in this sandbox — see the script header for exactly what that does and does not prove).
**Scenes/chapters run:** 3 (capped at 3 deliberately — this is a targeted test of chapters 1-3, not a full-novel run)
**Halted by:** `max-scenes-guard` (max-scenes-guard is EXPECTED and correct here — the cap was intentional, not a failure to reach closure)

## Mechanical continuity checks (checkContinuity + checkNumericLocks) — never trusted on say-so

- **0 flags across all 3 chapters.** No declared entity conflict term appeared, and the one declared numeric lock (syndicate-share percentage) never drifted or went internally inconsistent.

## Mechanical payoff checks

- none attempted yet — no commitment's cooldown had elapsed within the first 3 chapters (by design: chapters 1-3 are open/introduce moves only, establishing the world before anything pays off)

No fixed chapter count or content was declared to the engine beyond the 3-scene cap — nextMove() chose "open", then "introduce donor", then "introduce horse" on its own, in that order, from the declared world's existence-dependency structure (both entities have `requires: null`, so they introduce in declaration order; `ledger` and `source` are gated behind the `tip` commitment resolving, which is why chapter 4+ would look different from a naive continuation).