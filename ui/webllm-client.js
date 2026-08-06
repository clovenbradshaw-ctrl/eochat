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

class LocalModel {
  constructor() {
    this.modelId = readStoredModelId();
    this.nicknames = readStoredNicknames();
    this.engine = null;
    // Catalog rows as the picker sees them: the static entries above plus
    // whether each is already on disk. Filled by refreshCatalog(); until then
    // `cached` is null, meaning "not looked yet", which the UI renders as
    // silence rather than as "not installed".
    this.catalog = MODEL_CATALOG.map((m) => ({ ...m, cached: null }));
    // Bytes this origin is using / is allowed, from navigator.storage.estimate().
    // Null when the browser does not expose it.
    this.storage = null;
    // idle -> loading -> ready, or idle -> unsupported / error.
    // "error" is not terminal: init() may be called again (the UI's retry
    // button does exactly that) and re-attempts the full sequence.
    this.status = "idle";
    this.progress = { text: "", percent: 0 };
    this.error = null;
    this._listeners = new Set();
    this._loading = null; // in-flight init() promise, so concurrent callers share one attempt
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

  async init() {
    if (this.status === "ready") return this.snapshot();
    if (this._loading) return this._loading;
    this._loading = this._runInit().finally(() => { this._loading = null; });
    return this._loading;
  }

  async _runInit() {
    const readiness = webgpuReadiness();
    if (!readiness.ok) {
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
      if (!adapter) {
        this.status = "unsupported";
        this.error = "WebGPU is present but this device offers no GPU adapter — usually hardware acceleration being off or the GPU being blocklisted. Turn hardware acceleration on and reload.";
        this._emit();
        return this.snapshot();
      }
    } catch (adapterErr) {
      this.status = "unsupported";
      this.error = "WebGPU adapter could not be created: " + ((adapterErr && adapterErr.message) || adapterErr);
      this._emit();
      return this.snapshot();
    }

    this.status = "loading";
    this.error = null;
    this.progress = { text: "Starting…", percent: 0 };
    this._emit();

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
      try {
        const webllm = await loadWebLLMModule();
        const engine = await webllm.CreateMLCEngine(this.modelId, {
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
        const row = this.catalog.find((m) => m.id === this.modelId);
        if (row) row.cached = true;
        this._emit();
        this._refreshStorage().then(() => this._emit());
        return this.snapshot();
      } catch (err) {
        lastErr = err;
        console.error(`[webllm-client] load attempt ${attempt + 1}/${MAX_LOAD_ATTEMPTS} failed:`, err);
        this.engine = null;
        if (attempt < MAX_LOAD_ATTEMPTS - 1) {
          const wait = RETRY_BACKOFF_MS[attempt] || 5000;
          this.progress = { text: `Download failed — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${MAX_LOAD_ATTEMPTS})…`, percent: 0 };
          this._emit();
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }

    this.status = "error";
    this.error = (lastErr && lastErr.message) || "Model download failed after retrying.";
    this.progress = { text: "", percent: 0 };
    this._emit();
    return this.snapshot();
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
