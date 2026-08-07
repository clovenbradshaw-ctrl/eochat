// coherence-check.mjs — CRISPR.md pipeline stage 10 (the coherence gate),
// implemented, not just proposed.
//
// Verification (stage 8) proves each snipped piece works in isolation. It
// says nothing about whether MULTIPLE snipped pieces actually relate to
// each other the way a real implementation would, or just sit next to each
// other because they each individually compiled. This module answers that,
// by pointing `server/task-log.js`'s deriveLevels() — already a working,
// mechanical existence-dependency test ("B cannot exist without A" => A is
// above B; a pair earning neither test is a PEER, a first-class honest
// result, not a failure to find a hierarchy) — at a REAL import graph
// instead of an abstract task's hand-declared depends_on.
//
// HONEST LIMIT, carried over from deriveLevels() itself and stated in
// CRISPR.md's coherence-gate stage: docs/holon-level.md names TWO tests,
// existence-dependency and possibility-constraint ("A constrains what B may
// be"). Only existence-dependency is implemented here, because only
// existence-dependency is implemented anywhere in this codebase —
// possibility-constraint has no working definition yet to build against.
// This module can tell you two snipped files are UNRELATED; it cannot yet
// tell you two related files are wired CORRECTLY.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";
import { deriveLevels } from "../../server/task-log.js";

function resolveInSandbox(sandboxDir, relPath) {
  const abs = resolve(sandboxDir, String(relPath ?? "."));
  const rel = relative(sandboxDir, abs);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`path "${relPath}" escapes the sandbox directory`);
  }
  return abs;
}

const CODE_EXTS = new Set([".js", ".mjs", ".jsx", ".ts", ".tsx"]);
// Matches `import ... from "x"`, `import "x"`, and `require("x")` — good
// enough to find the real edges a snip actually declares; a full parser
// would catch more (dynamic imports, re-exports) but this is the same
// regex-based discipline content-index.js already uses for the same job.
const IMPORT_RE = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|require\(\s*)["']([^"']+)["']/g;

function listCodeFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) listCodeFiles(p, base, out);
    else if (CODE_EXTS.has(extname(name))) out.push(relative(base, p));
  }
  return out;
}

/** Resolve a relative import spec to one of the snip's own files, or null (external / not part of this snip). */
function resolveImport(fromFile, spec, allFiles, baseDir) {
  if (!spec.startsWith(".")) return null;
  const raw = resolve(baseDir, dirname(fromFile), spec);
  const rel = relative(baseDir, raw);
  const candidates = [
    rel,
    ...[...CODE_EXTS].map((e) => rel + e),
    ...[...CODE_EXTS].map((e) => join(rel, "index" + e)),
  ];
  return candidates.find((c) => allFiles.includes(c)) ?? null;
}

function buildImportGraph(dir, files) {
  return files.map((f) => {
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      // unreadable file: no edges found, treated as isolated rather than guessed
    }
    const depends_on = new Set();
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(text))) {
      const target = resolveImport(f, m[1], files, dir);
      if (target && target !== f) depends_on.add(target);
    }
    return { task_id: f, depends_on: [...depends_on] };
  });
}

/**
 * Run the coherence gate over a real snipped set of files: does the real
 * import graph actually relate them (existence-dependency, via
 * deriveLevels), or is at least one file present with zero earned relation
 * to anything else in the snip — the "incoherent pile" this gate exists to
 * catch, since a search/snip step can easily group files that are
 * topically similar (same directory, same keyword match) without being
 * structurally connected at all.
 *
 * @param {string} dir directory containing the snipped files (e.g. a
 *   cloned repo, or a subdirectory of one)
 * @param {string[]} [files] optional explicit file list (relative to dir);
 *   defaults to every real code file found under dir
 */
export function checkCoherence(dir, files = null) {
  const allFiles = files ?? listCodeFiles(dir);
  if (allFiles.length < 2) {
    return { files: allFiles, relations: [], isolated: allFiles, coherent: allFiles.length === 1 };
  }

  const tasks = buildImportGraph(dir, allFiles);
  const { levels, relations } = deriveLevels(tasks);

  const isolated = allFiles.filter(
    (f) => !relations.some((r) => (r.a === f || r.b === f) && r.relation !== "peer"),
  );

  return {
    files: allFiles,
    levels,
    relations,
    relatedCount: relations.filter((r) => r.relation !== "peer").length,
    peerCount: relations.filter((r) => r.relation === "peer").length,
    isolated,
    // Coherent only if EVERY snipped file earns a real relation to at least
    // one other file in the snip — a lone file with zero import edges in
    // either direction is exactly the failure this gate is built to catch.
    coherent: isolated.length === 0,
  };
}

const MAX_ISOLATED_LISTED = 8; // same prompt-window-economy discipline as crispr-search.mjs

/**
 * Wires check_coherence onto an existing toolset IN PLACE, scoped to
 * sandboxDir the same way tools.mjs's own tools are — this one touches the
 * agent's actual workspace files, unlike search_prior_art/search_app_archetype,
 * so it needs the same path-escape guard every other file-reading tool has.
 * The full `relations` array is deliberately never returned to the model —
 * only the compact isolated/coherent summary — for the reason stated in
 * crispr-search.mjs's own header: the system prompt (this tool's
 * description) and every tool result are both a permanent, per-call tax on
 * a small local model's context.
 */
export function addCoherenceCheckTool(toolset, sandboxDir) {
  toolset.tools.check_coherence = {
    description:
      'check_coherence({"dir": "relative/path"}) — after snipping/adapting code from elsewhere, checks whether the files under dir actually import/reference each other (real wiring) or are just sitting next to each other with no real connection. Run this before finish whenever you copied code in from outside.',
    run(args) {
      let result;
      try {
        const abs = resolveInSandbox(sandboxDir, args?.dir ?? ".");
        const full = checkCoherence(abs);
        result = {
          fileCount: full.files.length,
          isolated: full.isolated.slice(0, MAX_ISOLATED_LISTED),
          isolatedCount: full.isolated.length,
          relatedCount: full.relatedCount,
          coherent: full.coherent,
          note: full.coherent
            ? "every file relates to at least one other file here"
            : "some files have zero real connection to the rest — check if they're actually needed, or missing an edge",
        };
      } catch (err) {
        result = { error: err.message };
      }
      toolset.toolCalls.push({ name: "check_coherence", args, result, ts: toolset.toolCalls.length });
      return result;
    },
  };
  return toolset;
}
