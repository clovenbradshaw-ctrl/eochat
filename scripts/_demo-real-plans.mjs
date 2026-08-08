// Real-document test — 10 actual, currently-published municipal housing/
// community-plan PDFs (Nashville's Unified Housing Strategy, Houston's and
// Jacksonville's Consolidated Plans, NYC's Housing Plan, RI's Housing 2030,
// Grand Rapids's strategic plan), extracted to plain text with pdftotext
// -layout, ingested WHOLE into one shared project through the real
// InsightStore — no synthetic fixtures, no truncation. Reports what the
// heuristic pass actually finds on real prose-heavy government documents,
// what cross-document key drift looks like at real scale, and — the part
// that actually matters — whether every stored fact's quote can truly be
// found, verbatim, in the exact document text it claims to come from.
//
// Run: node scripts/_demo-real-plans.mjs <dir-of-.txt-files>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InsightStore } from "../server/insight-store.js";
import { normalizeForFidelity, quoteOccursIn } from "../server/citation-check.js";

const plansDir = process.argv[2];
if (!plansDir) { console.error("usage: node _demo-real-plans.mjs <dir-of-.txt-files>"); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "insight-real-"));
const store = new InsightStore({ dir });
const PROJECT = "communities";

const files = fs.readdirSync(plansDir).filter((f) => f.endsWith(".txt")).sort();
const sourceTextByName = new Map();

function rule(label) { console.log("\n" + "=".repeat(90) + `\n${label}\n` + "=".repeat(90)); }

async function main() {
  rule(`INGESTING ${files.length} REAL DOCUMENTS INTO ONE SHARED PROJECT (whole text, no truncation)`);
  const perDoc = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(plansDir, f), "utf8");
    sourceTextByName.set(f, text);
    const result = await store.ingestDocument(PROJECT, {
      text, sourceId: `source:${f}`, sourceName: f,
      // Declared, not inferred — every document in this batch really is
      // English; a real caller (the upload form) would know this per file,
      // not assume it for whatever gets ingested.
      language: "en",
    });
    perDoc.push({ file: f, chars: text.length, ...result });
    console.log(
      `${f.padEnd(34)} ${String(text.length).padStart(9)} chars -> ` +
      `${String(result.added).padStart(4)} facts  (${result.resolved} resolved, ${result.unclear} unclear, ${result.kindUnclear} kind-unclear)`
    );
  }

  rule("KIND DISTRIBUTION ACROSS ALL EXTRACTED FACTS (structural signal only — no keyword guessing)");
  const all = await store.listObservations(PROJECT, {});
  const byKind = new Map();
  for (const o of all) byKind.set(o.kind, (byKind.get(o.kind) || 0) + 1);
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(22)} ${n}`);
  }
  console.log(`  TOTAL facts: ${all.length}`);

  rule("A SAMPLE OF WHAT WAS ACTUALLY EXTRACTED (first 25 facts, across all docs)");
  for (const o of all.slice(0, 25)) {
    console.log(`  [${String(o.kind).padEnd(18)}] "${o.rawKey}" = "${o.value}"  (${o.sourceName})`);
  }

  rule("CROSS-DOCUMENT KEY DRIFT: raw keys awaiting a human merge decision, real documents, real vocabulary");
  const unclear = await store.unclearKeys(PROJECT);
  console.log(`${unclear.length} distinct unclear-key groups across ${files.length} independently-written real documents.\n`);
  // Show the ones that actually recur across MULTIPLE documents — the real
  // "does this platform notice the same concept said two different ways in
  // two different cities' documents" test.
  const withSources = await Promise.all(unclear.map(async (u) => {
    const obs = all.filter((o) => u.observationIds.includes(o.id));
    const docs = new Set(obs.map((o) => o.sourceName));
    return { ...u, docCount: docs.size, docs: [...docs] };
  }));
  const crossDoc = withSources.filter((u) => u.docCount > 1).sort((a, b) => b.count - a.count);
  console.log(`${crossDoc.length} of those raw-key groups already recur across MORE THAN ONE document (same wording, different source):`);
  for (const u of crossDoc.slice(0, 15)) {
    console.log(`  "${u.rawKey}" (${u.count}x across ${u.docCount} docs: ${u.docs.join(", ")})`);
  }
  console.log("\nTop 15 highest-count unclear keys overall (candidates for pre-seeding a shared template registry):");
  for (const u of withSources.sort((a, b) => b.count - a.count).slice(0, 15)) {
    const cand = u.candidates.length ? ` -> candidates: ${u.candidates.map((c) => c.label).join(", ")}` : "";
    console.log(`  "${u.rawKey}" (${u.count}x)${cand}`);
  }

  rule("THE AUDIT: for EVERY one of these real facts, does its quote really appear in the real document text?");
  let pass = 0, fail = 0;
  const failures = [];
  for (const o of all) {
    const src = sourceTextByName.get(o.sourceName);
    const ok = src && o.quote && quoteOccursIn(normalizeForFidelity(src), normalizeForFidelity(o.quote));
    if (ok) pass++; else { fail++; failures.push(o); }
  }
  console.log(`${pass}/${all.length} PASS — quote independently re-verified as a literal substring of its claimed source.`);
  if (fail) {
    console.log(`${fail} FAIL — investigate before trusting anything above:`);
    for (const o of failures.slice(0, 10)) console.log(`  [${o.sourceName}] "${o.rawKey}" -> "${o.quote}"`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => { console.error("CRASHED:", err); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
