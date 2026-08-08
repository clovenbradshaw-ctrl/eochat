// Local mode for eochat: a small instruct model running entirely in this tab
// via WebLLM/WebGPU, answering over the same evidence engineGroundQuery
// retrieves server-side — no Ollama, no proxy generation call. Loaded as a
// plain <script type="module">, not bundled, so it can be dropped next to
// index.html and served as-is (see ui/README-less setup: `npm run ui`).
//
// window.EOWebLLM is the integration point: index.html's Component class is
// eval'd as an ordinary script (dc-runtime's evalDcLogic — see support.js),
// not a module, so it can only reach this through a global, not an import.
//
// Default model: the 3B instruct tier of WebLLM's prebuilt catalog —
// Llama-3.2-3B-Instruct-q4f16_1-MLC (~2.3GB VRAM, ~2GB download). Nothing
// smaller survives a real reading question well. On the static (GitHub Pages)
// build this download is the entire answer path, so it starts automatically
// the moment the page mounts.
//
// Resilience: a multi-GB in-browser download over WebGPU has a lot of ways to
// fail (no WebGPU, no adapter, a flaky CDN shard) that have nothing to do
// with whether the reader can be helped at all. Rather than a status of
// 'error'/'unsupported' that dead-ends the UI, every such failure lands in
// 'standby' — see _enterStandby below — where a zero-dependency
// StandbyResponder answers basic back-and-forth instead of throwing, and a
// background timer keeps quietly retrying the real model on a growing
// backoff for as long as the tab stays open. There is no terminal failure
// state; there is only "not up yet."
//
// Off the main thread: the engine itself runs in webllm-worker.js via
// CreateWebWorkerMLCEngine, not inline via CreateMLCEngine. Shader
// compilation and generation are heavy enough to jank the UI thread while
// running there, and — the part that actually motivates this — a WebGPU
// device the browser reclaims mid-answer (low memory, a backgrounded tab, a
// driver reset; see mlc-ai/web-llm#647) only takes the worker down. The
// client below terminates and rebuilds that worker and routes to standby
// instead of the page hanging or the failure surfacing as an uncaught error.
const DEFAULT_MODEL_ID = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

// The models a reader may install, smallest first. These are prebuilt WebLLM
// ids; the catalog is intersected with the module's own prebuiltAppConfig at
// runtime (see refreshCatalog), so an id that a future web-llm release drops
// disappears from the picker instead of failing at download time.
//
// Only ONE of these is ever on disk at a time. Weights are gigabytes, and the
// browser's storage quota is shared with everything else this origin keeps
// (documents, chats); silently accumulating four models would evict that data
// out from under the reader. selectModel() therefore purges every other
// model's cache entries BEFORE the new download starts — the space has to be
// free first, or the new fetch is what hits the quota wall.
const MODEL_CATALOG = [
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B", size: "~0.9 GB", note: "Fastest, lightest. Fine for short questions; loses the thread on long sources." },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 1.5B", size: "~1.1 GB", note: "Small but stronger than 1B at following instructions." },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B", size: "~1.6 GB", note: "Careful, quotes its sources closely." },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", size: "~2.3 GB", note: "The default. Best balance of reading quality and download size." },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 3B", size: "~2.5 GB", note: "Comparable to the default; better at structured answers." },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi 3.5 mini", size: "~2.6 GB", note: "3.8B. Strong reasoning for its size, slower per token." },
  { id: "Llama-3.1-8B-Instruct-q4f16_1-MLC", label: "Llama 3.1 8B", size: "~5.0 GB", note: "Best answers here, but needs a large-memory GPU (~6GB VRAM)." },
];

// Where the reader's choice survives a reload. Weights live in the browser's
// Cache API; this is only the pointer to which one they picked.
const MODEL_PREF_KEY = "eochat.webllm.modelId";

function readStoredModelId() {
  try {
    const stored = localStorage.getItem(MODEL_PREF_KEY);
    if (stored && MODEL_CATALOG.some((m) => m.id === stored)) return stored;
  } catch { /* private mode / storage disabled — fall through to the default */ }
  return DEFAULT_MODEL_ID;
}

function writeStoredModelId(id) {
  try { localStorage.setItem(MODEL_PREF_KEY, id); } catch { /* not fatal: the choice just won't survive reload */ }
}

// Reader-chosen display names, keyed by catalog model id — e.g. "my fast
// model" instead of "Llama-3.2-1B-Instruct-q4f16_1-MLC". Cosmetic only: the
// id used to fetch/select/purge is never touched, so a nickname can never
// point at the wrong weights. Kept as a map (not one value) so a nickname
// survives switching away from that model and back.
const NICKNAME_KEY = "eochat.webllm.nicknames";

function readStoredNicknames() {
  try {
    const raw = JSON.parse(localStorage.getItem(NICKNAME_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function writeStoredNicknames(map) {
  try { localStorage.setItem(NICKNAME_KEY, JSON.stringify(map)); } catch { /* not fatal */ }
}

// esm.run (jsdelivr) serves an ESM build with no bundler required — the
// WebLLM README's own documented no-build integration path.
//
// PINNED, deliberately. An unversioned specifier ("…/@mlc-ai/web-llm") resolves
// to whatever MLC published most recently, so every page load is a silent
// upgrade: an upstream regression, a renamed export, or a prebuilt-catalog
// change reaches readers with no commit on this end and no way to tell a new
// bug from an old one. The version moves when someone bumps it here and
// re-tests, not when jsdelivr's cache expires.
//
// webllm-worker.js imports the same build and MUST stay on the same version —
// two copies of web-llm in one page is a config/protocol mismatch waiting to
// happen. Its import is static (no top-level await, so no window where a
// message could arrive before the handler is installed), which means the
// version is written out twice, spelled the same way in both files;
// scripts/test-webllm-client.mjs asserts the two agree so the pair can't
// drift. Bump both together.
const WEBLLM_MODULE_URL = "https://esm.run/@mlc-ai/web-llm@0.2.84";

// The worker script the engine actually runs in — see the header comment
// above. Resolved relative to this module (not the page) so it keeps working
// regardless of what URL index.html itself is served from.
const WEBLLM_WORKER_URL = new URL("./webllm-worker.js", import.meta.url);

// WebLLM's own MLCEngine watches for the WebGPU device being reclaimed by the
// browser and unloads itself when it happens (mlc-ai/web-llm#647); the next
// call against that engine then throws. Errors crossing the worker's
// postMessage RPC boundary don't reliably keep their subclass identity —
// structured clone flattens custom Error subclasses to a plain Error — so
// match on both the exported class name (works same-thread) and the message
// text WebLLM ships for DeviceLostError (survives the clone).
function isDeviceLostError(err) {
  if (!err) return false;
  const name = err.name || "";
  const message = err.message || String(err);
  return name === "DeviceLostError" || /device (was |is )?lost/i.test(message);
}

// The download is many sharded fetches over a CDN; a transient failure on
// one shard is common and not evidence the model can never load here. Each
// attempt after the first benefits from whatever the browser's Cache API
// backend (WebLLM's default cacheBackend) already committed to disk, so a
// retry is usually resuming, not restarting.
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 7000];

// How long a stopped generation gets to wind itself down before we treat the
// engine as wedged — see _interruptAndDrain. The work left after an interrupt
// is at most "finish the in-flight forward pass, emit the closing chunks",
// which is sub-second while decoding; the ceiling is generous only because an
// interrupt landing during prefill has to wait that prefill out, and a long
// prompt on a slow GPU can make that several seconds. Anything past this is
// not slowness, it's a stall.
const INTERRUPT_DRAIN_TIMEOUT_MS = 30000;

// Once those in-init() attempts are exhausted (or WebGPU is missing outright)
// the reader is handed to standby mode — but this module keeps trying the
// real model in the background forever, on a slow-growing backoff, rather
// than requiring a manual click. Cheap either way: a blocked-WebGPU recheck
// is a single requestAdapter() call, and a download retry resumes from
// whatever the Cache API already committed (see the MAX_LOAD_ATTEMPTS
// comment above) — this is that same reasoning applied on a longer clock.
const STANDBY_RETRY_BASE_MS = 20000;
const STANDBY_RETRY_MAX_MS = 300000;

// Why local mode can be off. The three common reasons look nothing alike to
// a reader — a browser with WebGPU disabled, a page served over plain http
// (WebGPU requires a secure context), and a GPU that offers no adapter are
// all "the model didn't load" from the reader's chair. Report which one, with
// the specific fix, instead of one generic wall of text.
function webgpuReadiness() {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return { ok: false, key: "not-a-browser", hint: "This page is not running in a browser, so the in-tab model cannot load." };
  }
  if (window.isSecureContext === false) {
    return { ok: false, key: "insecure-context", hint: "WebGPU only runs in a secure context (https:// or http://localhost). This page is served over plain http — serve it over https and reload." };
  }
  if (!navigator.gpu) {
    return { ok: false, key: "no-webgpu", hint: "This browser exposes no WebGPU, which the in-tab model needs. In Chrome/Edge, turn on hardware acceleration (Settings → System) and check chrome://gpu; WebLLM does not run in Firefox at all. Then reload this tab." };
  }
  return { ok: true, key: "webgpu" };
}

let webllmModulePromise = null;
function loadWebLLMModule() {
  if (!webllmModulePromise) webllmModulePromise = import(WEBLLM_MODULE_URL);
  return webllmModulePromise;
}

// The reader must never be left with a hard dead end just because a multi-GB
// download failed or this device has no WebGPU. StandbyResponder is the
// bottom rung of that ladder: zero download, zero GPU, zero dependency on
// anything that can fail — a handful of pattern-matched replies plus one
// honest "the real model isn't up yet, here's why, it's retrying" message.
// It is not a language model; it is a circuit breaker with a bedside manner,
// so `.stream()` always has *something* to hand back instead of throwing.
const STANDBY_GREETING = /^(hi|hello|hey|yo|good (morning|afternoon|evening))\b[!.,]*$/i;
const STANDBY_THANKS = /\b(thanks|thank you|thx|ty)\b/i;
const STANDBY_FAREWELL = /^(bye|goodbye|see ya|later|night)\b[!.,]*$/i;
const STANDBY_WHOAMI = /\b(who are you|what are you|are you (a )?(bot|ai|model)|what('s| is) your name)\b/i;
const STANDBY_CAPABILITY = /\b(what can you do|what can i ask|help me|how does this work)\b/i;
const STANDBY_AFFIRM = /^(ok(ay)?|yes|yep|sure|got it|understood|cool|alright)\b[!.,]*$/i;

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user" && typeof messages[i].content === "string") {
      return messages[i].content.trim();
    }
  }
  return "";
}

// `reason` is whatever LocalModel recorded as why the real model isn't up
// (download failure text, "no WebGPU", etc.) — always spoken plainly rather
// than glossed over, so standby mode never reads as the real model being
// slow or dim.
function standbyReply(question, reason) {
  const q = question || "";
  if (STANDBY_GREETING.test(q)) return "Hello. The full local model isn't up yet, so I'm just a lightweight standby for now — ask me anything simple, or wait a moment for the real thing to finish loading.";
  if (STANDBY_FAREWELL.test(q)) return "Goodbye for now.";
  if (STANDBY_THANKS.test(q)) return "You're welcome.";
  if (STANDBY_WHOAMI.test(q)) return "I'm a standby responder — a small set of canned replies, not a language model. The real local model is unavailable right now" + (reason ? ` (${reason})` : "") + "; it's retrying in the background and I'll step aside the moment it's ready.";
  if (STANDBY_CAPABILITY.test(q)) return "Not much, honestly — I can only manage this kind of short exchange until the real local model loads. It's retrying automatically in the background; check Settings → Local model for its status, or try a smaller model from the picker there.";
  if (STANDBY_AFFIRM.test(q)) return "Noted.";
  if (/\?\s*$/.test(q)) {
    return "I can't actually answer that — the real local model isn't loaded yet" + (reason ? ` (${reason})` : "") + ", and I'm only a standby with a few canned replies, not a model that can read or reason. It's retrying in the background; try again shortly, or open Settings → Local model to check progress or pick a smaller model.";
  }
  return "The local model is still unavailable" + (reason ? ` (${reason})` : "") + ". I'm a lightweight standby, not the real thing — it's retrying automatically, so this should resolve on its own. You can also check Settings → Local model.";
}

class StandbyResponder {
  async *stream(messages, { signal } = {}) {
    const text = standbyReply(lastUserText(messages), this.reason);
    // A light word-by-word cadence rather than dumping the whole string at
    // once — mid-turn, both read the same as an engine actually thinking,
    // and instant walls of text elsewhere in the UI are a "did this really
    // run?" signal readers have learned to distrust.
    const words = text.split(/(?<=\s)/);
    for (const w of words) {
      if (signal && signal.aborted) return;
      yield w;
      await new Promise((r) => setTimeout(r, 18));
    }
  }
}

class LocalModel {
  constructor() {
    this.modelId = readStoredModelId();
    this.nicknames = readStoredNicknames();
    this.engine = null;
    // The Worker the engine RPCs into — see WEBLLM_WORKER_URL. Owned
    // one-to-one with `engine`: created fresh each load attempt, terminated
    // in unload() and whenever the engine is discarded (a failed attempt, a
    // lost device), so a dead worker is never reused for a retry.
    this.worker = null;
    // Catalog rows as the picker sees them: the static entries above plus
    // whether each is already on disk. Filled by refreshCatalog(); until then
    // `cached` is null, meaning "not looked yet", which the UI renders as
    // silence rather than as "not installed".
    this.catalog = MODEL_CATALOG.map((m) => ({ ...m, cached: null }));
    // Bytes this origin is using / is allowed, from navigator.storage.estimate().
    // Null when the browser does not expose it.
    this.storage = null;
    // idle -> loading -> ready, or idle -> loading -> standby.
    // "standby" is never terminal: a background timer (_scheduleStandbyRetry)
    // keeps quietly re-attempting the real model on a growing backoff, and
    // init() may also be called directly (the UI's retry button does this).
    // There is deliberately no permanent "unsupported"/"error" dead end — see
    // _enterStandby.
    this.status = "idle";
    this.progress = { text: "", percent: 0 };
    this.error = null;
    // Why the real model isn't currently active. Same text as `error` for a
    // failed download, but also set for hard blockers (no WebGPU, insecure
    // context) that never populate `error` today — standby mode needs a
    // reason to show regardless of which branch produced it.
    this.standbyReason = null;
    this.standby = new StandbyResponder();
    this._listeners = new Set();
    this._loading = null; // in-flight init() promise, so concurrent callers share one attempt
    this._standbyRetryTimer = null;
    this._standbyRetryDelayMs = STANDBY_RETRY_BASE_MS;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snap = this.snapshot();
    for (const fn of this._listeners) {
      try { fn(snap); } catch (e) { console.error("[webllm-client] listener threw", e); }
    }
  }

  snapshot() {
    return {
      status: this.status,
      progress: this.progress,
      error: this.error,
      standbyReason: this.standbyReason,
      modelId: this.modelId,
      nickname: this.nicknames[this.modelId] || null,
      catalog: this.catalog.map((m) => ({ ...m, active: m.id === this.modelId, nickname: this.nicknames[m.id] || null })),
      storage: this.storage,
    };
  }

  // The reader's own name for a model, when they've set one, else the
  // catalog's stock label. Used everywhere a model is displayed — the
  // Settings picker, the composer status line, the model chip — so renaming
  // it once changes it everywhere at once.
  modelLabel(id) {
    const key = id || this.modelId;
    const nick = this.nicknames[key];
    if (nick) return nick;
    const row = MODEL_CATALOG.find((m) => m.id === key);
    return row ? row.label : key;
  }

  // Set or clear (empty/whitespace-only name) the reader's nickname for a
  // catalog model. Purely cosmetic — does not touch the cache, the active
  // model, or anything selectModel() cares about.
  setNickname(id, name) {
    const trimmed = (name || "").trim();
    if (trimmed) this.nicknames[id] = trimmed;
    else delete this.nicknames[id];
    writeStoredNicknames(this.nicknames);
    this._emit();
  }

  // Which models are actually on disk, and how much room this origin has left.
  // Best-effort throughout: a browser that blocks the Cache API or does not
  // implement StorageManager leaves the fields null rather than erroring, so
  // the picker still works — it just cannot say "already downloaded".
  async refreshCatalog() {
    try {
      const webllm = await loadWebLLMModule();
      const known = webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list
        ? new Set(webllm.prebuiltAppConfig.model_list.map((m) => m.model_id))
        : null;
      const rows = [];
      for (const m of MODEL_CATALOG) {
        // A build of web-llm that no longer ships this id would fail at
        // download time; drop it from the picker instead.
        if (known && !known.has(m.id)) continue;
        let cached = null;
        try {
          if (typeof webllm.hasModelInCache === "function") cached = await webllm.hasModelInCache(m.id);
        } catch { /* cache unreadable — leave unknown */ }
        rows.push({ ...m, cached });
      }
      if (rows.length) this.catalog = rows;
    } catch (e) {
      console.warn("[webllm-client] could not read the model cache:", e);
    }
    await this._refreshStorage();
    this._emit();
    return this.snapshot();
  }

  async _refreshStorage() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        this.storage = { usage: est.usage || 0, quota: est.quota || 0 };
      }
    } catch { this.storage = null; }
  }

  // Delete every cached model except `keepId`. This is the "wipe the old one"
  // half of installing a new model, and it runs BEFORE the new download so the
  // freed space is what the download uses. Deleting a model that was never
  // cached is a no-op, so this is safe to call unconditionally.
  async purgeOthers(keepId) {
    const keep = keepId || this.modelId;
    let freed = 0;
    try {
      const webllm = await loadWebLLMModule();
      if (typeof webllm.deleteModelAllInfoInCache !== "function") return freed;
      for (const m of this.catalog) {
        if (m.id === keep) continue;
        if (m.cached === false) continue; // known-absent: nothing to delete
        try {
          await webllm.deleteModelAllInfoInCache(m.id);
          if (m.cached) freed++;
          m.cached = false;
        } catch (e) {
          console.warn(`[webllm-client] could not evict ${m.id}:`, e);
        }
      }
    } catch (e) {
      console.warn("[webllm-client] purge skipped — WebLLM module unavailable:", e);
    }
    await this._refreshStorage();
    this._emit();
    return freed;
  }

  // Delete every cached model, including the active one, and drop the engine.
  // The reader's escape hatch when the browser is out of room.
  async purgeAll() {
    await this.unload();
    try {
      const webllm = await loadWebLLMModule();
      if (typeof webllm.deleteModelAllInfoInCache === "function") {
        for (const m of this.catalog) {
          try { await webllm.deleteModelAllInfoInCache(m.id); m.cached = false; } catch { /* best effort */ }
        }
      }
    } catch (e) {
      console.warn("[webllm-client] purge-all skipped:", e);
    }
    await this._refreshStorage();
    this._emit();
    return this.snapshot();
  }

  // Install a different model: tear the running engine down, free the disk the
  // other models were holding, then download and load the new one. Selecting
  // the model that is already loaded is a no-op rather than a re-download.
  async selectModel(id) {
    const row = MODEL_CATALOG.find((m) => m.id === id);
    if (!row) throw new Error(`Unknown local model: ${id}`);
    if (id === this.modelId && this.status === "ready") return this.snapshot();

    // Any in-flight load is for the old model; let it settle before swapping
    // the id out from under it, so its callbacks cannot report progress
    // against a model the reader has already moved off.
    if (this._loading) {
      try { await this._loading; } catch { /* its own failure is already recorded */ }
    }

    await this.unload();
    this.modelId = id;
    writeStoredModelId(id);
    this.status = "loading";
    this.progress = { text: `Clearing space (removing other models)…`, percent: 0 };
    this._emit();

    await this.purgeOthers(id);
    return this.init();
  }

  // A reader- or timer-driven attempt at the real model. Called directly by
  // the UI's retry button (deliberate — resets the backoff) and by
  // _scheduleStandbyRetry (background — keeps the backoff growing). Either
  // way it's safe to call from any status: 'ready' short-circuits, and a
  // second concurrent call joins the same in-flight attempt.
  async init() {
    if (this.status === "ready") return this.snapshot();
    if (this._loading) return this._loading;
    this._loading = this._runInit().finally(() => { this._loading = null; });
    return this._loading;
  }

  // Same as init(), but for the reader's own "try again" click: cancels any
  // pending background retry and restarts the backoff from the base delay, so
  // one manual click doesn't inherit a five-minute wait a quiet failure
  // earlier had already grown into.
  retryNow() {
    this._clearStandbyRetry();
    this._standbyRetryDelayMs = STANDBY_RETRY_BASE_MS;
    return this.init();
  }

  _clearStandbyRetry() {
    if (this._standbyRetryTimer) {
      clearTimeout(this._standbyRetryTimer);
      this._standbyRetryTimer = null;
    }
  }

  // Tear down the worker the engine (if any) is running in. Always safe to
  // call — a worker in a bad state (crashed, device lost, mid-attempt
  // failure) must never be handed to the next load attempt or left running
  // after unload(), so every path that discards `engine` discards `worker`
  // with it.
  _terminateWorker() {
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* best effort */ }
      this.worker = null;
    }
  }

  // The one and only way this module gives up on the real model for now. It
  // never gives up permanently: a background timer keeps re-attempting on a
  // slow-growing backoff (capped at STANDBY_RETRY_MAX_MS) for as long as the
  // reader leaves the tab open, so a driver update, a flipped browser flag, or
  // a network blip that resolves itself all self-heal without anyone coming
  // back to click retry.
  _enterStandby(reason) {
    this.engine = null;
    this.status = "standby";
    this.standbyReason = reason;
    this.standby.reason = reason;
    this.progress = { text: "", percent: 0 };
    this._emit();
    this._scheduleStandbyRetry();
  }

  _scheduleStandbyRetry() {
    this._clearStandbyRetry();
    const delay = this._standbyRetryDelayMs;
    this._standbyRetryTimer = setTimeout(() => {
      this._standbyRetryTimer = null;
      this._standbyRetryDelayMs = Math.min(this._standbyRetryDelayMs * 2, STANDBY_RETRY_MAX_MS);
      // Only worth attempting if the reader hasn't since moved on (unload()
      // clears the timer, so status would already be 'idle' here — this
      // guard is belt-and-suspenders against a race between the two).
      if (this.status === "standby") this.init();
    }, delay);
  }

  async _runInit() {
    const readiness = webgpuReadiness();
    if (!readiness.ok) {
      this._enterStandby(readiness.hint);
      return this.snapshot();
    }

    // The WebGPU API existing does not mean an adapter can be created
    // (headless Chrome, GPU blocklisted, hardware acceleration off). Fail
    // fast with the specific reason rather than letting CreateWebWorkerMLCEngine
    // throw after the download has already started.
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        this._enterStandby("WebGPU is present but this device offers no GPU adapter — usually hardware acceleration being off or the GPU being blocklisted. Turn hardware acceleration on and reload.");
        return this.snapshot();
      }
    } catch (adapterErr) {
      this._enterStandby("WebGPU adapter could not be created: " + ((adapterErr && adapterErr.message) || adapterErr));
      return this.snapshot();
    }

    this.status = "loading";
    this.error = null;
    this.standbyReason = null;
    this.progress = { text: "Starting…", percent: 0 };
    this._emit();

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
      try {
        const webllm = await loadWebLLMModule();
        // A fresh worker per attempt — see _terminateWorker: an attempt that
        // failed partway through model load can leave its worker in an
        // unknown state, so the next attempt never reuses one.
        this._terminateWorker();
        this.worker = new Worker(WEBLLM_WORKER_URL, { type: "module" });
        this.worker.onerror = (event) => {
          if (this.status !== "ready" && this.status !== "loading") return;
          console.error("[webllm-client] worker crashed:", (event && event.message) || event);
          this._terminateWorker();
          this._enterStandby("The in-tab model's background worker crashed" + (event && event.message ? `: ${event.message}` : "") + ".");
        };
        const engine = await webllm.CreateWebWorkerMLCEngine(this.worker, this.modelId, {
          initProgressCallback: (report) => {
            this.progress = {
              text: report && report.text ? report.text : "Downloading…",
              percent: Math.round(((report && report.progress) || 0) * 100),
            };
            this._emit();
          },
        });
        this.engine = engine;
        this.status = "ready";
        this.progress = { text: "Ready", percent: 100 };
        this.error = null;
        this.standbyReason = null;
        this._standbyRetryDelayMs = STANDBY_RETRY_BASE_MS;
        this._clearStandbyRetry();
        const row = this.catalog.find((m) => m.id === this.modelId);
        if (row) row.cached = true;
        this._emit();
        this._refreshStorage().then(() => this._emit());
        return this.snapshot();
      } catch (err) {
        lastErr = err;
        console.error(`[webllm-client] load attempt ${attempt + 1}/${MAX_LOAD_ATTEMPTS} failed:`, err);
        this.engine = null;
        this._terminateWorker();
        if (attempt < MAX_LOAD_ATTEMPTS - 1) {
          const wait = RETRY_BACKOFF_MS[attempt] || 5000;
          this.progress = { text: `Download failed — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${MAX_LOAD_ATTEMPTS})…`, percent: 0 };
          this._emit();
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }

    this.error = (lastErr && lastErr.message) || "Model download failed after retrying.";
    this._enterStandby(this.error);
    return this.snapshot();
  }

  // Stop a generation and let the engine finish tearing it down. This is the
  // whole reason "Stop" used to hang the next question, so it's worth being
  // precise about the mechanics:
  //
  // WebLLM serializes every request to a model behind an FCFS lock
  // (mlc-ai/web-llm#549 — a model physically cannot run two overlapping
  // generations). chatCompletion() acquires that lock BEFORE it hands back the
  // streaming iterator, and the lock is released at the very bottom of the
  // iterator's own body. There is no try/finally around it. So a caller that
  // simply walks away from the iterator — `break`, an early `return`, dropping
  // it on abort — leaves the lock held with nothing left running to release
  // it, and the NEXT create() call blocks on acquire() forever. Not slow:
  // stopped, until the page reloads.
  //
  // The worker split makes it strictly worse rather than better. The real
  // generator lives in the worker, and the main thread only holds a proxy that
  // asks for one chunk per postMessage; there is no "close the generator" RPC
  // in the protocol at all, so abandoning the proxy cannot even in principle
  // reach the generator holding the lock.
  //
  // The only exit that actually releases it is to let the generator finish:
  // interruptGenerate() sets the flag its decode loop checks, then we keep
  // pulling chunks (discarding them) until it reports done and runs its own
  // release. That's what this does — interrupt, then drain, bounded by
  // INTERRUPT_DRAIN_TIMEOUT_MS so a genuinely stuck engine can't hang the stop
  // path too. A drain that times out means the lock is unrecoverable, which
  // leaves exactly one honest move: throw the worker away and rebuild, which
  // standby's retry loop does on its own.
  async _interruptAndDrain(iterator) {
    try {
      // WebWorkerMLCEngine's interruptGenerate() is fire-and-forget (it posts
      // the message and drops the promise), so this await returns immediately
      // on the worker path — the drain below is what actually waits.
      if (this.engine) await this.engine.interruptGenerate();
    } catch (e) {
      console.warn("[webllm-client] interruptGenerate failed:", e);
    }

    let timer = null;
    const TIMED_OUT = Symbol("drain-timeout");
    // A rejection thrown out of the generator is fine and needs no handling:
    // WebLLM releases the lock on its own error paths before rethrowing, so
    // the thing we came here to guarantee already happened.
    const drained = (async () => { while (!(await iterator.next()).done) { /* discard */ } })()
      .catch(() => {});
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => reject(TIMED_OUT), INTERRUPT_DRAIN_TIMEOUT_MS);
    });

    try {
      await Promise.race([drained, expiry]);
    } catch (err) {
      if (err !== TIMED_OUT) throw err;
      console.error("[webllm-client] interrupted generation did not wind down; rebuilding the engine.");
      this._terminateWorker();
      this._enterStandby("The in-tab model stopped responding after a generation was interrupted. Reloading it.");
    } finally {
      clearTimeout(timer);
    }
  }

  // Streams completion text deltas. In 'ready' status this is the real model;
  // in 'standby' status (WebGPU missing, download failed — see _enterStandby)
  // it's the zero-dependency canned responder instead of a thrown error, so a
  // caller that already treats 'standby' as answerable never has to special-
  // case the failure. Callers that require the real model (tool-executing
  // agent runs, the fidelity-checked long-form pipeline) should keep gating
  // on status === 'ready' before calling this at all.
  //
  // Stopping is the caller's `signal` and nothing else — every caller already
  // passes one (the chat composer's Stop button, the web gate's timeout, the
  // eoCode run panel, the long-form pipeline's deadline), and each of the
  // three ways a caller can walk away — aborting the signal, `break`ing out of
  // the `for await`, or returning from inside it — lands in the same finally
  // below and gets the same interrupt-and-drain. No call site has to know the
  // engine has a lock in it.
  async *stream(messages, { signal } = {}) {
    if (this.status === "standby") {
      yield* this.standby.stream(messages, { signal });
      return;
    }
    if (this.status !== "ready" || !this.engine) {
      throw new Error("Local model is not ready — call init() first.");
    }
    // Non-null exactly while the engine's generator may still be holding the
    // model lock; cleared on every path where WebLLM has already released it
    // (ran to completion, or threw).
    let pending = null;
    let onAbort = null;
    try {
      const chunks = await this.engine.chat.completions.create({
        messages,
        stream: true,
        temperature: 0.4,
      });
      // Driven by hand rather than with `for await`, which is not a style
      // choice: `for await` calls .return() on the iterator when the loop
      // exits early, and unwinding this generator would fire that BEFORE the
      // finally below could interrupt — closing the proxy while the worker's
      // generator keeps the lock, the one state there is no recovery from.
      const iterator = typeof chunks[Symbol.asyncIterator] === "function"
        ? chunks[Symbol.asyncIterator]()
        : chunks;
      pending = iterator;

      // Interrupt the moment the signal fires instead of at the next chunk
      // boundary. Waiting for the loop to notice would mean an abort during a
      // long prefill sits unheard until the first token arrives — the reader
      // clicks Stop and watches text keep coming.
      if (signal) {
        onAbort = () => {
          try { if (this.engine) this.engine.interruptGenerate(); }
          catch (e) { console.warn("[webllm-client] interruptGenerate on abort failed:", e); }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      while (true) {
        const next = await iterator.next();
        if (next.done) {
          pending = null; // ran out on its own: WebLLM released the lock
          break;
        }
        if (signal && signal.aborted) break; // -> finally interrupts and drains
        const chunk = next.value;
        const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (delta) yield delta;
      }
    } catch (err) {
      // Every throw out of WebLLM releases the lock before it propagates, so
      // there is nothing left to drain — and the engine may well be gone.
      pending = null;
      if (signal && signal.aborted) return;
      // Mid-answer engine failures — chiefly the WebGPU device getting
      // reclaimed by the browser (mlc-ai/web-llm#647) — surface here as a
      // rejected/thrown call on an engine WebLLM has already unloaded
      // internally. Rather than let that throw reach the caller as a broken
      // turn, drop to standby and finish this same answer from there: the
      // reader sees a plain-spoken "the model dropped" reply instead of a
      // thrown error, and the background retry loop takes it from here.
      console.error("[webllm-client] stream failed, falling back to standby:", err);
      const reason = isDeviceLostError(err)
        ? "The GPU device was lost mid-answer, usually from low memory or a driver reset — " + ((err && err.message) || "device lost")
        : ((err && err.message) || String(err));
      this._terminateWorker();
      this._enterStandby(reason);
      yield* this.standby.stream(messages, { signal });
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (pending) await this._interruptAndDrain(pending);
    }
  }

  async unload() {
    this._clearStandbyRetry();
    this._standbyRetryDelayMs = STANDBY_RETRY_BASE_MS;
    if (this.engine) {
      try { await this.engine.unload(); } catch { /* best-effort teardown */ }
    }
    this.engine = null;
    this._terminateWorker();
    this.status = "idle";
    this.progress = { text: "", percent: 0 };
    this.error = null;
    this.standbyReason = null;
    this._emit();
  }
}

window.EOWebLLM = new LocalModel();
