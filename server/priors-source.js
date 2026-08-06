// priors-source.js — makes live_priors (github.com/clovenbradshaw-ctrl/live_priors)
// browsable, searchable, and citable in eochat as a first-class source,
// WITHOUT letting priors leak into corpus grounding.
//
// Each file in the live_priors category tree is one prior. Two layers:
//
//   RAW  — the file itself, ingested unmodified. Citations carry a verifiable
//          byte range into the actual source text.
//   CARD — a generated markdown wrapper under .derived/prior-cards/ with
//          metadata header + content preview. Ingested alongside so retrieval
//          has a clean markdown surface to match on.
//
// Both live in the "priors" POOL, never the corpus pool.
//
// CHROME — live_priors records what is default-off in each source
// (manifests/chrome/<source>.json, produced by scripts/pipeline-chrome.mjs).
// Chrome is a LAYER, not a wall: the corpus view is the default (chrome OFF),
// and readPrior(id, { chrome: true }) surfaces the archived raw with chrome
// back in. Nothing was ever deleted — the ledger says what is off and where.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { engineIngestFile, engineDeleteSource, engineSearch, DEFAULT_POOL } from "./engine-ground.js";
import { PRIORS_ROOT, REPO_ROOT } from "./paths.js";
import { isPriorDisabled, setPriorDisabled } from "./priors-state.js";

export const PRIORS_POOL = "priors";
const CARDS_DIR = path.join(REPO_ROOT, ".derived", "prior-cards");
const CHROME_DIR = path.join(PRIORS_ROOT, "manifests", "chrome");
const RAW_ROOT = path.join(PRIORS_ROOT, "raw");

const INGESTIBLE_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".xml", ".csv",
  ".scala", ".go", ".py", ".ts", ".c", ".rst",
  ".toml", ".mjs", ".js",
]);

const RAW_INGEST_MAX_BYTES = 2 * 1024 * 1024;
const CARD_PREVIEW_BYTES = 4000;

const CATEGORY_LABELS = {
  "01-literature-books": "Literature & Books",
  "02-encyclopedic": "Encyclopedic",
  "04-pre-aggregated-bulk": "Pre-aggregated Bulk",
  "05-academic-papers": "Academic Papers",
  "06-government-legal": "Government & Legal",
  "07-images-media": "Images & Media",
  "08-news-current": "News & Current",
  "09-source-code": "Source Code",
  "10-audio-music": "Audio & Music",
  "11-multi-language": "Multi-language",
  "13-mysticism": "Mysticism",
  "14-holy-texts": "Holy Texts",
  "15-western-canon": "Western Canon",
  "16-organic-community": "Organic Community",
  "17-formal-algebraic": "Formal & Algebraic",
};

function categoryOf(rel) {
  const top = rel.split("/")[0];
  return CATEGORY_LABELS[top] || top;
}

function walkFiles(dir, base = "") {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    // manifests/ and raw/ are the pipeline's bookkeeping, not priors:
    // manifests are fetch/pipeline metadata, raw/ is the verbatim chrome-surf
    // mirror of files already in the catalog. Neither belongs in the pool.
    if (e.name === "manifests" || e.name === "raw") continue;
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(abs, rel));
    else {
      const ext = path.extname(e.name).toLowerCase();
      if (INGESTIBLE_EXTENSIONS.has(ext)) out.push({ rel, abs });
    }
  }
  return out;
}

function sourceOf(rel) {
  const seg = rel.split("/");
  return seg.length > 1 ? seg[1] : seg[0];
}

// ─── chrome layer ─────────────────────────────────────────────────────────
// Per-source chrome ledgers recorded by live_priors' pipeline. Read once,
// cached; a missing ledger means "chrome not yet recorded" — never an error.

let chromeCache = null;

function loadChromeLedgers() {
  if (chromeCache) return chromeCache;
  const cache = new Map();
  if (fs.existsSync(CHROME_DIR)) {
    for (const f of fs.readdirSync(CHROME_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(CHROME_DIR, f), "utf8"));
        if (parsed?.source && parsed?.regions) {
          cache.set(parsed.source, parsed);
        }
      } catch {
        // skip corrupt ledger; surf layer degrades to "chrome not recorded"
      }
    }
  }
  chromeCache = cache;
  return cache;
}

export function chromeFor(rel, { includeRegions = false } = {}) {
  const ledger = loadChromeLedgers().get(sourceOf(rel));
  if (!ledger) return null;
  const entry = ledger.regions[rel];
  const regions = (entry && entry.regions) || [];
  const rawAbs = path.join(RAW_ROOT, rel);
  const base = {
    source: ledger.source,
    sourceDocs: ledger.docs,
    sourceChromeFraction: ledger.chromeFraction,
    regionsByKind: ledger.regionsByKind || null,
    regionCount: regions.length,
    hasRaw: fs.existsSync(rawAbs),
    defaultOff: true,
  };
  if (!includeRegions) return base;
  return {
    ...base,
    regions: regions.slice(0, 12).map((r) => ({
      kind: r.kind,
      startLine: r.startLine,
      endLine: r.endLine,
      members: r.membershipSize,
      sources: r.sources,
    })),
  };
}

function hashOf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

let catalogCache = null;

export function priorsCatalog({ refresh = false } = {}) {
  if (catalogCache && !refresh) return catalogCache;
  const items = [];
  for (const { rel, abs } of walkFiles(PRIORS_ROOT)) {
    const stat = fs.statSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const id = rel.replace(/\.[^.]+$/, "");
    const cardPath = path.join(CARDS_DIR, `${id}.md`);
    items.push({
      id,
      rel,
      path: abs,
      bytes: stat.size,
      ext,
      category: categoryOf(rel),
      cardPath,
      disabled: isPriorDisabled(id),
      rawIngestable: stat.size <= RAW_INGEST_MAX_BYTES,
      gap: stat.size > RAW_INGEST_MAX_BYTES
        ? `raw not admitted to the engine (${(stat.size / 1048576).toFixed(1)}MB > ${RAW_INGEST_MAX_BYTES / 1048576}MB cap); card is indexed, raw is readable by byte range`
        : null,
      chrome: chromeFor(rel),
    });
  }
  catalogCache = items;
  return items;
}

export function findPrior(id) {
  const wanted = String(id || "");
  const cat = priorsCatalog();
  return cat.find((p) => p.id === wanted)
    || cat.find((p) => p.id.endsWith(`/${wanted}`))
    || cat.find((p) => p.path === id)
    || null;
}

export function renderCard(item) {
  const body = [];
  body.push(`# ${item.id}`, "");
  body.push(
    `- **category**: ${item.category}`,
    `- **source**: \`live_priors/${item.rel}\``,
    `- **bytes**: ${item.bytes}`,
    `- **github**: https://github.com/clovenbradshaw-ctrl/live_priors/blob/main/${item.rel}`,
    "",
  );

  const chrome = chromeFor(item.rel);
  if (chrome) {
    const kinds = chrome.regionsByKind && Object.keys(chrome.regionsByKind).length
      ? Object.entries(chrome.regionsByKind).map(([k, v]) => `${v} ${k}`).join(", ")
      : "none recorded";
    body.push(
      `- **chrome**: ${(chrome.sourceChromeFraction * 100).toFixed(1)}% of this source is recurrent (default OFF, recorded in \`manifests/chrome/${chrome.source}.json\`)`,
      `- **chrome regions here**: ${chrome.regionCount} (${kinds})`,
      `- **surf chrome**: \`readPrior("${item.id}", { chrome: true })\`${chrome.hasRaw ? " — raw archived, full text surfable" : " — raw not archived yet (stripped at fetch); re-run the source fetcher to make it surfable"}`,
      "",
    );
  }

  let content = "";
  try {
    content = fs.readFileSync(item.path, "utf8");
  } catch {
    body.push("## Gap", "", "file could not be read", "");
    return body.join("\n");
  }

  if (content.length > CARD_PREVIEW_BYTES) {
    body.push(
      `## Preview`, "",
      content.slice(0, CARD_PREVIEW_BYTES),
      "",
      `_… truncated at ${CARD_PREVIEW_BYTES} of ${content.length} chars — read raw for full content._`,
      "",
    );
  } else {
    body.push("## Content", "", content, "");
  }

  if (item.gap) {
    body.push("## Gaps", "", `- ${item.gap}`, "");
  }

  return body.join("\n");
}

export function buildCards({ force = false } = {}) {
  fs.mkdirSync(CARDS_DIR, { recursive: true });
  const written = [];
  for (const item of priorsCatalog()) {
    const stamp = `<!-- source-sha256: ${hashOf(fs.readFileSync(item.path))} -->`;
    fs.mkdirSync(path.dirname(item.cardPath), { recursive: true });
    if (!force && fs.existsSync(item.cardPath)) {
      const existing = fs.readFileSync(item.cardPath, "utf8");
      if (existing.startsWith(stamp)) continue;
    }
    fs.writeFileSync(item.cardPath, `${stamp}\n${renderCard(item)}`, "utf8");
    written.push(item.id);
  }
  return written;
}

let ingested = null;

export function ensurePriorsIngested({ force = false } = {}) {
  if (ingested && !force) return ingested;
  buildCards({ force });

  const sources = [];
  const gaps = [];
  for (const item of priorsCatalog()) {
    if (item.disabled) {
      gaps.push(`${item.id}: disabled by user — not ingested (toggle it on in the Priors tab)`);
      continue;
    }
    try {
      const card = engineIngestFile(item.cardPath, {
        pool: PRIORS_POOL,
        kind: "prior-card",
        displayName: `${item.id} (card)`,
      });
      sources.push({ id: item.id, layer: "card", chunks: card.chunks, path: item.cardPath });
    } catch (err) {
      gaps.push(`card ingest failed for ${item.id}: ${err.message}`);
    }

    if (!item.rawIngestable) {
      gaps.push(`${item.id}: ${item.gap}`);
      continue;
    }
    try {
      const raw = engineIngestFile(item.path, {
        pool: PRIORS_POOL,
        kind: "prior-raw",
        displayName: item.rel,
      });
      sources.push({ id: item.id, layer: "raw", chunks: raw.chunks, path: item.path });
    } catch (err) {
      gaps.push(`raw ingest failed for ${item.id}: ${err.message}`);
    }
  }

  ingested = { pool: PRIORS_POOL, priors: priorsCatalog().length, sources, gaps };
  return ingested;
}

export function setPriorEnabled(id, enabled) {
  const item = findPrior(id);
  if (!item) return { error: `unknown prior "${id}"` };

  const changed = setPriorDisabled(item.id, !enabled);
  if (!changed) return { id: item.id, disabled: !enabled, changed: false };
  catalogCache = null;

  const gaps = [];
  if (enabled) {
    try {
      engineIngestFile(item.cardPath, { pool: PRIORS_POOL, kind: "prior-card", displayName: `${item.id} (card)` });
    } catch (err) {
      gaps.push(`card ingest failed for ${item.id}: ${err.message}`);
    }
    if (item.rawIngestable) {
      try {
        engineIngestFile(item.path, { pool: PRIORS_POOL, kind: "prior-raw", displayName: item.rel });
      } catch (err) {
        gaps.push(`raw ingest failed for ${item.id}: ${err.message}`);
      }
    } else if (item.gap) {
      gaps.push(item.gap);
    }
  } else {
    const cardRes = engineDeleteSource(item.cardPath, { pool: PRIORS_POOL });
    if (cardRes.error) gaps.push(`card: ${cardRes.error}`);
    if (item.rawIngestable) {
      const rawRes = engineDeleteSource(item.path, { pool: PRIORS_POOL });
      if (rawRes.error) gaps.push(`raw: ${rawRes.error}`);
    }
  }
  return { id: item.id, disabled: !enabled, changed: true, gaps };
}

export function readPrior(id, { layer = "raw", byteStart = 0, maxBytes = 40000, chrome = false } = {}) {
  const item = findPrior(id);
  if (!item) return { error: `unknown prior "${id}"` };

  const chromeInfo = chromeFor(item.rel, { includeRegions: true });
  const surfChrome = chrome && chromeInfo?.hasRaw;
  const target = layer === "card" ? item.cardPath : surfChrome ? path.join(RAW_ROOT, item.rel) : item.path;
  if (!fs.existsSync(target)) return { error: `${layer} not built for "${item.id}" (${target})` };
  const stat = fs.statSync(target);
  const start = Math.max(0, Math.min(byteStart, stat.size));
  const length = Math.min(maxBytes, stat.size - start);
  const fd = fs.openSync(target, "r");
  const buf = Buffer.alloc(length);
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return {
    id: item.id,
    layer: surfChrome ? "raw-with-chrome" : layer,
    path: target,
    category: item.category,
    byte_start: start,
    byte_end: start + length,
    total_bytes: stat.size,
    truncated: start + length < stat.size,
    gap: item.gap,
    text: buf.toString("utf8"),
    chrome: {
      defaultOff: true,
      requested: !!chrome,
      surfed: surfChrome,
      // When the chrome was destroyed at fetch (before raw archiving), the
      // ledger documents what is off but cannot conjure it. Re-fetch the
      // source to archive raw and make it surfable.
      notSurfableReason: chrome && chromeInfo && !chromeInfo.hasRaw
        ? `raw was not archived for this source (stripped at fetch before raw/ existed) — re-run the source fetcher to archive it; ledger still records ${chromeInfo.regionCount} chrome region(s)`
        : null,
      ...chromeInfo,
    },
  };
}

export function searchPriors(query, limit = 8, { maxChars = 900, prior } = {}) {
  ensurePriorsIngested();
  if (DEFAULT_POOL === PRIORS_POOL) throw new Error("priors pool must not be the default pool");
  const source = prior ? (findPrior(prior)?.id ?? prior) : null;
  return engineSearch(query, limit, { maxChars, source, pool: PRIORS_POOL });
}
