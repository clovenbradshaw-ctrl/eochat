# Milkshake-Machine-Repair — Real Conversation Adversary Comparison

Same methodology as scoreboard.md in this directory, but against the REAL, API-generated troubleshooting transcript (eval/chat/live/milkshake-scenario.mjs + build-transcript.mjs) instead of synthetic trivia. Newest runs first.

## 2026-08-08T14-49-19-716Z__milkshake__qwen2.5-3b-vs-claude-haiku-4-5

| pipeline | context | recall | avg latency (this CPU sandbox) | est. MacBook Air M2 GPU latency |
|---|---|---|---|---|
| adversary (claude-haiku-4-5, growing) | 27401 chars | **80%** | 3309ms | n/a — already hosted |
| local, windowed-only (qwen2.5:3b, no fold) | 6470 chars | **0%** | 25270ms | 3713-5940ms *(est.)* |
| local + surf/fold (qwen2.5:3b) | 7417 chars (3.7x smaller) | **100%** | 14553ms | 2138-3421ms *(est.)* |
| fold + hosted (claude-haiku-4-5, same folded context) | 7417 chars (3.7x smaller) | **100%** | 1108ms | n/a — already hosted |

GPU column: this sandbox has no GPU (Ollama confirmed at install: "Unable to detect NVIDIA/AMD GPU"). Estimated by calibrating qwen2.5:3b's REAL generation speed on this CPU (11.8 tok/s, measured live this run) and scaling by the publicly reported 50-80 tok/s range for 3B-class models on an M2 MacBook Air (ModelPiper / HybridLLM.dev public Ollama benchmark aggregations for 3B-class Q4 models on M2 MacBook Air, accessed 2026-08-08 — not measured by this eval). A disclosed estimate, not a measurement.

local+fold missed nothing.
fold+hosted missed nothing.


## 2026-08-08T14-38-59-509Z__milkshake__qwen2.5-3b-vs-claude-haiku-4-5

| pipeline | context | recall | avg latency |
|---|---|---|---|
| adversary (claude-haiku-4-5, growing) | 27401 chars | **40%** | 3410ms |
| local, windowed-only (qwen2.5:3b, no fold) | 6470 chars | **0%** | 20890ms |
| local + surf/fold (qwen2.5:3b) | 7417 chars (3.7x smaller) | **100%** | 18833ms |
| fold + hosted (claude-haiku-4-5, same folded context) | 7417 chars (3.7x smaller) | **80%** | 1698ms |

local+fold missed nothing.
fold+hosted missed: last daily cleaning date


## 2026-08-08T14-32-29-640Z__milkshake__qwen2.5-3b-vs-claude-haiku-4-5

adversary (claude-haiku-4-5, growing, 27401 chars): **40%** — local windowed-only (qwen2.5:3b, no fold, 6470 chars): **0%** — local + surf/fold (7417 chars, 3.7x smaller than the adversary's): **100%**

local+fold missed nothing.


## 2026-08-08T14-29-29-974Z__milkshake__qwen2.5-3b-vs-claude-haiku-4-5

adversary (claude-haiku-4-5, growing, 27401 chars): **60%** — local windowed-only (qwen2.5:3b, no fold, 6470 chars): **0%** — local + surf/fold (7417 chars, 3.7x smaller than the adversary's): **80%**

local+fold missed: beater motor idle amp reading

