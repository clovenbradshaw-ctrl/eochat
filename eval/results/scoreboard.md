# Agentic Coding Capability — Eval Scoreboard

Each run is a local CPU model attempting the Level 1-7 task ladder (see eval/README.md). All planning and all coding is done by the model under test via the tool loop in eval/agent/ — the harness only sandboxes, seeds, scores, and records. Newest runs first.

## 2026-08-07T04-41-44-033Z__qwen2.5-coder_7b

Model: `qwen2.5-coder:7b` — 2/4 tasks passed.

### Level 1
- **level1-csv-to-json** (Level 1) — PASS — finished:true decomposed:false iterationsToGreen:2 tools:4 wall:233.5s
- **level1-fizzbuzz** (Level 1) — PASS — finished:true decomposed:false iterationsToGreen:1 tools:2 wall:89.7s

### Level 2
- **level2-csv-quoted-comma** (Level 2) — FAIL — finished:false decomposed:false iterationsToGreen:4 tools:8 wall:239.0s
- **level2-jsonl-quirk** (Level 2) — FAIL — finished:false decomposed:false iterationsToGreen:4 tools:8 wall:225.6s

