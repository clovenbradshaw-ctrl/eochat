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

1. **RESOLVED (proxy path) — Chat messages can silently fail to register.** Root cause: a brand-new project has zero conversations, so `switchProject` set `activeSpaceId: null`; sending the first message then posted to `/api/conversations/null/turns`, which 404'd and left the transcript looking stale/empty. Fixed in `switchProject` (`ui/index.html`) — a project with no conversations now gets one created immediately, the same one `+ New chat` would create. (The "conversation state bleeds across projects" half of this item was not reproduced this pass and may already be fixed or may need its own repro. This is a different code path from the no-proxy/WebLLM bugs found in the follow-up passes below.)
2. ~~**Duplicate project names allowed with no disambiguation.**~~ **Fixed** (see follow-up pass below): `createProject` now auto-suffixes `(2)`, `(3)`, … the same way Finder/Notion do, so rows stay distinguishable without blocking creation.
3. **RESOLVED — Document ingestion status shows "pending" forever, even after folding is possible.** Root cause: `fetchSources()` (`ui/index.html`) warms the entity/fold cache (`warmFolds`) only for sources in the shared default `"corpus"` pool; sources ingested straight into a project's own pool (via the correctly project-scoped `/api/projects/:id/ingest`) were never warmed at all, so `state.folds[name]` never got populated and the Explorer/Outline legend showed `pending` indefinitely — not slow, **never triggered**. Same root cause as #4 below. Fixed by warming project-pool sources too, and by threading the source's own `pool` through every `fetchFold`/`fetchOutline` call site (`/api/fold` and `/api/verbatim/outline` both default to the `"corpus"` pool and 404 on a project-scoped source name otherwise). Manually opening a document in the reader already worked around this some of the time; the automatic on-load warm is what was actually broken and is what a normal user hits first.
4. **RESOLVED — The Entity Explorer (VOID/ENTITY/KIND/FIELD/LINK/NETWORK/ATMOSPHERE/LENS/PARADIGM ladder) showed "0 beings" permanently for any document ingested into a project**, even a document dense with real named entities (verified with a fixture paragraph naming 3 people, 3 places, and 4 organizations). Same root cause as #3 — `fetchFold` never ran for project-pool sources, and when it did run manually it queried the wrong pool and 404'd. After the fix, the same fixture correctly surfaces real entities across every rung. **This is very likely the concrete bug behind "the entity explorer is broken."** Two placeholder pages (`example.com`/`example.org`) legitimately show 0 beings after folding — they have no real content to extract from — so an empty Explorer is not a bug in itself; a folded document with real prose and still 0 beings would be.

## P1 — Misleading / missing user feedback

5. **`proxy · live` status pill conflates "proxy process is up" with "model backend is reachable."** It reads "live" even when Ollama itself is completely unreachable; the user only discovers the real state when a send fails with a raw `(Proxy unavailable — fetch failed)`.
6. **Raw/internal error strings surfaced verbatim to users** — `fetch failed`, `(Proxy unavailable — fetch failed)`, `Plan parsing failed. Model returned: ...` — these are Node/fetch/JSON-parse errors, not user-facing copy.
7. **RESOLVED / not reproduced — "Stop generating" button appears to be unconditionally rendered.** Re-checked with Playwright against the no-proxy path: it's properly gated by `sc-if value="{{ streamingLoading }}"` — Send shows at rest, Stop shows mid-turn, Stop disappears once the turn ends.
8. ~~**One of Fork / Surf / Regenerate produced a `404 Not Found`**~~ **Regenerate and Fork fixed** (see follow-up pass below) for the no-proxy path; Surf not yet checked.
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

## Follow-up pass — browser + WebLLM/no-proxy path (this session)

This environment could not run the real engine/proxy stack at all (server/model-router.js
and server/engine-ground.js statically import `@eoreader/engine`/`@eoreader/host` from a
sibling `../eoreader6` checkout that doesn't exist here, plus the `vendor/eoreader5` and
`vendor/live_priors` git submodules are uninitialized) — so this pass instead exercised
the client-side no-proxy path (`ui/index.html` served standalone, `noProxyMode()` true),
which is also exactly what the GitHub Pages / offline-WebLLM deployment runs. Confirmed
fixed, in the real code, not just retested:

- **#6 (Stop button unconditionally rendered) — already fixed.** It's properly gated by
  `sc-if value="{{ streamingLoading }}"`; verified with Playwright that Send shows at
  rest, Stop shows mid-turn, and Stop disappears once the turn ends.
- **#12 (WebGPU warning leaking into the main composer) — already fixed / not reproduced.**
  The standby-mode WebGPU explanation now stays correctly scoped to Settings → Local
  model; it does not appear in the main chat composer.

New, confirmed bugs found and fixed this pass (all in `ui/index.html` unless noted):

- **`marked` (markdown renderer) loaded from a URL that 404s on every load, for every
  user, regardless of network conditions** — `unpkg.com/marked@15.0.7/lib/marked.umd.min.js`
  is not a file that package version ships (confirmed against unpkg's own file listing).
  The existing `typeof marked === 'undefined'` guard meant this degraded silently to
  literal, unrendered markdown (no bold, no lists, no code blocks) instead of crashing —
  which is presumably why it went unnoticed. Fixed by pointing at
  `unpkg.com/marked@15.0.7/marked.min.js`, which exists and is the same UMD build under a
  different path. Verified before/after: bold, bullets, inline code, and fenced code
  blocks all render correctly now.
- **Every answer from the reader's own connected Ollama instance was mislabeled as coming
  from the in-browser WebLLM model.** `localAskConversation()`'s per-turn `model:`
  attribution and trace only branched on `anthropic` vs. everything else, so an
  Ollama-direct turn showed "via local: Llama-3.2-3B-Instruct-q4f16_1-MLC (WebLLM,
  browser-only)" even though the actual generation came from the reader's own Ollama
  server. Fixed to branch on `ollamaDirect` too and report `ollama: <model>
  (browser-direct, your own Ollama)`.
- **Connecting Ollama never actually pointed the outgoing `/api/chat` request at an
  Ollama model — it silently kept sending the WebLLM model id, which a real Ollama
  server rejects as unknown.** `fetchModels()` fills `state.model` with the WebLLM
  default id as soon as the tab loads (so the Local provider has something to show
  before the reader touches anything). `_doFetchOllamaModels()`'s "fill in a default
  model" step was guarded on `!this.state.model`, which is never true by the time a
  reader connects Ollama, so it never overwrote the stale WebLLM id — every Ollama turn
  went out requesting a model Ollama doesn't have. Fixed the guard to check whether the
  current model is actually one Ollama just reported, defaulting to the first real one
  if not. Verified end-to-end against a stub Ollama server logging the requested model
  name: before the fix it requested `Llama-3.2-3B-Instruct-q4f16_1-MLC`; after, it
  correctly requests the connected instance's own model name.
- **Picking Ollama or Anthropic from the static/no-proxy model picker (Settings → Model)
  never turned the `localModel` flag off**, only `provider`. Since the header pill,
  composer badge, and per-answer attribution all check `localModel` before `provider`
  (by design — see the `modelPickerLabel` comment in the code, which already documents
  fixing this exact confusion for the *toggle* button), the UI kept reading "local model
  · standby" everywhere even after a reader explicitly switched to and successfully
  connected their own Ollama/Anthropic. Actual message routing was unaffected (it checks
  `ollamaDirect`/`anthropic` before `localModel`), but the display was actively
  misleading about which engine was answering. Fixed `staticSelectLocal` /
  `staticSelectAnthropic` / `staticSelectOllama` to set `localModel` accordingly and mark
  `_localModelUserTouched` so the periodic health-check auto-default doesn't flip it back.

- **#2 (duplicate project names) — fixed.** `createProject` now checks the current
  project list (case-insensitive, trimmed) and auto-suffixes ` (2)`, ` (3)`, … on a
  collision instead of creating an indistinguishable duplicate row. Verified in browser:
  creating "Research" three times in a row produced "Research", "Research (2)",
  "Research (3)".

## Follow-up pass — chat back-and-forth (this session)

Drove multi-turn conversation specifically, against a context-echoing stub Ollama server
(one that reports back exactly what it received, so the test verifies the UI sent the
right history rather than just that *a* reply rendered).

- **Multi-turn history threading works correctly.** 3 turns in a row: turn 2's request
  correctly included turn 1's Q+A, turn 3's included both prior turns. No dropped or
  duplicated history within the `LOCAL_HISTORY_TURNS` (6-turn) window.
- **#7 (Regenerate) — fixed, no-proxy path.** `regenerateAnswer()` unconditionally hit
  the proxy-only `/api/conversations/:id/turns/:id/regenerate` endpoint with no
  `noProxyMode()` check, so on local/Ollama-direct/Anthropic-direct turns the fetch
  always failed — caught and logged only to the Glass box's internal activity feed,
  never shown in the transcript. Clicking "regenerate" looked like it did nothing.
  Fixed by giving `localAskConversation()` an `opts.regenerateTurnId` that reuses the
  existing turn in place (same id/position, `a`/`citations` reset, history correctly
  excludes the turn being redone and anything after it) instead of appending a new one,
  and routing `regenerateAnswer()` through it when there's no proxy. Verified against
  the stub server: 2 real `/api/chat` calls, turn count stayed at 1 (in-place replace,
  not a duplicate), answer content updated.
- **#7 (Fork) — fixed, and the root cause was deeper than the proxy call.** Same
  proxy-only-fetch problem as regenerate (`forkSpace()` always POSTed to
  `/api/conversations` with no no-proxy fallback) — but even after adding one, forking
  still looked like a complete no-op: the new space was created and `activeSpaceId` was
  pointed at it, yet the header/transcript kept showing the *pre-fork* conversation.
  Root cause: `activeSpace()` resolves the current space by filtering
  `state.spaces` on `sp.spaceId === activeProjectId` first — every other space-creation
  path (`newConversation`, `updateActiveSpace`'s own fallback) sets `spaceId`, but
  `forkSpace()` never did, on either the proxy or no-proxy path. An orphaned space with
  no `spaceId` can never be found by that filter, so `activeSpace()` silently fell back
  to `scoped[0]` — the original conversation — as if nothing had happened. This means
  **fork has likely never worked as advertised even against the real engine**, not just
  in the no-proxy path (PUNCH-LIST's earlier "confirmed working well" note on fork was
  apparently a case where this didn't surface, or wasn't checked against the sidebar/
  header). Fixed by carrying `spaceId` (and `pool`) forward from the space being forked.
  Verified: after fixing both issues, forking now correctly bumps the sidebar's "Chats"
  count and switches the header/transcript to show the new "<name> (fork)" conversation.
- **Surf not yet tested** (needs a grounded/citation-bearing turn to be meaningful).
- **"Edit & ask again" is a simple compose-box repopulate, not a ChatGPT-style branching
  edit** — it puts the old question text back in the composer for the reader to change
  and re-send; it does not remove the old turn or truncate history after it. Sending the
  edited version appends a *new* turn rather than replacing the old one in place, so a
  correction leaves the original (wrong) Q&A pair visible above it. This may be
  deliberate (simpler, non-destructive), but it reads differently from the "general
  Claude/ChatGPT" edit behavior the task asked about — flagging as a product-direction
  question rather than fixing outright, since removing/rewriting history on edit is a
  larger behavior change than the other fixes in this pass.

## Follow-up pass — more chat back-and-forth bugs (this session, cont'd)

- **Renaming a chat silently reverted itself in the no-proxy path.** `renameConversation`
  optimistically applied the new title, then PATCHed the proxy-only
  `/api/conversations/:id`; on failure (no proxy to hit) it rolled the name back —
  so the reader would watch their new title flash for a moment and silently revert,
  with the only explanation logged to the Glass box, never the visible UI. (Compare
  `renameProject`, which never rolls back — it's fire-and-forget.) Fixed by skipping the
  network call entirely in `noProxyMode()` and treating the local rename as final, same
  as every other local-first write path. Verified: rename now sticks.
- **The "Web" search toggle is inert for Ollama-direct and Anthropic-direct chat, but
  says nothing to indicate this.** The semantic gate that decides whether a turn needs
  live web research (`_webGate`) only ever asks the in-browser WebLLM model to vote —
  never the Ollama or Anthropic model actually answering the turn — so for anyone using
  either of those providers the gate always returns "no verdict," and the old fallback
  message ("no discourse weight required it") made that read as a deliberate judgment
  call instead of "the vote never happened." (Separately, actual web search execution is
  proxy-only — `/api/web-ground` — so even a working gate can't make search function
  without a proxy; `runWebSearch`, used elsewhere for manually adding a web source, has
  a real no-proxy fallback via DuckDuckGo's instant-answer API that this path doesn't
  reuse.) Fixed the misleading message so a null verdict reads honestly as "no engine
  was available to judge whether this needs web research" rather than implying a
  considered "no." Wiring the gate itself (and ideally the actual search) through
  whichever engine/method is actually active is a larger follow-up, not done here.

## Follow-up pass — delete confirmations (this session, cont'd)

- **Deleting an entire chat or an entire project happened instantly on a single click,
  with zero confirmation and no recycle bin.** Every other destructive action in this
  codebase confirms first — deleting a source (`confirm(...)`, and even then it only
  moves to a recoverable recycle bin), permanently purging a source from the recycle
  bin, purging the whole recycle bin, clearing downloaded local models — but
  `deleteConversation`/`deleteProject` (the trash icons in the Chats list and the
  Projects sidebar) had no guard at all: one click, gone, no undo, and for a project
  that means every document and conversation scoped to it. Fixed by adding
  `window.confirm(...)` to both, matching the wording/pattern already used elsewhere.
  Verified both ways: dismissing the confirm leaves the chat/project untouched,
  accepting it deletes as before.

## Follow-up pass — attaching a file in the no-proxy path (this session, cont'd)

- **Attaching a file to a chat message and asking about it was completely non-functional
  with no proxy, and the only feedback was a raw fetch error buried in the Glass box.**
  `uploadFiles()` always calls `_ingestTextContent()`, which POSTs to the proxy-only
  `/api/ingest` — no `noProxyMode()` fallback at all. Every no-proxy attachment failed
  that call, the source row showed a bare `⊘` glyph, and the Glass box's only explanation
  was `Upload failed for "x.txt" — Failed to fetch` (the exact class of raw-error problem
  P1 #5 already names). Worse than misleading feedback: the file's content was then never
  available to the model in any form — `localAskConversation()`'s `groundFailed` fallback
  ("answer from general knowledge") had no path back to the attachment's own text, so a
  file the reader could see sitting in the composer was invisible to every answer.
  Verified end-to-end against a stub server that echoes back its actual received payload:
  before this fix, asking about an attached file containing "The secret code is BANANA42"
  produced zero mention of it anywhere in the system prompt. Fixed two things: (1)
  `_uploadParsedFile` now caches the extracted text in `readerContent` *before* attempting
  ingest (extraction had already succeeded; only the indexing call was the proxy-only
  step), and its catch block distinguishes "no engine to index this" (now: `◐`, "stored in
  this tab — no engine to index it, so it will be included directly") from a real ingest
  failure; (2) a new `_attachmentContextText()` helper folds each attached file's cached
  text directly into the turn's system prompt (capped at 24k chars total, truncated with a
  note beyond that) whenever grounding is unavailable. No chunking, search, or citations —
  just enough for the model to actually see what was attached, the same bar a ChatGPT/
  Claude-style paste-a-file-and-ask-about-it turn needs to clear. Verified: the stub
  server's received system message now contains the attached file's exact text.
- **The same bug (and the same fix) applied to the other three upload paths** —
  `_uploadSpreadsheetBinary` (.xlsx/.xls via SheetJS), `_uploadPDFBinary` (text-layer/OCR),
  and `_uploadImageBinary` (vision senses) each call the same proxy-only
  `_ingestTextContent()` but cached `readerContent` only *after* a successful ingest and
  had no `noProxyMode()` branch in their catch blocks — so a spreadsheet/PDF/image
  attachment lost its already-extracted content on a no-proxy ingest failure exactly the
  way plain text files did, and (for the spreadsheet path specifically) the failure was
  additionally mislabeled as "SheetJS could not read" a file SheetJS had actually parsed
  fine. Applied the identical fix to all three: cache the extracted content before
  attempting to index it, and give each its own honest no-engine status instead of folding
  a proxy-unreachable error into the parser's own failure message.
- **Audited the remaining ~55 `fetch(this.proxyUrl() ...)` call sites for the same
  missing-`noProxyMode()`-guard pattern** (task: systematic sweep). Most are read-only
  polls that are supposed to fail in no-proxy mode (health/status checks, sources/models
  lists) and already degrade correctly. `deleteSource` is worth a note even though it's
  not broken: its confirm text promises "moved to the recycle bin and can be restored
  later," which isn't true in no-proxy mode (the recycle bin is server-side only) — but
  the optimistic client-side removal is safe either way (`fetchSources()`'s catch is a
  silent no-op that never touches the local `sp.sources` the removal edited, so nothing
  flickers back). Priors, Senses, and the recycle bin's own restore/purge are real
  proxy-only features with no offline equivalent conceivable — not bugs, just gaps
  already covered by "Not yet tested" below.

## Not yet tested — recommended follow-up

- Recycle bin restore/purge (`d.restore` / `d.purge`, "Empty recycle bin") — still not located/exercised in any pass so far.
- Priors tab's per-prior subscribe/"activate on ingestion" controls (the top-level scope toggle was exercised; individual prior rows were not).
- Senses install flow (downloading a vision model into the browser) — the catalog view was checked, not an actual install.
- Document reader ("Open"/"Read" button) — the fold/outline fix above touches the same fetch calls the reader's own open-toggle makes, but the reader pane itself (byte-range paging, highlight-jump) was not re-driven in either pass.
- ~~Delete-chat and delete-project confirmation flows.~~ **Tested and fixed** — see follow-up pass below.
- ~~Mobile/narrow-viewport layout.~~ **Tested** — see P3 #18 above (tab bar overflow with no wrap/scroll at 390px).

## Server-side pass, live Ollama backend (2026-08-07) — fixed this session

Found and fixed by exercising real turns against a live local Ollama
(phi4-mini / llama3.2), not the stub server the browser pass above used —
these only show up once real (slow, occasionally noncompliant) model output
is in the loop.

1. **Fixed — ungrounded answers could carry invented `[1][2][3]` citations straight to the reader.** `finalizeAndReview` only ran `validateCitations` (which voids out-of-range brackets) when `maxCitation > 0`; a plain greeting/opinion turn has `maxCitation === 0`, so a model-invented bracket sailed through untouched, then got flagged by review as "unresolved," burning a correction round-trip that usually didn't even remove it. Fixed with a new mechanical `stripUngroundedCitations` (`citation-check.js`) applied whenever there is nothing to cite — same "never trust the model to self-police a bracket" principle `validateCitations` already uses for the grounded case.
2. **Fixed — the review pass flagged `missing_citations` on every ungrounded answer, triggering an expensive correction loop for a violation that never happened.** `core-citation-law.md` is explicit that a turn with no passages should emit *zero* brackets — but `reviewOutput`'s mechanical check only looked at whether the citation-law fold was *active* (always true), never at whether the turn actually had any `groundText` to cite. Root cause of the worst latency seen: a bare "hello?" taking 120–145s because a correction call (non-streaming, on a slow local model) fired to "fix" citations that were never missing. Fixed by gating the check on `groundText.trim()` in `output-review.js`.
3. **Fixed — Ollama/WebLLM prompt drift.** `turn-controller.js` (the Ollama talker) maintained its own hand-copied version of the grounded/ungrounded system prompt instead of calling `engine-ground.js`'s `buildGroundedSystemPrompt`/`buildUngroundedSystemPrompt` — the exact functions `/api/ground` already hands the browser-local WebLLM path. The two copies had already drifted (no anti-boilerplate wording, no tools paragraph). `turn-controller.js` now delegates to the shared functions so both backends answer from byte-identical instruction text.
4. **Fixed (partial, prompt-level) — small local models default to ChatGPT-style assistant boilerplate** ("Hello! How can I assist you with your research today?", "Feel free to ask!", "I'm here to help") on ungrounded/greeting turns, and on at least one llama3.2:latest run wrote a literal unfilled template placeholder into the reply (`"...this conversation about [your selected topic or question]."`). Added an explicit anti-boilerplate + anti-placeholder guard to `buildUngroundedSystemPrompt`/`buildGroundedSystemPrompt` (`engine-ground.js`) and `040-core-style.md`. This is instruction-level, not mechanical — a small enough model can still ignore it; no regex safety net was added because the placeholder shapes are too varied to strip mechanically without risking real content (e.g. code with `array[i]`).
5. **Fixed — no request timeout on either Ollama call path.** Neither `callOllamaStreaming` nor `callModelNonStreaming` had any timeout; a wedged local backend (model-swap contention, an OOM-stalled `llama-server`, a connection accepted but never written to) hung the turn forever with no error and no partial answer. Added an idle timeout to the streaming path (resets on every chunk, so a genuinely long generation is never killed early) and a hard deadline to the non-streaming path. See `OLLAMA_IDLE_TIMEOUT_MS` / `OLLAMA_NON_STREAMING_TIMEOUT_MS` in `turn-controller.js`.
6. **Fixed — a narrow two-fact factual lookup got escalated to a 4-section essay with generic, question-blind section titles, taking ~9 minutes.** Asked "how long does the battery last, and how deep is the sensor rated" against a 377-byte ingested doc; `defineAnswerSpec` (`holonic-chat.js`) came back with no `units` but a `compliance.minWords >= 100`, which alone was enough to trigger `deriveSectionsFromQuestion`'s hardcoded recovery template (`Overview` / `History and Background` / `Key Aspects` / `Current State` / `Importance and Significance`) — a skeleton meant for an open "tell me about X" ask, not a 2-value lookup. Each section then ran its own plan/retrieve/generate/evaluate/reconcile round trip against a slow local model. Fixed by requiring the model's own explicit `depth: "essay"` to trigger the template recovery — `minWords` alone (a real, legitimate "give me a real paragraph, not one line" signal) no longer does.
7. **Fixed — a low-relevance web result could dominate, then completely replace, an otherwise well-grounded essay answer.** Same battery-question probe, run repeatedly: with `webSearch` defaulting to `true` (same default the UI's "Web" toggle ships with), the essay path pulled in unrelated third-party pages ("9V battery lifespan," a "Ring doorbell battery" page) and on one run the final answer never mentioned the ingested product at all — 100% displaced by web content, 24+ minutes, with leaked reconcile-loop meta-commentary ("The previous attempt at this part contained citations that were actually references...") shipped straight into the reply. Root cause was NOT the web-fetch gate (that already only fires when local evidence is "thin," and a test already covers "sufficient local evidence must not trigger web research" — correct as designed). The actual cause was `buildSectionPrompt` handing the writer local and web passages as one undifferentiated `MATERIAL` list with no provenance marker. Fixed by labeling each passage `(your document)` / `(web search)` and instructing the writer to prefer the reader's own document for any claim it covers, using web material only to fill gaps — plus a follow-up fix (below, item 11) once the model started echoing the literal label text into the answer.
8. **Fixed — the learned model-router could keep sampling a fast-but-noncompliant model for grounded/citation-critical generation indefinitely, because its reward signal is pure latency, blind to content quality.** `selectModel`'s heuristic (`proxy.js`) already special-cased grounding markers to force `MEDIUM_MODEL` — but `modelRouter` (a learned bandit, `model-router.js`) is consulted FIRST at both call sites in `turn-controller.js` and only falls back to the heuristic when the router itself is absent, so the heuristic fix never actually ran once the ledger had history for both candidates. This is what let `TINY_MODEL` (`llama3.2:latest`) keep drafing essay sections and unravel across reconcile rounds into 24+ minutes of off-topic, self-contradicting output (see #7) even after the heuristic was "fixed." A model that answers fast but wrong racks up "success" in a latency-only reward signal just as fast as one that answers right. Fixed by exporting `requiresGroundedModel` (`proxy.js`) and calling it directly at both `turn-controller.js` model-selection sites, ahead of `modelRouter.pick` — grounded/essay generation now always gets the medium model, deterministically, never left to the bandit's sampling.
9. **Fixed — the essay per-section leak-check's word list was common English, not leak-specific, and was silently destroying correct, on-topic answers.** `evaluateUnit`'s `LEAK_HARD` regex matched bare `material(s)`, `passage(s)`, `source(s)` anywhere in a section's draft — "the power source is USB-C," "moisture sensor materials," any ordinary technical sentence — and blocked the section outright as a mechanism leak. Confirmed live: a correctly-grounded, on-topic battery/sensor answer was dropped for writing "materials." Fixed by requiring these words to appear with a self-referential qualifier ("the source material," "these passages," "provided material") before counting as a leak; `cited`/`citing`/`citation(s)`/`verbatim` stay bare since those are genuinely near-exclusive to meta-commentary.
10. **Fixed — a tokenization mismatch made every hyphenated proper name in a source document register as "unsupported," dropping otherwise-correct sections.** `specificsResidual`'s evidence-side word extractor included `-` as a word-continuation character, so "Zorbex-9" in the source text tokenized as `zorbex-` (with a dangling hyphen); the draft-side name extractor (`\b[A-Z][a-z]{2,}\b`, no hyphen) produced clean `zorbex` — two strings that could never match as the same set member, so the reader's own product name, verbatim in their own document, was reported as a name "not carried by the evidence." This alone was enough to drop 100%-correct sections after items 6–9 were already fixed. Fixed by dropping `-` from the evidence-side character class so both sides tokenize identically. This is likely to have been silently misfiring on any hyphenated name/spec/model-number in any prior essay answer, not just this test case.
11. **Fixed (minor) — the writer echoed its own provenance labels into the visible answer.** Once item 7's `(your document)` / `(web search)` labels were added, one run wrote `"...as specified by (your document)"` straight into the answer. Added an explicit "those labels are for you only, never write them" line to `buildSectionPrompt`.
12. **Fixed — raw fetch/timeout errors reached the reader verbatim.** A failed turn (Ollama unreachable, or a call that hit the new timeouts in #5) sent `err.message` — `"fetch failed"`, an undici cause code — straight into the chat as the visible failure text (same class of problem as the browser-pass P1 #5 above, confirmed still present in the live turn-failure path specifically). Added `friendlyModelErrorMessage` (`turn-controller.js`), reusing the same causeCode-branching `/api/ollama/models` already used for its setup-guide diagnosis, at all four `runAnswer`/`runSurfAnswer`/`runEssayAnswer` failure sites.
13. **Fixed — the mechanism-leak detector didn't catch the instruction-gate's own header/footer framing text.** A live reply from `llama3.2:latest` echoed `"===== END RULES IN FORCE THIS TURN ====="` (the literal block-boundary text `instruction-gate.js` wraps around the folded-rules system message) directly into the visible answer. `output-review.js`'s `MECHANISM_LEAK` regex had no pattern for it. Added a second regex (`MECHANISM_LEAK_FRAMING`) rather than folding it into the first — `"====="` has no word-character boundary, so it cannot sit inside the first regex's `\b...\b` wrapper.
14. **End-to-end result, same repeated probe (ingest a 377-byte spec doc, ask a 2-fact question about it), before vs. after this session's fixes:** before — routinely 130–1,890 seconds (up to 31 minutes), frequently a wrong-topic answer (generic "9V battery"/"Ring doorbell" web content, zero mention of the actual product) or a completely empty answer ("None of the planned sections passed review"). After items 1–13 above — 80 seconds, correctly cited to the reader's own document, zero gaps, on-topic in both section headers and body. Not a synthetic benchmark: this was the same real local Ollama backend (phi4-mini / llama3.2) throughout, re-run after each fix to confirm it actually moved the needle rather than trusting the diagnosis.
