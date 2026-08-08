# Milkshake-Machine-Repair — Real Conversation Adversary Comparison

Same methodology as scoreboard.md in this directory, but against the REAL, API-generated troubleshooting transcript (eval/chat/live/milkshake-scenario.mjs + build-transcript.mjs) instead of synthetic trivia. Newest runs first.

## 2026-08-08T14-32-29-640Z__milkshake__qwen2.5-3b-vs-claude-haiku-4-5

adversary (claude-haiku-4-5, growing, 27401 chars): **40%** — local windowed-only (qwen2.5:3b, no fold, 6470 chars): **0%** — local + surf/fold (7417 chars, 3.7x smaller than the adversary's): **100%**

local+fold missed nothing.


## 2026-08-08T14-29-29-974Z__milkshake__qwen2.5-3b-vs-claude-haiku-4-5

adversary (claude-haiku-4-5, growing, 27401 chars): **60%** — local windowed-only (qwen2.5:3b, no fold, 6470 chars): **0%** — local + surf/fold (7417 chars, 3.7x smaller than the adversary's): **80%**

local+fold missed: beater motor idle amp reading

