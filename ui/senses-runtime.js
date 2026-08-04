// senses-runtime.js — the senses that actually install.
//
// senses-catalog.js (server) describes fourteen vision models, and every one
// of them needs a self-hosted or cloud endpoint the reader has to stand up
// themselves. That library is a shortlist, not a working pipeline: until an
// endpoint exists, nothing runs, and on the static GitHub Pages build there
// is no proxy to hold the state at all.
//
// This module is the other half. It installs Hugging Face models *into this
// browser* — real weights, downloaded once into the Cache API, run locally on
// WebGPU (or WASM) via Transformers.js — so "install" and "on/off" mean what
// they say and an uploaded image can be read with no server anywhere.
//
// window.EOSenses is the integration point, mirroring window.EOWebLLM: the
// Component class in index.html is eval'd as an ordinary script (dc-runtime's
// evalDcLogic — see support.js), not a module, so a global is the only way in.
//
// Three facts per sense, deliberately independent, matching senses-state.js's
// vocabulary so the two families read alike in one list:
//   - installed: weights are in this browser's cache. Costs a download.
//   - enabled:   run it on ingestion. Only meaningful once installed.
//   - prompt:    the candidate labels a zero-shot model needs to look for.
//                Without it a zero-shot detector has been asked nothing.
//
// What this module refuses to do is claim facts it hasn't checked. The
// catalog below carries only an id, a task, and what the model is for —
// never a license, a size, or a download count from memory. Those come from
// the Hub, live, at preflight, and a catalog entry that does not resolve
// there fails the install by name and reason rather than dying somewhere
// inside the loader.

const TRANSFORMERS_MODULE_URL = "https://esm.run/@huggingface/transformers";
const HF_API = "https://huggingface.co/api/models";
const STORE_KEY = "eochat.senses.browser.v1";

// Transformers.js's own default cache name. Uninstall has to reach into it
// directly — there is no public "delete this model" API — so removing a sense
// really frees the disk instead of only forgetting a flag.
const TRANSFORMERS_CACHE = "transformers-cache";

const MAX_INSTALL_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 7000];

// The pipeline tasks this module knows how to turn into text. Anything else
// on the Hub may be a fine model and still be unrunnable here — a depth map
// or a segmentation mask is not something the ingest path can index — so
// discovery filters to these and says how many it dropped rather than
// quietly showing a shorter list.
//
// `scope` is the honest part: `page` means the model reads a full rendered
// page, `image` means it expects one already-cropped subject. The PDF path
// renders whole pages, so an `image`-scope sense is not run there and says
// why, instead of being handed a page and returning one line of nonsense.
export const RUNNABLE_TASKS = {
  "image-to-text": { category: "vlm", scope: "page", needsLabels: false },
  "image-classification": { category: "detection", scope: "image", needsLabels: false },
  "zero-shot-image-classification": { category: "detection", scope: "image", needsLabels: true },
  "object-detection": { category: "detection", scope: "page", needsLabels: false },
  "zero-shot-object-detection": { category: "detection", scope: "page", needsLabels: true },
};

// Used when a zero-shot model is enabled with no labels typed. A zero-shot
// detector with no candidate labels has been asked nothing at all, so rather
// than send an empty question the run uses these and says in its own output
// that it did — a default that announces itself is auditable, one that
// doesn't is a lie about what was asked.
const DEFAULT_LABELS = "text, a person, a chart, a table, a diagram, a logo, a button, a photograph";

// A shortlist of models that run through Transformers.js's plain `pipeline()`
// with no bespoke wiring. Not a ranking and not a claim about quality — the
// facts that matter (license, size, downloads) are fetched from the Hub at
// preflight, and anything here that no longer resolves fails loudly. Use the
// Hugging Face search for everything this list does not cover; that path
// queries the Hub live and is the reason this list can stay short.
//
// Screen grounding has no entry on purpose. Nothing in the GUI-grounding
// layer (Holo2, OmniParser, GUI-Actor) ships ONNX weights that Transformers.js
// can drive today, so that category stays endpoint-only — an empty category
// stated out loud, not padded with a model that would not do the job.
export const BROWSER_SENSES = [
  {
    id: "Xenova/trocr-small-printed",
    name: "TrOCR small (printed)",
    vendor: "Microsoft · Xenova ONNX build",
    category: "ocr",
    task: "image-to-text",
    scope: "image",
    summary: "Transformer OCR for printed text. Reads one cropped line of text at a time — point it at a crop, not a page. Whole-page OCR stays with Tesseract.js, which is already the baseline for scanned PDFs.",
  },
  {
    id: "Xenova/trocr-base-printed",
    name: "TrOCR base (printed)",
    vendor: "Microsoft · Xenova ONNX build",
    category: "ocr",
    task: "image-to-text",
    scope: "image",
    summary: "The larger printed-text TrOCR. Same single-line scope as the small build, more accurate on hard crops, a bigger download.",
  },
  {
    id: "Xenova/trocr-base-handwritten",
    name: "TrOCR base (handwritten)",
    vendor: "Microsoft · Xenova ONNX build",
    category: "ocr",
    task: "image-to-text",
    scope: "image",
    summary: "Handwriting rather than print — the one case Tesseract.js is worst at. Still line-at-a-time.",
  },
  {
    id: "Xenova/vit-gpt2-image-captioning",
    name: "ViT-GPT2 captioning",
    vendor: "nlpconnect · Xenova ONNX build",
    category: "vlm",
    task: "image-to-text",
    scope: "page",
    summary: "Describes what a photograph shows in a sentence. The smallest thing that makes an uploaded image searchable at all — without it an image with no endpoint is stored for reading and never indexed.",
  },
  {
    id: "Xenova/clip-vit-base-patch32",
    name: "CLIP ViT-B/32",
    vendor: "OpenAI · Xenova ONNX build",
    category: "vlm",
    task: "zero-shot-image-classification",
    scope: "image",
    summary: "Scores an image against labels you supply, so you decide the vocabulary. Answers \"which of these is it\", never \"what is it\" — an unlisted answer cannot be returned.",
  },
  {
    id: "Xenova/detr-resnet-50",
    name: "DETR ResNet-50",
    vendor: "Facebook · Xenova ONNX build",
    category: "detection",
    task: "object-detection",
    scope: "page",
    summary: "Fixed-vocabulary object detection (the COCO classes) with boxes. No labels to type — it finds what it was trained on and nothing else.",
  },
  {
    id: "Xenova/yolos-tiny",
    name: "YOLOS tiny",
    vendor: "hustvl · Xenova ONNX build",
    category: "detection",
    task: "object-detection",
    scope: "page",
    summary: "The small end of detection. Same fixed COCO vocabulary as DETR, a fraction of the download — the one to try first on a slow connection.",
  },
  {
    id: "Xenova/owlvit-base-patch32",
    name: "OWL-ViT base",
    vendor: "Google · Xenova ONNX build",
    category: "detection",
    task: "zero-shot-object-detection",
    scope: "page",
    summary: "Open-vocabulary detection: type the things to look for and it boxes them. The only browser-installable sense here that can be pointed at nouns nobody trained it on.",
  },
];

const CATEGORY_ORDER = ["grounding", "vlm", "ocr", "detection"];

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Persisted state ───────────────────────────────────────────────────────
// localStorage, not the proxy, and deliberately so: an installed model lives
// in *this* browser's cache. State that outlived the thing it describes —
// "enabled" syncing to a second browser where the weights were never
// downloaded — would be a switch that lies. Per-browser state for a
// per-browser fact.

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      installed: raw.installed && typeof raw.installed === "object" ? raw.installed : {},
      enabled: Array.isArray(raw.enabled) ? raw.enabled : [],
      added: Array.isArray(raw.added) ? raw.added : [],
      prompts: raw.prompts && typeof raw.prompts === "object" ? raw.prompts : {},
    };
  } catch {
    return { installed: {}, enabled: [], added: [], prompts: {} };
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Best-effort. A full or blocked localStorage must not break a toggle —
    // the in-memory state still reflects the choice for this tab's lifetime,
    // and the install itself lives in the Cache API, not here.
  }
}

// ── Environment ───────────────────────────────────────────────────────────
// Three separate things can be missing, and they fail differently. WebGPU
// absent only costs speed — WASM still runs. The Cache API absent costs
// persistence: every load re-downloads, so "installed" would be a word for
// something that does not survive a reload, and this says so rather than
// letting a reader believe a download was permanent.
function environment() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { runnable: false, webgpu: false, cache: false, hint: "Not running in a browser — no sense can be installed here." };
  }
  const webgpu = !!navigator.gpu;
  const cache = typeof caches !== "undefined" && window.isSecureContext !== false;
  let hint;
  if (!cache && window.isSecureContext === false) {
    hint = "Served over plain http, so the browser offers no Cache API — models will run but re-download every reload. Serve over https:// or http://localhost to make an install stick.";
  } else if (!webgpu) {
    hint = "No WebGPU in this browser — senses run on WASM instead. Slower, but everything installs and runs.";
  } else {
    hint = "WebGPU available — senses run on the GPU in this tab.";
  }
  return { runnable: true, webgpu, cache, hint };
}

// ── Hub lookups ───────────────────────────────────────────────────────────

async function hubJson(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Hugging Face returned ${res.status}`);
  return res.json();
}

// Sums the ONNX weight files in a repo. Every dtype variant ships in the same
// repo, so the total across all of them overstates a single install badly —
// the quantized subset is what a default install actually pulls, and that is
// what gets reported, with the full total kept beside it so neither number
// has to stand in for the other.
function weightSizes(siblings) {
  let quantized = 0;
  let all = 0;
  for (const f of siblings || []) {
    const name = f.rfilename || "";
    if (!/\.onnx(_data)?$/.test(name)) continue;
    const size = Number(f.size ?? (f.lfs && f.lfs.size) ?? 0);
    if (!Number.isFinite(size) || size <= 0) continue;
    all += size;
    if (/quantized|_q4|_q8|int8|uint8|_bnb/i.test(name)) quantized += size;
  }
  return { quantized, all };
}

function licenseOf(tags) {
  const found = (tags || []).find((t) => t.startsWith("license:"));
  return found ? found.slice("license:".length) : "license not stated on the Hub";
}

const RESTRICTIVE_LICENSE_RE = /agpl|cc-by-nc|non.?commercial/i;

async function fetchHubMeta(id) {
  const model = await hubJson(`${HF_API}/${id}?blobs=true`);
  if (!model || !model.id) throw new Error(`no such model on the Hub: ${id}`);
  const tags = model.tags || [];
  const sizes = weightSizes(model.siblings);
  const license = licenseOf(tags);
  return {
    id: model.id,
    license,
    licenseFlag: RESTRICTIVE_LICENSE_RE.test(license),
    downloads: model.downloads || 0,
    likes: model.likes || 0,
    pipelineTag: model.pipeline_tag || null,
    // Neither tag is required for a model to work, but their absence is the
    // single best predictor of an install that will fail deep in the loader,
    // so it is carried forward and named in the error if one happens.
    hasOnnx: tags.includes("onnx") || (model.siblings || []).some((f) => /\.onnx$/.test(f.rfilename || "")),
    hasTransformersJs: tags.includes("transformers.js"),
    sizeBytes: sizes.quantized || sizes.all || 0,
    sizeIsWholeRepo: !sizes.quantized && !!sizes.all,
    url: `https://huggingface.co/${model.id}`,
    fetchedAt: new Date().toISOString(),
  };
}

// ── The runtime ───────────────────────────────────────────────────────────

class SensesRuntime {
  constructor() {
    this.env = environment();
    this.store = loadStore();
    // id → { state, percent, text, error, device, bytes }
    this.progress = new Map();
    this.hubMeta = new Map();
    this.pipelines = new Map();
    this._transformers = null;
    this._listeners = new Set();
    this._verified = false;
    this.searchState = { query: "", loading: false, results: null, error: null, filteredOut: 0 };
  }

  subscribe(fn) {
    this._listeners.add(fn);
    fn(this.snapshot());
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snap = this.snapshot();
    for (const fn of this._listeners) {
      try { fn(snap); } catch { /* a broken listener must not stop the others */ }
    }
  }

  _entries() {
    const added = (this.store.added || []).filter((a) => a && a.id);
    const catalogIds = new Set(BROWSER_SENSES.map((s) => s.id));
    return [...BROWSER_SENSES, ...added.filter((a) => !catalogIds.has(a.id))];
  }

  entry(id) {
    return this._entries().find((e) => e.id === id) || null;
  }

  snapshot() {
    const library = this._entries().map((e) => {
      const p = this.progress.get(e.id) || {};
      const installedRecord = this.store.installed[e.id] || null;
      const meta = this.hubMeta.get(e.id) || null;
      const needsLabels = !!(RUNNABLE_TASKS[e.task] || {}).needsLabels;
      const prompt = this.store.prompts[e.id] || "";
      return {
        ...e,
        runtime: "browser",
        installed: !!installedRecord,
        installedAt: installedRecord ? installedRecord.installedAt : null,
        installedBytes: installedRecord ? installedRecord.bytes || 0 : 0,
        device: installedRecord ? installedRecord.device || "" : "",
        enabled: this.store.enabled.includes(e.id),
        installing: p.state === "installing",
        percent: p.percent || 0,
        statusText: p.text || "",
        error: p.error || null,
        // "Installed but the cache is gone" is a third state, not a variant of
        // installed — a browser that evicted the weights will re-download on
        // the next run, and the reader is owed that fact before it happens.
        cacheMissing: !!(installedRecord && installedRecord.cacheVerified === false),
        needsLabels,
        prompt,
        promptEffective: prompt.trim() || DEFAULT_LABELS,
        hub: meta,
        sizeLabel: meta ? humanBytes(meta.sizeBytes) : "",
        source: BROWSER_SENSES.some((s) => s.id === e.id) ? "catalog" : "hub",
      };
    });
    return {
      env: this.env,
      library,
      categoryOrder: CATEGORY_ORDER,
      search: { ...this.searchState },
      installedCount: library.filter((s) => s.installed).length,
      enabledCount: library.filter((s) => s.installed && s.enabled).length,
    };
  }

  // Every installed sense that is switched on, in the shape the ingest paths
  // consume. `scope` rides along so the PDF path can tell a page reader from
  // a crop reader instead of feeding both the same rendered page.
  activeSenses(category) {
    return this.snapshot().library.filter(
      (s) => (!category || s.category === category) && s.installed && s.enabled
    );
  }

  // Installed-but-off and on-but-not-installed are both gaps worth naming at
  // ingest time; neither is a silent skip.
  pendingSenses(category) {
    return this.snapshot().library.filter(
      (s) => (!category || s.category === category) && s.enabled && !s.installed
    );
  }

  _setProgress(id, patch) {
    this.progress.set(id, { ...(this.progress.get(id) || {}), ...patch });
    this._emit();
  }

  async init() {
    if (this._verified) return this.snapshot();
    this._verified = true;
    await this.verifyInstalls();
    return this.snapshot();
  }

  // Reconciles the recorded installs against what is actually in the browser
  // cache. A cleared cache is common and invisible — without this, the panel
  // would go on reporting "installed" for weights that are gone, which is the
  // exact shape of a switch that lies about the world.
  async verifyInstalls() {
    const ids = Object.keys(this.store.installed);
    if (!ids.length || typeof caches === "undefined") return;
    let cached;
    try {
      cached = await this._cachedModelIds();
    } catch {
      return; // Can't read the cache: leave the record alone rather than wrongly clearing it.
    }
    let changed = false;
    for (const id of ids) {
      const present = cached.has(id);
      if (this.store.installed[id].cacheVerified !== present) {
        this.store.installed[id] = { ...this.store.installed[id], cacheVerified: present };
        changed = true;
      }
    }
    if (changed) {
      saveStore(this.store);
      this._emit();
    }
  }

  async _cachedModelIds() {
    const names = await caches.keys();
    const ids = new Set();
    for (const name of names) {
      if (name !== TRANSFORMERS_CACHE && !/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const m = /huggingface\.co\/([^/]+\/[^/]+)\//.exec(req.url);
        if (m) ids.add(m[1]);
      }
    }
    return ids;
  }

  async _loadTransformers() {
    if (!this._transformers) {
      this._transformers = import(TRANSFORMERS_MODULE_URL).then((mod) => {
        // Local model files never exist for this deployment — leaving the
        // default on makes every load try a same-origin /models/… path first
        // and eat a 404 before reaching the Hub.
        if (mod.env) {
          mod.env.allowLocalModels = false;
          mod.env.useBrowserCache = this.env.cache;
        }
        return mod;
      });
    }
    return this._transformers;
  }

  /**
   * Downloads a model's weights into this browser and holds the loaded
   * pipeline. Reports named progress throughout (which file, what percent,
   * how many bytes) rather than a spinner — the download is minutes long on
   * a slow connection and a bare spinner would be indistinguishable from a
   * hang. Resolves to the snapshot; the failure path records the reason on
   * the sense instead of throwing into a void.
   */
  async install(id) {
    const entry = this.entry(id);
    if (!entry) return { ok: false, error: `"${id}" is not in the senses library` };
    if (!this.env.runnable) return { ok: false, error: this.env.hint };

    this._setProgress(id, { state: "installing", percent: 0, text: "Checking the model on Hugging Face…", error: null });

    // Preflight against the Hub first. A wrong id, a repo with no ONNX
    // weights, or a gated repo all fail here with a sentence that says which
    // — far better than the same three failures arriving as an opaque 404
    // from somewhere inside the loader ten seconds later.
    let meta = null;
    try {
      meta = await fetchHubMeta(id);
      this.hubMeta.set(id, meta);
      const size = meta.sizeBytes ? ` · ${humanBytes(meta.sizeBytes)} to download` : "";
      this._setProgress(id, { text: `Found ${id} on the Hub — ${meta.license}${size}` });
    } catch (err) {
      this._setProgress(id, { state: "error", percent: 0, text: "", error: `Could not verify ${id} on Hugging Face — ${err.message}` });
      return { ok: false, error: err.message };
    }
    if (!meta.hasOnnx) {
      const msg = `${id} publishes no ONNX weights, so Transformers.js cannot run it in a browser. Use a model tagged "transformers.js" or "onnx", or point a sense at an endpoint instead.`;
      this._setProgress(id, { state: "error", percent: 0, text: "", error: msg });
      return { ok: false, error: msg };
    }

    let transformers;
    try {
      transformers = await this._loadTransformers();
    } catch (err) {
      const msg = `Could not load Transformers.js from ${TRANSFORMERS_MODULE_URL} — ${err.message}`;
      this._setProgress(id, { state: "error", percent: 0, text: "", error: msg });
      return { ok: false, error: msg };
    }

    // Bytes are summed across files rather than read off one file's percent:
    // a model is many shards, and "file 3 is 90% done" tells the reader
    // nothing about the whole download.
    const seen = new Map();
    const onProgress = (p) => {
      if (!p) return;
      if (p.status === "progress" && p.file) {
        seen.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
        let loaded = 0, total = 0;
        for (const v of seen.values()) { loaded += v.loaded; total += v.total; }
        const percent = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
        this._setProgress(id, { percent, text: `Downloading ${p.file} — ${humanBytes(loaded)} of ${humanBytes(total)}`, bytes: loaded });
      } else if (p.status === "initiate" && p.file) {
        this._setProgress(id, { text: `Fetching ${p.file}…` });
      } else if (p.status === "ready") {
        this._setProgress(id, { percent: 99, text: "Preparing the model…" });
      }
    };

    // Two axes of fallback, each reported when it fires. q8 keeps the
    // download small but not every repo ships a quantized variant; WebGPU is
    // faster but not every model has a WebGPU-compatible graph. Silently
    // succeeding on the second attempt would hide which build is actually
    // running, so the device and dtype that won are recorded and shown.
    const attempts = [];
    if (this.env.webgpu) attempts.push({ device: "webgpu", dtype: "q8" }, { device: "webgpu", dtype: undefined });
    attempts.push({ device: undefined, dtype: "q8" }, { device: undefined, dtype: undefined });

    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      const { device, dtype } = attempts[i];
      const label = `${device || "wasm"}${dtype ? `/${dtype}` : ""}`;
      if (i > 0) this._setProgress(id, { text: `Retrying as ${label} — ${lastErr ? lastErr.message : "previous build unavailable"}` });
      try {
        const opts = { progress_callback: onProgress };
        if (device) opts.device = device;
        if (dtype) opts.dtype = dtype;
        const pipe = await transformers.pipeline(entry.task, id, opts);
        this.pipelines.set(id, pipe);
        let bytes = 0;
        for (const v of seen.values()) bytes += v.loaded;
        this.store.installed[id] = {
          installedAt: new Date().toISOString(),
          bytes: bytes || meta.sizeBytes || 0,
          device: label,
          cacheVerified: this.env.cache ? true : false,
        };
        saveStore(this.store);
        this._setProgress(id, { state: "installed", percent: 100, text: `Installed — running on ${label}`, error: null });
        return { ok: true, device: label, bytes };
      } catch (err) {
        lastErr = err;
      }
    }

    // Every build failed. A network blip mid-download looks identical to an
    // incompatible model from here, so the retry loop above is given a real
    // second chance before this is called final.
    const msg = `Could not install ${id} — ${lastErr ? lastErr.message : "no compatible build"}${meta.hasTransformersJs ? "" : ". This repo is not tagged transformers.js, which is the usual cause."}`;
    this._setProgress(id, { state: "error", percent: 0, text: "", error: msg });
    return { ok: false, error: msg };
  }

  async installWithRetry(id) {
    let last = null;
    for (let attempt = 0; attempt < MAX_INSTALL_ATTEMPTS; attempt++) {
      last = await this.install(id);
      if (last.ok) return last;
      // Only a transport-shaped failure is worth retrying. "No ONNX weights"
      // will fail identically forever and retrying it three times just makes
      // the reader wait longer for the same true answer.
      if (!/network|fetch|timeout|aborted|502|503|504/i.test(last.error || "")) return last;
      if (attempt < MAX_INSTALL_ATTEMPTS - 1) {
        const wait = RETRY_BACKOFF_MS[attempt] || 7000;
        this._setProgress(id, { state: "installing", text: `Download failed — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${MAX_INSTALL_ATTEMPTS})…` });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    return last;
  }

  /**
   * Removes a model's weights from the browser cache and forgets the install.
   * Deletes real bytes, not just a flag — the reason to uninstall is usually
   * disk, and an uninstall that frees nothing would be a lie by omission.
   * Also switches the sense off: an enabled sense with no weights would go on
   * announcing itself at every ingest.
   */
  async uninstall(id) {
    this.pipelines.delete(id);
    let deleted = 0;
    try {
      if (typeof caches !== "undefined") {
        for (const name of await caches.keys()) {
          if (name !== TRANSFORMERS_CACHE && !/transformers/i.test(name)) continue;
          const cache = await caches.open(name);
          for (const req of await cache.keys()) {
            if (req.url.includes(`/${id}/`)) {
              if (await cache.delete(req)) deleted += 1;
            }
          }
        }
      }
    } catch {
      // A cache we cannot open is a cache we cannot clear; the record below
      // is still cleared so the panel stops claiming an install this browser
      // may no longer honour, and `deleted` reports what was really freed.
    }
    delete this.store.installed[id];
    this.store.enabled = this.store.enabled.filter((x) => x !== id);
    saveStore(this.store);
    this.progress.delete(id);
    this._emit();
    return { ok: true, deleted };
  }

  // Enabling something that is not installed is a caller error, not a silent
  // auto-install: an install is a multi-hundred-megabyte download and must
  // never be a side effect of flipping a switch.
  setEnabled(id, on) {
    if (on && !this.store.installed[id]) {
      return { ok: false, error: "not installed" };
    }
    const has = this.store.enabled.includes(id);
    if (on === has) return { ok: true, changed: false };
    this.store.enabled = on ? [...this.store.enabled, id] : this.store.enabled.filter((x) => x !== id);
    saveStore(this.store);
    this._emit();
    return { ok: true, changed: true };
  }

  setPrompt(id, text) {
    this.store.prompts = { ...this.store.prompts, [id]: text };
    saveStore(this.store);
    this._emit();
  }

  /** Adds a Hub search result to the library. Does not install it — same
   *  two-step contract as everything else here. */
  addFromHub(result) {
    if (!result || !result.id) return { ok: false, error: "no model id" };
    const task = result.task || result.pipelineTag;
    if (!RUNNABLE_TASKS[task]) {
      return { ok: false, error: `${task || "this model"} is not a task this browser runtime can turn into text` };
    }
    if (this.entry(result.id)) return { ok: false, error: "already in the library" };
    const spec = RUNNABLE_TASKS[task];
    const entry = {
      id: result.id,
      name: result.id,
      vendor: result.vendor || result.id.split("/")[0] || "",
      category: result.category || spec.category,
      task,
      scope: spec.scope,
      summary: result.summary || `${task} · added from the Hugging Face Hub`,
    };
    this.store.added = [...(this.store.added || []), entry];
    saveStore(this.store);
    if (result.hub) this.hubMeta.set(result.id, result.hub);
    this._emit();
    return { ok: true, entry };
  }

  /** Removes a Hub-added entry from the library entirely, uninstalling first
   *  so the weights do not outlive the row that could have removed them. */
  async removeFromLibrary(id) {
    if (BROWSER_SENSES.some((s) => s.id === id)) {
      return { ok: false, error: "built-in library entries cannot be removed — uninstall it instead" };
    }
    await this.uninstall(id);
    this.store.added = (this.store.added || []).filter((a) => a.id !== id);
    saveStore(this.store);
    this._emit();
    return { ok: true };
  }

  async loadHubMeta(id) {
    try {
      const meta = await fetchHubMeta(id);
      this.hubMeta.set(id, meta);
      this._emit();
      return meta;
    } catch (err) {
      this._setProgress(id, { error: `Could not read ${id} on Hugging Face — ${err.message}` });
      return null;
    }
  }

  /**
   * Searches the Hub from this browser — no proxy in the path, so it works on
   * the static build where /api/senses/discover cannot be reached at all.
   * Filters to tasks this runtime can actually run and reports how many
   * results that dropped, because a silently shortened list reads as "the Hub
   * only has four of these".
   */
  async searchHub(query) {
    const q = (query || "").trim();
    this.searchState = { query: q, loading: true, results: null, error: null, filteredOut: 0 };
    this._emit();
    const params = new URLSearchParams({ filter: "transformers.js", sort: "downloads", direction: "-1", limit: "40", full: "true" });
    if (q) params.set("search", q);
    try {
      const models = await hubJson(`${HF_API}?${params}`, 30000);
      const runnable = [];
      let filteredOut = 0;
      for (const m of models) {
        const task = m.pipeline_tag;
        if (!RUNNABLE_TASKS[task]) { filteredOut += 1; continue; }
        const license = licenseOf(m.tags);
        runnable.push({
          id: m.id,
          vendor: m.author || (m.id.split("/")[0] || ""),
          task,
          category: RUNNABLE_TASKS[task].category,
          license,
          licenseFlag: RESTRICTIVE_LICENSE_RE.test(license),
          downloads: m.downloads || 0,
          likes: m.likes || 0,
          url: `https://huggingface.co/${m.id}`,
          summary: `${task} · ${(m.downloads || 0).toLocaleString()} downloads`,
          inLibrary: !!this.entry(m.id),
        });
      }
      this.searchState = { query: q, loading: false, results: runnable, error: null, filteredOut };
      this._emit();
      return this.searchState;
    } catch (err) {
      this.searchState = { query: q, loading: false, results: null, error: err.message, filteredOut: 0 };
      this._emit();
      return this.searchState;
    }
  }

  async _pipelineFor(id) {
    if (this.pipelines.has(id)) return this.pipelines.get(id);
    const entry = this.entry(id);
    if (!entry) throw new Error(`"${id}" is not in the senses library`);
    if (!this.store.installed[id]) throw new Error(`${entry.name} is switched on but not installed`);
    // Installed but not resident in this tab: loading from the browser cache
    // is fast and offline, but if the cache was evicted this is a fresh
    // download — so it reports progress the same way an install does rather
    // than appearing to hang on the first ingest after a reload.
    const transformers = await this._loadTransformers();
    this._setProgress(id, { state: "installing", percent: 0, text: "Loading from cache…", error: null });
    const record = this.store.installed[id] || {};
    const device = /webgpu/.test(record.device || "") ? "webgpu" : undefined;
    const dtype = /q8/.test(record.device || "") ? "q8" : undefined;
    const opts = { progress_callback: (p) => { if (p && p.status === "progress" && p.total) this._setProgress(id, { percent: Math.round((p.loaded / p.total) * 100), text: `Re-downloading ${p.file} — the browser cache no longer has it` }); } };
    if (device) opts.device = device;
    if (dtype) opts.dtype = dtype;
    const pipe = await transformers.pipeline(entry.task, id, opts);
    this.pipelines.set(id, pipe);
    this._setProgress(id, { state: "installed", percent: 100, text: `Ready — ${record.device || "wasm"}`, error: null });
    return pipe;
  }

  /**
   * Runs one installed sense over one image and returns { text } — the same
   * shape _callSenseEndpoint returns, so the ingest paths take a browser
   * sense and a hosted one through the identical branch. Throws on failure;
   * callers catch per-sense so one broken model does not take down the others
   * looking at the same page.
   */
  async run(id, blob, extra = {}) {
    const entry = this.entry(id);
    if (!entry) throw new Error(`"${id}" is not in the senses library`);
    const pipe = await this._pipelineFor(id);
    const transformers = await this._loadTransformers();

    let image;
    let objectUrl = null;
    try {
      if (transformers.RawImage && transformers.RawImage.fromBlob) {
        image = await transformers.RawImage.fromBlob(blob);
      } else {
        objectUrl = URL.createObjectURL(blob);
        image = objectUrl;
      }

      const labels = (this.store.prompts[id] || "").trim() || DEFAULT_LABELS;
      const usingDefaultLabels = !(this.store.prompts[id] || "").trim();
      const labelList = labels.split(",").map((s) => s.trim()).filter(Boolean);

      let out;
      switch (entry.task) {
        case "image-to-text":
          out = await pipe(image);
          return { text: this._formatGenerated(out), sense: entry.name };
        case "object-detection":
          out = await pipe(image, { threshold: 0.5 });
          return { text: this._formatBoxes(out, entry, extra), sense: entry.name };
        case "zero-shot-object-detection":
          out = await pipe(image, labelList, { threshold: 0.1 });
          return { text: this._withLabelNote(this._formatBoxes(out, entry, extra), labelList, usingDefaultLabels), sense: entry.name };
        case "image-classification":
          out = await pipe(image, { top_k: 5 });
          return { text: this._formatScores(out), sense: entry.name };
        case "zero-shot-image-classification":
          out = await pipe(image, labelList);
          return { text: this._withLabelNote(this._formatScores(out), labelList, usingDefaultLabels), sense: entry.name };
        default:
          throw new Error(`${entry.task} is not a task this runtime knows how to read`);
      }
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  _formatGenerated(out) {
    const arr = Array.isArray(out) ? out : [out];
    return arr.map((o) => (o && (o.generated_text || o.text)) || "").filter(Boolean).join("\n").trim();
  }

  // Coordinates are kept, not rounded away into prose. A detection without
  // its box is a claim that cannot be checked against the image it came from,
  // and the whole point of storing this text is that a reader can go back to
  // the picture and see whether it was right.
  _formatBoxes(out, entry, extra) {
    const arr = Array.isArray(out) ? out : [out];
    const lines = arr.filter(Boolean).map((d) => {
      const box = d.box || {};
      const at = ["xmin", "ymin", "xmax", "ymax"].every((k) => typeof box[k] === "number")
        ? ` at [${Math.round(box.xmin)}, ${Math.round(box.ymin)} → ${Math.round(box.xmax)}, ${Math.round(box.ymax)}]`
        : "";
      return `${d.label} (${(d.score * 100).toFixed(1)}%)${at}`;
    });
    if (!lines.length) return `${entry.name} found nothing above its confidence threshold${extra.page ? ` on page ${extra.page}` : ""}.`;
    return lines.join("\n");
  }

  _formatScores(out) {
    const arr = Array.isArray(out) ? out : [out];
    return arr.filter(Boolean).map((d) => `${d.label} — ${(d.score * 100).toFixed(1)}%`).join("\n");
  }

  // A zero-shot model can only return a label it was handed. Printing the
  // question alongside the answer is what makes the answer readable later:
  // "no chart found" means nothing unless "chart" was one of the things asked
  // about, and a default vocabulary the reader never chose says so explicitly.
  _withLabelNote(text, labelList, usingDefault) {
    const asked = `Asked about: ${labelList.join(", ")}${usingDefault ? " (default vocabulary — set your own in Settings → Senses)" : ""}`;
    return `${asked}\n\n${text}`;
  }
}

window.EOSenses = new SensesRuntime();
window.EOSenses.init();
