# Conversational Memory Capability — Eval Scoreboard

Each run replays the same scripted multi-turn conversations through two REAL context-assembly pipelines from server/turn-controller.js and server/conversation-memory.js — a windowed-only baseline (what a plain chat completion passthrough gives you) and the holonic pipeline (windowing + the desk). Newest runs first.

## 2026-08-08T14-24-15-401Z__scripted

4/4 scenarios passed (scripted, deterministic context-only run — see README.md for what this does and does not prove).

- **long-thread-recall** — PASS (4/4 checks)
- **multi-fact-recall** — PASS (6/6 checks)
- **recall-denial-resistance** — PASS (2/2 checks)
- **silent-truncation-disclosure** — PASS (5/5 checks)


## 2026-08-08T14-05-26-033Z__scripted

4/4 scenarios passed (scripted, deterministic context-only run — see README.md for what this does and does not prove).

- **long-thread-recall** — PASS (4/4 checks)
- **multi-fact-recall** — PASS (6/6 checks)
- **recall-denial-resistance** — PASS (2/2 checks)
- **silent-truncation-disclosure** — PASS (5/5 checks)


## 2026-08-08T14-04-28-790Z__scripted

1/4 scenarios passed (scripted, deterministic context-only run — see README.md for what this does and does not prove).

- **long-thread-recall** — FAIL (2/4 checks) — FAILED: holonic's desk-augmented context still carries the fact; a context-bound model recalls the fact from the holonic context
- **multi-fact-recall** — FAIL (2/6 checks) — FAILED: holonic context still carries fact A; holonic context still carries fact B; a context-bound model recalls fact A from the holonic context; a context-bound model recalls fact B from the holonic context
- **recall-denial-resistance** — FAIL (1/2 checks) — FAILED: a false denial of the recorded vault code is flagged
- **silent-truncation-disclosure** — PASS (5/5 checks)


## 2026-08-08T13-53-00-073Z__scripted

4/4 scenarios passed (scripted, deterministic context-only run — see README.md for what this does and does not prove).

- **long-thread-recall** — PASS (4/4 checks)
- **multi-fact-recall** — PASS (6/6 checks)
- **recall-denial-resistance** — PASS (2/2 checks)
- **silent-truncation-disclosure** — PASS (5/5 checks)


## 2026-08-07T15-24-07-657Z__scripted

4/4 scenarios passed (scripted, deterministic context-only run — see README.md for what this does and does not prove).

- **long-thread-recall** — PASS (4/4 checks)
- **multi-fact-recall** — PASS (6/6 checks)
- **recall-denial-resistance** — PASS (2/2 checks)
- **silent-truncation-disclosure** — PASS (5/5 checks)

