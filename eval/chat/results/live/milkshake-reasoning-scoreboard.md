# Milkshake-Machine-Repair — Critical-Thinking / Synthesis Comparison

Harder counterpart to milkshake-scoreboard.md: not single-fact recall, but multi-fact synthesis and diagnostic reasoning, graded by an LLM judge against real ground-truth excerpts. Newest runs first.

## 2026-08-08T16-32-12-819Z__milkshake-holonic-reasoning__claude-haiku-4-5 (holonic — eval/agent/holon-reasoning.mjs)

| pipeline | rubric items met | probes overall-sound |
|---|---|---|
| holonic (SEG-per-candidate, claude-haiku-4-5) | 5/9 (56%) | 1/3 |
| flat fold+hosted baseline (same model, prior run) | 7/9 (78%) | 2/3 |

- **leading-suspect**: decomposed into 5 candidate(s), tiebreak resolved to "Lubricant and mix accumulation in the drive coupling assembly is restricting engagement, adding drag that forces motor current above the overload threshold." — 1/3 rubric items
- **elimination**: decomposed into 5 candidate(s), tiebreak resolved to "both" — 1/3 rubric items
- **next-step-conditional**: decomposed into 5 candidate(s), tiebreak resolved to "both" — 3/3 rubric items


## 2026-08-08T16-22-38-357Z__milkshake-reasoning__qwen2.5-3b-vs-claude-haiku-4-5

| pipeline | rubric items met | probes overall-sound |
|---|---|---|
| adversary (claude-haiku-4-5, growing) | 4/9 (44%) | 0/3 |
| local+fold (qwen2.5:3b) | 1/9 (11%) | 0/3 |
| fold+hosted (claude-haiku-4-5) | 7/9 (78%) | 2/3 |

Graded by claude-haiku-4-5 against verbatim ground-truth excerpts from the real transcript, not a hardcoded rubric answer.

