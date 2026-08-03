// senses-hf.js — discovers vision models from the Hugging Face Hub API so
// the Senses library doesn't go stale in a field that moves this fast.
//
// There's no RSS feed for this — HF never shipped one for repos. What it has
// instead is better: the Hub's model-listing API is itself a queryable
// catalog, and its own task taxonomy (pipeline_tag) is the category
// vocabulary, fetched fresh rather than hardcoded — see
// https://huggingface.co/api/models and https://huggingface.co/api/models-tags-by-type.
//
// One blind spot querying tasks alone can't fix: HF has no OCR tag and no
// GUI-grounding tag. dots.mocr, Holo2, and PaddleOCR-VL all land under
// image-text-to-text, the same bucket as every general VLM — pipeline_tag
// cannot segment them out. The only way to find that layer is watching the
// authors who publish it (AUTHOR_WATCH, below); pipeline_tag alone is a
// firehose for those two categories specifically.
//
// Two sorts per task: `downloads` is the stable, proven shortlist;
// `createdAt` is the upgrade-candidate feed. The Hub API's sort param is
// camelCase (`createdAt`) — the browser URL's `sort=created` is a different,
// unaliased value the API silently ignores, falling back to lastModified
// desc. That failure mode looks like it worked (200, JSON, plausible dates)
// while quietly returning something else, which is exactly the kind of gap
// this codebase's laws forbid staying silent — so the query below uses the
// API's actual spelling, not the browser's.

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

const CACHE_PATH = path.join(MEMORY_DIR, "senses-hf-cache.json");
const HF_API = "https://huggingface.co/api/models";
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly — daily is fine-tune noise

// pipeline_tag → our four-category vocabulary. Grounding and OCR are not
// represented here on purpose — see the module comment. They come only from
// AUTHOR_WATCH, below, which overrides whatever this map would have said.
const TASK_CATEGORY = {
  "image-text-to-text": "vlm",
  "visual-question-answering": "vlm",
  "document-question-answering": "vlm",
  "video-text-to-text": "vlm",
  "visual-document-retrieval": "vlm",
  "any-to-any": "vlm",
  "image-feature-extraction": "vlm",
  "object-detection": "detection",
  "zero-shot-object-detection": "detection",
  "image-segmentation": "detection",
  "mask-generation": "detection",
  "keypoint-detection": "detection",
  "depth-estimation": "detection",
  "image-classification": "detection",
  "zero-shot-image-classification": "detection",
};

const TASKS = Object.keys(TASK_CATEGORY);

// Authors known to publish grounding/OCR models whose pipeline_tag (if any)
// doesn't say so. Deliberately short — a broad author watch turns into a
// firehose of that author's unrelated repos, which is the exact failure this
// exists to avoid for the two untagged categories.
const AUTHOR_WATCH = [
  { author: "Hcompany", category: "grounding" }, // Holo2
  { author: "rednote-hilab", category: "ocr" }, // dots.mocr
  { author: "PaddlePaddle", category: "ocr" }, // PaddleOCR-VL
];

const RESTRICTIVE_LICENSE_RE = /agpl|cc-by-nc|non.?commercial/i;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HF Hub returned ${res.status} for ${url}`);
  return res.json();
}

function licenseOf(tags) {
  const found = (tags || []).find((tag) => tag.startsWith("license:"));
  return found ? found.slice("license:".length) : "unknown";
}

function looksVision(pipelineTag) {
  return !pipelineTag || pipelineTag in TASK_CATEGORY || /image|vision|vqa|ocr|document|video/i.test(pipelineTag);
}

function normalize(m, category) {
  const license = licenseOf(m.tags);
  return {
    id: m.id,
    name: m.id,
    vendor: m.author || (m.id.split("/")[0] || ""),
    category,
    pipelineTag: m.pipeline_tag || null,
    summary: `${m.pipeline_tag || "vision model"} · ${(m.downloads || 0).toLocaleString()} downloads · ${(m.likes || 0).toLocaleString()} likes`,
    license,
    // Auto-flagged at catalog time, not after someone's already built on it —
    // this is exactly the AGPL/non-commercial trap OmniParser's detector and
    // Holo2's larger sizes set for anyone skimming a benchmark table.
    licenseFlag: RESTRICTIVE_LICENSE_RE.test(license),
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    createdAt: m.createdAt || null,
    hfUrl: `https://huggingface.co/${m.id}`,
    source: "huggingface",
    needsEndpoint: true,
  };
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — a failed write just means the next call refetches rather
    // than trusting a cache it couldn't confirm was saved.
  }
}

export function discoverCacheStatus() {
  const cache = loadCache();
  if (!cache) return { fetched: false, lastRefreshed: null, stale: true };
  const age = Date.now() - new Date(cache.lastRefreshed).getTime();
  return { fetched: true, lastRefreshed: cache.lastRefreshed, stale: age > REFRESH_INTERVAL_MS };
}

/**
 * Refreshes the discovered-model cache from the Hub: two queries per task
 * (downloads desc, createdAt desc) plus one per watched author, deduped by
 * id, diffed against the previous cache. Serves the cache unchanged if it's
 * still within the weekly window, unless `force` is set.
 *
 * Returns { discovered, lastRefreshed, isNew, errors, fromCache }. `errors`
 * is never swallowed into a falsely-empty result — if every query fails and
 * there's a prior cache, that cache is what's returned (with the errors
 * listed), not a wipe; if there's no prior cache, the empty result is
 * returned with the errors, because "genuinely nothing found" and
 * "everything failed" are different facts and must not read alike.
 */
export async function refreshHfCatalog({ force = false } = {}) {
  const prior = loadCache();
  if (!force && prior) {
    const age = Date.now() - new Date(prior.lastRefreshed).getTime();
    if (age < REFRESH_INTERVAL_MS) {
      return { discovered: prior.discovered, lastRefreshed: prior.lastRefreshed, isNew: [], errors: [], fromCache: true };
    }
  }

  const byId = new Map();
  const errors = [];

  for (const task of TASKS) {
    const category = TASK_CATEGORY[task];
    for (const sort of ["downloads", "createdAt"]) {
      const url = `${HF_API}?pipeline_tag=${encodeURIComponent(task)}&sort=${sort}&direction=-1&limit=25&full=true`;
      try {
        const models = await fetchJson(url);
        for (const m of models) if (!byId.has(m.id)) byId.set(m.id, normalize(m, category));
      } catch (err) {
        errors.push(`${task} (${sort}): ${err.message}`);
      }
    }
  }

  for (const { author, category } of AUTHOR_WATCH) {
    const url = `${HF_API}?author=${encodeURIComponent(author)}&full=true&limit=50`;
    try {
      const models = await fetchJson(url);
      for (const m of models) {
        if (!looksVision(m.pipeline_tag)) continue;
        byId.set(m.id, normalize(m, category)); // author watch wins the category on conflict
      }
    } catch (err) {
      errors.push(`author ${author}: ${err.message}`);
    }
  }

  const discovered = [...byId.values()].sort((a, b) => b.downloads - a.downloads);
  const priorIds = new Set((prior?.discovered || []).map((d) => d.id));
  const isNew = discovered.filter((d) => !priorIds.has(d.id)).map((d) => d.id);
  const lastRefreshed = new Date().toISOString();

  // Only overwrite the cache on a refresh that actually found something, or
  // when there was nothing to preserve — an all-failed refresh must not
  // erase a working prior snapshot just because HF was briefly unreachable.
  if (discovered.length || !prior) {
    saveCache({ discovered, lastRefreshed, errors });
    return { discovered, lastRefreshed, isNew, errors, fromCache: false };
  }
  return { discovered: prior.discovered, lastRefreshed: prior.lastRefreshed, isNew: [], errors, fromCache: true };
}
