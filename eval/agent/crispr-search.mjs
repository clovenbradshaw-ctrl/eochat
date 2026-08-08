// crispr-search.mjs — CRISPR.md §6's recommended first, buildable step:
//
// PROMPT-WINDOW ECONOMY IS A HARD CONSTRAINT, NOT AN AFTERTHOUGHT. eoCode
// drives a small local model (see server/eocode-agent.js's default
// qwen2.5-coder:1.5b), and react-loop.mjs already documents the real
// failure mode this causes when ignored: n_tokens climbing past 3400
// within half a dozen steps because every tool observation gets replayed
// in full every turn. That fold discipline (DEFAULT_FOLD_K) only applies
// to TOOL RESULTS after they age out of the recent window — the SYSTEM
// PROMPT (every tool's `description`) is resent verbatim on every single
// turn for the entire run, unfolded, forever. So: keep this tool's
// description as short as the sibling tools in tools.mjs, and keep its
// RETURNED payload small even before folding — every extra field here is
// a real, permanent tax on a context budget that was already measured
// to be tight.
// check the local organ registry, then the public npm registry, before
// writing any new code, and retain provenance of every search whether or
// not it finds anything (CRISPR.md §3 / LAWS.md L2, L2e).
//
// Deliberately NOT the full pipeline CRISPR.md describes. Two honest
// simplifications, both already named in the essay's own open questions:
//   - "Kind induction" here is plain keyword extraction from the task
//     text, not the real entity-kinds induction organ — that organ lives
//     in eoreader5/6, not vendored into this checkout.
//   - No license-compatibility check, no cube-address confirmation, no
//     verification/splice gate. A candidate returned here is a LEAD to
//     review, never an auto-applied answer — the "permitter, not
//     generator" caution CRISPR.md itself insists on, just not yet
//     mechanized past the search step.
//
// Kept separate from eval/agent/tools.mjs on purpose: those tools also
// back the offline capability eval, which deliberately runs with no
// network access so it measures dependency-free coding ability. This tool
// is added on top, only for eoCode's real workspace sessions, via
// addPriorArtSearchTool() — see server/eocode-agent.js.

import { readFileSync, readdirSync, statSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { REPO_ROOT } from "../../server/paths.js";
import { ENTITY_NAMES } from "../../server/content-index.js";

export const DEFAULT_LEDGER_PATH = join(REPO_ROOT, "memory", "crispr-ledger.jsonl");

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "be", "that", "this", "it", "as", "by", "at", "from", "into", "not",
  "but", "if", "then", "code", "function", "write", "create", "add", "make",
  "implement", "build", "need", "should", "would", "could", "when", "which",
  "new", "file", "module", "using", "use", "want",
]);

const LOCAL_SCAN_DIRS = ["server", "eval", "ui"];
const LOCAL_SCAN_EXTS = new Set([".js", ".mjs"]);
const NPM_SEARCH_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 5; // bounds the raw JSON size of a single call's result — see the module header
const MAX_DESC_CHARS = 70;

function clip(s, n = MAX_DESC_CHARS) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

/** Plain keyword extraction — a stand-in for real kind induction (open question, CRISPR.md §5). */
export function extractSignature(taskPrompt, { max = 6 } = {}) {
  const words = String(taskPrompt ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, max);
}

function headerLineOf(absPath) {
  try {
    const text = readFileSync(absPath, "utf8").slice(0, 400);
    const line = text.split("\n").find((l) => l.trim().startsWith("//"));
    return line ? line.replace(/^\s*\/\/\s*/, "").trim() : "";
  } catch {
    return "";
  }
}

function walkFiles(dir, base, out) {
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
    if (st.isDirectory()) walkFiles(p, base, out);
    else if (LOCAL_SCAN_EXTS.has(name.slice(name.lastIndexOf(".")))) out.push(relative(base, p));
  }
  return out;
}

/**
 * Step 3 of CRISPR.md's pipeline: has this repo already built this kind?
 * Checked two ways — against the hand-registered organ names first (the
 * cheapest, most trusted source), then against this repo's own files by
 * name and header line.
 */
function searchLocal(signature) {
  const matches = [];

  for (const [key, name] of ENTITY_NAMES) {
    const hay = `${key} ${name}`.toLowerCase();
    if (signature.some((term) => hay.includes(term))) {
      matches.push({ kind: "organ", key, name, source: "server/content-index.js ENTITY_NAMES" });
    }
  }

  for (const dir of LOCAL_SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const rel of walkFiles(abs, REPO_ROOT, [])) {
      const header = headerLineOf(join(REPO_ROOT, rel));
      const hay = `${rel} ${header}`.toLowerCase();
      const hitCount = signature.filter((term) => hay.includes(term)).length;
      const threshold = Math.min(2, signature.length);
      if (hitCount >= threshold && hitCount > 0) {
        matches.push({ kind: "file", path: rel, header: clip(header), hitCount });
      }
    }
  }

  matches.sort((a, b) => (b.hitCount ?? 1) - (a.hitCount ?? 1));
  return matches.slice(0, MAX_CANDIDATES);
}

/**
 * Step 4 of CRISPR.md's pipeline: the industry's already-solved layer
 * (Krueger 1992) — is there a maintained package for this kind? Uses curl
 * (already the pattern eval/agent/tools.mjs's run_shell relies on) rather
 * than fetch so this stays synchronous, matching every other tool's run().
 */
function searchNpm(signature) {
  if (signature.length === 0) return { candidates: [] };
  const query = encodeURIComponent(signature.join(" "));
  const url = `https://registry.npmjs.org/-/v1/search?text=${query}&size=${MAX_CANDIDATES}`;
  try {
    const out = execSync(`curl -sS --max-time 8 "${url}"`, {
      encoding: "utf8",
      timeout: NPM_SEARCH_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    const data = JSON.parse(out);
    // npmUrl is deliberately omitted — it's mechanically derivable from
    // `name` (https://www.npmjs.com/package/<name>) and every extra field
    // here is a permanent tax on a small local model's context (see header).
    const candidates = (data.objects || []).slice(0, MAX_CANDIDATES).map((o) => ({
      name: o.package.name,
      version: o.package.version,
      description: clip(o.package.description),
      license: o.package.license || "UNKNOWN",
    }));
    return { candidates };
  } catch (err) {
    return { candidates: [], error: err.message };
  }
}

function appendLedger(ledgerPath, entry) {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort provenance logging (CRISPR.md §3 / LAWS.md L2e) — a
    // ledger write failure must never block the search result itself.
  }
}

/**
 * CRISPR.md §6's recommended first step, as a callable function: search
 * before hand-coding, and retain what was searched and found — or not
 * found — regardless of outcome.
 *
 * @param {object} opts
 * @param {string} opts.taskPrompt   what the agent is about to build
 * @param {string} [opts.ledgerPath] override for tests
 */
export function searchPriorArt({ taskPrompt, ledgerPath = DEFAULT_LEDGER_PATH }) {
  const signature = extractSignature(taskPrompt);
  const local = signature.length ? searchLocal(signature) : [];
  const npmResult = signature.length ? searchNpm(signature) : { candidates: [] };
  const npm = npmResult.candidates;
  const hit = local.length > 0 || npm.length > 0;

  const entry = {
    ts: Date.now(),
    taskPrompt: String(taskPrompt ?? "").slice(0, 300),
    signature,
    localCount: local.length,
    npmCount: npm.length,
    hit,
    npmError: npmResult.error,
  };
  appendLedger(ledgerPath, entry);

  return {
    signature,
    local,
    npm,
    hit,
    note: hit
      ? "review license/provenance before reusing"
      : signature.length === 0
        ? "no usable keywords in task description"
        : "no match — hand-coding is the honest next step",
  };
}

/**
 * Wires search_prior_art onto an existing eval/agent/tools.mjs toolset IN
 * PLACE. Not folded into createTools() itself because that function also
 * backs the offline capability eval, which deliberately has no network
 * access — see the module header. Only eoCode's real workspace sessions
 * (server/eocode-agent.js) call this.
 */
export function addPriorArtSearchTool(toolset) {
  toolset.tools.search_prior_art = {
    description:
      'search_prior_art({"task": "what you\'re about to build"}) — checks this codebase and npm for something that already does it, before you hand-code it. Review results yourself; nothing is auto-installed.',
    run(args) {
      let result;
      try {
        result = searchPriorArt({ taskPrompt: String(args?.task ?? "") });
      } catch (err) {
        result = { error: err.message };
      }
      toolset.toolCalls.push({ name: "search_prior_art", args, result, ts: toolset.toolCalls.length });
      return result;
    },
  };
  return toolset;
}
