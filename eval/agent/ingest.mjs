// The "surf and fold" half of the redirect, applied to a whole codebase
// instead of prose: clone a public GitHub repo (or use a local path), admit
// every source file into a dedicated pool of the REAL engine corpus
// (@eoreader/host/corpus, via engine-ground.js's engineIngestFile —
// text/byte-chunked, format-agnostic, so source code ingests exactly like
// prose does), then expose a `surf(query)` research callback backed by the
// real engineGroundQuery (search -> score -> fold to a token budget, the
// same mechanism engineSearch/holonic-task.js already use for retrieval).
//
// This is deliberately NOT a bespoke grep-and-cat tool: the point of the
// redirect is that a CPU-bound local model has small, slow, precious
// context, and "surf broadly, then fold to what fits the budget, and REPORT
// what got withheld" is a real, already-proven discipline in this codebase
// (task-log.js's foldToWorkingSet; engineGroundQuery's own `gaps`/`dropped`
// accounting) — reused here rather than re-invented as raw file dumping.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { engineIngestFile, engineGroundQuery } from "../../server/engine-ground.js";

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java",
  ".rb", ".c", ".h", ".cpp", ".md", ".json", ".txt", ".css", ".html",
]);
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", "vendor", "__pycache__"]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 200_000;

function listSourceFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (out.length >= MAX_FILES) return out;
    if (st.isDirectory()) listSourceFiles(p, base, out);
    else if (CODE_EXTENSIONS.has(extname(entry)) && st.size <= MAX_FILE_BYTES) out.push(p);
  }
  return out;
}

/** Accepts a full git URL, an "owner/repo" GitHub shorthand, or a local directory already on disk. */
export function resolveAndCloneRepo(source, destDir) {
  if (existsSync(source) && statSync(source).isDirectory()) return { dir: source, cloned: false };
  const url = source.includes("://") || source.endsWith(".git") ? source : `https://github.com/${source}.git`;
  mkdirSync(destDir, { recursive: true });
  execSync(`git clone --depth 1 "${url}" "${destDir}"`, { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return { dir: destDir, cloned: true, url };
}

/** Ingest every source file under `rootDir` into the named engine pool. Returns an honest count, never a silent partial. */
export function ingestCodebase(rootDir, poolName) {
  const files = listSourceFiles(rootDir);
  const ingested = [];
  const skipped = [];
  for (const abs of files) {
    const rel = relative(rootDir, abs);
    try {
      engineIngestFile(abs, { pool: poolName, kind: "corpus", displayName: rel });
      ingested.push(rel);
    } catch (err) {
      skipped.push({ path: rel, reason: err.message });
    }
  }
  return { pool: poolName, rootDir, filesIngested: ingested.length, filesFound: files.length, skipped, hitFileCap: files.length >= MAX_FILES };
}

/** The surf+fold research callback handed to holon-coder.mjs / react-loop.mjs. */
export function createSurf(poolName, { budget = 1200, maxUnits = 6 } = {}) {
  return async function surf(query) {
    const result = engineGroundQuery(query, { pool: poolName, budget, maxUnits });
    if (!result.citations?.length) {
      return `(surf found no matching passages in the ingested codebase for: "${query}" — ${result.total} candidate span(s) scored below the relevance floor)`;
    }
    const lines = result.citations.map((c, i) => `[${i + 1}] ${c.source_id}: ${String(c.text ?? "").slice(0, 400)}`);
    if (result.dropped > 0) lines.push(`(${result.dropped} more matching passage(s) exceeded the ${budget}-token research budget and were withheld, not silently dropped)`);
    return lines.join("\n\n");
  };
}
