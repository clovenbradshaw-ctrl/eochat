#!/usr/bin/env node
// probe-unrelated-prior.mjs — does a GENUINELY UNRELATED external prior fare
// differently than the same-tradition one already tested and found worse?
//
// probe-surf-fold-odyssey-surprise.mjs and probe-external-prior-structure-
// level.mjs found the Iliad-derived prior worse than the within-text
// baseline at both entity-level surprise and structural boundary detection,
// diagnosed to the Iliad and Odyssey sharing the same formulaic tradition
// too closely — a linear blend dilutes local contrast instead of sharpening
// it. This probe tests the natural follow-on: does a prior from something
// genuinely UNRELATED — different genre, different era, different dialect,
// different subject — behave differently?
//
// External prior source: Herodotus's Histories (Ἱστορίαι), fetched from the
// same trusted source as the Odyssey/Iliad (Perseus Digital Library). Real,
// substantial, and genuinely distant from Homeric epic: 5th-century BC Ionic
// PROSE history/ethnography, not 8th-century BC epic hexameter VERSE — a
// different genre, a different (though related) dialect, a different
// register, no oral-formulaic diction system in common with Homer at all.
// Same script (Greek), so tokenization is not the variable under test.
//
// Architectural correction from the prior probes, made explicit: a prior
// belongs ONLY on the scoring side, computing an independent surprise
// score used to rank/select — it must never leak into, blend with, or
// alter the actual CONTENT pass. Every span's literal text in this
// investigation has always been sliced directly from the real source and
// independently re-verified (see probe-surf-fold-odyssey.mjs) — that
// discipline is unchanged here. What IS corrected here: the earlier
// probes' 50/50 "blend" computed one hybrid distribution by averaging the
// external prior with the local within-text window before scoring, which
// let the content-pass (recent real text) leak into what should be a
// clean, independent prior-side comparison. This probe computes local-
// surprise and external-surprise as two SEPARATE, independently derived
// scores — never merged into one distribution — so each stays a clean
// read of exactly one thing: "surprising relative to genre" or
// "surprising relative to recent narrative," never a muddy mixture of
// both that cannot be attributed to either.
//
// Usage: node scripts/probe-unrelated-prior.mjs

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
  { splitSentences, frameText, detectBoundaries },
  { wordFrequencies, klDivergence },
] = await Promise.all([
  importFromLegacyEngine("emergence/summary/text-organ.js"),
  importFromLegacyEngine("emergence/surprise/index.js"),
]);

const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Fetch/cache Herodotus — PROSE structure (<p> paragraphs), not verse
// (<l> lines) like the Odyssey/Iliad extractor used. A genuinely different
// TEI shape for a genuinely different genre, handled on its own terms
// rather than forced through the verse extractor.
async function ensureHerodotus() {
  const cachePath = path.join(CACHE_DIR, "herodotus-grc.txt");
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8");
  const url = "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/master/data/tlg0016/tlg001/tlg0016.tlg001.perseus-grc2.xml";
  console.log(`Fetching Herodotus, Histories: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const xml = await res.text();
  const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const paras = [...xml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1])).filter(Boolean);
  if (paras.length === 0) throw new Error("matched 0 <p> paragraphs — Herodotus TEI structure may differ from expected");
  const text = ["THE HISTORIES OF HERODOTUS", "Ancient Greek, Ionic prose (Perseus Digital Library, tlg0016.tlg001.perseus-grc2)", "", ...paras].join("\n");
  fs.writeFileSync(cachePath, text, "utf8");
  console.log(`  cached ${paras.length} paragraphs -> ${path.relative(REPO_ROOT, cachePath)}`);
  return text;
}

const odysseyPath = path.join(CACHE_DIR, "odyssey-grc.txt");
const iliadPath = path.join(CACHE_DIR, "iliad-grc.txt");
if (!fs.existsSync(odysseyPath) || !fs.existsSync(iliadPath)) {
  throw new Error("Run probe-surf-fold-odyssey-surprise.mjs first to fetch+cache the Odyssey and Iliad.");
}
const realText = fs.readFileSync(odysseyPath, "utf8");
const iliadText = fs.readFileSync(iliadPath, "utf8");
const herodotusText = await ensureHerodotus();

console.log(`\nOdyssey (subject text): ${realText.length.toLocaleString()} chars`);
console.log(`Iliad (SAME-tradition external prior): ${iliadText.length.toLocaleString()} chars`);
console.log(`Herodotus (UNRELATED external prior — different genre/era/register): ${herodotusText.length.toLocaleString()} chars\n`);

const iliadDist = wordFrequencies(iliadText);
const herodotusDist = wordFrequencies(herodotusText);

// A crude, disclosed lexical-overlap check between the two prior sources
// and the subject text, so "unrelated" is a measured claim, not just an
// assertion based on genre labels.
function jaccardTop(distA, distB, topN = 2000) {
  const topA = new Set([...distA.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]));
  const topB = new Set([...distB.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]));
  let inter = 0;
  for (const w of topA) if (topB.has(w)) inter++;
  return inter / (topA.size + topB.size - inter);
}
const odysseyDist = wordFrequencies(realText);
console.log(`Lexical overlap check (Jaccard over each corpus's top 2000 words, vs. the Odyssey's):`);
console.log(`  Iliad:      ${(jaccardTop(odysseyDist, iliadDist) * 100).toFixed(1)}%`);
console.log(`  Herodotus:  ${(jaccardTop(odysseyDist, herodotusDist) * 100).toFixed(1)}%`);
console.log(`  (lower = less overlap = more genuinely "unrelated" by this crude measure)\n`);

// ══════════════════════════════════════════════════════════════════════════
// PART A — entity-level: does an unrelated prior rank the real disguise
// line better, worse, or the same as the same-tradition prior did?
// ══════════════════════════════════════════════════════════════════════════
console.log("=".repeat(78));
console.log("PART A — entity-level surprise: Athena's disguise line (contains \"Μέντ\"), three priors, kept SEPARATE");
console.log("=".repeat(78));

const sentences = splitSentences(realText);
const WINDOW = 60;

// Pure, unblended: score every sentence against ONE FIXED distribution only
// (no local window involved at all) — the clean way to test an external
// prior in isolation, avoiding the earlier probes' distribution-blending.
function scoreAgainstFixedPrior(sentences, priorDist) {
  return sentences.map((s) => {
    if (s.text.split(/\s+/).filter(Boolean).length < 4) return 0;
    return klDivergence(wordFrequencies(s.text), priorDist);
  });
}
// Pure within-text local-window score, unchanged from spine.js's own mechanism.
function scoreLocalWindow(sentences) {
  const localWindow = [];
  return sentences.map((s) => {
    const text = s.text;
    if (text.split(/\s+/).filter(Boolean).length < 4) return 0;
    let score = 0;
    if (localWindow.length > 0) {
      const combined = new Map(); let total = 0;
      for (const h of localWindow) for (const [w, p] of wordFrequencies(h)) { combined.set(w, (combined.get(w) ?? 0) + p); total++; }
      const localDist = new Map([...combined].map(([w, p]) => [w, p / total]));
      score = klDivergence(wordFrequencies(text), localDist);
    }
    localWindow.push(text);
    if (localWindow.length > WINDOW) localWindow.shift();
    return score;
  });
}

const localScores = scoreLocalWindow(sentences);
const iliadScores = scoreAgainstFixedPrior(sentences, iliadDist);
const herodotusScores = scoreAgainstFixedPrior(sentences, herodotusDist);

const mentesIdx = sentences.findIndex((s) => s.text.includes("Μέντ"));
console.log(`\nAthena's disguise-name line at sentence ${mentesIdx} of ${sentences.length}.\n`);

function reportRank(scores, label) {
  const ranked = scores.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const rank = ranked.findIndex((x) => x.i === mentesIdx);
  const topPct = rank >= 0 ? (100 * rank / ranked.length) : null;
  console.log(`  ${label.padEnd(45)} score=${scores[mentesIdx]?.toFixed(3)}  rank ${rank + 1} of ${ranked.length}  (top ${topPct?.toFixed(2)}% most surprising)`);
  return topPct;
}
const localPct = reportRank(localScores, "within-text local-window (baseline):");
const iliadPct = reportRank(iliadScores, "Iliad (same-tradition external):");
const herodotusPct = reportRank(herodotusScores, "Herodotus (UNRELATED external):");

console.log(`\nPART A FINDING: unrelated (Herodotus) prior is ${
  herodotusPct < iliadPct ? "BETTER ranked than the same-tradition Iliad prior" : herodotusPct > iliadPct ? "WORSE ranked than the same-tradition Iliad prior" : "about the same as"
} (top ${herodotusPct.toFixed(2)}% vs Iliad's top ${iliadPct.toFixed(2)}%), and ${
  herodotusPct < localPct ? "BEATS" : "still underperforms"
} the within-text baseline (top ${localPct.toFixed(2)}%).`);

// ══════════════════════════════════════════════════════════════════════════
// PART B — structure-level: real book-boundary detection, same three priors
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(78));
console.log("PART B — structural boundary detection, same three priors, real ground truth (24 book markers)");
console.log("=".repeat(78));

const bookMarkers = [...realText.matchAll(/\[BOOK (\d+)\]/g)].map((m) => ({ n: m[1], offset: m.index }));
const frames = frameText(realText);
const TOLERANCE = 2000;

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
  console.log(`  ${label.padEnd(45)} ${boundaries.length} boundaries, ${truePositives}/${bookMarkers.length} real book-starts matched (recall=${(recall*100).toFixed(1)}% precision=${(precision*100).toFixed(1)}%)`);
  return { recall, precision };
}

// Production's own zThreshold, confirmed by grep in the sibling probe.
const baselineBoundaries = detectBoundaries(frames, { zThreshold: 1.8, window: 20 });
scoreAgainstGroundTruth(baselineBoundaries, "within-text local-window (production baseline):");

function detectBoundariesFixedPrior(frames, priorDist, { zThreshold = 1.8, window = 20 } = {}) {
  const scores = frames.map((f) => ({ order: f.order, offset: f.offset, score: klDivergence(f.dist, priorDist) }));
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
scoreAgainstGroundTruth(detectBoundariesFixedPrior(frames, iliadDist), "Iliad (same-tradition external):");
scoreAgainstGroundTruth(detectBoundariesFixedPrior(frames, herodotusDist), "Herodotus (UNRELATED external):");

console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`Both external priors were kept strictly on the scoring side — never blended into a shared distribution with the`);
console.log(`local window, never touching any span's literal content. Whether "unrelated" beats "same-tradition," and whether`);
console.log(`either beats the within-text baseline, is reported above with actual numbers, at both grains, not assumed.`);
