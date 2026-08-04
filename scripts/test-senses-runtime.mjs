#!/usr/bin/env node
// Tests for ui/senses-runtime.js — the browser-side install/enable/run
// machinery behind Settings → Senses.
//
// That module is written for a browser, so the browser is what gets stubbed:
// localStorage as a Map, fetch as a scripted responder, caches as an
// in-memory cache with the same delete semantics the real one has. Nothing
// here reaches the network or the Hugging Face Hub, which is the point — the
// behaviour under test is what the module does with the Hub's answers, and
// that must be checkable without one.
//
// Transformers.js itself is never imported: every test either stops before
// the pipeline load or asserts the failure that happens instead. The one
// thing this cannot cover is whether a given repo really loads, which is
// exactly why install() preflights the Hub and reports the reason by name.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, "..", "ui", "senses-runtime.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// ── Browser stubs ─────────────────────────────────────────────────────────

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// Mirrors the Cache API surface the module actually uses: keys() over cache
// names, open(), keys() over requests, delete(request) returning whether
// something was removed.
function makeCaches(initial = {}) {
  const store = new Map(Object.entries(initial).map(([name, urls]) => [name, new Set(urls)]));
  return {
    keys: async () => [...store.keys()],
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Set());
      const set = store.get(name);
      return {
        keys: async () => [...set].map((url) => ({ url })),
        delete: async (req) => set.delete(req.url),
      };
    },
    _store: store,
  };
}

// Loads a fresh copy of the module against a fresh set of stubs. The module
// installs a singleton on window at import time, so the cache-busting query
// is what keeps one test's state out of the next one's.
let loadCounter = 0;
async function loadRuntime({ fetchImpl, caches: cachesStub, webgpu = true, secure = true, storage } = {}) {
  const localStorage = storage || makeLocalStorage();
  const win = {
    isSecureContext: secure,
    location: { hostname: "localhost" },
  };
  globalThis.window = win;
  // Node exposes `navigator` as a getter-only global, so plain assignment
  // throws — defineProperty is the only way to swap it for a stub.
  Object.defineProperty(globalThis, "navigator", {
    value: webgpu ? { gpu: {} } : {},
    configurable: true,
    writable: true,
  });
  globalThis.localStorage = localStorage;
  globalThis.caches = cachesStub === null ? undefined : (cachesStub || makeCaches());
  globalThis.fetch = fetchImpl || (async () => { throw new Error("no fetch stub installed"); });
  globalThis.URL.createObjectURL = () => "blob:stub";
  globalThis.URL.revokeObjectURL = () => {};

  loadCounter += 1;
  const url = pathToFileURL(MODULE_PATH).href + `?t=${loadCounter}`;
  await import(url);
  const runtime = win.EOSenses;
  // init() runs at import and is async; let its cache verification settle so
  // assertions see a reconciled snapshot rather than a half-built one.
  await runtime.init();
  return { runtime, localStorage, win };
}

function hubModelResponse(overrides = {}) {
  return {
    id: "Xenova/test-model",
    tags: ["onnx", "transformers.js", "license:apache-2.0"],
    downloads: 1234,
    likes: 7,
    pipeline_tag: "image-to-text",
    siblings: [
      { rfilename: "config.json", size: 900 },
      { rfilename: "onnx/model.onnx", size: 40 * 1024 * 1024 },
      { rfilename: "onnx/model_quantized.onnx", size: 10 * 1024 * 1024 },
    ],
    ...overrides,
  };
}

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body };
}

// ── The module's own shape ────────────────────────────────────────────────

const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");

await test("every catalog entry declares a task this runtime can actually run", async () => {
  const { runtime } = await loadRuntime();
  const { library } = runtime.snapshot();
  assert.ok(library.length >= 8, "the shortlist should not have silently emptied");
  const runnable = new Set([
    "image-to-text", "image-classification", "zero-shot-image-classification",
    "object-detection", "zero-shot-object-detection",
  ]);
  for (const s of library) {
    assert.ok(runnable.has(s.task), `${s.id} declares task "${s.task}", which run() has no branch for`);
    assert.ok(["page", "image"].includes(s.scope), `${s.id} has no usable scope`);
    assert.ok(s.id.includes("/"), `${s.id} is not a Hub repo id`);
  }
});

await test("the catalog states no license, size, or download count from memory", async () => {
  // The whole honesty argument for this module is that repo facts come from
  // the Hub at preflight. A hardcoded license in the catalog would be a claim
  // about a repo nobody checked, and would go stale silently.
  const catalog = SOURCE.slice(SOURCE.indexOf("export const BROWSER_SENSES"), SOURCE.indexOf("const CATEGORY_ORDER"));
  assert.ok(!/license\s*:/.test(catalog), "a catalog entry hardcodes a license");
  assert.ok(!/\bsizes?\s*:/.test(catalog), "a catalog entry hardcodes a size");
  assert.ok(!/downloads\s*:/.test(catalog), "a catalog entry hardcodes a download count");
});

await test("screen grounding is left empty rather than filled with a model that can't do it", async () => {
  const { runtime } = await loadRuntime();
  const grounding = runtime.snapshot().library.filter((s) => s.category === "grounding");
  assert.strictEqual(grounding.length, 0, "no ONNX GUI-grounding model is claimed");
});

// ── Environment reporting ─────────────────────────────────────────────────

await test("no WebGPU is reported as slower, not as broken", async () => {
  const { runtime } = await loadRuntime({ webgpu: false });
  const { env } = runtime.snapshot();
  assert.strictEqual(env.runnable, true);
  assert.strictEqual(env.webgpu, false);
  assert.match(env.hint, /WASM/i);
});

await test("an insecure context reports that installs will not persist", async () => {
  const { runtime } = await loadRuntime({ secure: false, caches: null });
  const { env } = runtime.snapshot();
  assert.strictEqual(env.cache, false);
  assert.match(env.hint, /re-download/i);
});

// ── Enable/install state machine ──────────────────────────────────────────

await test("a sense cannot be switched on before it is installed", async () => {
  const { runtime } = await loadRuntime();
  const id = "Xenova/yolos-tiny";
  const result = runtime.setEnabled(id, true);
  assert.strictEqual(result.ok, false, "enabling an uninstalled sense must be refused");
  assert.strictEqual(result.error, "not installed");
  assert.strictEqual(runtime.snapshot().library.find((s) => s.id === id).enabled, false);
});

await test("uninstalling switches the sense off as well as deleting the weights", async () => {
  const id = "Xenova/yolos-tiny";
  const caches = makeCaches({ "transformers-cache": [
    `https://huggingface.co/${id}/resolve/main/config.json`,
    `https://huggingface.co/${id}/resolve/main/onnx/model_quantized.onnx`,
    "https://huggingface.co/Xenova/other/resolve/main/config.json",
  ] });
  const storage = makeLocalStorage();
  storage.setItem("eochat.senses.browser.v1", JSON.stringify({
    installed: { [id]: { installedAt: "2026-01-01T00:00:00.000Z", bytes: 1, device: "wasm/q8", cacheVerified: true } },
    enabled: [id],
    added: [],
    prompts: {},
  }));
  const { runtime } = await loadRuntime({ caches, storage });

  const before = runtime.snapshot().library.find((s) => s.id === id);
  assert.strictEqual(before.installed, true);
  assert.strictEqual(before.enabled, true);

  const result = await runtime.uninstall(id);
  assert.strictEqual(result.deleted, 2, "both cached files for this model are deleted, and only those");
  assert.strictEqual(caches._store.get("transformers-cache").size, 1, "another model's cache entry is untouched");

  const after = runtime.snapshot().library.find((s) => s.id === id);
  assert.strictEqual(after.installed, false);
  assert.strictEqual(after.enabled, false, "an enabled sense with no weights would announce itself at every ingest");
});

await test("an install recorded against a cache the browser has since cleared is reported, not believed", async () => {
  const id = "Xenova/detr-resnet-50";
  const storage = makeLocalStorage();
  storage.setItem("eochat.senses.browser.v1", JSON.stringify({
    installed: { [id]: { installedAt: "2026-01-01T00:00:00.000Z", bytes: 5, device: "wasm/q8", cacheVerified: true } },
    enabled: [id], added: [], prompts: {},
  }));
  const { runtime } = await loadRuntime({ storage, caches: makeCaches({ "transformers-cache": [] }) });
  const sense = runtime.snapshot().library.find((s) => s.id === id);
  assert.strictEqual(sense.cacheMissing, true, "the panel must not go on claiming weights that are gone");
  assert.strictEqual(sense.installed, true, "the record survives — the next run re-downloads rather than failing");
});

await test("install and enable state survives a reload", async () => {
  const id = "Xenova/vit-gpt2-image-captioning";
  const storage = makeLocalStorage();
  const caches = makeCaches({ "transformers-cache": [`https://huggingface.co/${id}/resolve/main/config.json`] });
  const first = await loadRuntime({ storage, caches });
  first.runtime.store.installed[id] = { installedAt: "2026-01-01T00:00:00.000Z", bytes: 3, device: "webgpu/q8", cacheVerified: true };
  first.runtime.setEnabled(id, true);

  const second = await loadRuntime({ storage, caches });
  const sense = second.runtime.snapshot().library.find((s) => s.id === id);
  assert.strictEqual(sense.installed, true);
  assert.strictEqual(sense.enabled, true);
  assert.strictEqual(sense.cacheMissing, false);
});

// ── Preflight ─────────────────────────────────────────────────────────────

await test("installing a model with no ONNX weights fails by name, before any download", async () => {
  let pipelineTouched = false;
  const { runtime } = await loadRuntime({
    fetchImpl: async () => jsonOk(hubModelResponse({
      id: "Xenova/vit-gpt2-image-captioning",
      tags: ["license:apache-2.0"],
      siblings: [{ rfilename: "pytorch_model.bin", size: 100 }],
    })),
  });
  runtime._loadTransformers = async () => { pipelineTouched = true; return {}; };
  const result = await runtime.install("Xenova/vit-gpt2-image-captioning");
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /no ONNX weights/);
  assert.strictEqual(pipelineTouched, false, "the loader must not be reached once preflight has the answer");
});

await test("a model missing from the Hub fails with the Hub's reason, not a loader stack trace", async () => {
  const { runtime } = await loadRuntime({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const result = await runtime.install("Xenova/yolos-tiny");
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /404/);
  const sense = runtime.snapshot().library.find((s) => s.id === "Xenova/yolos-tiny");
  assert.match(sense.error, /Could not verify/);
});

await test("the reported download size is the quantized build, not every dtype in the repo", async () => {
  const { runtime } = await loadRuntime({ fetchImpl: async () => jsonOk(hubModelResponse({ id: "Xenova/yolos-tiny" })) });
  const meta = await runtime.loadHubMeta("Xenova/yolos-tiny");
  assert.strictEqual(meta.sizeBytes, 10 * 1024 * 1024, "40 MB fp32 + 10 MB q8 must not be reported as a 50 MB download");
  assert.strictEqual(meta.sizeIsWholeRepo, false);
});

await test("a repo with no quantized build says so instead of quietly reporting the full size as the download", async () => {
  const { runtime } = await loadRuntime({
    fetchImpl: async () => jsonOk(hubModelResponse({
      id: "Xenova/yolos-tiny",
      siblings: [{ rfilename: "onnx/model.onnx", size: 40 * 1024 * 1024 }],
    })),
  });
  const meta = await runtime.loadHubMeta("Xenova/yolos-tiny");
  assert.strictEqual(meta.sizeBytes, 40 * 1024 * 1024);
  assert.strictEqual(meta.sizeIsWholeRepo, true);
});

await test("a restrictive license is flagged at catalog time, not after someone has built on it", async () => {
  const { runtime } = await loadRuntime({
    fetchImpl: async () => jsonOk(hubModelResponse({ id: "Xenova/yolos-tiny", tags: ["onnx", "license:cc-by-nc-4.0"] })),
  });
  const meta = await runtime.loadHubMeta("Xenova/yolos-tiny");
  assert.strictEqual(meta.licenseFlag, true);
});

await test("a permanent failure is not retried three times to reach the same answer", async () => {
  let calls = 0;
  const { runtime } = await loadRuntime({
    fetchImpl: async () => { calls += 1; return jsonOk(hubModelResponse({ id: "Xenova/yolos-tiny", tags: ["license:mit"], siblings: [{ rfilename: "pytorch_model.bin", size: 1 }] })); },
  });
  const result = await runtime.installWithRetry("Xenova/yolos-tiny");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(calls, 1, "no ONNX weights will be just as absent on the third attempt");
});

// ── Hub search ────────────────────────────────────────────────────────────

await test("search hides models this browser cannot run and says how many", async () => {
  const { runtime } = await loadRuntime({
    fetchImpl: async () => jsonOk([
      { id: "Xenova/a", pipeline_tag: "image-to-text", tags: ["license:mit"], downloads: 10, author: "Xenova" },
      { id: "Xenova/b", pipeline_tag: "depth-estimation", tags: ["license:mit"], downloads: 9, author: "Xenova" },
      { id: "Xenova/c", pipeline_tag: "image-segmentation", tags: ["license:mit"], downloads: 8, author: "Xenova" },
      { id: "Xenova/d", pipeline_tag: "zero-shot-object-detection", tags: ["license:apache-2.0"], downloads: 7, author: "Xenova" },
    ]),
  });
  const result = await runtime.searchHub("vision");
  assert.strictEqual(result.results.length, 2);
  assert.strictEqual(result.filteredOut, 2, "a shortened list must say what was dropped, not just look short");
  assert.deepStrictEqual(result.results.map((r) => r.id), ["Xenova/a", "Xenova/d"]);
});

await test("a failed search is an error, never an empty result set", async () => {
  const { runtime } = await loadRuntime({ fetchImpl: async () => { throw new Error("network down"); } });
  const result = await runtime.searchHub("ocr");
  assert.strictEqual(result.results, null, "\"found nothing\" and \"could not check\" must not read alike");
  assert.match(result.error, /network down/);
});

await test("adding from the Hub puts it in the library without installing it", async () => {
  const { runtime } = await loadRuntime();
  const added = runtime.addFromHub({ id: "onnx-community/some-detector", task: "object-detection" });
  assert.strictEqual(added.ok, true);
  const sense = runtime.snapshot().library.find((s) => s.id === "onnx-community/some-detector");
  assert.ok(sense, "the added model appears in the library");
  assert.strictEqual(sense.installed, false, "adding must never trigger a hundred-megabyte download as a side effect");
  assert.strictEqual(sense.category, "detection");
  assert.strictEqual(sense.source, "hub");
});

await test("a model whose task this runtime cannot read is refused with the reason", async () => {
  const { runtime } = await loadRuntime();
  const added = runtime.addFromHub({ id: "onnx-community/depth", task: "depth-estimation" });
  assert.strictEqual(added.ok, false);
  assert.match(added.error, /depth-estimation/);
});

await test("built-in entries cannot be removed from the library by mistake", async () => {
  const { runtime } = await loadRuntime();
  const result = await runtime.removeFromLibrary("Xenova/yolos-tiny");
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /uninstall/);
});

// ── Output formatting ─────────────────────────────────────────────────────

await test("detections keep their boxes so a claim can be checked against the image", async () => {
  const { runtime } = await loadRuntime();
  const entry = runtime.entry("Xenova/detr-resnet-50");
  const text = runtime._formatBoxes(
    [{ label: "person", score: 0.91, box: { xmin: 10.2, ymin: 20.8, xmax: 90.1, ymax: 180.4 } }],
    entry, {}
  );
  assert.match(text, /person \(91\.0%\) at \[10, 21 → 90, 180\]/);
});

await test("finding nothing is stated, not returned as empty text", async () => {
  const { runtime } = await loadRuntime();
  const entry = runtime.entry("Xenova/detr-resnet-50");
  const text = runtime._formatBoxes([], entry, { page: 3 });
  assert.match(text, /found nothing/);
  assert.match(text, /page 3/, "which page found nothing is part of the finding");
});

await test("a zero-shot answer carries the question it was asked", async () => {
  const { runtime } = await loadRuntime();
  const withOwn = runtime._withLabelNote("cat — 90.0%", ["cat", "dog"], false);
  assert.match(withOwn, /Asked about: cat, dog/);
  assert.ok(!/default vocabulary/.test(withOwn));

  const withDefault = runtime._withLabelNote("cat — 90.0%", ["cat", "dog"], true);
  assert.match(withDefault, /default vocabulary/, "a vocabulary the reader never chose must announce itself");
});

await test("an enabled zero-shot sense always has some vocabulary to ask about", async () => {
  const { runtime } = await loadRuntime();
  const owl = runtime.snapshot().library.find((s) => s.id === "Xenova/owlvit-base-patch32");
  assert.strictEqual(owl.needsLabels, true);
  assert.ok(owl.promptEffective.length > 0, "an empty question would be sent otherwise");
  runtime.setPrompt(owl.id, "a stop sign, a crosswalk");
  const after = runtime.snapshot().library.find((s) => s.id === owl.id);
  assert.strictEqual(after.promptEffective, "a stop sign, a crosswalk");
});

// ── What the ingest paths consume ─────────────────────────────────────────

await test("activeSenses is installed AND on — neither alone", async () => {
  const id = "Xenova/vit-gpt2-image-captioning";
  const storage = makeLocalStorage();
  const caches = makeCaches({ "transformers-cache": [`https://huggingface.co/${id}/resolve/main/config.json`] });
  const { runtime } = await loadRuntime({ storage, caches });

  assert.strictEqual(runtime.activeSenses().length, 0);

  runtime.store.installed[id] = { installedAt: "2026-01-01T00:00:00.000Z", bytes: 1, device: "wasm/q8", cacheVerified: true };
  assert.strictEqual(runtime.activeSenses().length, 0, "installed but off must not run");

  runtime.setEnabled(id, true);
  const active = runtime.activeSenses();
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].runtime, "browser", "the ingest path branches on this");
  assert.ok(active[0].scope, "the PDF path needs scope to tell a page reader from a crop reader");
});

await test("switched on but never installed is a gap the ingest path can name", async () => {
  const { runtime } = await loadRuntime();
  const id = "Xenova/yolos-tiny";
  // Reaching past setEnabled's guard on purpose: this is the state a browser
  // lands in when the cache is cleared, and it must be reportable, not
  // unreachable.
  runtime.store.enabled = [id];
  const pending = runtime.pendingSenses();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].id, id);
  assert.strictEqual(runtime.activeSenses().length, 0, "a sense with no weights must never be run");
});

await test("line-level OCR senses are marked so the PDF page loop can skip them honestly", async () => {
  const { runtime } = await loadRuntime();
  const trocr = runtime.snapshot().library.filter((s) => s.id.includes("trocr"));
  assert.ok(trocr.length >= 3);
  for (const s of trocr) {
    assert.strictEqual(s.scope, "image", `${s.id} reads one cropped line — handing it a full page returns nonsense`);
  }
});

console.log(`\nSENSES-RUNTIME TESTS: ${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
