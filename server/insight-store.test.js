// Tests for the community-insights ledger: key merging, unclear-key
// flagging, conflict detection, and goal-vs-current delta computation.
//
// Uses a real InsightStore against a throwaway directory under the OS temp
// dir (not memory/insights/) so runs never touch or depend on real project
// data and can run in parallel/repeatedly without cleanup between them.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InsightStore,
  normalizeKeyText,
  jaccardSimilarity,
  matchKey,
  parseValue,
  sameValue,
  extractCandidateFacts,
  slugifyKey,
} from "./insight-store.js";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "insight-store-test-"));
  return new InsightStore({ dir });
}

// ── normalizeKeyText / jaccardSimilarity / matchKey ─────────────────────────

test("normalizeKeyText strips case, punctuation and diacritics to a token bag", () => {
  assert.equal(normalizeKeyText("Affordable Housing Units!"), "affordable housing units");
  assert.equal(normalizeKeyText("Café-Aff. Housing"), "cafe aff housing");
  assert.equal(normalizeKeyText(""), "");
});

test("jaccardSimilarity is 1 for identical token bags and 0 for disjoint ones", () => {
  assert.equal(jaccardSimilarity("affordable housing units", "affordable housing units"), 1);
  assert.equal(jaccardSimilarity("affordable housing units", "graduation rate"), 0);
  assert.ok(jaccardSimilarity("affordable housing units", "affordable housing target") > 0.3);
});

test("matchKey returns exact for an alias match, auto for a close fuzzy match, candidates for a plausible-but-unconfirmed one, unclear otherwise", () => {
  const registry = [
    { key: "housing_affordable_units", label: "Affordable housing units", aliases: ["Aff. Housing Units"] },
    { key: "youth_grad_rate", label: "Youth graduation rate", aliases: [] },
  ];
  assert.deepEqual(matchKey("Aff. Housing Units", registry).status, "exact");
  const auto = matchKey("affordable housing units total", registry);
  assert.equal(auto.status, "auto");
  assert.equal(auto.key, "housing_affordable_units");

  const candidates = matchKey("housing units", registry);
  assert.ok(candidates.status === "auto" || candidates.status === "candidates");

  const unclear = matchKey("stormwater capacity", registry);
  assert.equal(unclear.status, "unclear");
  assert.deepEqual(unclear.candidates, []);
});

test("slugifyKey produces a stable, filesystem/JSON-safe key from a label", () => {
  assert.equal(slugifyKey("Affordable Housing Units!"), "affordable_housing_units");
  assert.ok(slugifyKey("").startsWith("key_"));
});

// ── parseValue / sameValue ───────────────────────────────────────────────

test("parseValue recognizes percent, currency, number+unit, date, boolean and text", () => {
  assert.deepEqual(parseValue("42%"), { type: "percent", number: 42, unit: "%", text: "42%" });
  assert.equal(parseValue("$1.2 million").number, 1_200_000);
  assert.equal(parseValue("$1.2 million").type, "currency");
  const num = parseValue("500 units");
  assert.equal(num.type, "number");
  assert.equal(num.number, 500);
  assert.equal(num.unit, "units");
  assert.equal(parseValue("2030").type, "date");
  assert.equal(parseValue("2030").year, 2030);
  assert.equal(parseValue("Yes").bool, true);
  assert.equal(parseValue("Not met").bool, false);
  assert.equal(parseValue("a narrative description here").type, "text");
});

test("sameValue compares numeric values by number+unit and refuses to equate different units", () => {
  assert.ok(sameValue(parseValue("500 units"), parseValue("500 units")));
  assert.ok(!sameValue(parseValue("500 units"), parseValue("500 beds")));
  assert.ok(!sameValue(parseValue("500 units"), parseValue("600 units")));
  assert.ok(sameValue(parseValue("42%"), parseValue("42%")));
});

// ── extractCandidateFacts ────────────────────────────────────────────────

test("extractCandidateFacts pulls key:value lines and tags kind from section headers", () => {
  const text = [
    "GOALS",
    "Affordable housing units: 500 by 2030",
    "",
    "CURRENT STATE",
    "Affordable housing units: 210",
  ].join("\n");
  const facts = extractCandidateFacts(text);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].kind, "goal");
  assert.equal(facts[0].rawKey, "Affordable housing units");
  assert.equal(facts[0].rawValue, "500 by 2030");
  assert.equal(facts[1].kind, "current_state");
  assert.equal(facts[1].rawValue, "210");
});

test("extractCandidateFacts honors a leading 'By <year>' / '(<year>)' prefix as asOfYear", () => {
  const facts = extractCandidateFacts("By 2030: Affordable housing units = 500");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].asOfYear, 2030);
  assert.equal(facts[0].rawKey, "Affordable housing units");
  assert.equal(facts[0].rawValue, "500");
});

test("extractCandidateFacts reads a markdown table using header names to pick key/value columns", () => {
  const text = [
    "| Indicator | Baseline | Target |",
    "| --- | --- | --- |",
    "| Graduation rate | 74% | 90% |",
  ].join("\n");
  const facts = extractCandidateFacts(text);
  // Both baseline and target columns are not both extracted by one row scan —
  // this module picks one value column per row (target-like wins over
  // current/baseline-like when both are present) and the other one is not
  // silently invented; here Target should be selected.
  assert.equal(facts.length, 1);
  assert.equal(facts[0].rawKey, "Graduation rate");
  assert.equal(facts[0].rawValue, "90%");
  assert.equal(facts[0].kind, "goal");
});

test("extractCandidateFacts reads tab-separated rows (DOCX table extraction shape)", () => {
  const facts = extractCandidateFacts("Berth capacity\t3.4m\n");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].rawKey, "Berth capacity");
  assert.equal(facts[0].rawValue, "3.4m");
});

// ── InsightStore: ingestion, key merging, unclear flagging ──────────────

test("ingestDocument records observations and resolves keys already in the registry", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units", unit: "units" });
  const result = await store.ingestDocument("p1", {
    text: "GOALS\nAffordable housing units: 500 by 2030\n",
    kind: "goal",
    sourceId: "source:plan.pdf",
    sourceName: "2030 Community Plan",
  });
  assert.equal(result.added, 1);
  assert.equal(result.resolved, 1);
  assert.equal(result.unclear, 0);
  assert.equal(result.observations[0].key, "affordable_housing_units");
});

test("ingestDocument flags a raw key with no plausible registry match as unclear, with no candidates invented", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Graduation rate" });
  const result = await store.ingestDocument("p1", {
    text: "Stormwater capacity: 12M gallons\n",
    kind: "current_state",
  });
  assert.equal(result.unclear, 1);
  assert.equal(result.observations[0].keyStatus, "unclear");
  assert.deepEqual(result.observations[0].candidates, []);
  const unclear = await store.unclearKeys("p1");
  assert.equal(unclear.length, 1);
  assert.equal(unclear[0].rawKey, "Stormwater capacity");
});

test("resolveKey merges an unclear raw key into an existing canonical key and retroactively resolves prior observations", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units" });
  await store.ingestDocument("p1", { text: "Aff Housing Total: 500\n", kind: "goal" });
  let unclear = await store.unclearKeys("p1");
  assert.equal(unclear.length, 1);

  const { resolvedCount } = await store.resolveKey("p1", {
    rawKey: "Aff Housing Total",
    canonicalKey: "affordable_housing_units",
  });
  assert.equal(resolvedCount, 1);

  unclear = await store.unclearKeys("p1");
  assert.equal(unclear.length, 0);
  const obs = await store.listObservations("p1", { key: "affordable_housing_units" });
  assert.equal(obs.length, 1);
  assert.equal(obs[0].keyStatus, "resolved");

  // The alias sticks — a second document using the exact same wording merges
  // automatically without asking again.
  const again = await store.ingestDocument("p1", { text: "Aff Housing Total: 210\n", kind: "current_state" });
  assert.equal(again.observations[0].keyStatus, "resolved");
  assert.equal(again.observations[0].key, "affordable_housing_units");
});

test("resolveKey can create a brand-new canonical key from a raw key instead of mapping to an existing one", async () => {
  const store = freshStore();
  await store.ingestDocument("p1", { text: "Stormwater capacity: 12M gallons\n", kind: "current_state" });
  const { key, resolvedCount } = await store.resolveKey("p1", {
    rawKey: "Stormwater capacity",
    createLabel: "Stormwater capacity",
    category: "infrastructure",
  });
  assert.equal(resolvedCount, 1);
  const keys = await store.listKeys("p1");
  assert.ok(keys.some((k) => k.key === key && k.label === "Stormwater capacity"));
});

// ── Conflicts ────────────────────────────────────────────────────────────

test("conflicts() surfaces disagreeing values for the same resolved key/kind/asOf, each with its own source", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units" });
  await store.addObservation("p1", {
    key: "affordable_housing_units", rawKey: "Affordable housing units", kind: "current_state",
    value: "210", asOf: "2026", sourceId: "source:a", sourceName: "Doc A",
  });
  await store.addObservation("p1", {
    key: "affordable_housing_units", rawKey: "Affordable housing units", kind: "current_state",
    value: "240", asOf: "2026", sourceId: "source:b", sourceName: "Doc B",
  });
  const conflicts = await store.conflicts("p1");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, "affordable_housing_units");
  assert.equal(conflicts[0].values.length, 2);
  const sources = conflicts[0].values.map((v) => v.sourceId).sort();
  assert.deepEqual(sources, ["source:a", "source:b"]);
});

test("conflicts() does not fire when two observations for the same key/kind/asOf actually agree", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "current_state", value: "210", asOf: "2026", sourceId: "a" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "current_state", value: "210", asOf: "2026", sourceId: "b" });
  assert.deepEqual(await store.conflicts("p1"), []);
});

// ── state() / deltaReport() ──────────────────────────────────────────────

test("state() computes a numeric delta between a goal and a current value sharing a unit", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units", unit: "units" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "goal", value: "500", asOf: "2030" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "current_state", value: "210", asOf: "2026" });
  const [row] = await store.state("p1");
  assert.equal(row.deltaStatus, "computed");
  assert.equal(row.delta.amount, -290);
  assert.ok(Math.abs(row.delta.pctOfGoal - 42) < 0.01);
});

test("state() reports unit-mismatch instead of a wrong number when goal and current disagree on unit", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Housing budget" });
  await store.addObservation("p1", { key: "housing_budget", rawKey: "x", kind: "goal", value: "500 units" });
  await store.addObservation("p1", { key: "housing_budget", rawKey: "x", kind: "current_state", value: "500 beds" });
  const [row] = await store.state("p1");
  assert.equal(row.deltaStatus, "unit-mismatch");
  assert.equal(row.delta, null);
});

test("state() marks conflict status (not a guessed delta) when the current value itself is ambiguous", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "goal", value: "500", asOf: "2030" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "current_state", value: "210", asOf: "2026", sourceId: "a" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "current_state", value: "240", asOf: "2026", sourceId: "b" });
  const [row] = await store.state("p1");
  assert.equal(row.currentConflict, true);
  assert.equal(row.deltaStatus, "conflict");
  assert.equal(row.delta, null);
});

test("deltaReport() only includes keys that have a goal and/or a current observation", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units" });
  await store.createKey("p1", { label: "Untouched key" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "goal", value: "500" });
  const report = await store.deltaReport("p1");
  assert.equal(report.length, 1);
  assert.equal(report[0].key, "affordable_housing_units");
});

// ── history() / deltaBetween() ───────────────────────────────────────────

test("deltaBetween() finds the nearest observation at-or-before each requested point and diffs them", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "current_state", value: "150", asOf: "2022" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "current_state", value: "210", asOf: "2026" });
  const result = await store.deltaBetween("p1", "affordable_housing_units", { from: "2022", to: "2026" });
  assert.equal(result.status, "computed");
  assert.equal(result.delta.amount, 60);
});
