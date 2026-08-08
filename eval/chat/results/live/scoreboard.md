# Live Adversary Comparison — local CPU model + surf/fold vs. a hosted Claude model with a growing context window

Each run replays the SAME scripted long conversation through THREE real context-assembly pipelines (eval/chat/pipelines.mjs) and asks a REAL model to answer a recall probe against each: a hosted Claude model given the entire unbounded raw history (the adversary — "just run a Claude model with a growing context window instead of surf and fold"), a small local CPU model (Ollama) given only the windowed history with no desk (shows the failure surf/fold exists to fix), and the same local model given the windowed history PLUS the desk (surf/fold). Recall is graded mechanically: does the model's answer contain the planted fact's exact code. Newest runs first.

## 2026-08-08T13-54-46-612Z__qwen2.5-3b-vs-claude-haiku-4-5 (adversary: claude-haiku-4-5, local: qwen2.5:3b)

- **scale=12 turns, 3 facts** — adversary (Claude, growing): 100% recall @ 384 input tokens, 1398ms | local, windowed-only (no fold): 0% recall @ 490 prompt chars, 6661ms | local + surf/fold: 100% recall @ 1881 prompt chars, 8110ms — local+fold context is 0.6x smaller than the adversary's


## 2026-08-08T13-53-04-928Z__qwen2.5-3b-vs-claude-haiku-4-5 (adversary: claude-haiku-4-5, local: qwen2.5:3b)

- **scale=10 turns, 2 facts** — adversary (Claude, growing): 50% recall @ 306 input tokens, 2437ms | local, windowed-only (no fold): 0% recall @ 442 prompt chars, 10908ms | local + surf/fold: 100% recall @ 1679 prompt chars, 16738ms — local+fold context is 0.5x smaller than the adversary's

