#!/usr/bin/env node
// probe-all-literature-prior.mjs — "turn on all the literature priors":
// build ONE aggregate external prior from a genuinely broad real sample of
// ancient Greek literature (13 works, 6 genres: epic, didactic epic,
// tragedy x3, comedy, philosophy, history x2, oratory, prose memoir, lyric)
// instead of a single comparandum, and re-run the same two real tests
// (entity-level surprise ranking, real structural boundary detection)
// already run against the within-text baseline, the same-tradition Iliad
// prior, and the unrelated Herodotus prior.
//
// Why this is a real next step, not just "add more data": the Herodotus
// probe found relatedness-to-subject is what determines whether an
// external prior dilutes local contrast or not. A single unrelated work is
// one data point on that axis. A broad literature-wide prior is a
// different thing again — closer to "the general shape of the Greek
// literary lexicon" than to any one comparandum's specific vocabulary —
// and it is not obvious in advance whether averaging across many genres
// converges toward something more useful (a genuinely general baseline) or
// less useful (a smeared-out distribution with no work's specific
// character left in it). Tested here, not assumed.
//
// Additional works fetched (Iliad and Herodotus reused from cache — see
// probe-surf-fold-odyssey-surprise.mjs and probe-unrelated-prior.mjs):
//   Hesiod, Works and Days (tlg0020.tlg002) — didactic epic, archaic
//   Hesiod, Theogony (tlg0020.tlg001) — didactic epic, archaic
//   Aeschylus, Agamemnon (tlg0085.tlg006) — tragedy
//   Sophocles, Antigone (tlg0011.tlg003) — tragedy
//   Euripides, Medea (tlg0006.tlg003) — tragedy
//   Aristophanes, Clouds (tlg0019.tlg011) — comedy
//   Plato, Republic (tlg0059.tlg030) — philosophy, prose
//   Thucydides, History (tlg0003.tlg001) — history, prose
//   Demosthenes, On the Crown (tlg0014.tlg018) — oratory, prose
//   Xenophon, Anabasis (tlg0032.tlg006) — prose memoir/history
//   Pindar, Odes (tlg0033.tlg001) — lyric poetry
//
// These are fetched with a single generic extractor (strip <teiHeader>,
// strip all remaining tags, collapse whitespace) rather than the bespoke
// verse-line/paragraph extractors used for the Odyssey/Iliad/Herodotus —
// bulk vocabulary for a background distribution does not need clean
// structural boundaries the way the Odyssey's own ground-truth book
// markers did; using a simpler, more robust extractor here is a
// deliberate, disclosed choice, not an oversight.
//
// Usage: node scripts/probe-all-literature-prior.mjs

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

const WORKS = [
  { id: "hesiod-works-days", label: "Hesiod, Works and Days", genre: "didactic epic", urn: "tlg0020/tlg002/tlg0020.tlg002.perseus-grc2.xml" },
  { id: "hesiod-theogony", label: "Hesiod, Theogony", genre: "didactic epic", urn: "tlg0020/tlg001/tlg0020.tlg001.perseus-grc2.xml" },
  { id: "aeschylus-agamemnon", label: "Aeschylus, Agamemnon", genre: "tragedy", urn: "tlg0085/tlg006/tlg0085.tlg006.perseus-grc2.xml" },
  { id: "sophocles-antigone", label: "Sophocles, Antigone", genre: "tragedy", urn: "tlg0011/tlg003/tlg0011.tlg003.perseus-grc2.xml" },
  { id: "euripides-medea", label: "Euripides, Medea", genre: "tragedy", urn: "tlg0006/tlg003/tlg0006.tlg003.perseus-grc2.xml" },
  { id: "aristophanes-clouds", label: "Aristophanes, Clouds", genre: "comedy", urn: "tlg0019/tlg011/tlg0019.tlg011.perseus-grc2.xml" },
  { id: "plato-republic", label: "Plato, Republic", genre: "philosophy (prose)", urn: "tlg0059/tlg030/tlg0059.tlg030.perseus-grc2.xml" },
  { id: "thucydides-history", label: "Thucydides, History", genre: "history (prose)", urn: "tlg0003/tlg001/tlg0003.tlg001.perseus-grc2.xml" },
  { id: "demosthenes-on-crown", label: "Demosthenes, On the Crown", genre: "oratory (prose)", urn: "tlg0014/tlg018/tlg0014.tlg018.perseus-grc2.xml" },
  { id: "xenophon-anabasis", label: "Xenophon, Anabasis", genre: "prose memoir/history", urn: "tlg0032/tlg006/tlg0032.tlg006.perseus-grc2.xml" },
  { id: "pindar-odes", label: "Pindar, Odes", genre: "lyric poetry", urn: "tlg0033/tlg001/tlg0033.tlg001.perseus-grc2.xml" },
];

function genericTeiToPlainText(xml) {
  const noHeader = xml.replace(/<teiHeader\b[\s\S]*?<\/teiHeader>/i, "");
  return noHeader.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function ensureWork(work) {
  const cachePath = path.join(CACHE_DIR, `${work.id}-grc.txt`);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8");
  const url = `https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/master/data/${work.urn}`;
  console.log(`Fetching ${work.label}: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${work.label}: ${res.status}`);
  const xml = await res.text();
  const text = genericTeiToPlainText(xml);
  if (text.length < 1000) throw new Error(`${work.label}: suspiciously short extraction (${text.length} chars) — check TEI structure`);
  fs.writeFileSync(cachePath, text, "utf8");
  console.log(`  cached ${text.length.toLocaleString()} chars -> ${path.relative(REPO_ROOT, cachePath)}`);
  return text;
}

const odysseyPath = path.join(CACHE_DIR, "odyssey-grc.txt");
const iliadPath = path.join(CACHE_DIR, "iliad-grc.txt");
const herodotusPath = path.join(CACHE_DIR, "herodotus-grc.txt");
for (const p of [odysseyPath, iliadPath, herodotusPath]) {
  if (!fs.existsSync(p)) throw new Error(`${p} not found — run the earlier probes first (probe-surf-fold-odyssey-surprise.mjs, probe-unrelated-prior.mjs).`);
}
const realText = fs.readFileSync(odysseyPath, "utf8");
const iliadText = fs.readFileSync(iliadPath, "utf8");
const herodotusText = fs.readFileSync(herodotusPath, "utf8");

console.log(`Fetching/loading ${WORKS.length} additional works (13 total literature sources with Iliad+Herodotus)...\n`);
const fetched = [];
for (const w of WORKS) fetched.push({ ...w, text: await ensureWork(w) });

const allWorks = [
  { id: "iliad", label: "Homer, Iliad", genre: "epic", text: iliadText },
  { id: "herodotus", label: "Herodotus, Histories", genre: "history (prose)", text: herodotusText },
  ...fetched,
];

console.log(`\n${"=".repeat(78)}`);
console.log(`ALL LITERATURE PRIORS — ${allWorks.length} real works, ${new Set(allWorks.map((w) => w.genre)).size} genres`);
console.log("=".repeat(78));
let totalChars = 0;
for (const w of allWorks) { console.log(`  ${w.label.padEnd(32)} ${w.genre.padEnd(24)} ${w.text.length.toLocaleString()} chars`); totalChars += w.text.length; }
console.log(`  TOTAL: ${totalChars.toLocaleString()} chars across ${allWorks.length} works — the aggregate prior corpus\n`);

const combinedText = allWorks.map((w) => w.text).join("\n\n");
const allLitDist = wordFrequencies(combinedText);
const odysseyDist = wordFrequencies(realText);

function jaccardTop(distA, distB, topN = 2000) {
  const topA = new Set([...distA.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]));
  const topB = new Set([...distB.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]));
  let inter = 0;
  for (const w of topA) if (topB.has(w)) inter++;
  return inter / (topA.size + topB.size - inter);
}
console.log(`Lexical overlap (Jaccard, top-2000 words) between the all-literature aggregate and the Odyssey: ${(jaccardTop(odysseyDist, allLitDist) * 100).toFixed(1)}%`);
console.log(`(for reference: Iliad alone 36.6%, Herodotus alone 13.0%, from the earlier probe)\n`);

// ══════════════════════════════════════════════════════════════════════════
// PART A — entity-level surprise, all-literature prior vs. the three earlier conditions
// ══════════════════════════════════════════════════════════════════════════
console.log("=".repeat(78));
console.log("PART A — entity-level surprise: Athena's disguise line, all-literature aggregate prior");
console.log("=".repeat(78));

const sentences = splitSentences(realText);
const WINDOW = 60;
function scoreAgainstFixedPrior(sentences, priorDist) {
  return sentences.map((s) => {
    if (s.text.split(/\s+/).filter(Boolean).length < 4) return 0;
    return klDivergence(wordFrequencies(s.text), priorDist);
  });
}
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
const allLitScores = scoreAgainstFixedPrior(sentences, allLitDist);
const mentesIdx = sentences.findIndex((s) => s.text.includes("Μέντ"));

function reportRank(scores, label) {
  const ranked = scores.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const rank = ranked.findIndex((x) => x.i === mentesIdx);
  const topPct = rank >= 0 ? (100 * rank / ranked.length) : null;
  console.log(`  ${label.padEnd(45)} score=${scores[mentesIdx]?.toFixed(3)}  rank ${rank + 1} of ${ranked.length}  (top ${topPct?.toFixed(2)}%)`);
  return topPct;
}
const localPct = reportRank(localScores, "within-text local-window (baseline):");
const allLitPct = reportRank(allLitScores, "ALL-LITERATURE aggregate (13 works, 6 genres):");
console.log(`  (for reference from earlier probes: Iliad-only top 28.33%, Herodotus-only top 11.36%)`);

// ══════════════════════════════════════════════════════════════════════════
// PART B — structural boundary detection, all-literature prior
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(78));
console.log("PART B — structural boundary detection, all-literature aggregate prior, real ground truth");
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
  console.log(`  ${label.padEnd(45)} ${boundaries.length} boundaries, ${truePositives}/${bookMarkers.length} matched (recall=${(recall * 100).toFixed(1)}% precision=${(precision * 100).toFixed(1)}%)`);
  return { recall, precision };
}

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
scoreAgainstGroundTruth(detectBoundariesFixedPrior(frames, allLitDist), "ALL-LITERATURE aggregate (13 works, 6 genres):");
console.log(`  (for reference from earlier probes: Iliad-only recall=16.7%/precision=16.0%, Herodotus-only recall=25.0%/precision=30.0%)`);

console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`A 13-work, 6-genre aggregate prior (${totalChars.toLocaleString()} chars, ${(jaccardTop(odysseyDist, allLitDist) * 100).toFixed(1)}% lexical overlap with the Odyssey) is compared`);
console.log(`directly against the within-text baseline and the two single-work priors already tested. Kept strictly on the`);
console.log(`scoring side, never blended into a shared distribution, never touching any span's literal content — same`);
console.log(`discipline as the unrelated-prior probe. Whether broadening to "all of Greek literature" converges toward the`);
console.log(`baseline, toward the best single-work result, or toward something else entirely is reported above, not assumed.`);
