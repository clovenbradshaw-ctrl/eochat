// Tier 0, invariant "Priors boundary" — every prior touching a turn's
// surf/fold must be declared and traceable (id + action), never a silent
// side channel. There is no single "priors ledger" module in this codebase
// (the research pass confirmed the real primitive is engine-ground.js's
// widenQueryWithPriors, whose `priorWidening` array is threaded into
// turn-controller.js's `witnesses_selected` SSE event) — so the mechanical
// check here is a call-site audit: every place `loadCorefPrior`/
// `activatePriors` (server/priors-bridge.js) is actually invoked, locked to
// a known, individually-verified set. A NEW call site is exactly the failure
// mode the spec describes ("a prior wired into engine-ground.js but not
// surfaced in the ledger") and must fail this test until it is audited and
// added below with a note on where its usage is reported.
//
// Same ratchet shape as eoreader6/conformance/reproducibility.test.js's
// absolute-path debt list — this allow-list may only change by a deliberate
// edit, in either direction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { EOCHAT_ROOT } from "./lib/import-graph.mjs";
import { join, relative } from "node:path";

const CALL_RE = /\b(loadCorefPrior|activatePriors)\s*\(/g;
const isDeclaration = (src, matchIndex) => /function\s*$/.test(src.slice(Math.max(0, matchIndex - 20), matchIndex));

// Audited 2026-08-07. For each: the file:line, and WHERE the prior's effect
// is reported to a caller (never silently dropped).
const KNOWN_CALL_SITES = [
  // engine-ground.js widenQueryWithPriors -> returns `priorWidening`, threaded
  // through engineSearch()/engineGroundQuery() into turn-controller.js's
  // `witnesses_selected` SSE event.
  { file: "server/engine-ground.js", fn: "loadCorefPrior" },
  { file: "server/engine-ground.js", fn: "activatePriors" },
  // engine-ground.js engineFoldSource -> descriptor-coref fold projection;
  // absence is pushed as a typed gap (`typedGap("prior", ...)`), not silently
  // skipped.
  { file: "server/engine-ground.js", fn: "loadCorefPrior" },
  // proxy.js exposes a `getPriors(text, sourceId)` tool method that returns
  // the raw `activatePriors` result directly to its caller — a declared,
  // named surface, not a bypass of the ledger (it does not touch fold itself;
  // see the no-llm-on-load-bearing-path suite for that boundary).
  { file: "server/proxy.js", fn: "loadCorefPrior" },
  { file: "server/proxy.js", fn: "activatePriors" },
];

test("every loadCorefPrior/activatePriors call site is a known, audited one", () => {
  const found = [];
  // Scan the whole server/ tree, not just the known files, so a brand
  // new file calling these functions is caught even if it isn't in the list.
  const allServerFiles = readAllJsUnder(join(EOCHAT_ROOT, "server"));
  for (const abs of allServerFiles) {
    const rel = relative(EOCHAT_ROOT, abs);
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(CALL_RE)) {
      if (isDeclaration(src, m.index)) continue; // "export function loadCorefPrior(" is not a call site
      found.push({ file: rel, fn: m[1] });
    }
  }

  const key = (s) => `${s.file}::${s.fn}`;
  const knownCounts = countBy(KNOWN_CALL_SITES.map(key));
  const foundCounts = countBy(found.map(key));

  const newSites = [...foundCounts.keys()].filter((k) => !knownCounts.has(k) || foundCounts.get(k) > knownCounts.get(k));
  assert.deepEqual(newSites, [], `new, un-audited prior call site(s) — a prior may be touching surf/fold with no traced report:\n${newSites.join("\n")}`);

  const missingSites = [...knownCounts.keys()].filter((k) => !foundCounts.has(k));
  assert.deepEqual(missingSites, [], `an audited call site no longer exists — remove it from KNOWN_CALL_SITES so the list reflects reality:\n${missingSites.join("\n")}`);
});

function countBy(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function readAllJsUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...readAllJsUnder(p));
    else if (entry.endsWith(".js")) out.push(p);
  }
  return out;
}
