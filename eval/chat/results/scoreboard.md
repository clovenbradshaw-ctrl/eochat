# Conversational Memory Capability — Eval Scoreboard

Each run replays the same scripted multi-turn conversations through two REAL context-assembly pipelines from server/turn-controller.js and server/conversation-memory.js — a windowed-only baseline (what a plain chat completion passthrough gives you) and the holonic pipeline (windowing + the desk). Newest runs first.

## 2026-08-07T15-24-07-657Z__scripted

4/4 scenarios passed (scripted, deterministic context-only run — see README.md for what this does and does not prove).

- **long-thread-recall** — PASS (4/4 checks)
- **multi-fact-recall** — PASS (6/6 checks)
- **recall-denial-resistance** — PASS (2/2 checks)
- **silent-truncation-disclosure** — PASS (5/5 checks)

