// One-off demo/audit run against real sample data — NOT a test file (no
// assertions), a readable report. Exercises the real InsightStore against
// two intentionally messy "documents" (spelling drift across them, a real
// conflict, prose with no header, an abbreviation the structural matcher
// correctly refuses to guess on) and, for every stored observation, proves
// the audit trail actually closes: the quote is a real, findable substring
// of the document it claims to come from. That check is the point of this
// run — extraction quality is secondary to "can a human catch a mistake."
//
// Run: node scripts/_demo-insights-sample.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InsightStore } from "../server/insight-store.js";
import { normalizeForFidelity, quoteOccursIn } from "../server/citation-check.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "insight-demo-"));
const store = new InsightStore({ dir });
const PROJECT = "riverside";

const line = (s = "") => console.log(s);
const rule = (label) => line("\n" + "=".repeat(78) + `\n${label}\n` + "=".repeat(78));

// ── Sample documents — deliberately messy, like real plan documents ────────

const DOC1_NAME = "Riverside Community Plan 2030";
const DOC1 = `Riverside Community Plan 2030

GOALS
Affordable housing units: 500 by 2030
Youth graduation rate target: 90% by 2030
Stormwater capacity: 12M gallons by 2028

DEFINITIONS
Affordable housing is defined as housing costing no more than 30% of household income.

CURRENT STATE
Affordable housing units: 210
Youth graduation rate: 74%

INTERVENTION METRICS
Zoning reform pilot: 40 additional units permitted in 2025
`;

// A second, independently-written report: drifted spellings, an
// abbreviation ("Aff"), a conflicting current-state number, and (crucially)
// prose with NO header at all above it, to check the honest kind:null gap.
const DOC2_NAME = "Q2 2026 Progress Report";
const DOC2 = `Community Progress Report — Q2 2026

Affordable Housing Units Total: 240
Aff Housing Units: 235

The city also aims to cut its carbon footprint by 25% by 2030 through a new transit initiative.
`;

async function verifyRoundTrip(obs, sourceTextByName) {
  const src = sourceTextByName.get(obs.sourceName);
  if (!obs.quote) return { ok: false, why: "no quote stored at all" };
  if (!src) return { ok: false, why: `no source text on file for "${obs.sourceName}"` };
  const hay = normalizeForFidelity(src);
  const needle = normalizeForFidelity(obs.quote);
  return { ok: quoteOccursIn(hay, needle), why: quoteOccursIn(hay, needle) ? null : "quote not found in claimed source" };
}

async function main() {
  const sourceTextByName = new Map([[DOC1_NAME, DOC1], [DOC2_NAME, DOC2]]);

  rule("STEP 1 — ingest Doc 1 into an EMPTY registry (everything starts unclear — expected)");
  const r1 = await store.ingestDocument(PROJECT, {
    text: DOC1, sourceId: `source:${DOC1_NAME}`, sourceName: DOC1_NAME,
  });
  line(`added=${r1.added} resolved=${r1.resolved} unclear=${r1.unclear} kindUnclear=${r1.kindUnclear}`);
  for (const o of r1.observations) {
    line(`  [${o.keyStatus.padEnd(8)}] kind=${String(o.kind).padEnd(18)} "${o.rawKey}" = "${o.value}"`);
  }

  rule("STEP 2 — unclearKeys() review queue (what a human sees first)");
  let unclear = await store.unclearKeys(PROJECT);
  for (const u of unclear) {
    line(`  "${u.rawKey}" (${u.count}x) candidates: ${u.candidates.map(c => `${c.label} [${c.structural ? "structural" : c.score.toFixed(2)}]`).join(", ") || "(none — brand new)"}`);
  }

  rule("STEP 3 — a human resolves the real keys (this is the only place merging actually happens)");
  const toDefine = [
    { raw: "Affordable housing units", label: "Affordable housing units", category: "housing", unit: "units", directionality: "higher_is_better" },
    { raw: "Youth graduation rate target", label: "Youth graduation rate", category: "education", unit: "%", directionality: "higher_is_better" },
    { raw: "Youth graduation rate", label: "Youth graduation rate" }, // maps into the same key by exact-ish label
    { raw: "Stormwater capacity", label: "Stormwater capacity", category: "infrastructure", unit: "gallons" },
    { raw: "Affordable housing", label: "Affordable housing" }, // the definition sentence's own subject
    { raw: "Zoning reform pilot", label: "Zoning reform pilot" },
  ];
  for (const d of toDefine) {
    if (d.label === "Youth graduation rate" && d.raw === "Youth graduation rate") {
      await store.resolveKey(PROJECT, { rawKey: d.raw, canonicalKey: "youth_graduation_rate" });
      continue;
    }
    await store.resolveKey(PROJECT, {
      rawKey: d.raw, createLabel: d.label, category: d.category ?? null, unit: d.unit ?? null,
      directionality: d.directionality ?? "unknown",
    });
  }
  unclear = await store.unclearKeys(PROJECT);
  line(`unclearKeys() remaining: ${unclear.length} (expect 0)`);

  rule("STEP 4 — ingest Doc 2: drifted spellings against a NOW-POPULATED registry");
  const r2 = await store.ingestDocument(PROJECT, {
    text: DOC2, sourceId: `source:${DOC2_NAME}`, sourceName: DOC2_NAME,
  });
  line(`added=${r2.added} resolved=${r2.resolved} unclear=${r2.unclear} kindUnclear=${r2.kindUnclear}`);
  for (const o of r2.observations) {
    line(`  [${o.keyStatus.padEnd(8)}] kind=${String(o.kind).padEnd(18)} "${o.rawKey}" = "${o.value}"`);
  }
  const unclear2 = await store.unclearKeys(PROJECT);
  line("\nWhat the drifted spellings actually did — NOT silently merged, even the close ones:");
  for (const u of unclear2) {
    line(`  "${u.rawKey}" -> candidates: ${u.candidates.map(c => `${c.label} [${c.structural ? "STRUCTURAL, still needs confirm" : "jaccard " + c.score.toFixed(2)}]`).join(", ") || "(none found at all)"}`);
  }

  rule("STEP 5 — confirm the one real match, watch the OTHER drifted spelling stay a separate, honest gap");
  const housingUnclear = unclear2.find(u => normalizeForFidelity(u.rawKey).toLowerCase().includes("housing units total"));
  if (housingUnclear) {
    const { resolvedCount } = await store.resolveKey(PROJECT, { rawKeys: housingUnclear.rawKeys, canonicalKey: "affordable_housing_units" });
    line(`Resolved "${housingUnclear.rawKey}" (and its cluster) -> affordable_housing_units (${resolvedCount} observation(s))`);
  }
  const stillUnclear = await store.unclearKeys(PROJECT);
  line(`\nStill unclear after that one confirmation: ${stillUnclear.length}`);
  for (const u of stillUnclear) {
    line(`  "${u.rawKey}" (${u.count}x) — candidates: ${JSON.stringify(u.candidates.map(c => c.label))}`);
    line(`    why it didn't auto-merge even though it LOOKS close: "Aff" is an abbreviation, not a containment`);
    line(`    match against "Affordable" — the structural test correctly refuses to guess that expansion.`);
  }

  rule("STEP 6 — ingest the identical spelling AGAIN: does the system actually 'learn' after a human confirms once?");
  const r3 = await store.ingestDocument(PROJECT, {
    text: "Affordable Housing Units Total: 260\n", sourceId: "source:doc3", sourceName: "Doc 3",
  });
  sourceTextByName.set("Doc 3", "Affordable Housing Units Total: 260\n");
  line(`This exact spelling was confirmed once in step 5 — now: keyStatus=${r3.observations[0].keyStatus} (should be 'resolved', no human asked again)`);

  rule("STEP 7 — conflicts(): Doc1 and Doc2 both report a current-state number for the same key, undated, disagreeing");
  const conflicts = await store.conflicts(PROJECT);
  for (const c of conflicts) {
    line(`  ${c.key} · ${c.kind} · asOf=${c.asOf ?? "(undated)"}`);
    for (const v of c.values) line(`    "${v.value}" — ${v.sourceName}  (quote: "${v.quote}")`);
  }
  if (!conflicts.length) line("  (none found — see note below if this is unexpected)");

  rule("STEP 8 — state(): the actual goal-vs-current delta table a reader wants");
  const rows = await store.state(PROJECT);
  for (const row of rows) {
    line(`  ${row.label.padEnd(28)} goal=${row.goal ? row.goal.value : "—"}  current=${row.current ? row.current.value : "—"}  status=${row.deltaStatus}  progress=${row.progress ?? "—"}`);
  }

  rule("STEP 9 — model-assisted pass on a PURE-PROSE sentence the heuristics structurally cannot see (stubbed model — no live LLM in this environment)");
  const proseText = "The city also aims to cut its carbon footprint by 25% by 2030 through a new transit initiative.";
  const stubCallModel = async () => JSON.stringify([
    { rawKey: "Carbon footprint reduction", value: "25%", kind: "goal", quote: proseText },
    { rawKey: "Fabricated claim", value: "0%", kind: "goal", quote: "The city will eliminate all emissions instantly via teleportation." },
  ]);
  const { proposeFactsWithModel } = await import("../server/insight-store.js");
  const modelResult = await proposeFactsWithModel(proseText, { callModel: stubCallModel, heuristicFacts: [] });
  line(`proposed=${modelResult.proposed.length} rejected=${modelResult.rejected.length}`);
  for (const p of modelResult.proposed) line(`  ACCEPTED: "${p.rawKey}" = "${p.rawValue}" (kindConfident=${p.kindConfident}) quote verified against real text`);
  for (const r of modelResult.rejected) line(`  REJECTED: ${r.reason} — candidate rawKey="${r.candidate?.rawKey}"`);

  rule("STEP 10 — THE AUDIT: for EVERY observation ever stored, does its quote really appear in the document it claims?");
  const all = await store.listObservations(PROJECT, {});
  let pass = 0, fail = 0;
  for (const o of all) {
    const result = await verifyRoundTrip(o, sourceTextByName);
    if (result.ok) pass++; else fail++;
    line(`  [${result.ok ? "PASS" : "FAIL"}] ${o.sourceName ?? "(no source)"} :: "${o.rawKey}" -> "${o.quote}"` + (result.ok ? "" : `  <<< ${result.why}`));
  }
  line(`\n${pass}/${all.length} observations' quotes independently verified against their claimed source text.`);
  if (fail) line(`${fail} FAILED — this is the thing that must never happen; investigate before trusting any delta above.`);
}

main().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
}).catch((err) => {
  console.error("DEMO CRASHED:", err);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
