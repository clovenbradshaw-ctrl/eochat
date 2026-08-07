# EOChat Browser Affordance Test — Punch List

Produced from an interactive browser test pass: proxy on :11435 serving the
real engine/holonic/citation-check backend, static UI on :8899, and a stub
Ollama server standing in for a real model so request/response plumbing
could be exercised end-to-end rather than just error paths.

**Update (second pass, real local model):** re-run against a real Ollama
instance serving `llama3.2:1b` (a genuinely small CPU model, not the stub)
plus a systematic click-through of every tab and the Entity Explorer ladder.
Items marked **RESOLVED** below were root-caused and fixed in this pass; one
new P0 (the Entity Explorer bug) was found and fixed. Everything else in the
original list is unchanged/unverified this round.

## P0 — Correctness / data integrity

1. **RESOLVED — Chat messages can silently fail to register.** Root cause: a brand-new project has zero conversations, so `switchProject` set `activeSpaceId: null`; sending the first message then posted to `/api/conversations/null/turns`, which 404'd and left the transcript looking stale/empty. Fixed in `switchProject` (`ui/index.html`) — a project with no conversations now gets one created immediately, the same one `+ New chat` would create. (The "conversation state bleeds across projects" half of this item was not reproduced this pass and may already be fixed or may need its own repro.)
2. **Duplicate project names allowed with no disambiguation.** Unchanged — not re-tested this pass.
3. **RESOLVED — Document ingestion status shows "pending" forever, even after folding is possible.** Root cause: `fetchSources()` (`ui/index.html`) warms the entity/fold cache (`warmFolds`) only for sources in the shared default `"corpus"` pool; sources ingested straight into a project's own pool (via the correctly project-scoped `/api/projects/:id/ingest`) were never warmed at all, so `state.folds[name]` never got populated and the Explorer/Outline legend showed `pending` indefinitely — not slow, **never triggered**. Same root cause as #4 below. Fixed by warming project-pool sources too, and by threading the source's own `pool` through every `fetchFold`/`fetchOutline` call site (`/api/fold` and `/api/verbatim/outline` both default to the `"corpus"` pool and 404 on a project-scoped source name otherwise). Manually opening a document in the reader already worked around this some of the time; the automatic on-load warm is what was actually broken and is what a normal user hits first.
4. **RESOLVED — The Entity Explorer (VOID/ENTITY/KIND/FIELD/LINK/NETWORK/ATMOSPHERE/LENS/PARADIGM ladder) showed "0 beings" permanently for any document ingested into a project**, even a document dense with real named entities (verified with a fixture paragraph naming 3 people, 3 places, and 4 organizations). Same root cause as #3 — `fetchFold` never ran for project-pool sources, and when it did run manually it queried the wrong pool and 404'd. After the fix, the same fixture correctly surfaces real entities across every rung. **This is very likely the concrete bug behind "the entity explorer is broken."** Two placeholder pages (`example.com`/`example.org`) legitimately show 0 beings after folding — they have no real content to extract from — so an empty Explorer is not a bug in itself; a folded document with real prose and still 0 beings would be.

## P1 — Misleading / missing user feedback

5. **`proxy · live` status pill conflates "proxy process is up" with "model backend is reachable."** It reads "live" even when Ollama itself is completely unreachable; the user only discovers the real state when a send fails with a raw `(Proxy unavailable — fetch failed)`.
6. **Raw/internal error strings surfaced verbatim to users** — `fetch failed`, `(Proxy unavailable — fetch failed)`, `Plan parsing failed. Model returned: ...` — these are Node/fetch/JSON-parse errors, not user-facing copy.
7. **"Stop generating" button appears to be unconditionally rendered**, not state-gated to "a response is currently streaming." Clicked it at rest (no active generation) and it was present/clickable with no error.
8. **One of Fork / Surf / Regenerate produced a `404 Not Found`** from the proxy in a sequence where the preceding send had already silently failed (see #1) — likely assumes a real prior turn existed when it didn't.
9. **The Documents tab's own "Add documents" button (shown front-and-center in the empty state, copy: "No documents in this project.") does not actually scope the ingest to that project.** It calls the generic, session-scoped `/api/ingest` (client function `ingestSource`), which always lands in the shared default `"corpus"` pool — a global pool every project's Documents tab also merges in unconditionally. The sidebar's separate "Add document to project" (+) button (`addProjectDocument` → `ingestProjectSource` → `/api/projects/:id/ingest`) is the one that's actually project-scoped. Net effect: a document added via the tab's main button is not really "in this project" — it's global and will appear in every other project too, contradicting the empty-state copy. Not fully broken (both paths do list the source and, after the fold fix above, both fold correctly), but confusing and worth unifying on the project-scoped path.

## P2 — Feature fragility

10. **Compose (longform generation) breaks hard on any model that doesn't emit strict JSON for task decomposition.** `/api/holonic` prompts the model to return a JSON array of 2-8 sub-tasks; when the model returned prose instead, the whole feature failed with a raw planner error and no retry/repair-JSON pass or graceful single-shot fallback.
11. **Product-shape issue (per explicit product direction, not a bug):** Compose currently exists as its own top-level tab with a separate input and Generate button. It's meant to be an *invisible* capability of Chat — long-form output should emerge from a normal chat ask when appropriate, not require the user to know a separate mode exists and switch to it.
12. **RESOLVED — A weak/small planner model's malformed JSON reply could force every ordinary chat turn into the expensive multi-section essay pipeline instead of a quick riff.** Reproduced with `llama3.2:1b` answering "hello there": its reply started correctly (`"depth":"riff"`) but then corrupted the JSON by echoing this prompt's own `"riff"|"essay"` type union literally, and the fallback heuristic scanned the model's *raw broken reply* for essay-shaped words — finding the leaked `"essay"` substring and overriding the model's actual (correct) answer. **Fixed** in `parsePlannerReply` (`server/holonic-chat.js`): a `"depth":"riff"` or `"depth":"essay"` field is now salvaged directly out of otherwise-unparseable JSON before falling back to the whole-text keyword scan.
13. **RESOLVED — A "holonic_plan" progress event could crash the whole chat with a raw `.join is not a function` error.** Two different server events share the name `"holonic_plan"`: the initial plan carries `sections` as an array of titles, but the essay-progress echo of the same phase carries `sections` as a plain count (a number). The client's shared log-line formatter assumed it was always an array. **Fixed** in `_holonicLogEntry` (`ui/index.html`) — it now branches on the actual shape.

## P3 — Dependency / resilience

14. **Hard runtime dependency on multiple external CDNs with zero offline/local fallback:** React + ReactDOM (`unpkg.com`), Babel standalone (`unpkg.com`), Google Fonts, Phosphor icon font/CSS (`unpkg.com`), SheetJS/XLSX (CDN, for `.xlsx` parsing), and WebLLM (`esm.run`/jsdelivr for local model mode). In a network-restricted environment the app is a blank page until every one of these is vendored locally. **Partially addressed:** React, ReactDOM, and Babel-standalone — the three hard-required scripts the page cannot boot without — are now vendored under `ui/vendor/` with a CDN fallback (`window.__resources` override in `index.html`); the remaining libraries listed here are all optional/degrade gracefully already and were left on the CDN.
15. **All icon-only buttons render as blank, unlabeled squares when the Phosphor icon font CDN is unreachable.** Send, trash, pencil, paperclip, stop, and every other icon-only control lose their glyph with no text fallback.
16. **A red WebGPU/local-model warning ("WebGPU is present but this device offers no GPU adapter...") renders unconditionally in the main chat composer area**, even in projects where local/WebLLM mode was never touched. Looks like a Senses/WebLLM capability check leaking into the main chat UI instead of staying scoped to Settings → Local model.
17. **Project/conversation state lives entirely in the proxy process's global store with no session/user scoping.** Every browser hitting the same proxy shares the same projects/conversations. Fine for single-user local use; a real gap if ever exposed to more than one person at a time.
18. **At a phone-width viewport (390px), the tab bar (Chat/Documents/Outline/Orbit/Priors/Glass box/Senses/Insights) overflows with no wrap, scroll, or overflow menu** — Glass box, Senses, and Insights are simply unreachable; there's no visual cue that more tabs exist off-screen.

## Confirmed working well

- Project create/switch, sidebar counts, chat rename (via the "Switch chat" dropdown pencil icon) — propagates cleanly to header + sidebar.
- Settings modal: API key fields, provider/model config, local WebLLM download UI.
- File attach-to-composer and the Web-source toggle (visibly highlights, wired to real toggle state).
- **Citation/grounding check is genuinely solid:** when the model fabricated `[1]`/`[2]` citations, eochat correctly flagged both as `⊘ unresolved — no engine passage for [N]` with a clear top-level warning banner. Real anti-hallucination plumbing, not decoration.
- Glass box tab: clean, accurate audit trail of engine actions.
- Instructions editor: modal opens, saves via `PUT /api/projects/:id/instructions`, and is confirmed to reach the model as a folded `EO INSTRUCTION GATE` system-prompt block on the next turn — works end-to-end.
- Fork (creates a distinct forked conversation) and Export-to-Markdown (real file download with a sensible name) both work correctly.
- **Outline, Orbit, Priors, Glass box, Senses, and Insights tabs all render sensible, honest states** against a real (if mostly empty/placeholder) project — no crashes, no raw errors. Orbit correctly shows a loading state for a still-pending document rather than a blank panel; Priors shows the real 1246-prior witness-tier catalog with a working scope toggle; Glass box's audit trail includes genuinely useful "Gap" entries explaining *why* a thin document produced no entities (e.g. "no coref prior for source", "the Ground→Figure gate is not wired to a document") — this is the app being honest about extraction limits, not a bug, and it's what let this pass distinguish "no beings because there's nothing to extract" from the real Entity Explorer bug above. Senses' vision-model library (Screen grounding / General vision / OCR / Object detection) renders correctly with 0 subscribed everywhere, as expected with nothing installed. Insights (Community Insights / structured plan-tracking) renders its ingest-a-plan flow correctly with no fixture loaded.
- A real `llama3.2:1b` chat turn now completes end-to-end through the actual UI with no crash, correct riff-mode routing for ordinary questions, and a visible, if unremarkable, answer — confirmed across 10 sequential turns in one conversation via the backend API and separately through the browser.

## Not yet tested — recommended follow-up

- Recycle bin restore/purge (`d.restore` / `d.purge`, "Empty recycle bin") — still not located/exercised this pass either.
- Priors tab's per-prior subscribe/"activate on ingestion" controls (the top-level scope toggle was exercised; individual prior rows were not).
- Senses install flow (downloading a vision model into the browser) — the catalog view was checked, not an actual install.
- Delete-chat and delete-project confirmation flows.
- Document reader ("Open" button) — the fold/outline fix above touches the same fetch calls the reader's own open-toggle makes, but the reader pane itself (byte-range paging, highlight-jump) was not re-driven this pass.
