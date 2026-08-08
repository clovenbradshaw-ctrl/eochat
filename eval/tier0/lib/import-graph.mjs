// A small, honest static import-graph walker for the no-llm-on-load-bearing-
// path check. It understands exactly two kinds of specifiers this monorepo
// actually uses — relative ("./x.js", "../x.js") and the "@eoreader/*" file:
// aliases eochat/package.json declares — and nothing else. A specifier it
// cannot resolve is reported as an unresolved node, never silently dropped,
// so the walker can't produce a false "clean" graph by failing quietly on
// exactly the edge that mattered.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EOCHAT_ROOT = resolve(__dirname, "../../..");
export const WORK_ROOT = resolve(EOCHAT_ROOT, "..");

const IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|(?:await\s+)?import\(\s*["']([^"']+)["']\s*\)/g;

function readAliasMap() {
  const pkg = JSON.parse(readFileSync(join(EOCHAT_ROOT, "package.json"), "utf8"));
  const map = {};
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    const m = /^file:(.+)$/.exec(spec);
    if (m) map[name] = resolve(EOCHAT_ROOT, m[1]);
  }
  return map; // e.g. { "@eoreader/engine": "/…/eoreader6/packages/engine", ... }
}
export const ALIASES = readAliasMap();

function candidatePaths(p) {
  if (existsSync(p) && !p.endsWith("/")) return [p];
  return [p, `${p}.js`, `${p}.mjs`, join(p, "index.js"), join(p, "index.mjs")];
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec);
    return candidatePaths(base).find(existsSync) ?? null;
  }
  for (const alias of Object.keys(ALIASES).sort((a, b) => b.length - a.length)) {
    if (spec === alias || spec.startsWith(`${alias}/`)) {
      const rest = spec.slice(alias.length).replace(/^\//, "");
      const base = rest ? join(ALIASES[alias], rest) : ALIASES[alias];
      const hit = candidatePaths(base).find(existsSync);
      if (hit) return hit;
      // package.json "exports" map (e.g. "@eoreader/engine/prediction/tasks")
      try {
        const pkgJsonPath = join(ALIASES[alias], "package.json");
        if (existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
          const exp = pkgJson.exports?.[`./${rest}`] ?? pkgJson.exports?.[rest];
          if (exp) {
            const expPath = resolve(ALIASES[alias], typeof exp === "string" ? exp : exp.default ?? exp.import);
            if (existsSync(expPath)) return expPath;
          }
        }
      } catch { /* fall through to unresolved */ }
      return null;
    }
  }
  return null; // bare specifier this walker does not claim to resolve (e.g. "node:fs", "fs")
}

/**
 * BFS the local import graph starting at `entryFile`, up to `maxDepth` hops.
 * Returns { reached: Set<absPath>, unresolved: Set<string> } — bare
 * specifiers (npm packages, node builtins) are recorded as unresolved rather
 * than silently skipped, so a caller can see what the walk could not follow.
 */
export function importGraphFrom(entryFile, { maxDepth = 8 } = {}) {
  const reached = new Set([resolve(entryFile)]);
  const unresolved = new Set();
  let frontier = [resolve(entryFile)];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next = [];
    for (const file of frontier) {
      let src;
      try { src = readFileSync(file, "utf8"); } catch { continue; }
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec) continue;
        if (!spec.startsWith(".") && !Object.keys(ALIASES).some((a) => spec === a || spec.startsWith(`${a}/`))) {
          unresolved.add(spec); // node:fs, "node-fetch", etc — not this monorepo's own graph
          continue;
        }
        const resolved = resolveSpecifier(spec, file);
        if (!resolved) { unresolved.add(`${spec} (from ${file})`); continue; }
        if (!reached.has(resolved)) { reached.add(resolved); next.push(resolved); }
      }
    }
    frontier = next;
    depth += 1;
  }
  return { reached, unresolved };
}
