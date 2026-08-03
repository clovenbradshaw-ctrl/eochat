// live-priors-source.js — makes live_priors browsable as a folder tree in the
// Priors tab. Unlike priors-source.js (which ingests JSON artifacts into the
// engine), this module exposes the raw directory structure so the UI can
// navigate folders and open individual files.
//
// Empty folders — those with no real files, only .DS_Store or nothing — are
// filtered out at every level. A folder that contains only empty subfolders
// is itself empty. The tree the UI sees is the tree that actually has content.

import fs from "node:fs";
import path from "node:path";
import { LIVE_PRIORS_ROOT } from "./paths.js";

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"]);
const IGNORED_DIRS = new Set([".git", "node_modules", ".tmp-*", "downloads"]);

function isIgnoredDir(name) {
  if (IGNORED_DIRS.has(name)) return true;
  if (name.startsWith(".tmp-")) return true;
  return false;
}

function isIgnoredFile(name) {
  return IGNORED_FILES.has(name) || name.startsWith(".");
}

// Count real files in a directory tree, ignoring .DS_Store etc. A folder with
// zero real files is empty and should not appear in the tree.
function countRealFiles(dir) {
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (isIgnoredDir(e.name)) continue;
      count += countRealFiles(path.join(dir, e.name));
    } else if (e.isFile() && !isIgnoredFile(e.name)) {
      count++;
    }
  }
  return count;
}

// Build the tree recursively. Each node is either a folder (with children) or
// a file (with size). Folders with zero real files are pruned.
function buildTree(dir, relBase = "") {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }

  const folders = [];
  const files = [];

  for (const e of entries) {
    // At the root, this is the corpus's OWN repo — its package.json, README,
    // SOURCES.md, scripts/, src/, manifests/ manage the corpus, they are not
    // source-text content. Only the numbered taxonomy folders (01-literature-
    // books, 02-encyclopedic, ...) are the living corpus the Priors tab is
    // for. One level down, no such rule applies — a category's own internal
    // structure is real content.
    if (relBase === "" && !(e.isDirectory() && /^\d+-/.test(e.name))) continue;

    const abs = path.join(dir, e.name);
    const rel = relBase ? `${relBase}/${e.name}` : e.name;

    if (e.isDirectory()) {
      if (isIgnoredDir(e.name)) continue;
      const subtree = buildTree(abs, rel);
      if (!subtree) continue;
      // A folder is only included if it has content (files or non-empty subfolders).
      if (subtree.fileCount === 0) continue;
      folders.push({
        type: "folder",
        name: e.name,
        path: rel,
        children: subtree.children,
        fileCount: subtree.fileCount,
      });
    } else if (e.isFile() && !isIgnoredFile(e.name)) {
      const stat = fs.statSync(abs);
      files.push({
        type: "file",
        name: e.name,
        path: rel,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }

  const fileCount = files.length + folders.reduce((sum, f) => sum + f.fileCount, 0);
  if (fileCount === 0) return null;

  return { children: [...folders, ...files], fileCount };
}

let treeCache = null;
let treeCacheTime = 0;
const TREE_CACHE_TTL = 30_000;

// Return the full tree, cached for 30 seconds. The tree is a snapshot of the
// directory at a point in time; fresh enough for browsing, stale enough to
// avoid re-walking on every request.
export function livePriorsTree({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && treeCache && now - treeCacheTime < TREE_CACHE_TTL) {
    return treeCache;
  }
  const result = buildTree(LIVE_PRIORS_ROOT);
  treeCache = result;
  treeCacheTime = now;
  return result;
}

// Resolve a relative path against LIVE_PRIORS_ROOT, checked to ensure it
// doesn't escape the root. Shared by readLivePrior (text) and the raw byte
// server (audio/video/image) so both enforce the same containment rule.
export function resolveLivePriorPath(relPath) {
  const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(LIVE_PRIORS_ROOT, normalized);
  if (!abs.startsWith(LIVE_PRIORS_ROOT)) {
    return { error: "path escapes live_priors root" };
  }
  if (!fs.existsSync(abs)) {
    return { error: `file not found: ${normalized}` };
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    return { error: `not a file: ${normalized}` };
  }
  return { normalized, abs, stat };
}

// Read a file's contents by relative path. The path is resolved against
// LIVE_PRIORS_ROOT and checked to ensure it doesn't escape the root.
export function readLivePrior(relPath, { byteStart = 0, maxBytes = 80000 } = {}) {
  const resolved = resolveLivePriorPath(relPath);
  if (resolved.error) return resolved;
  const { normalized, abs, stat } = resolved;

  const start = Math.max(0, Math.min(byteStart, stat.size));
  const length = Math.min(maxBytes, stat.size - start);
  const fd = fs.openSync(abs, "r");
  const buf = Buffer.alloc(length);
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  return {
    path: normalized,
    absPath: abs,
    byte_start: start,
    byte_end: start + length,
    total_bytes: stat.size,
    truncated: start + length < stat.size,
    text: buf.toString("utf8"),
  };
}

// List the top-level categories (the numbered folders). This is a thin
// wrapper over the tree for the UI's initial view.
export function livePriorsCategories() {
  const tree = livePriorsTree();
  if (!tree) return [];
  return tree.children
    .filter((c) => c.type === "folder")
    .map((f) => ({
      name: f.name,
      path: f.path,
      fileCount: f.fileCount,
    }));
}
