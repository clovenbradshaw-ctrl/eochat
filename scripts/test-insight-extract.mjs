#!/usr/bin/env node
// Tests for ui/insight-extract.js and the localStorage-backed fallback store
// built on it in ui/index.html (the _localInsight* methods on the
// dc-runtime Component) — the standalone path Community Insights uses when
// no proxy is reachable (the GitHub Pages build ships ui/ alone, see
// .github/workflows/deploy-pages.yml).
//
// Two things are checked, both against the REAL source, not a re-derived
// copy:
//
//   1. Parity — ui/insight-extract.js's extraction/matching functions must
//      behave identically to server/insight-store.js's own copy of the same
//      functions on the same inputs. A fix made to one and not the other is
//      a fact that would merge two different ways depending on whether the
//      proxy happened to be running.
//
//   2. The local store — the _localInsight* methods actually shipped in
//      ui/index.html (extracted by comment marker, not a hardcoded line
//      range, so this keeps testing real source as the file changes), run
//      through a realistic ingest -> unclear -> resolve -> conflicts ->
//      state flow with a stubbed localStorage.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InsightStore } from "../server/insight-store.js";
import * as Server from "../server/insight-store.js";
import Client from "../ui/insight-extract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.stack || err.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.stack || err.message}`); process.exitCode = 1; }
}

// ── 1. Parity: ui/insight-extract.js vs server/insight-store.js ────────────

const SAMPLES = [
  `GOALS
Affordable housing units: 500 by 2030
Youth graduation rate: 74% (baseline)

CURRENT STATE
Affordable housing units: 210
Youth graduation rate: 61%`,
  `By 2030, Affordable housing units: 500
As of 2024: Affordable housing units: 210`,
  `| Indicator | Baseline | Target |
| --- | --- | --- |
| Affordable housing units | 210 | 500 |
| Youth graduation rate | 61% | 74% |`,
  `MNPD-DFR-Trial-Program-Proposal

CURRENT STATE
DFR pilot exempt from Council review: yes
Number of flights logged — 1,204

DEFINITIONS
Drone as First Responder: defined as a program dispatching a UAV ahead of officers to a 911 call.`,
  `Key\tValue
Response time\t4.2 minutes
Coverage area\t12 sq mi`,
  "not a key value line at all, just prose.\nAnother sentence without a colon or dash.",
];

check("extractCandidateFacts matches server output on every sample", () => {
  for (const [i, text] of SAMPLES.entries()) {
    assert.deepEqual(
      Client.extractCandidateFacts(text, { defaultKind: "goal" }),
      Server.extractCandidateFacts(text, { defaultKind: "goal" }),
      `sample #${i} diverged`
    );
  }
});

check("normalizeKeyText / jaccardSimilarity / matchKey match server", () => {
  const registry = [
    { key: "housing_affordable_units", label: "Affordable housing units", aliases: ["Aff. Housing Units"] },
    { key: "youth_grad_rate", label: "Youth graduation rate", aliases: [] },
  ];
  const rawKeys = ["Affordable Housing Units!", "Aff. Housing Units", "affordable housing units total", "housing units", "stormwater capacity", "Café-Aff. Housing"];
  for (const rk of rawKeys) {
    assert.equal(Client.normalizeKeyText(rk), Server.normalizeKeyText(rk), `normalizeKeyText(${rk})`);
    assert.deepEqual(Client.matchKey(rk, registry), Server.matchKey(rk, registry), `matchKey(${rk})`);
  }
});

check("parseValue / sameValue match server", () => {
  const values = ["42%", "$1.2 million", "2030", "500 units", "-3.5", "yes", "off track", "hello world", "", "500 by 2030"];
  for (const v of values) assert.deepEqual(Client.parseValue(v), Server.parseValue(v), `parseValue(${v})`);
  assert.equal(
    Client.sameValue(Client.parseValue("42%"), Client.parseValue("42%")),
    Server.sameValue(Server.parseValue("42%"), Server.parseValue("42%"))
  );
});

// asOfSortKey isn't exported from server/insight-store.js (a private helper
// there — only #pickLatest/history/deltaBetween use it), so this checks the
// client's copy against hand-computed expectations instead of the server.
check("asOfSortKey sorts a bare year, an ISO date, and undated consistently", () => {
  assert.equal(Client.asOfSortKey(""), "");
  assert.equal(Client.asOfSortKey(null), "");
  assert.equal(Client.asOfSortKey("2030"), "2030-99-99");
  assert.equal(Client.asOfSortKey("2024-01-01"), "2024-01-01");
  assert.ok(Client.asOfSortKey("") < Client.asOfSortKey("2024-01-01"));
  assert.ok(Client.asOfSortKey("2024-01-01") < Client.asOfSortKey("2030"));
});

check("slugifyKey matches server", () => {
  assert.equal(Client.slugifyKey("Affordable Housing Units!"), Server.slugifyKey("Affordable Housing Units!"));
  assert.ok(Client.slugifyKey("").startsWith("key_"));
});

check("thresholds match server exactly", () => {
  assert.equal(Client.CANDIDATE_THRESHOLD, Server.CANDIDATE_THRESHOLD);
  assert.equal(Client.AUTO_MERGE_THRESHOLD, Server.AUTO_MERGE_THRESHOLD);
  assert.equal(Client.MAX_CANDIDATES, Server.MAX_CANDIDATES);
});

// ── 2. The local store, extracted from the real ui/index.html by marker ────

const START_MARKER = "// ── Community Insights — standalone fallback (mirrors server/insight-store.js) ──";
const END_MARKER = "// ── Community Insights — standardized-key ledger (server/insight-store.js) ──";

function extractLocalStoreSource() {
  const html = fs.readFileSync(path.join(REPO_ROOT, "ui", "index.html"), "utf8");
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  assert.ok(start !== -1, `could not find start marker in ui/index.html — has the comment above _localInsightsMap() moved or been reworded?`);
  assert.ok(end !== -1 && end > start, `could not find end marker in ui/index.html — has the comment above fetchInsights() moved or been reworded?`);
  return html.slice(start, end);
}

function buildHarness() {
  const methodsSrc = extractLocalStoreSource();
  const classSrc = `(function(){
class Harness {
  constructor() { this._backing = new Map(); }
  _loadLocal(key) { try { const v = this._backing.get(key); return v === undefined ? null : JSON.parse(v); } catch { return null; } }
  _saveLocal(key, val) { try { this._backing.set(key, JSON.stringify(val)); } catch {} }
${methodsSrc}
}
return Harness;
})()`;
  // eslint-disable-next-line no-eval
  const Harness = (0, eval)(classSrc);
  return new Harness();
}

global.window = { EOInsightExtract: Client };
const harness = buildHarness();

const DOC1 = `GOALS
Affordable housing units: 500
Youth graduation rate: 74%

CURRENT STATE
Affordable housing units: 210
Youth graduation rate: 61%
Stormwater capacity: adequate`;

const DOC2 = `CURRENT STATE
Aff. Housing Units: 225
Affordable housing units: 300`;

const DOC3 = `CURRENT STATE
Affordable housing units: 225`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "insight-store-test-"));
const server = new InsightStore({ dir: tmpDir });
const PROJECT = "proj-e2e";

const localResult1 = harness._localInsightIngest(PROJECT, { content: DOC1, name: "Doc1", kind: "goal", asOf: null });

await checkAsync("_localInsightIngest: added/resolved/unclear counts match InsightStore.ingestDocument", async () => {
  const serverResult1 = await server.ingestDocument(PROJECT, { text: DOC1, kind: "goal", asOf: null, sourceId: "source:Doc1", sourceName: "Doc1" });
  assert.equal(localResult1.added, serverResult1.added);
  assert.equal(localResult1.resolved, serverResult1.resolved);
  assert.equal(localResult1.unclear, serverResult1.unclear);
  assert.ok(localResult1.added >= 5, `expected at least 5 facts, got ${localResult1.added}`);
});

check("_localInsightUnclearKeys: every fact from a fresh registry is unclear", () => {
  const unclear = harness._localInsightUnclearKeys(PROJECT);
  assert.equal(unclear.reduce((n, g) => n + g.count, 0), localResult1.added);
});

check("_localInsightResolveKey: merges the housing-units group onto a new canonical key", () => {
  const housingGroup = harness._localInsightUnclearKeys(PROJECT).find(g => g.rawKeys.some(k => /affordable housing units/i.test(k)));
  assert.ok(housingGroup, "expected an 'Affordable housing units' unclear group");
  const resolved = harness._localInsightResolveKey(PROJECT, { rawKeys: housingGroup.rawKeys, createLabel: "Affordable housing units" });
  assert.equal(resolved.resolvedCount, housingGroup.count);
});

check("_localInsightResolveKey: merges the graduation-rate group too", () => {
  const gradGroup = harness._localInsightUnclearKeys(PROJECT).find(g => g.rawKeys.some(k => /graduation/i.test(k)));
  assert.ok(gradGroup, "expected a 'Youth graduation rate' unclear group");
  harness._localInsightResolveKey(PROJECT, { rawKeys: gradGroup.rawKeys, createLabel: "Youth graduation rate" });
});

harness._localInsightIngest(PROJECT, { content: DOC2, name: "Doc2", kind: "current_state", asOf: "2025" });

check("_localInsightIngest (2nd doc): an exact-text raw key auto-merges onto the canonical key from doc 1", () => {
  const housingRow = harness._localInsightState(PROJECT).find(r => r.label === "Affordable housing units");
  assert.ok(housingRow, "expected a merged 'Affordable housing units' row");
  assert.ok(housingRow.signalCount >= 3, `expected signals from both docs, got ${housingRow.signalCount}`);
});

check("_localInsightIngest (2nd doc): a merely-similar raw key stays unclear with a candidate, never auto-merged", () => {
  const group = harness._localInsightUnclearKeys(PROJECT).find(g => g.rawKeys.includes("Aff. Housing Units"));
  assert.ok(group, "expected 'Aff. Housing Units' (~0.5 jaccard, below AUTO_MERGE_THRESHOLD) to still be unclear");
  assert.ok(group.candidates.some(c => c.label === "Affordable housing units"), "expected the canonical key offered as a candidate");
});

harness._localInsightIngest(PROJECT, { content: DOC3, name: "Doc3", kind: "current_state", asOf: "2025" });

check("_localInsightConflicts: two distinct values for the same key/kind/asOf are flagged, not silently picked", () => {
  const conflicts = harness._localInsightConflicts(PROJECT);
  const housingConflict = conflicts.find(c => c.values.some(v => v.value === "225") && c.values.some(v => v.value === "300"));
  assert.ok(housingConflict, `expected a 225-vs-300 conflict, got: ${JSON.stringify(conflicts)}`);
  assert.equal(housingConflict.key, "affordable_housing_units");
  assert.equal(housingConflict.asOf, "2025");
});

check("_localInsightState: a conflict-free goal and current value compute a numeric delta", () => {
  const gradRow = harness._localInsightState(PROJECT).find(r => r.label === "Youth graduation rate");
  assert.ok(gradRow, "expected a 'Youth graduation rate' row");
  assert.equal(gradRow.goal.parsed.type, "percent");
  assert.equal(gradRow.goal.parsed.number, 74);
  assert.equal(gradRow.current.parsed.number, 61);
  assert.equal(gradRow.deltaStatus, "computed");
  assert.equal(Math.round(gradRow.delta.amount), -13);
});

check("_localInsightCreateKey / _localInsightUpdateKey / _localInsightAddObservation / _localInsightHistory round-trip", () => {
  harness._localInsightCreateKey(PROJECT, { label: "Response time (minutes)", directionality: "unknown" });
  const rtKey = harness._localInsightState(PROJECT).find(r => r.label === "Response time (minutes)").key;
  harness._localInsightUpdateKey(PROJECT, rtKey, { directionality: "lower_is_better" });
  harness._localInsightAddObservation(PROJECT, { key: rtKey, kind: "goal", value: "4", asOf: "2028", sourceName: "manual entry" });
  harness._localInsightAddObservation(PROJECT, { key: rtKey, kind: "current_state", value: "6", asOf: "2025", sourceName: "manual entry" });
  const row = harness._localInsightState(PROJECT).find(r => r.key === rtKey);
  assert.equal(row.directionality, "lower_is_better");
  assert.equal(row.deltaStatus, "computed");
  assert.equal(row.progress, "off-track"); // current (6) worse than goal (4), lower is better
  const hist = harness._localInsightHistory(PROJECT, rtKey, "current_state");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].value, "6");
});

check("_localInsightRemoveObservation drops the fact from history", () => {
  const rtKey = harness._localInsightState(PROJECT).find(r => r.label === "Response time (minutes)").key;
  const hist = harness._localInsightHistory(PROJECT, rtKey, "current_state");
  const removed = harness._localInsightRemoveObservation(PROJECT, hist[0].id);
  assert.equal(removed.deleted, true);
  assert.equal(harness._localInsightHistory(PROJECT, rtKey, "current_state").length, 0);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed`);
if (process.exitCode) console.error("SOME TESTS FAILED");
