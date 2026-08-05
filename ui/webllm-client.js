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
const DEFAULT_MODEL_ID = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

// The fast lane: used by initSmart() to get the reader a working model in
// well under a minute on a cold cache, while their real target downloads in
// the background — see _upgradeInBackground. Qwen 2.5 1.5B, not the 1B tier:
// 1B's answers are weak enough on real reading questions that reviewers read
// the "instant" reply as broken rather than as a fast placeholder. 1.5B is
// still a small, quick download (~1.1GB) but is the smallest tier worth
// showing a reader unqualified. Kept on disk permanently — unlike every other
// catalog entry — so this is what makes initSmart()'s "instant fast tier,
// then upgrade" behavior actually instant on every load after the first, not
// just the first (see the exemption in purgeOthers()).
const FAST_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

// The models a reader may install, smallest first. These are prebuilt WebLLM
// ids; the catalog is intersected with the module's own prebuiltAppConfig at
// runtime (see refreshCatalog), so an id that a future web-llm release drops
// disappears from the picker instead of failing at download time.
//
// `starter: true` marks the three tiers the picker leads with (Fast /
// Balanced / Best) — a reader choosing a local model for the first time needs
// one clear decision, not a wall of seven near-identical rows. The rest stay
// reachable behind a "more models" expander, not removed.
//
// Only ONE of these is ever on disk at a time. Weights are gigabytes, and the
// browser's storage quota is shared with everything else this origin keeps
// (documents, chats); silently accumulating four models would evict that data
// out from under the reader. selectModel() therefore purges every other
// model's cache entries BEFORE the new download starts — the space has to be
// free first, or the new fetch is what hits the quota wall.
const MODEL_CATALOG = [
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B", size: "~0.9 GB", note: "Fastest, lightest. Fine for short questions; loses the thread on long sources." },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 1.5B", size: "~1.1 GB", note: "Small but stronger than 1B at following instructions.", starter: true, starterLabel: "Fast" },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B", size: "~1.6 GB", note: "Careful, quotes its sources closely." },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", size: "~2.3 GB", note: "The default. Best balance of reading quality and download size.", starter: true, starterLabel: "Balanced" },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 3B", size: "~2.5 GB", note: "Comparable to the default; better at structured answers." },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi 3.5 mini", size: "~2.6 GB", note: "3.8B. Strong reasoning for its size, slower per token." },
  { id: "Llama-3.1-8B-Instruct-q4f16_1-MLC", label: "Llama 3.1 8B", size: "~5.0 GB", note: "Best answers here, but needs a large-memory GPU (~6GB VRAM).", starter: true, starterLabel: "Best" },
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

// esm.run (jsdelivr) serves an ESM build with no bundler required — the
// WebLLM README's own documented no-build integration path.
const WEBLLM_MODULE_URL = "https://esm.run/@mlc-ai/web-llm";

// The download is many sharded fetches over a CDN; a transient failure on
// one shard is common and not evidence the model can never load here. Each
// attempt after the first benefits from whatever the browser's Cache API
// backend (WebLLM's default cacheBackend) already committed to disk, so a
// retry is usually resuming, not restarting.
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 7000];

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

function opfsSupported() {
  try {
    return typeof navigator !== "undefined" && !!navigator.storage && typeof navigator.storage.getDirectory === "function";
  } catch { return false; }
}

// A model-load failure that is actually the browser refusing more disk
// space (as opposed to a network error, a bad shard, an aborted fetch,
// etc). Storage-full surfaces differently across browsers/backends — a
// DOMException named QuotaExceededError from Cache API or OPFS sync-access-
// handle writes, or (less consistently) just a message mentioning "quota" —
// so this checks both rather than assuming one shape. Used only to pick a
// clearer, actionable error string; a miss here still surfaces the raw
// error, it just doesn't get the specific diagnosis.
function isQuotaError(err) {
  if (!err) return false;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "QuotaExceededError") return true;
  return /quota.?exceeded|out of storage|storage.*full/i.test(String((err && err.message) || err));
}

// OPFS (Origin Private File System) is a materially faster backend than the
// default Cache API for the many-hundred-MB shard reads/writes a model load
// does — real wins on both the first download and every later "load from
// cache" pass, which is most of what makes a warm start feel slow today.
// Engages only where the browser actually supports it; every other browser
// keeps using Cache API exactly as before. "auto" access mode itself falls
// back from OPFS sync access handles to plain async OPFS when sync handles
// aren't available (e.g. outside a Worker) — a second layer of degradation
// before ever touching Cache API.
//
// Must be threaded through every cache-touching web-llm call —
// hasModelInCache / deleteModelAllInfoInCache / CreateMLCEngine each read or
// write whichever backend THEIR OWN appConfig names, so a call given the
// wrong one silently checks or purges the wrong store instead of throwing.
function appConfigFor(webllm) {
  return opfsSupported() ? { ...webllm.prebuiltAppConfig, cacheBackend: "opfs", opfsAccessMode: "auto" } : undefined;
}

class LocalModel {
  constructor() {
    this.modelId = readStoredModelId();
    this.engine = null;
    // Catalog rows as the picker sees them: the static entries above plus
    // whether each is already on disk. Filled by refreshCatalog(); until then
    // `cached` is null, meaning "not looked yet", which the UI renders as
    // silence rather than as "not installed".
    this.catalog = MODEL_CATALOG.map((m) => ({ ...m, cached: null }));
    // Bytes this origin is using / is allowed, from navigator.storage.estimate().
    // Null when the browser does not expose it.
    this.storage = null;
    // Whether the browser has granted persistent storage for this origin —
    // i.e. whether navigator.storage.persist() actually protects the
    // multi-GB model download (and everything else this origin keeps) from
    // best-effort LRU eviction under disk pressure. true = granted, false =
    // asked and denied (the model can be silently evicted; the UI should
    // say so rather than let a reader discover it via a mysterious re-
    // download), null = not asked yet, or the browser does not expose
    // navigator.storage.persist() at all (e.g. Firefox as of writing) so
    // there is nothing to ask. Set once by _runInit() before the first
    // download attempt — see there for why asking is safe to skip on
    // repeat inits.
    this.persisted = null;
    // idle -> loading -> ready, or idle -> unsupported / error.
    // "error" is not terminal: init() may be called again (the UI's retry
    // button does exactly that) and re-attempts the full sequence.
    this.status = "idle";
    this.progress = { text: "", percent: 0 };
    this.error = null;
    this._listeners = new Set();
    this._loading = null; // in-flight init() promise, so concurrent callers share one attempt
    // Bumped by unload()/selectModel() to invalidate an in-flight _runInit —
    // its own captured token then stops matching, so every state-changing
    // step after the cancel point becomes a no-op instead of resurrecting
    // status/progress the reader already asked to stop. This is what makes
    // "turn Local off" or "pick a different model" during a download actually
    // stop it, rather than just flipping a display flag while the fetch (and
    // its eventual completion) keeps running in the background regardless.
    this._loadToken = 0;
    // 'fast' while the FAST_MODEL_ID lane is what's actually serving answers,
    // 'target' once the reader's real pick has taken over. Null before either
    // has loaded. Purely informational — stream()/status don't depend on it.
    this.tier = null;
    // A background upgrade (fast tier -> reader's real target) in progress.
    // Deliberately separate from status/progress/error: those describe the
    // engine that's ACTUALLY serving answers right now, which stays "ready"
    // throughout an upgrade so the reader is never blocked waiting for it.
    this.upgrading = false;
    this.upgradeModelId = null;
    this.upgradeProgress = { text: "", percent: 0 };
    this.upgradeError = null;
    // Separate cancel token from _loadToken — an upgrade runs concurrently
    // WITH a ready, serving fast-tier engine, not instead of it, so it needs
    // its own invalidation channel rather than sharing _runInit's.
    this._upgradeToken = 0;
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
      modelId: this.modelId,
      tier: this.tier,
      upgrading: this.upgrading,
      upgradeModelId: this.upgradeModelId,
      upgradeProgress: this.upgradeProgress,
      upgradeError: this.upgradeError,
      catalog: this.catalog.map((m) => ({ ...m, active: m.id === this.modelId })),
      storage: this.storage,
      persisted: this.persisted,
    };
  }

  modelLabel(id) {
    const row = MODEL_CATALOG.find((m) => m.id === (id || this.modelId));
    return row ? row.label : (id || this.modelId);
  }

  // Which models are actually on disk, and how much room this origin has left.
  // Best-effort throughout: a browser that blocks the Cache API or does not
  // implement StorageManager leaves the fields null rather than erroring, so
  // the picker still works — it just cannot say "already downloaded".
  async refreshCatalog() {
    try {
      const webllm = await loadWebLLMModule();
      const appConfig = appConfigFor(webllm);
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
          if (typeof webllm.hasModelInCache === "function") cached = await webllm.hasModelInCache(m.id, appConfig);
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

  // Delete every cached model except `keepId` (and the fast lane — see
  // below). This is the "wipe the old one" half of installing a new model,
  // and it runs BEFORE the new download so the freed space is what the
  // download uses. Deleting a model that was never cached is a no-op, so
  // this is safe to call unconditionally.
  async purgeOthers(keepId) {
    const keep = keepId || this.modelId;
    let freed = 0;
    try {
      const webllm = await loadWebLLMModule();
      const appConfig = appConfigFor(webllm);
      if (typeof webllm.deleteModelAllInfoInCache !== "function") return freed;
      for (const m of this.catalog) {
        if (m.id === keep) continue;
        // The fast lane is a deliberate, bounded exception to "only one
        // model ever cached": at ~0.9GB it costs little to keep permanently,
        // and doing so is what makes initSmart()'s "instant fast tier, then
        // upgrade" behavior actually instant on every load after the first,
        // not just the first.
        if (m.id === FAST_MODEL_ID) continue;
        if (m.cached === false) continue; // known-absent: nothing to delete
        try {
          await webllm.deleteModelAllInfoInCache(m.id, appConfig);
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
      const appConfig = appConfigFor(webllm);
      if (typeof webllm.deleteModelAllInfoInCache === "function") {
        for (const m of this.catalog) {
          try { await webllm.deleteModelAllInfoInCache(m.id, appConfig); m.cached = false; } catch { /* best effort */ }
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

    // Any in-flight load is for the old model — invalidate it immediately
    // (unload() bumps the cancel token) rather than waiting for it to settle,
    // so switching models mid-download doesn't leave the reader stuck
    // watching a download they already asked to abandon.
    await this.unload();
    this.modelId = id;
    writeStoredModelId(id);
    this.status = "loading";
    this.progress = { text: `Clearing space (removing other models)…`, percent: 0 };
    this._emit();

    await this.purgeOthers(id);
    return this.init();
  }

  // The recommended entry point for turning local mode on: gets the reader a
  // working model as fast as possible, upgrading to their real target
  // afterward rather than making every cold start wait for it up front.
  //
  //   - Reader's target already cached, or IS the fast model: load it
  //     directly — it's already going to be quick, so the fast-then-upgrade
  //     dance would only add a pointless extra hop.
  //   - Target not cached (genuine download needed): load the fast tier
  //     first (itself possibly a download, but a much smaller one — ~0.9GB
  //     vs up to ~5GB), let the reader start chatting the moment IT is
  //     ready, then upgrade to the target in the background. An in-flight
  //     reply keeps using whichever engine object it already grabbed (see
  //     stream()), so a mid-generation upgrade never interrupts an answer.
  async initSmart() {
    const target = this.modelId;
    if (this.catalog.every((m) => m.cached === null)) {
      await this.refreshCatalog();
    }
    const targetRow = this.catalog.find((m) => m.id === target);
    const targetCached = targetRow ? targetRow.cached : null;
    if (target === FAST_MODEL_ID || targetCached === true) {
      return this.init();
    }

    this.modelId = FAST_MODEL_ID;
    await this.init();
    // Only chase the upgrade if the fast tier actually came up AND the
    // reader hasn't since picked something else themselves (selectModel()
    // would have moved modelId off FAST_MODEL_ID already, in which case that
    // pick — not this one — owns what happens next).
    if (this.status === "ready" && this.modelId === FAST_MODEL_ID) {
      this._upgradeInBackground(target);
    }
    return this.snapshot();
  }

  async init() {
    if (this.status === "ready") return this.snapshot();
    if (this._loading) return this._loading;
    // Capture the promise locally: if this load gets cancelled (unload()
    // bumps the token) while a NEWER load is already in flight, the old
    // promise's .finally must not null out the new one out from under it.
    const p = this._runInit().finally(() => { if (this._loading === p) this._loading = null; });
    this._loading = p;
    return this._loading;
  }

  async _runInit() {
    const token = ++this._loadToken;
    const stale = () => token !== this._loadToken;

    const readiness = webgpuReadiness();
    if (!readiness.ok) {
      if (stale()) return this.snapshot();
      this.status = "unsupported";
      this.error = readiness.hint;
      this._emit();
      return this.snapshot();
    }

    // The WebGPU API existing does not mean an adapter can be created
    // (headless Chrome, GPU blocklisted, hardware acceleration off). Fail
    // fast with the specific reason rather than letting CreateMLCEngine throw
    // after the download has already started.
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (stale()) return this.snapshot();
      if (!adapter) {
        this.status = "unsupported";
        this.error = "WebGPU is present but this device offers no GPU adapter — usually hardware acceleration being off or the GPU being blocklisted. Turn hardware acceleration on and reload.";
        this._emit();
        return this.snapshot();
      }
    } catch (adapterErr) {
      if (stale()) return this.snapshot();
      this.status = "unsupported";
      this.error = "WebGPU adapter could not be created: " + ((adapterErr && adapterErr.message) || adapterErr);
      this._emit();
      return this.snapshot();
    }

    // Ask the browser to exempt this origin's storage from best-effort
    // eviction before the multi-GB download that's about to make eviction
    // worth caring about starts. Only asked once per LocalModel lifetime
    // (this.persisted starts null and only ever becomes true/false) — the
    // browser's answer does not change moment to moment, and re-asking on
    // every retry/model-switch would just be noise. A denial is not
    // treated as fatal (non-persisted storage still works for as long as
    // the browser doesn't need the space back) but IS recorded so the UI
    // can warn the reader their download may vanish under pressure, rather
    // than that happening silently — see snapshot().persisted.
    if (this.persisted === null && navigator.storage && typeof navigator.storage.persist === "function") {
      try {
        this.persisted = await navigator.storage.persist();
      } catch (persistErr) {
        console.warn("[webllm-client] navigator.storage.persist() threw:", persistErr);
        this.persisted = false;
      }
      if (stale()) return this.snapshot();
    }

    this.status = "loading";
    this.error = null;
    this.progress = { text: "Starting…", percent: 0 };
    this._emit();

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
      if (stale()) return this.snapshot();
      try {
        const webllm = await loadWebLLMModule();
        if (stale()) return this.snapshot();
        const engine = await webllm.CreateMLCEngine(this.modelId, {
          appConfig: appConfigFor(webllm),
          initProgressCallback: (report) => {
            if (stale()) return;
            this.progress = {
              text: report && report.text ? report.text : "Downloading…",
              percent: Math.round(((report && report.progress) || 0) * 100),
            };
            this._emit();
          },
        });
        if (stale()) {
          // The reader cancelled or switched models while this attempt was
          // finishing. Tear the now-unwanted engine down rather than leaking
          // its GPU/WASM resources, and leave status/progress alone — a
          // newer _runInit (or unload()) already owns them.
          try { engine.unload(); } catch { /* best-effort */ }
          return this.snapshot();
        }
        this.engine = engine;
        this.status = "ready";
        this.progress = { text: "Ready", percent: 100 };
        this.error = null;
        this.tier = this.modelId === FAST_MODEL_ID ? "fast" : "target";
        const row = this.catalog.find((m) => m.id === this.modelId);
        if (row) row.cached = true;
        this._emit();
        this._refreshStorage().then(() => this._emit());
        return this.snapshot();
      } catch (err) {
        if (stale()) return this.snapshot();
        lastErr = err;
        console.error(`[webllm-client] load attempt ${attempt + 1}/${MAX_LOAD_ATTEMPTS} failed:`, err);
        this.engine = null;
        if (attempt < MAX_LOAD_ATTEMPTS - 1) {
          const wait = RETRY_BACKOFF_MS[attempt] || 5000;
          this.progress = { text: `Download failed — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${MAX_LOAD_ATTEMPTS})…`, percent: 0 };
          this._emit();
          await new Promise((r) => setTimeout(r, wait));
          if (stale()) return this.snapshot();
        }
      }
    }

    if (stale()) return this.snapshot();
    this.status = "error";
    if (isQuotaError(lastErr)) {
      // Diagnosed rather than raw: the browser's own QuotaExceededError
      // message is often just a generic sentence with no remediation. If
      // persist() was denied (or unsupported) this is also the moment that
      // matters most for it, so the two facts are surfaced together.
      this.error = "Ran out of browser storage space downloading this model."
        + (this.persisted === false ? " This browser also declined to make this site's storage persistent, so existing downloads may be evicted under the same pressure." : "")
        + " Free up disk space (or clear other site data for this origin) and retry.";
    } else {
      this.error = (lastErr && lastErr.message) || "Model download failed after retrying.";
    }
    this.progress = { text: "", percent: 0 };
    this._emit();
    return this.snapshot();
  }

  // Downloads the reader's real target while the fast tier keeps serving
  // answers, then swaps it in atomically on success. Deliberately does not
  // touch status/progress/engine until the new engine is actually ready —
  // those describe what's serving RIGHT NOW, which stays the fast tier
  // (fully usable) for the whole duration of this. Uses its own cancel
  // token (_upgradeToken, bumped by unload()/selectModel()) rather than
  // _loadToken, since this runs concurrently WITH a ready engine instead of
  // replacing an in-flight load.
  async _upgradeInBackground(target) {
    const token = ++this._upgradeToken;
    const stale = () => token !== this._upgradeToken;

    this.upgrading = true;
    this.upgradeModelId = target;
    this.upgradeProgress = { text: "Starting…", percent: 0 };
    this.upgradeError = null;
    this._emit();

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
      if (stale()) return;
      try {
        const webllm = await loadWebLLMModule();
        if (stale()) return;
        const engine = await webllm.CreateMLCEngine(target, {
          appConfig: appConfigFor(webllm),
          initProgressCallback: (report) => {
            if (stale()) return;
            this.upgradeProgress = {
              text: report && report.text ? report.text : "Downloading…",
              percent: Math.round(((report && report.progress) || 0) * 100),
            };
            this._emit();
          },
        });
        if (stale()) {
          try { engine.unload(); } catch { /* best-effort */ }
          return;
        }
        // Swap in the upgraded engine and retire the fast one — in that
        // order, so a reply that started mid-swap never sees a moment with
        // no engine at all (stream() only ever reads this.engine once, at
        // call time, so an in-flight generation keeps its own reference
        // regardless of what this.engine is reassigned to next).
        const old = this.engine;
        this.engine = engine;
        this.modelId = target;
        this.tier = "target";
        this.status = "ready";
        this.progress = { text: "Ready", percent: 100 };
        this.error = null;
        const row = this.catalog.find((m) => m.id === target);
        if (row) row.cached = true;
        this.upgrading = false;
        this.upgradeModelId = null;
        this.upgradeProgress = { text: "", percent: 0 };
        this._emit();
        this._refreshStorage().then(() => this._emit());
        if (old) { try { await old.unload(); } catch { /* best-effort */ } }
        return;
      } catch (err) {
        if (stale()) return;
        lastErr = err;
        console.error(`[webllm-client] background upgrade attempt ${attempt + 1}/${MAX_LOAD_ATTEMPTS} failed:`, err);
        if (attempt < MAX_LOAD_ATTEMPTS - 1) {
          const wait = RETRY_BACKOFF_MS[attempt] || 5000;
          this.upgradeProgress = { text: `Upgrade failed — retrying in ${Math.round(wait / 1000)}s…`, percent: 0 };
          this._emit();
          await new Promise((r) => setTimeout(r, wait));
          if (stale()) return;
        }
      }
    }

    if (stale()) return;
    // Give up quietly: the fast tier is still fully usable, so this is a
    // downgrade of ambition, not an outage. Surfaced once, softly, rather
    // than as an error banner over a chat that is in fact still working.
    this.upgrading = false;
    this.upgradeModelId = null;
    this.upgradeProgress = { text: "", percent: 0 };
    this.upgradeError = (lastErr && lastErr.message) || "Background upgrade failed.";
    this._emit();
  }

  // Streams completion text deltas. Caller owns the message array — this
  // module has no opinion on grounding/citations, only on running the model.
  async *stream(messages, { signal } = {}) {
    if (this.status !== "ready" || !this.engine) {
      throw new Error("Local model is not ready — call init() first.");
    }
    const chunks = await this.engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.4,
    });
    for await (const chunk of chunks) {
      if (signal && signal.aborted) return;
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (delta) yield delta;
    }
  }

  async unload() {
    // Invalidate any in-flight _runInit FIRST — this is what makes unload()
    // during a download a real cancel: every state-changing step in that
    // attempt checks this token and bails instead of resurrecting
    // status/progress after the reader already asked to stop.
    this._loadToken++;
    this._loading = null;
    // Also cancel any background upgrade — there is no serving engine left
    // for it to hand off to once this returns.
    this._upgradeToken++;
    this.tier = null;
    this.upgrading = false;
    this.upgradeModelId = null;
    this.upgradeProgress = { text: "", percent: 0 };
    this.upgradeError = null;
    if (this.engine) {
      try { await this.engine.unload(); } catch { /* best-effort teardown */ }
    }
    this.engine = null;
    this.status = "idle";
    this.progress = { text: "", percent: 0 };
    this.error = null;
    this._emit();
  }
}

window.EOWebLLM = new LocalModel();
