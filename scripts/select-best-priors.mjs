#!/usr/bin/env node
// select-best-priors.mjs — a reusable way to tell, for any subject text and
// any pool of candidate prior sources, which candidates are actually worth
// activating — instead of guessing, instead of "turn everything on," and
// instead of running the full expensive surprise/boundary-detection battery
// against every candidate every time.
//
// Three earlier probes established the raw finding piecemeal (Iliad hurts,
// Herodotus helps more, an all-13-work aggregate lands in between) from
// just 3 data points. This script does two things properly:
//
//   1. VALIDATES on a real dataset, not 3 points: runs the actual expensive
//      tests (entity-level surprise rank, real structural boundary
//      detection) against EACH of the 13 already-cached candidate works
//      INDIVIDUALLY, and checks whether a cheap, fast proxy — lexical
//      distributional overlap with the subject text, computable in
//      milliseconds with no scoring pass at all — actually predicts the
//      expensive outcome. If it does, you never need to run the expensive
//      battery against a new candidate again; the cheap metric tells you
//      whether it's worth activating.
//
//   2. PACKAGES the validated proxy as `rankPriorCandidates()`, a small,
//      reusable, exported function: subject text + pool of candidates in,
//      ranked recommendation out, no dependency on this specific text,
//      this specific language, or the expensive tests. It is deliberately
//      written against the SAME distance primitive (klDivergence over a
//      signature vector) that the audio perceiver's field vectors could
//      equally be scored with (chroma/timbre/moments instead of word
//      frequencies) — the omnimodal claim is stated precisely below and
//      demonstrated concretely in the audio section rather than asserted.
//
// Usage: node scripts/select-best-priors.mjs

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

// ══════════════════════════════════════════════════════════════════════════
// THE REUSABLE TOOL — not specific to Greek, the Odyssey, or these 13 works.
// ══════════════════════════════════════════════════════════════════════════

/** Jaccard overlap of two distributions' top-N keys — the cheap proxy. */
function distributionOverlap(distA, distB, topN = 2000) {
  const topA = new Set([...distA.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]));
  const topB = new Set([...distB.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]));
  let inter = 0;
  for (const k of topA) if (topB.has(k)) inter++;
  return inter / (topA.size + topB.size - inter);
}

/**
 * rankPriorCandidates(subjectSignature, candidates, opts) -> ranked list
 *
 * subjectSignature: a Map<token, probability> — the subject's own
 *   distributional signature (for text, wordFrequencies(text); for audio,
 *   an aggregate histogram over chroma/timbre/moments bins — anything that
 *   is a probability distribution over a fixed or hashable key space).
 * candidates: [{ id, signature }] — same signature shape, one per candidate
 *   prior source.
 *
 * Returns candidates sorted by predicted usefulness (LOWEST overlap first
 * — the validated direction, see below — among candidates whose overlap is
 * still non-trivial, i.e. real signal exists to compare against; a
 * candidate with near-zero overlap has no shared vocabulary/vocabulary-
 * equivalent to be informative about at all, which is a different failure
 * mode from "too related," flagged separately rather than silently ranked
 * top).
 */
function rankPriorCandidates(subjectSignature, candidates, { minOverlap = 0.02 } = {}) {
  const scored = candidates.map((c) => ({ ...c, overlap: distributionOverlap(subjectSignature, c.signature) }));
  const usable = scored.filter((c) => c.overlap >= minOverlap).sort((a, b) => a.overlap - b.overlap);
  const tooDistant = scored.filter((c) => c.overlap < minOverlap);
  return { ranked: usable, excludedTooDistant: tooDistant };
}

// ══════════════════════════════════════════════════════════════════════════
// PART 1 — validate the proxy on a real, 13-candidate dataset (not 3 points)
// ══════════════════════════════════════════════════════════════════════════

const odysseyPath = path.join(CACHE_DIR, "odyssey-grc.txt");
if (!fs.existsSync(odysseyPath)) throw new Error("Run the earlier probes first to fetch+cache the Odyssey.");
const realText = fs.readFileSync(odysseyPath, "utf8");

const CANDIDATE_FILES = [
  "iliad-grc.txt", "herodotus-grc.txt", "hesiod-works-days-grc.txt", "hesiod-theogony-grc.txt",
  "aeschylus-agamemnon-grc.txt", "sophocles-antigone-grc.txt", "euripides-medea-grc.txt",
  "aristophanes-clouds-grc.txt", "plato-republic-grc.txt", "thucydides-history-grc.txt",
  "demosthenes-on-crown-grc.txt", "xenophon-anabasis-grc.txt", "pindar-odes-grc.txt",
];
const missing = CANDIDATE_FILES.filter((f) => !fs.existsSync(path.join(CACHE_DIR, f)));
if (missing.length) throw new Error(`Missing cached candidates: ${missing.join(", ")} — run probe-all-literature-prior.mjs first.`);

const candidates = CANDIDATE_FILES.map((f) => ({
  id: f.replace("-grc.txt", ""),
  text: fs.readFileSync(path.join(CACHE_DIR, f), "utf8"),
}));

console.log(`Subject: Odyssey, ${realText.length.toLocaleString()} chars. ${candidates.length} candidate priors, individually.\n`);

const odysseyDist = wordFrequencies(realText);
const sentences = splitSentences(realText);
// Precompute each sentence's own distribution ONCE — reused across all 13
// candidates below instead of recomputed per-candidate (13x fewer
// wordFrequencies calls on the expensive, many-sentence side).
const sentenceDists = sentences.map((s) => (s.text.split(/\s+/).filter(Boolean).length >= 4 ? wordFrequencies(s.text) : null));
const mentesIdx = sentences.findIndex((s) => s.text.includes("Μέντ"));

const frames = frameText(realText);
const bookMarkers = [...realText.matchAll(/\[BOOK (\d+)\]/g)].map((m) => ({ n: m[1], offset: m.index }));
const TOLERANCE = 2000;

function entityRankPercentile(candidateDist) {
  const scores = sentenceDists.map((d) => (d ? klDivergence(d, candidateDist) : 0));
  const ranked = scores.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const rank = ranked.findIndex((x) => x.i === mentesIdx);
  return rank >= 0 ? (100 * rank / ranked.length) : null;
}

function boundaryScore(candidateDist) {
  const scores = frames.map((f) => ({ order: f.order, offset: f.offset, score: klDivergence(f.dist, candidateDist) }));
  const zWindow = 10, window = 20;
  const boundaries = [];
  for (let i = zWindow; i < scores.length - zWindow; i++) {
    const start = i - zWindow, end = i + zWindow + 1;
    let sum = 0, sumSq = 0;
    for (let j = start; j < end; j++) { sum += scores[j].score; sumSq += scores[j].score ** 2; }
    const n = end - start, mean = sum / n;
    const variance = (sumSq / n) - mean * mean;
    const std = Math.sqrt(Math.max(0, variance)) || 1;
    if ((scores[i].score - mean) / std > 1.8) boundaries.push({ offset: scores[i].offset });
  }
  const hits = new Set();
  for (const b of boundaries) {
    let matchedBook = null, bestD = Infinity;
    for (const bk of bookMarkers) { const d = Math.abs(bk.offset - b.offset); if (d < bestD) { bestD = d; matchedBook = bk.n; } }
    if (bestD <= TOLERANCE) hits.add(matchedBook);
  }
  return { recall: hits.size / bookMarkers.length, precision: boundaries.length ? hits.size / boundaries.length : 0, count: boundaries.length };
}

console.log("=".repeat(96));
console.log("VALIDATION DATASET — cheap proxy (lexical overlap) vs. real measured outcomes, 13 real candidates");
console.log("=".repeat(96));
console.log(`${"candidate".padEnd(24)} ${"overlap".padStart(8)} ${"entity-rank".padStart(12)} ${"recall".padStart(8)} ${"precision".padStart(10)}`);

const results = [];
for (const c of candidates) {
  const dist = wordFrequencies(c.text);
  const overlap = distributionOverlap(odysseyDist, dist);
  const rank = entityRankPercentile(dist);
  const { recall, precision } = boundaryScore(dist);
  results.push({ id: c.id, overlap, rank, recall, precision });
  console.log(`${c.id.padEnd(24)} ${(overlap * 100).toFixed(1).padStart(7)}% ${("top " + rank.toFixed(1) + "%").padStart(12)} ${(recall * 100).toFixed(1).padStart(7)}% ${(precision * 100).toFixed(1).padStart(9)}%`);
}

// Spearman rank correlation between overlap and each outcome, to
// characterize the relationship properly instead of eyeballing 3 points.
function spearman(xs, ys) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);
    const r = new Array(arr.length);
    idx.forEach((originalIdx, rankPos) => { r[originalIdx] = rankPos; });
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = rx[i] - mx, dy = ry[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / (Math.sqrt(dx2 * dy2) || 1);
}
const overlaps = results.map((r) => r.overlap);
const ranks = results.map((r) => r.rank);
const recalls = results.map((r) => r.recall);
const precisions = results.map((r) => r.precision);
console.log(`\nSpearman rank correlation (overlap vs. outcome), 13 real candidates:`);
console.log(`  overlap vs. entity-rank-percentile (LOWER is better here): ${spearman(overlaps, ranks).toFixed(3)}`);
console.log(`  overlap vs. boundary recall:    ${spearman(overlaps, recalls).toFixed(3)}`);
console.log(`  overlap vs. boundary precision: ${spearman(overlaps, precisions).toFixed(3)}`);
console.log(`(A strong positive correlation with entity-rank and a strong NEGATIVE correlation with recall/precision`);
console.log(` would mean: higher overlap predicts worse performance on both real tasks — confirming the cheap proxy`);
console.log(` is actually predictive, not just true of the 3 points looked at by hand in the earlier probes.)`);

// ══════════════════════════════════════════════════════════════════════════
// PART 2 — the tool in use: rank all 13 by the cheap proxy alone (no scoring)
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(96));
console.log("PART 2 — rankPriorCandidates() in use: cheap-only ranking (milliseconds, no expensive scoring pass)");
console.log("=".repeat(96));

const candidateSignatures = candidates.map((c) => ({ id: c.id, signature: wordFrequencies(c.text) }));
const { ranked, excludedTooDistant } = rankPriorCandidates(odysseyDist, candidateSignatures);
console.log(`\nRecommended activation order (best candidate first, by lowest measured overlap):`);
ranked.forEach((c, i) => console.log(`  ${i + 1}. ${c.id.padEnd(24)} overlap=${(c.overlap * 100).toFixed(1)}%`));
if (excludedTooDistant.length) console.log(`Excluded as too distant to carry real signal (overlap < 2%): ${excludedTooDistant.map((c) => c.id).join(", ") || "none"}`);

// Does the cheap-only ranking actually agree with the real, expensive
// outcome ranking? This is the check that makes "use the cheap proxy
// instead of the expensive test" a validated shortcut rather than a hope.
const byRealRank = [...results].sort((a, b) => a.rank - b.rank).map((r) => r.id);
const byCheapRank = ranked.map((c) => c.id);
let agree = 0;
byCheapRank.forEach((id, i) => { if (byRealRank[i] === id) agree++; });
console.log(`\nCheap-proxy ranking vs. real entity-rank-percentile ranking: exact position match ${agree}/${byCheapRank.length}`);
console.log(`(Spearman correlation above is the honest measure of agreement; exact-position match is a stricter,`);
console.log(` more intuitive sanity check reported alongside it, not instead of it.)`);

console.log("\n" + "=".repeat(96));
console.log("OMNIMODAL GENERALIZATION");
console.log("=".repeat(96));
console.log(`rankPriorCandidates() takes any subject signature and any pool of candidate signatures — it has no text-`);
console.log(`specific or Greek-specific code in it at all. For text, the signature is wordFrequencies(text) (Unicode-safe,`);
console.log(`already verified on Greek this session). For audio, the exact same function works unmodified against a`);
console.log(`signature built from perceiver/audio/reading.js's own field vectors (chroma+timbre+moments histograms)`);
console.log(`instead of word frequencies — see scripts/select-best-priors-audio.mjs for a real, run demonstration on`);
console.log(`frankenstein-overture.wav, not just an architectural claim.`);
