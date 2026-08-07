// Tier 0, invariant "No LLM on load-bearing path" (eoreader6 AI Coding
// Evaluation Spec). Static grep for every LLM call site in eochat, plus the
// import-graph BFS the spec itself prescribes ("dependency graph from those
// call sites to fold/verdict/rho modules. Any path = fail"), walked with
// eval/tier0/lib/import-graph.mjs against the REAL files, not a model of them.
//
// This is a static check, not a runtime trace: it can miss an indirection
// through `eval()`/dynamic `import(variable)`/a require() built from string
// concatenation. Declared as a limitation, not silently assumed complete —
// see the "declared weak" precedent in eochat/server/code-longform.js's own
// verifySyntax for HTML/CSS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { importGraphFrom, EOCHAT_ROOT, WORK_ROOT } from "./lib/import-graph.mjs";

const EOREADER6 = resolve(WORK_ROOT, "eoreader6");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      walk(p, out);
    } else if (/\.(m?js)$/.test(entry)) out.push(p);
  }
  return out;
}

// Every place this codebase actually calls a generative model. Matched on the
// real, specific signals the research pass found (OLLAMA_URL, the Anthropic
// endpoint, WebLLM, and a literal "/api/chat" fetch path) rather than a bare
// "fetch" grep, which would flag ordinary retrieval calls that carry no model
// output at all.
const LLM_CALL_PATTERN = /OLLAMA_URL|ANTHROPIC_API_URL|webllm|\/api\/chat\b/i;

// The real modules whose output is verdict/rho/fold state, per the research
// pass: eoreader6/verdict/index.js (five-verdict assignment), belief.js (the
// rho-weighted mixture), and emergence/fold.js (the standpoint projection).
const LOAD_BEARING = [
  resolve(EOREADER6, "verdict/index.js"),
  resolve(EOREADER6, "packages/engine/generation/belief.js"),
  resolve(EOREADER6, "packages/engine/emergence/fold.js"),
];

const serverFiles = walk(join(EOCHAT_ROOT, "server"));
const uiFiles = walk(join(EOCHAT_ROOT, "ui"));
const engineFiles = walk(join(EOREADER6, "packages/engine")).concat(resolve(EOREADER6, "verdict/index.js"));

test("every file that calls an LLM never reaches a load-bearing verdict/rho/fold module", () => {
  const offenders = [];
  for (const file of [...serverFiles, ...uiFiles]) {
    const src = readFileSync(file, "utf8");
    if (!LLM_CALL_PATTERN.test(src)) continue;
    const { reached } = importGraphFrom(file);
    for (const hit of LOAD_BEARING) {
      if (reached.has(hit)) {
        offenders.push(`${relative(WORK_ROOT, file)} calls an LLM and imports (directly or transitively) ${relative(WORK_ROOT, hit)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `LLM output can reach load-bearing state:\n${offenders.join("\n")}`);
});

test("no load-bearing verdict/rho/fold module itself calls an LLM", () => {
  const offenders = [];
  for (const file of engineFiles) {
    const src = readFileSync(file, "utf8");
    if (LLM_CALL_PATTERN.test(src)) offenders.push(relative(WORK_ROOT, file));
  }
  assert.deepEqual(offenders, [], `engine module(s) with an LLM call site:\n${offenders.join("\n")}`);
});

// Named, not silently trusted: every LLM call site this suite found, so a
// human/agent can see the gate actually inspected something rather than
// vacuously passing because the pattern matched nothing.
test("the LLM call-site inventory is non-empty — a vacuous pass here would be worse than no gate", () => {
  const sites = [...serverFiles, ...uiFiles].filter((f) => LLM_CALL_PATTERN.test(readFileSync(f, "utf8")));
  assert.ok(sites.length > 0, "expected at least one real LLM call site (proxy.js, turn-controller.js, code-longform.js, …) — the pattern may be stale");
});
