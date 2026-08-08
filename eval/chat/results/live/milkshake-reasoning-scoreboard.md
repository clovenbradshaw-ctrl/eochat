# Milkshake-Machine-Repair — Critical-Thinking / Synthesis Comparison

Harder counterpart to milkshake-scoreboard.md: not single-fact recall, but multi-fact synthesis and diagnostic reasoning, graded by an LLM judge against real ground-truth excerpts. Newest runs first.

## 2026-08-08T16-22-38-357Z__milkshake-reasoning__qwen2.5-3b-vs-claude-haiku-4-5

| pipeline | rubric items met | probes overall-sound |
|---|---|---|
| adversary (claude-haiku-4-5, growing) | 4/9 (44%) | 0/3 |
| local+fold (qwen2.5:3b) | 1/9 (11%) | 0/3 |
| fold+hosted (claude-haiku-4-5) | 7/9 (78%) | 2/3 |

Graded by claude-haiku-4-5 against verbatim ground-truth excerpts from the real transcript, not a hardcoded rubric answer.

