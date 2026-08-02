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
// Model choice: the smallest instruct build in WebLLM's prebuilt catalog —
// SmolLM2-360M-Instruct-q4f16_1-MLC, ~376MB quantized. SmolLM2 is
// HuggingFace's own small-model line, benchmarked specifically for the
// best quality/size trade-off on short-prompt instruction-following, and
// this is its smallest quantized WebLLM build — which is also the one most
// likely to download reliably: fewer bytes over a flaky connection is a
// stability property, not just a size one.
const MODEL_ID = "SmolLM2-360M-Instruct-q4f16_1-MLC";

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

function supportsWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
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
    if (!supportsWebGPU()) {
      this.status = "unsupported";
      this.error = "No WebGPU in this browser — local mode needs it to run a model in the tab.";
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
