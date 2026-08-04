#!/usr/bin/env node
// probe-external-prior-structure-level.mjs — test a sharper, corrected
// version of the external-prior hypothesis from probe-surf-fold-odyssey-
// surprise.mjs. That probe found the Iliad-derived prior measurably WORSE
// than within-text-only surprise at the ENTITY level (a specific
// character's specific sentence, scored against ~60 sentences of local
// recent context) — diagnosed to the Iliad and Odyssey sharing the same
// formulaic diction too closely for a whole-corpus blend to sharpen
// anything that fine-grained.
//
// This probe tests a different, more specific claim: that the SAME
// external prior might still be useful at a coarser grain — STRUCTURE
// (real book/scene boundaries) and macro content-zones — rather than at
// individual-entity-sentence granularity. Two real, checkable tests:
//
//   A. STRUCTURE: does scoring frame-to-frame divergence against the fixed
//      external (Iliad) distribution find real book boundaries better,
//      worse, or about the same as text-organ.js's own detectBoundaries
//      (which uses a within-text local-window prior, unmodified here)?
//      Ground truth is real, not invented: this probe's own cached Odyssey
//      text carries 24 "[BOOK N]" markers from the original TEI structure.
//
//   B. MACRO CONTENT-ZONES: does KL-divergence of each whole BOOK against
//      the external Iliad prior differentiate books in a way that lines up
//      with anything independently checkable (book length as a confound
//      control; Book 11's Nekyia/catalogue-of-heroines section is widely
//      noted in Homeric scholarship as stylistically distinct, an
//      independent, non-invented check) — reported as exploratory, not
//      proven, since there's no equivalent hard ground truth to part A's.
//
// Usage: node scripts/probe-external-prior-structure-level.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_ENGINE_ROOT, MEMORY_DIR, REPO_ROOT } from "../server/paths.js";

function importFromLegacyEngine(relPath) {
  const abs = path.join(LEGACY_ENGINE_ROOT, "packages", "engine", relPath);
  if (!fs.existsSync(abs)) throw new Error(`eoreader5 organ not found at ${abs}`);
  return import(pathToFileURL(abs).href);
}

const [
  { frameText, detectBoundaries },
  { wordFrequencies, klDivergence },
] = await Promise.all([
  importFromLegacyEngine("emergence/summary/text-organ.js"),
  importFromLegacyEngine("emergence/surprise/index.js"),
]);

const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
const odysseyPath = path.join(CACHE_DIR, "odyssey-grc.txt");
const iliadPath = path.join(CACHE_DIR, "iliad-grc.txt");
for (const p of [odysseyPath, iliadPath]) {
  if (!fs.existsSync(p)) throw new Error(`${p} not found — run scripts/probe-surf-fold-odyssey-surprise.mjs first to fetch+cache both texts.`);
}
const realText = fs.readFileSync(odysseyPath, "utf8");
const iliadText = fs.readFileSync(iliadPath, "utf8");
console.log(`Odyssey: ${realText.length.toLocaleString()} chars. Iliad (external prior, genuinely separate work): ${iliadText.length.toLocaleString()} chars.\n`);

const externalDist = wordFrequencies(iliadText);

// ── Ground truth: real book boundaries, from this probe's own cache format ──
const bookMarkers = [...realText.matchAll(/\[BOOK (\d+)\]/g)].map((m) => ({ n: m[1], offset: m.index }));
console.log(`Ground truth: ${bookMarkers.length} real book-boundary markers (from the source TEI structure, not invented).\n`);

// ══════════════════════════════════════════════════════════════════════════
// PART A — STRUCTURE: real book-boundary detection, within-text prior vs. external prior
// ══════════════════════════════════════════════════════════════════════════
console.log("=".repeat(78));
console.log("PART A — does the external prior help find REAL book boundaries?");
console.log("=".repeat(78));

const frames = frameText(realText);
console.log(`${frames.length} frames.\n`);

function nearestBookDistance(offset) {
  let best = Infinity;
  for (const b of bookMarkers) best = Math.min(best, Math.abs(b.offset - offset));
  return best;
}

const TOLERANCE = 2000; // chars — a frame near enough to a real book start counts as a hit

// A.1 — baseline: text-organ.js's own detectBoundaries, unmodified, within-text
// local-window prior. zThreshold=1.8 to match what multi-altitude-fold.js and
// entity-fold.js actually use in production — NOT detectBoundaries' own
// default of 2.5. Checked directly (grep) rather than assumed: using the
// wrong threshold here would silently manufacture a "baseline fails" result
// that is really just this probe's own miscalibration, exactly the class of
// self-inflicted bug already caught twice earlier in this investigation
// (the provenance whitespace-normalization bug, the TEI attribute-order
// regex). zThreshold=2.5 is shown alongside for comparison, not hidden.
const baselineDefault = detectBoundaries(frames, { zThreshold: 2.5, window: 20 });
const baseline = detectBoundaries(frames, { zThreshold: 1.8, window: 20 });
function scoreAgainstGroundTruth(boundaries, label) {
  const hits = new Set();
  let truePositives = 0;
  for (const b of boundaries) {
    let matchedBook = null, bestD = Infinity;
    for (const bk of bookMarkers) { const d = Math.abs(bk.offset - b.offset); if (d < bestD) { bestD = d; matchedBook = bk.n; } }
    if (bestD <= TOLERANCE && !hits.has(matchedBook)) { hits.add(matchedBook); truePositives++; }
  }
  const recall = truePositives / bookMarkers.length;
  const precision = boundaries.length ? truePositives / boundaries.length : 0;
  console.log(`  ${label.padEnd(45)} ${boundaries.length} boundaries detected, ${truePositives}/${bookMarkers.length} real book-starts matched within ${TOLERANCE} chars`);
  console.log(`  ${" ".repeat(45)} recall=${(recall * 100).toFixed(1)}% precision=${(precision * 100).toFixed(1)}%`);
  return { recall, precision, count: boundaries.length };
}
console.log(`  (for reference: detectBoundaries' own DEFAULT zThreshold=2.5 finds ${baselineDefault.length} boundaries on this text — too strict for real Greek`);
console.log(`   verse at this z-scoring scale; production code (multi-altitude-fold.js, entity-fold.js) uses 1.8, confirmed by grep, used below.`);
const baselineScore = scoreAgainstGroundTruth(baseline, "within-text local-window prior, zThreshold=1.8 (production value):");

// A.2 — same z-scoring logic, but the "prior" each frame is scored against
// is the FIXED external distribution instead of a local window. Reimplemented
// directly (detectBoundaries does not expose the prior as a parameter) —
// same z-scoring shell, only the background distribution changes, so any
// difference in recall/precision is attributable to that one change.
function detectBoundariesExternalPrior(frames, externalDist, { zThreshold = 1.8, window = 20 } = {}) {
  const scores = frames.map((f) => ({ order: f.order, offset: f.offset, score: klDivergence(f.dist, externalDist), text: f.text }));
  const zWindow = Math.min(window, 10);
  const boundaries = [];
  for (let i = zWindow; i < scores.length - zWindow; i++) {
    const start = i - zWindow, end = i + zWindow + 1;
    let sum = 0, sumSq = 0;
    for (let j = start; j < end; j++) { sum += scores[j].score; sumSq += scores[j].score ** 2; }
    const n = end - start, mean = sum / n;
    const variance = (sumSq / n) - mean * mean;
    const std = Math.sqrt(Math.max(0, variance)) || 1;
    const z = (scores[i].score - mean) / std;
    if (z > zThreshold) boundaries.push({ order: scores[i].order, offset: scores[i].offset, score: scores[i].score, z, text: scores[i].text });
  }
  return boundaries;
}
const externalBoundaries = detectBoundariesExternalPrior(frames, externalDist);
const externalScore = scoreAgainstGroundTruth(externalBoundaries, "external (Iliad) fixed prior, same z-scoring shell:");

// A.3 — blend, matching the alpha construction from the entity-level probe,
// at the midpoint that probe found already-worse than alpha=0 there — check
// whether structure-level detection shows the same direction or not.
function detectBoundariesBlended(frames, externalDist, alpha, { zThreshold = 1.8, window = 20 } = {}) {
  const scores = [];
  for (let i = 0; i < frames.length; i++) {
    const priorStart = Math.max(0, i - window);
    const localFrames = frames.slice(priorStart, i);
    let localDist = new Map();
    if (localFrames.length > 0) {
      const combined = new Map(); let total = 0;
      for (const pf of localFrames) for (const [w, p] of pf.dist) { combined.set(w, (combined.get(w) ?? 0) + p); total += p; }
      for (const [w, p] of combined) localDist.set(w, p / total);
    }
    const blended = localFrames.length === 0 ? externalDist : (() => {
      const out = new Map();
      for (const [w, p] of externalDist) out.set(w, (out.get(w) ?? 0) + p * alpha);
      for (const [w, p] of localDist) out.set(w, (out.get(w) ?? 0) + p * (1 - alpha));
      return out;
    })();
    scores.push({ order: frames[i].order, offset: frames[i].offset, score: klDivergence(frames[i].dist, blended), text: frames[i].text });
  }
  const zWindow = Math.min(window, 10);
  const boundaries = [];
  for (let i = zWindow; i < scores.length - zWindow; i++) {
    const start = i - zWindow, end = i + zWindow + 1;
    let sum = 0, sumSq = 0;
    for (let j = start; j < end; j++) { sum += scores[j].score; sumSq += scores[j].score ** 2; }
    const n = end - start, mean = sum / n;
    const variance = (sumSq / n) - mean * mean;
    const std = Math.sqrt(Math.max(0, variance)) || 1;
    const z = (scores[i].score - mean) / std;
    if (z > zThreshold) boundaries.push({ order: scores[i].order, offset: scores[i].offset, score: scores[i].score, z });
  }
  return boundaries;
}
const blended = detectBoundariesBlended(frames, externalDist, 0.5);
const blendedScore = scoreAgainstGroundTruth(blended, "50/50 blend (local window + external prior):");

console.log(`\nPART A FINDING: ${
  externalScore.recall > baselineScore.recall
    ? "the external prior finds MORE real book boundaries than the within-text baseline"
    : externalScore.recall === baselineScore.recall
      ? "the external prior finds the SAME number of real book boundaries as the within-text baseline"
      : "the external prior finds FEWER real book boundaries than the within-text baseline"
} (recall ${(externalScore.recall*100).toFixed(1)}% vs ${(baselineScore.recall*100).toFixed(1)}%).`);

// ══════════════════════════════════════════════════════════════════════════
// PART B — MACRO CONTENT-ZONES: per-book divergence from the external prior
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(78));
console.log("PART B — per-book divergence from the external (Iliad) prior — exploratory, no hard ground truth");
console.log("=".repeat(78));

const books = [];
for (let i = 0; i < bookMarkers.length; i++) {
  const start = bookMarkers[i].offset;
  const end = i + 1 < bookMarkers.length ? bookMarkers[i + 1].offset : realText.length;
  books.push({ n: bookMarkers[i].n, text: realText.slice(start, end), chars: end - start });
}
const bookScores = books.map((b) => ({ n: b.n, chars: b.chars, div: klDivergence(wordFrequencies(b.text), externalDist) }));
bookScores.sort((a, b) => b.div - a.div);
console.log(`\nBooks ranked by KL-divergence from the external Iliad prior (highest = most lexically distinct from Homeric-epic baseline):`);
for (const b of bookScores) console.log(`  Book ${b.n.padStart(2)}: divergence=${b.div.toFixed(3)}  (${b.chars.toLocaleString()} chars)`);

// Confound check: does divergence just track book length (shorter books,
// noisier KL estimate) rather than anything about content?
const meanChars = bookScores.reduce((a, b) => a + b.chars, 0) / bookScores.length;
const corr = (() => {
  const xs = bookScores.map((b) => b.chars), ys = bookScores.map((b) => b.div);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / (Math.sqrt(dx2 * dy2) || 1);
})();
console.log(`\nConfound check: correlation between book length and divergence score = ${corr.toFixed(3)} (near 0 = divergence tracks`);
console.log(`content, not just length; near +/-1 = divergence is mostly a length artifact and this ranking should not be trusted as content-driven).`);

const book11 = bookScores.find((b) => b.n === "11");
const book11Rank = bookScores.findIndex((b) => b.n === "11") + 1;
console.log(`\nIndependent spot-check (checked AFTER computing the ranking, not used to build it): Book 11 (the Nekyia — Odysseus's`);
console.log(`descent to the underworld and catalogue of heroines) is widely noted in Homeric scholarship as one of the most`);
console.log(`stylistically distinct books in the poem. Its rank here by external-prior divergence: ${book11Rank} of ${bookScores.length}`);
console.log(`(1 = most divergent). ${book11Rank <= 6 ? "Consistent with that independent claim." : "NOT particularly high in this ranking — reported as-is, not adjusted to fit."}`);

console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`Part A is the rigorous test (real ground truth, precision/recall): does an external-corpus prior improve REAL`);
console.log(`structural boundary detection, as opposed to entity-level sentence surprise (which it measurably worsened in the`);
console.log(`earlier probe)? Part B is exploratory (no hard ground truth, one independent scholarly spot-check, a length-confound`);
console.log(`control reported alongside it rather than hidden). Both are reported with actual numbers above, not assumed from theory.`);
