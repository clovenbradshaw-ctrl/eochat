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
// Model choice: the 3B instruct tier of WebLLM's prebuilt catalog —
// Llama-3.2-3B-Instruct-q4f16_1-MLC (~2.3GB VRAM, ~2GB download). Nothing
// smaller survives a real reading question well, and of the prebuilt 3B
// instruct builds this is the one that does not also demand the shader-f16
// adapter feature, so it has the widest device reach of the 3B candidates.
// On the static (GitHub Pages) build this download is the entire answer
// path, so it starts automatically the moment the page mounts.
const MODEL_ID = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

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
    this.modelId = MODEL_ID;
    this.engine = null;
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
    return { status: this.status, progress: this.progress, error: this.error, modelId: this.modelId };
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
        const engine = await webllm.CreateMLCEngine(MODEL_ID, {
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
        this._emit();
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
