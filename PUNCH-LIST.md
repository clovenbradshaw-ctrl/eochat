# EOChat Browser Affordance Test — Punch List

Produced from an interactive browser test pass: proxy on :11435 serving the
real engine/holonic/citation-check backend, static UI on :8899, and a stub
Ollama server standing in for a real model so request/response plumbing
could be exercised end-to-end rather than just error paths.

## P0 — Correctness / data integrity

1. **Chat messages can silently fail to register / conversation state bleeds across projects and sessions.** Reproduced repeatedly: switching to a brand-new project with 0 sources still showed an unrelated prior conversation's messages; a freshly typed message never appeared in the transcript at all — the view kept showing a stale conversation instead. Needs root-cause in whichever code path resolves `activeConversationId` relative to `activeProjectId` (`ui/index.html`, `switchProject`/conversation-load path) and on the server in `conversation-store.js` / `/api/conversations/:id`.
2. **Duplicate project names allowed with no disambiguation.** Creating multiple projects with the same name is silently permitted; the sidebar shows indistinguishable rows with no id/date/description to tell them apart.
3. **Document ingestion status shows "pending" with no visible progress, retry, or timeout.** An uploaded file sat at `pending` in the Explorer legend indefinitely with no spinner, ETA, or way to check what it's waiting on.

## P1 — Misleading / missing user feedback

4. **`proxy · live` status pill conflates "proxy process is up" with "model backend is reachable."** It reads "live" even when Ollama itself is completely unreachable; the user only discovers the real state when a send fails with a raw `(Proxy unavailable — fetch failed)`.
5. **Raw/internal error strings surfaced verbatim to users** — `fetch failed`, `(Proxy unavailable — fetch failed)`, `Plan parsing failed. Model returned: ...` — these are Node/fetch/JSON-parse errors, not user-facing copy.
6. **"Stop generating" button appears to be unconditionally rendered**, not state-gated to "a response is currently streaming." Clicked it at rest (no active generation) and it was present/clickable with no error.
7. **One of Fork / Surf / Regenerate produced a `404 Not Found`** from the proxy in a sequence where the preceding send had already silently failed (see #1) — likely assumes a real prior turn existed when it didn't.

## P2 — Feature fragility

8. **Compose (longform generation) breaks hard on any model that doesn't emit strict JSON for task decomposition.** `/api/holonic` prompts the model to return a JSON array of 2-8 sub-tasks; when the model returned prose instead, the whole feature failed with a raw planner error and no retry/repair-JSON pass or graceful single-shot fallback.
9. **Product-shape issue (per explicit product direction, not a bug):** Compose currently exists as its own top-level tab with a separate input and Generate button. It's meant to be an *invisible* capability of Chat — long-form output should emerge from a normal chat ask when appropriate, not require the user to know a separate mode exists and switch to it.

## P3 — Dependency / resilience

10. **Hard runtime dependency on multiple external CDNs with zero offline/local fallback:** React + ReactDOM (`unpkg.com`), Babel standalone (`unpkg.com`), Google Fonts, Phosphor icon font/CSS (`unpkg.com`), SheetJS/XLSX (CDN, for `.xlsx` parsing), and WebLLM (`esm.run`/jsdelivr for local model mode). In a network-restricted environment the app is a blank page until every one of these is vendored locally.
11. **All icon-only buttons render as blank, unlabeled squares when the Phosphor icon font CDN is unreachable.** Send, trash, pencil, paperclip, stop, and every other icon-only control lose their glyph with no text fallback.
12. **A red WebGPU/local-model warning ("WebGPU is present but this device offers no GPU adapter...") renders unconditionally in the main chat composer area**, even in projects where local/WebLLM mode was never touched. Looks like a Senses/WebLLM capability check leaking into the main chat UI instead of staying scoped to Settings → Local model.
13. **Project/conversation state lives entirely in the proxy process's global store with no session/user scoping.** Every browser hitting the same proxy shares the same projects/conversations. Fine for single-user local use; a real gap if ever exposed to more than one person at a time.

## Confirmed working well

- Project create/switch, sidebar counts, chat rename (via the "Switch chat" dropdown pencil icon) — propagates cleanly to header + sidebar.
- Settings modal: API key fields, provider/model config, local WebLLM download UI.
- File attach-to-composer and the Web-source toggle (visibly highlights, wired to real toggle state).
- **Citation/grounding check is genuinely solid:** when the model fabricated `[1]`/`[2]` citations, eochat correctly flagged both as `⊘ unresolved — no engine passage for [N]` with a clear top-level warning banner. Real anti-hallucination plumbing, not decoration.
- Glass box tab: clean, accurate audit trail of engine actions.
- Instructions editor: modal opens, saves via `PUT /api/projects/:id/instructions`, and is confirmed to reach the model as a folded `EO INSTRUCTION GATE` system-prompt block on the next turn — works end-to-end.
- Fork (creates a distinct forked conversation) and Export-to-Markdown (real file download with a sensible name) both work correctly.

## Not yet tested — recommended follow-up

- Recycle bin restore/purge (`d.restore` / `d.purge`, "Empty recycle bin").
- Document reader ("Open"/"Read" buttons opening a source in-line).
- Priors tab toggles (bucket/prior enable, subscribe, "activate on ingestion").
- Senses install flow (downloading a vision model into the browser).
- Mobile/narrow-viewport layout — several `eo-mobile-only` buttons exist in the DOM but were never exercised at a narrow viewport.
- Delete-chat and delete-project confirmation flows.
