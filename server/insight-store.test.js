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
  keysStructurallyCorefer,
  matchKey,
  parseValue,
  sameValue,
  extractCandidateFacts,
  slugifyKey,
  proposeFactsWithModel,
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

test("matchKey returns exact ONLY for literal identity after normalization — everything else, however close, is a candidate", () => {
  const registry = [
    { key: "housing_affordable_units", label: "Affordable housing units", aliases: ["Aff. Housing Units"] },
    { key: "youth_grad_rate", label: "Youth graduation rate", aliases: [] },
  ];
  assert.equal(matchKey("Aff. Housing Units", registry).status, "exact");

  // Containment (structural) — a real, rankable signal, but never auto-applied.
  // eoreader6's referents/consequence.js retired appearance-based identity
  // matching even for its own, harder, statistically-testable version of this
  // problem ("No stem table, no edit distance... not even here"); this module
  // has no equivalent evidence to test against, so it is stricter still.
  const structural = matchKey("affordable housing units total", registry);
  assert.equal(structural.status, "candidates");
  assert.equal(structural.candidates[0].key, "housing_affordable_units");
  assert.equal(structural.candidates[0].structural, true);

  const unclear = matchKey("stormwater capacity", registry);
  assert.equal(unclear.status, "unclear");
  assert.deepEqual(unclear.candidates, []);
});

// ── keysStructurallyCorefer — a ranking signal only, never a merge trigger ──

test("keysStructurallyCorefer detects containment when the shared token is significant", () => {
  assert.ok(keysStructurallyCorefer("Affordable Housing Units", "Housing Units"));
  assert.ok(keysStructurallyCorefer("Housing Units", "Affordable Housing Units"));
});

test("keysStructurallyCorefer refuses containment on a shared GENERIC token alone — the 'Prince Andrew/Prince Vasili' failure mode ported to plan vocabulary", () => {
  // Both end in "units", but that is the only thing they share, and "units"
  // is exactly the kind of generic measurement noun discover-cast.js's
  // shared-leading-honorific carve-out warns against treating as identity.
  assert.ok(!keysStructurallyCorefer("Affordable Housing Units", "Broadband Access Units"));
  assert.ok(!keysStructurallyCorefer("Housing Target", "Graduation Target"));
});

test("matchKey never returns 'auto' for anything short of literal identity — not even structural containment", () => {
  const registry = [{ key: "housing_target_rate", label: "Housing target rate", aliases: [] }];
  const structural = matchKey("Affordable Housing Target Rate", registry); // contains "housing"
  assert.notEqual(structural.status, "auto");
  assert.equal(structural.status, "candidates");

  // High Jaccard overlap (both contain "target"/"rate") but no significant
  // shared token and no containment — still just a candidate.
  assert.ok(jaccardSimilarity("Annual Target Rate", "Housing target rate") >= 0.34);
  const fuzzy = matchKey("Annual Target Rate", registry);
  assert.notEqual(fuzzy.status, "auto");
});

test("matchKey reports an ambiguous structural match as candidates listing both, never guesses one", () => {
  const registry = [
    { key: "north_housing_units", label: "North district housing units", aliases: [] },
    { key: "south_housing_units", label: "South district housing units", aliases: [] },
  ];
  // "Housing Units" structurally corefers with BOTH (containment both ways) —
  // the "Prince across several princes" case. Must not silently pick one.
  const m = matchKey("Housing Units", registry);
  assert.equal(m.status, "candidates");
  const keys = m.candidates.filter((c) => c.structural).map((c) => c.key).sort();
  assert.deepEqual(keys, ["north_housing_units", "south_housing_units"]);
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

test("extractCandidateFacts pulls key:value lines and tags kind from section headers, given a declared language", () => {
  const text = [
    "GOALS",
    "Affordable housing units: 500 by 2030",
    "",
    "CURRENT STATE",
    "Affordable housing units: 210",
  ].join("\n");
  const facts = extractCandidateFacts(text, { language: "en" });
  assert.equal(facts.length, 2);
  assert.equal(facts[0].kind, "goal");
  assert.equal(facts[0].rawKey, "Affordable housing units");
  assert.equal(facts[0].rawValue, "500"); // trailing "by 2030" is stripped into asOfYear, not left in the value
  assert.equal(facts[0].asOfYear, 2030);
  assert.equal(facts[1].kind, "current_state");
  assert.equal(facts[1].rawValue, "210");
});

// "goals may never ever be called goals": the literal English word is never
// baked into this module as a universal signal. Undeclared language, the
// exact same document above gets NO kind signal from its headers at all —
// an honest gap, not a silent assumption that untagged text is English.
test("extractCandidateFacts gives no kind signal from section headers when no language is declared", () => {
  const text = ["GOALS", "Affordable housing units: 500"].join("\n");
  const facts = extractCandidateFacts(text);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, null);
});

test("extractCandidateFacts reads a real Spanish municipal-plan header ('OBJETIVOS') via the es kind-vocabulary prior", () => {
  // "OBJETIVOS" is a real section heading in Málaga's published Plan
  // Municipal de Vivienda y Suelo ("2. OBJETIVOS Y METODOLOGÍA", "2.1.
  // OBJETIVOS", "Objetivos Generales:") — not a translation guessed from the
  // English word list.
  const facts = extractCandidateFacts(
    ["OBJETIVOS", "Viviendas asequibles: 500"].join("\n"),
    { language: "es" },
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "goal");
});

test("extractCandidateFacts reads a real French PLH header ('DIAGNOSTIC') via the fr kind-vocabulary prior", () => {
  // "DIAGNOSTIC" is a real section heading in Plaine Commune's published
  // Programme Local de l'Habitat 2022-2027 synthesis — the document's own
  // word for its current-state/needs-assessment section.
  const facts = extractCandidateFacts(
    ["DIAGNOSTIC", "Logements sociaux: 4200"].join("\n"),
    { language: "fr" },
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "current_state");
});

test("extractCandidateFacts degrades honestly (no crash, no kind) for a language with no prior file yet", () => {
  const facts = extractCandidateFacts(
    ["ZIELE", "Bezahlbare Wohnungen: 500"].join("\n"),
    { language: "de" },
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, null);
});

test("extractCandidateFacts honors a leading 'By <year>' / '(<year>)' prefix as asOfYear, without defaulting an unsignaled kind to 'goal'", () => {
  const facts = extractCandidateFacts("By 2030: Affordable housing units = 500");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].asOfYear, 2030);
  assert.equal(facts[0].rawKey, "Affordable housing units");
  assert.equal(facts[0].rawValue, "500");
  // A dated line is not, by itself, evidence of being a GOAL — a dated
  // current-state line ("By 2024, current population reached 45,000") is
  // exactly as plausible and an earlier version of this code silently
  // guessed "goal" for both.
  assert.equal(facts[0].kind, null);
});

test("extractCandidateFacts strips a TRAILING 'by <year>' clause from the value — the far more natural phrasing real plan documents actually use", () => {
  // Found on real sample data: without this, parseValue("500 by 2030") is
  // type 'text' (the trailing digits aren't valid unit text), which silently
  // makes a goal-vs-current delta report 'type-mismatch' against a clean
  // current-state number, even though both sides are plainly numeric.
  const facts = extractCandidateFacts("Affordable housing units: 500 by 2030");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].rawValue, "500");
  assert.equal(facts[0].asOfYear, 2030);
  assert.equal(parseValue(facts[0].rawValue).type, "number");
});

test("extractCandidateFacts does not strip a trailing year from a value that already carries a real unit before it", () => {
  const facts = extractCandidateFacts("Stormwater capacity: 12M gallons by 2028");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].rawValue, "12M gallons");
  assert.equal(facts[0].asOfYear, 2028);
});

test("extractCandidateFacts reads a markdown table using header names to pick key/value columns, given a declared language", () => {
  const text = [
    "| Indicator | Baseline | Target |",
    "| --- | --- | --- |",
    "| Graduation rate | 74% | 90% |",
  ].join("\n");
  const facts = extractCandidateFacts(text, { language: "en" });
  // Both baseline and target columns are not both extracted by one row scan —
  // this module picks one value column per row (target-like wins over
  // current/baseline-like when both are present) and the other one is not
  // silently invented; here Target should be selected.
  assert.equal(facts.length, 1);
  assert.equal(facts[0].rawKey, "Graduation rate");
  assert.equal(facts[0].rawValue, "90%");
  assert.equal(facts[0].kind, "goal");
});

test("extractCandidateFacts picks no target/current column split at all without a declared language, rather than guessing from English column names", () => {
  const text = [
    "| Indicator | Baseline | Target |",
    "| --- | --- | --- |",
    "| Graduation rate | 74% | 90% |",
  ].join("\n");
  const facts = extractCandidateFacts(text);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, null);
});

test("extractCandidateFacts reads tab-separated rows (DOCX table extraction shape)", () => {
  const facts = extractCandidateFacts("Berth capacity\t3.4m\n");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].rawKey, "Berth capacity");
  assert.equal(facts[0].rawValue, "3.4m");
});

// ── Kind is derived from document structure only, never scored from a
//    sentence's own vocabulary — see insight-store.js's header on why a
//    keyword-based classifier (measured against CUBE.md's own refutation of
//    the mechanism it was ported from) was removed rather than kept
//    "advisory."

test("extractCandidateFacts leaves kind null (an honest gap) for a line with no header/table/date signal, however decisive its own wording sounds", () => {
  // No section header, no defaultKind, no year prefix — nothing structural
  // declares a kind, so none is guessed from the sentence's own words alone,
  // even though "goal" appears right in the text.
  const facts = extractCandidateFacts("Youth graduation rate goal: 90% by 2030");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, null);
});

test("extractCandidateFacts takes kind directly from a section header's own declared title, not from scoring the header's words", () => {
  const facts = extractCandidateFacts("GOALS\nStormwater capacity: 12M gallons\n", { language: "en" });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "goal");
});

test("extractCandidateFacts takes kind from the caller's document-level default when nothing else declares one", () => {
  const facts = extractCandidateFacts("Stormwater capacity: 12M gallons\n", { defaultKind: "current_state" });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "current_state");
});

// ── proposeFactsWithModel — model-assisted extraction, grounding-verified ──

function stubModel(response) {
  return async () => response;
}

test("proposeFactsWithModel accepts a candidate whose quote is a real, verbatim substring of the source", async () => {
  const text = "Community Plan 2030\n\nThe city aims to increase the affordable housing stock by 40% by 2030 through zoning reform.";
  const callModel = stubModel(JSON.stringify([
    { rawKey: "Affordable housing stock increase", value: "40%", kind: "goal", quote: "The city aims to increase the affordable housing stock by 40% by 2030 through zoning reform." },
  ]));
  const result = await proposeFactsWithModel(text, { callModel, heuristicFacts: [] });
  assert.equal(result.rejected.length, 0);
  assert.equal(result.proposed.length, 1);
  assert.equal(result.proposed[0].extractionMethod, "model");
  assert.equal(result.proposed[0].kind, "goal");
});

test("proposeFactsWithModel rejects a candidate whose quote cannot be found verbatim in the source — a fabrication, not a fact", async () => {
  const text = "Community Plan 2030\n\nThe city aims to increase the affordable housing stock by 40% by 2030.";
  const callModel = stubModel(JSON.stringify([
    { rawKey: "Made up fact", value: "99%", kind: "goal", quote: "The city will eliminate all traffic congestion by 2030 through teleportation." },
  ]));
  const result = await proposeFactsWithModel(text, { callModel, heuristicFacts: [] });
  assert.equal(result.proposed.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /not found verbatim/);
});

test("proposeFactsWithModel handles a model response that isn't valid JSON without throwing", async () => {
  const callModel = stubModel("I don't see any additional facts in this document.");
  const result = await proposeFactsWithModel("some text", { callModel, heuristicFacts: [] });
  assert.equal(result.proposed.length, 0);
  assert.equal(result.rejected.length, 1);
});

test("proposeFactsWithModel accepts the model's own kind claim as-is (no keyword-based cross-check) but always marks it kindConfident=false, needing human review", async () => {
  const text = "Report.\n\nAs of 2024, the current graduation rate stands at 74%, well below where it should be.";
  const callModel = stubModel(JSON.stringify([
    { rawKey: "Graduation rate", value: "74%", kind: "current_state", quote: "As of 2024, the current graduation rate stands at 74%, well below where it should be." },
  ]));
  const result = await proposeFactsWithModel(text, { callModel, heuristicFacts: [] });
  assert.equal(result.proposed.length, 1);
  assert.equal(result.proposed[0].kind, "current_state");
  // Never trusted as a structural fact, however plausible — same tier as
  // the model's rawKey claim, and the same discipline extractCandidateFacts
  // applies: a semantic judgment about content is not a document structure.
  assert.equal(result.proposed[0].kindConfident, false);
});

test("proposeFactsWithModel rejects a candidate whose kind is missing or not one of the four valid kinds", async () => {
  const text = "The city aims to increase transit ridership by 2030.";
  const callModel = stubModel(JSON.stringify([
    { rawKey: "Transit ridership", value: "20%", kind: "aspiration", quote: "The city aims to increase transit ridership by 2030." },
  ]));
  const result = await proposeFactsWithModel(text, { callModel, heuristicFacts: [] });
  assert.equal(result.proposed.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /no valid kind/);
});

test("ingestDocument with useModel merges verified model facts through the same matchKey pipeline as heuristic facts, and reports the two tiers separately", async () => {
  const store = freshStore();
  const text = "GOALS\nAffordable housing units: 500 by 2030\n\nThe city also aims to cut its carbon footprint by 25% by 2030 through a new transit initiative.";
  const callModel = stubModel(JSON.stringify([
    { rawKey: "Carbon footprint reduction", value: "25%", kind: "goal", quote: "The city also aims to cut its carbon footprint by 25% by 2030 through a new transit initiative." },
  ]));
  const result = await store.ingestDocument("p1", { text, useModel: true, callModel });
  assert.equal(result.heuristic.added, 1);
  assert.equal(result.model.ran, true);
  assert.equal(result.model.proposed, 1);
  assert.equal(result.added, 2);
  const modelObs = result.observations.find((o) => o.extractionMethod === "model");
  assert.ok(modelObs);
  assert.equal(modelObs.keyStatus, "unclear"); // no registry key exists yet for either — same pipeline, not model-assigned
});

test("ingestDocument reports model.ran=false (not a crash, not silence) when useModel is requested with no callModel configured", async () => {
  const store = freshStore();
  const result = await store.ingestDocument("p1", { text: "Affordable housing units: 500\n", useModel: true });
  assert.equal(result.added, 1); // heuristic pass still ran
  assert.equal(result.model.ran, false);
  assert.ok(result.model.error);
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

test("updateKey() edits a canonical key's label/category/unit/directionality without touching its aliases or observations", async () => {
  const store = freshStore();
  const entry = await store.createKey("p1", { label: "Poverty rate" });
  await store.resolveKey("p1", { rawKey: "Poverty %", canonicalKey: entry.key }); // give it an alias to preserve
  const updated = await store.updateKey("p1", entry.key, { directionality: "lower_is_better", unit: "%" });
  assert.equal(updated.directionality, "lower_is_better");
  assert.equal(updated.unit, "%");
  assert.deepEqual(updated.aliases, ["Poverty %"]);
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

// ── defineTerm() — a metric is useless without knowing what it measures ────

test("defineTerm() finds a definition by exact raw-key text, with source, asOf, and jurisdiction carried through", async () => {
  const store = freshStore();
  await store.addObservation("p1", {
    rawKey: "Affordable housing", kind: "definition",
    value: "Housing costing no more than 30% of household income.",
    asOf: "2024", sourceId: "source:a", sourceName: "Doc A",
    quote: "Affordable housing is defined as housing costing no more than 30% of household income.",
    jurisdiction: "HUD",
  });
  const result = await store.defineTerm("p1", "Affordable housing");
  assert.equal(result.definitions.length, 1);
  assert.equal(result.definitions[0].jurisdiction, "HUD");
  assert.equal(result.definitions[0].sourceName, "Doc A");
  assert.equal(result.definitions[0].asOf, "2024");
  assert.equal(result.conflicting, false);
});

test("defineTerm() flags conflicting when two sources disagree on what a term means, rather than picking one", async () => {
  const store = freshStore();
  await store.addObservation("p1", {
    rawKey: "Affordable housing", kind: "definition",
    value: "Housing costing no more than 30% of household income.",
    sourceId: "source:a", sourceName: "Doc A", jurisdiction: "HUD",
  });
  await store.addObservation("p1", {
    rawKey: "Affordable housing", kind: "definition",
    value: "Housing costing no more than 50% of area median income.",
    sourceId: "source:b", sourceName: "Doc B", jurisdiction: "City of Example",
  });
  const result = await store.defineTerm("p1", "Affordable housing");
  assert.equal(result.definitions.length, 2);
  assert.equal(result.conflicting, true);
  const jurisdictions = result.definitions.map((d) => d.jurisdiction).sort();
  assert.deepEqual(jurisdictions, ["City of Example", "HUD"]);
});

test("defineTerm() does not conflict when two sources restate the same definition", async () => {
  const store = freshStore();
  await store.addObservation("p1", { rawKey: "Chronically Homeless", kind: "definition", value: "Homeless for 12+ months or 4+ episodes in 3 years with a disabling condition.", sourceId: "a" });
  await store.addObservation("p1", { rawKey: "Chronically Homeless", kind: "definition", value: "Homeless for 12+ months or 4+ episodes in 3 years with a disabling condition.", sourceId: "b" });
  const result = await store.defineTerm("p1", "Chronically Homeless");
  assert.equal(result.definitions.length, 2);
  assert.equal(result.conflicting, false);
});

test("defineTerm() returns an honest empty result for a term with no definition on file, not an error", async () => {
  const store = freshStore();
  const result = await store.defineTerm("p1", "Nonexistent term");
  assert.deepEqual(result.definitions, []);
  assert.equal(result.conflicting, false);
});

test("defineTerm() also finds a definition once its raw key has been resolved onto a canonical key", async () => {
  const store = freshStore();
  await store.createKey("p1", { key: "affordable_housing", label: "Affordable housing" });
  await store.addObservation("p1", { key: "affordable_housing", rawKey: "Aff. housing", kind: "definition", value: "Housing costing no more than 30% of household income.", sourceId: "a" });
  // A differently-spelled raw key that resolves to the SAME canonical key
  // should be found too, not just an exact string match on the term typed.
  const result = await store.defineTerm("p1", "affordable_housing");
  assert.equal(result.definitions.length, 1);
});

test("state() flags definitionsConflict per key so a metric's number is never shown as if its definition were settled when it isn't", async () => {
  const store = freshStore();
  await store.createKey("p1", { key: "affordable_housing_units", label: "Affordable housing units" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "goal", value: "500", asOf: "2030" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "definition", value: "Units at or below 30% AMI.", sourceId: "a", jurisdiction: "HUD" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "definition", value: "Units at or below 50% AMI.", sourceId: "b", jurisdiction: "City" });
  const [row] = await store.state("p1");
  assert.equal(row.definitionsConflict, true);
  assert.equal(row.definitions.length, 2);
  assert.equal(row.definitions[0].jurisdiction, "HUD");
});

test("state() reports definitionsConflict false when a key has one settled definition or none at all", async () => {
  const store = freshStore();
  await store.createKey("p1", { key: "affordable_housing_units", label: "Affordable housing units" });
  await store.addObservation("p1", { key: "affordable_housing_units", rawKey: "x", kind: "goal", value: "500", asOf: "2030" });
  const [row] = await store.state("p1");
  assert.equal(row.definitionsConflict, false);
  assert.deepEqual(row.definitions, []);
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

// ── unclearKeys() clustering / resolveKey() with rawKeys ────────────────

test("unclearKeys() clusters mutually-similar-enough distinct spellings into one row instead of asking twice for the same document", async () => {
  const store = freshStore();
  await store.ingestDocument("p1", {
    text: "Affordable housing units total: 500\nAffordable housing units: 210\n",
    kind: "current_state",
  });
  const unclear = await store.unclearKeys("p1");
  // "Affordable housing units total" and "Affordable housing units" are
  // similar enough to auto-merge once a canonical key exists — they must be
  // offered as ONE row, not two, so resolving it clears both spellings.
  assert.equal(unclear.length, 1);
  assert.equal(unclear[0].count, 2);
  assert.ok(unclear[0].rawKeys.length >= 2);
});

test("unclearKeys() does NOT cluster genuinely different keys just because they share some words", async () => {
  const store = freshStore();
  await store.addObservation("p1", { rawKey: "Affordable housing units", kind: "goal", value: "500" });
  await store.addObservation("p1", { rawKey: "Youth graduation rate", kind: "current_state", value: "74%" });
  const unclear = await store.unclearKeys("p1");
  assert.equal(unclear.length, 2);
});

test("resolveKey() accepts a rawKeys array and clears every spelling in the cluster with one call", async () => {
  const store = freshStore();
  await store.ingestDocument("p1", {
    text: "Affordable housing units total: 500\nAffordable housing units: 210\n",
    kind: "current_state",
  });
  const [group] = await store.unclearKeys("p1");
  const { resolvedCount } = await store.resolveKey("p1", { rawKeys: group.rawKeys, createLabel: "Affordable housing units" });
  assert.equal(resolvedCount, 2);
  assert.equal((await store.unclearKeys("p1")).length, 0);
});

// ── state(): quote provenance and directionality-aware progress ─────────

test("state() carries the goal/current observation's quote and id through for provenance display", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Affordable housing units" });
  await store.ingestDocument("p1", { text: "Affordable housing units: 500\n", kind: "goal", sourceId: "s1", sourceName: "Plan" });
  const [row] = await store.state("p1");
  assert.equal(row.goal.quote, "Affordable housing units: 500");
  assert.ok(row.goal.observationId);
});

test("state() reports progress on-track/off-track only when directionality is declared, never guessed", async () => {
  const store = freshStore();
  await store.createKey("p1", { label: "Poverty rate", directionality: "lower_is_better" });
  await store.addObservation("p1", { key: "poverty_rate", rawKey: "x", kind: "goal", value: "10%" });
  await store.addObservation("p1", { key: "poverty_rate", rawKey: "x", kind: "current_state", value: "8%" });
  let [row] = await store.state("p1");
  assert.equal(row.progress, "on-track"); // 8% <= 10% goal ceiling — good

  const store2 = freshStore();
  await store2.createKey("p1", { label: "Housing units" }); // directionality left "unknown"
  await store2.addObservation("p1", { key: "housing_units", rawKey: "x", kind: "goal", value: "500" });
  await store2.addObservation("p1", { key: "housing_units", rawKey: "x", kind: "current_state", value: "210" });
  [row] = await store2.state("p1");
  assert.equal(row.deltaStatus, "computed");
  assert.equal(row.progress, null);
});
