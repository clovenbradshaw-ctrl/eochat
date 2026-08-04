#!/usr/bin/env node
// read-odyssey-ensemble-surprise.mjs — an actual reading pass over the
// Odyssey, surfacing what's surprising against ALL validated priors at
// once, not any single one.
//
// select-best-priors.mjs found that no single cheap prior reliably predicts
// which candidate helps (Spearman correlation with overlap ~ -0.02) — the
// 13 individual Greek-literature priors disagree with each other about
// what's surprising almost as much as they agree. That is exactly the
// situation an ENSEMBLE is for: instead of trusting any one external prior
// (already shown unreliable) or only the within-text baseline (the single
// best validated mechanism, but still just one signal), score every
// sentence against all 14 — the within-text local-window baseline plus all
// 13 individually-cached real works — and surface the moments where many
// signals agree, not the moments any one idiosyncratic prior happens to
// flag.
//
// Scope, stated plainly: this uses the 13 within-Greek candidates, not the
// eoPriors global_south_corpus cross-SCRIPT material (Sanskrit, Chinese,
// Arabic, ...). Word-frequency KL-divergence against a prior with zero
// shared vocabulary degenerates to the observed sentence's own self-entropy
// — the same failure mode already found for a cross-modal text/audio
// comparison — so a genuine cross-script pass would need a fundamentally
// different mechanism (semantic embeddings, not available in this
// toolchain) to mean anything at all. Included here only where comparison
// is real: shared-vocabulary, within-Greek.
//
// Usage: node scripts/read-odyssey-ensemble-surprise.mjs [topN]

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
  { splitSentences },
  { wordFrequencies, klDivergence },
] = await Promise.all([
  importFromLegacyEngine("emergence/summary/text-organ.js"),
  importFromLegacyEngine("emergence/surprise/index.js"),
]);

const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
const odysseyPath = path.join(CACHE_DIR, "odyssey-grc.txt");
if (!fs.existsSync(odysseyPath)) throw new Error("Run probe-organs-real-deployment.mjs first to fetch+cache the Odyssey.");
const rawText = fs.readFileSync(odysseyPath, "utf8");

// Strip this repo's own scaffolding (the header line, "[BOOK N]" tags)
// before reading — the same contamination probe-organs-real-deployment.mjs
// caught in the terrain-classifier test earlier ("[BOOK N]" tripping an
// English weak-term). A first run of THIS script missed the same fix and
// put the header line itself ("Murray (Perseus Digital Library...)") at
// #2 in the ranking — not Odyssey content, this probe's own formatting.
//
// "[BOOK N]" tags are blanked to equal-length whitespace, not deleted
// outright — deleting would shift every subsequent character's offset,
// breaking correspondence with `bookMarkers` (below, computed from these
// SAME offsets) and with any cross-reference back to the raw cached file.
// Equal-length blanking removes the contaminating tokens from what
// splitSentences/wordFrequencies ever see while leaving every real
// offset exactly where it already was.
const headerStripped = rawText.replace(/^THE ODYSSEY[\s\S]*?perseus-grc2\)/, (m) => " ".repeat(m.length));
const realText = headerStripped.replace(/\[BOOK \d+\]/g, (m) => " ".repeat(m.length));

const CANDIDATE_FILES = [
  "iliad-grc.txt", "herodotus-grc.txt", "hesiod-works-days-grc.txt", "hesiod-theogony-grc.txt",
  "aeschylus-agamemnon-grc.txt", "sophocles-antigone-grc.txt", "euripides-medea-grc.txt",
  "aristophanes-clouds-grc.txt", "plato-republic-grc.txt", "thucydides-history-grc.txt",
  "demosthenes-on-crown-grc.txt", "xenophon-anabasis-grc.txt", "pindar-odes-grc.txt",
];
const missing = CANDIDATE_FILES.filter((f) => !fs.existsSync(path.join(CACHE_DIR, f)));
if (missing.length) throw new Error(`Missing cached priors: ${missing.join(", ")} — run probe-all-literature-prior.mjs first.`);

console.log(`Loading Odyssey (${realText.length.toLocaleString()} chars) and ${CANDIDATE_FILES.length} real external priors...\n`);
const priors = CANDIDATE_FILES.map((f) => ({
  id: f.replace("-grc.txt", ""),
  dist: wordFrequencies(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")),
}));

// Book boundaries, for reporting real location, not just a raw offset.
// From headerStripped (tags still present there), NOT realText (tags
// already blanked out of it above) — offsets are identical between the
// two since blanking never changes string length.
const bookMarkers = [...headerStripped.matchAll(/\[BOOK (\d+)\]/g)].map((m) => ({ n: parseInt(m[1], 10), offset: m.index }));
function bookAt(offset) {
  let book = bookMarkers[0]?.n ?? 1;
  for (const b of bookMarkers) if (b.offset <= offset) book = b.n; else break;
  return book;
}

const sentences = splitSentences(realText);
const sentenceDists = sentences.map((s) => (s.text.split(/\s+/).filter(Boolean).length >= 4 ? wordFrequencies(s.text) : null));
console.log(`${sentences.length.toLocaleString()} sentences.\n`);

// ── Signal 1: within-text local-window baseline (sequential, forward-only) ──
console.log("Scoring signal 1/14: within-text baseline (sequential, forward-only)...");
const WINDOW = 60;
function scoreLocalWindow() {
  const localWindow = [];
  return sentences.map((s, i) => {
    const d = sentenceDists[i];
    if (!d) return 0;
    let score = 0;
    if (localWindow.length > 0) {
      const combined = new Map(); let total = 0;
      for (const h of localWindow) for (const [w, p] of h) { combined.set(w, (combined.get(w) ?? 0) + p); total++; }
      const localDist = new Map([...combined].map(([w, p]) => [w, p / total]));
      score = klDivergence(d, localDist);
    }
    localWindow.push(d);
    if (localWindow.length > WINDOW) localWindow.shift();
    return score;
  });
}
const baselineScores = scoreLocalWindow();

// ── Signals 2-14: each of the 13 real external priors, fixed, batch-scored ──
const allScores = { "within-text": baselineScores };
priors.forEach((p, idx) => {
  console.log(`Scoring signal ${idx + 2}/14: ${p.id}...`);
  allScores[p.id] = sentenceDists.map((d) => (d ? klDivergence(d, p.dist) : 0));
});

// ── Percentile-rank each signal independently (comparable scales), then average ──
function toPercentiles(scores) {
  const ranked = scores.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => a.s - b.s); // ascending
  const pct = new Array(scores.length).fill(0);
  ranked.forEach((r, pos) => { pct[r.i] = pos / (ranked.length - 1 || 1); }); // 0=least surprising, 1=most
  return pct;
}
const percentileSets = {};
for (const [id, scores] of Object.entries(allScores)) percentileSets[id] = toPercentiles(scores);

const signalIds = Object.keys(percentileSets);
const consensus = sentences.map((_, i) => {
  let sum = 0, topDecileCount = 0;
  for (const id of signalIds) {
    const p = percentileSets[id][i];
    sum += p;
    if (p >= 0.9) topDecileCount++;
  }
  return { meanPercentile: sum / signalIds.length, topDecileCount };
});

// ── Recurrence check: does this exact sentence text appear elsewhere in the
// poem? A high "surprise" score against non-epic external priors (prose
// history, philosophy, oratory) can just mean "this is recognizably epic
// diction," which is a genuinely different thing from "this moment is
// narratively unique" — a Homeric FORMULA (a stock phrase reused verbatim
// across scenes, the oral-formulaic composition this repo's own
// specs/composition-is-retrieval.md already cites) is the clearest case:
// it scores as distinctive relative to the external priors while being, if
// anything, the opposite of surprising within the poem's own compositional
// system, since it is expected, recurring boilerplate. Tagged automatically
// here instead of left for a reader to notice by eye.
const normText = (t) => t.replace(/\s+/g, " ").trim();
const byNormText = new Map();
sentences.forEach((s, i) => {
  const key = normText(s.text);
  if (!byNormText.has(key)) byNormText.set(key, []);
  byNormText.get(key).push(i);
});
function recurrenceTag(i, text) {
  const others = (byNormText.get(normText(text)) ?? []).filter((j) => j !== i);
  if (others.length === 0) return null;
  const books = [...new Set(others.map((j) => bookAt(sentences[j].offset)))].sort((a, b) => a - b);
  return { count: others.length, books };
}

// ── The reading: top consensus moments, ranked by how many of 14 signals agree ──
const topN = parseInt(process.argv[2] || "25", 10);
const ranked = sentences
  .map((s, i) => ({ i, text: s.text, offset: s.offset, ...consensus[i] }))
  .filter((x) => x.text.split(/\s+/).filter(Boolean).length >= 4)
  .sort((a, b) => (b.topDecileCount - a.topDecileCount) || (b.meanPercentile - a.meanPercentile));

console.log("\n" + "=".repeat(96));
console.log(`READING: top ${topN} consensus-surprise moments in the Odyssey — real quotes, real offsets, ranked by how`);
console.log(`many of 14 independent signals (baseline + 13 real external priors) place them in their own top decile`);
console.log("=".repeat(96));

let formulaCount = 0;
for (let rank = 0; rank < Math.min(topN, ranked.length); rank++) {
  const m = ranked[rank];
  const agreeing = signalIds.filter((id) => percentileSets[id][m.i] >= 0.9);
  const recur = recurrenceTag(m.i, m.text);
  console.log(`\n#${rank + 1} — Book ${bookAt(m.offset)}, offset ${m.offset} — ${m.topDecileCount}/14 signals agree (top-decile), mean percentile ${(m.meanPercentile * 100).toFixed(1)}`);
  console.log(`  "${m.text.replace(/\n/g, " / ")}"`);
  console.log(`  agreeing signals: ${agreeing.join(", ")}`);
  if (recur) {
    formulaCount++;
    console.log(`  ⚠ FORMULA — appears verbatim ${recur.count} more time(s) elsewhere: Book ${recur.books.join(", Book ")}`);
    console.log(`    (scores high against non-epic priors as recognizably epic diction, not as a narratively unique moment)`);
  } else {
    console.log(`  unique — no exact-text recurrence found elsewhere in the poem`);
  }
}
console.log(`\n${formulaCount}/${Math.min(topN, ranked.length)} of the top ${topN} are tagged as recurring formulae, not unique occurrences.`);

// ── Where does Athena's Book-1 Mentes line land under ensemble consensus? ──
const mentesIdx = sentences.findIndex((s) => s.text.includes("Μέντ"));
const mentesRank = ranked.findIndex((x) => x.i === mentesIdx);
console.log(`\n${"=".repeat(96)}`);
console.log(`Cross-check: Athena's disguise-name line (Book 1) ranks #${mentesRank + 1} of ${ranked.length} by ensemble consensus`);
console.log(`(${consensus[mentesIdx].topDecileCount}/14 signals place it in their own top decile, mean percentile ${(consensus[mentesIdx].meanPercentile * 100).toFixed(1)}) — reported as found, not adjusted.`);

console.log(`\n${"=".repeat(96)}`);
console.log("SUMMARY");
console.log("=".repeat(96));
console.log(`14 independent surprise signals (1 within-text baseline + 13 real, individually-validated external Greek`);
console.log(`literary priors), each percentile-ranked on its own terms, combined only by counting agreement — no single`);
console.log(`signal was trusted alone, consistent with the N=13 finding that no single external prior is reliable.`);
console.log(`This is what "reading the Odyssey against all of our priors" can honestly mean with the tools actually`);
console.log(`validated in this investigation: consensus across many real, independently-scored comparisons, not one.`);
