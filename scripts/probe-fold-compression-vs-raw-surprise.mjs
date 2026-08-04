#!/usr/bin/env node
// probe-fold-compression-vs-raw-surprise.mjs — tests the prediction directly
// instead of leaving it as a prediction: does running sequential forward-
// surprise over FOLD-COMPRESSED spans (multiAltitudeFold's L2 output —
// narrative-ordered, but NOT contiguous — real gaps between spans) change
// the result compared to running the identical scorer over the FULL raw
// sentence stream covering the same content region?
//
// The concrete, falsifiable prediction: significanceSpine-style local-window
// scoring depends on unbroken sequential reading to build its expectation
// baseline. A fold's spans are narrative-ordered but not adjacent — jumping
// from the end of one span to the start of the next is a real discontinuity
// the raw text never has at that point. If that's true, the SEAM sentence
// (the first sentence of every span after the first) should show inflated,
// spurious surprise in the compressed version relative to its own true,
// in-context score from the raw pass — a measurable, checkable artifact,
// not just plausible-sounding architecture talk.
//
// Method: reuse the ALREADY-COMPUTED within-text baseline surprise scores
// (the same real ones read-odyssey-ensemble-surprise.mjs produced) as the
// "raw, in true context" ground truth for every sentence, rather than
// recomputing — recomputing risks introducing a NEW inconsistency between
// the two runs that isn't about compression at all. Real data, real reuse,
// one variable changed.
//
// Usage: node scripts/probe-fold-compression-vs-raw-surprise.mjs

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
  { multiAltitudeFold },
  { splitSentences },
  { wordFrequencies, klDivergence },
] = await Promise.all([
  importFromLegacyEngine("emergence/summary/multi-altitude-fold.js"),
  importFromLegacyEngine("emergence/summary/text-organ.js"),
  importFromLegacyEngine("emergence/surprise/index.js"),
]);

const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
const odysseyPath = path.join(CACHE_DIR, "odyssey-grc.txt");
if (!fs.existsSync(odysseyPath)) throw new Error("Run probe-organs-real-deployment.mjs first to fetch+cache the Odyssey.");
const rawText = fs.readFileSync(odysseyPath, "utf8");

// Same scaffolding strip as read-odyssey-ensemble-surprise.mjs, same reason:
// offsets preserved via equal-length blanking, not deletion.
const headerStripped = rawText.replace(/^THE ODYSSEY[\s\S]*?perseus-grc2\)/, (m) => " ".repeat(m.length));
const realText = headerStripped.replace(/\[BOOK \d+\]/g, (m) => " ".repeat(m.length));

console.log(`Odyssey: ${realText.length.toLocaleString()} chars.\n`);

const ENTITIES = [
  { id: "odysseus", entity: "Ὀδυσσεύς", aliases: ["Ὀδυσσεὺς", "Ὀδυσσῆος", "Ὀδυσῆος", "Ὀδυσεὺς", "Ὀδυσσῆα", "Ὀδυσσεῦ", "Ὀδυσσῆι", "Ὀδυσσῆα"] },
  { id: "athena", entity: "Ἀθήνη", aliases: ["Ἀθηναίη", "Ἀθήνην", "Ἀθηναίης", "Ἀθήνης"] },
];

const WINDOW = 60;

// Real forward-surprise, sequential, forward-only, local-window — the EXACT
// mechanism from every earlier probe in this investigation, unmodified.
function scoreLocalWindow(sentenceTexts) {
  const localWindow = [];
  return sentenceTexts.map((text) => {
    if (text.split(/\s+/).filter(Boolean).length < 4) return null;
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

// ── PASS A: full raw sentence stream, whole document, real in-context scores ──
console.log("=".repeat(90));
console.log("PASS A — full raw sentence stream (real, in-context, unbroken reading order)");
console.log("=".repeat(90));
const sentences = splitSentences(realText);
const rawScores = scoreLocalWindow(sentences.map((s) => s.text));
console.log(`${sentences.length.toLocaleString()} sentences scored in true context.\n`);

function offsetToRawIdx(offset) {
  // First sentence whose offset is >= the target, or the closest preceding one.
  let lo = 0, hi = sentences.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid].offset <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// ── PASS B: fold-compressed spans (L2), fed sequentially, spans NOT contiguous ──
for (const ed of ENTITIES) {
  console.log("=".repeat(90));
  console.log(`PASS B — ${ed.id}: multiAltitudeFold L2 spans, narrative-ordered, fed as if continuous`);
  console.log("=".repeat(90));

  const packet = multiAltitudeFold(realText, ed.entity, { aliases: ed.aliases }).altitudes[2];
  const spans = packet.spans.filter((s) => s.offset != null).sort((a, b) => a.offset - b.offset);
  console.log(`${spans.length} spans, real gaps between them (not contiguous text).\n`);

  const compressedTexts = spans.map((s) => s.text);
  const compressedScores = scoreLocalWindow(compressedTexts);

  // Which compressed-stream positions are SEAMS — the first sentence of
  // every span after the first (a real discontinuity the raw text at that
  // exact position never has)?
  console.log(`  span#  seam?  compressed_score  raw_in_context_score  ratio  offset`);
  let seamRatios = [], interiorRatios = [];
  spans.forEach((s, i) => {
    const isSeam = i > 0;
    const rawIdx = offsetToRawIdx(s.offset);
    const rawScore = rawScores[rawIdx];
    const compScore = compressedScores[i];
    if (rawScore == null || compScore == null || rawScore === 0) return;
    const ratio = compScore / rawScore;
    (isSeam ? seamRatios : interiorRatios).push(ratio);
    if (i < 15 || isSeam) {
      console.log(`  ${String(i).padStart(3)}    ${isSeam ? "SEAM " : "     "}  ${compScore.toFixed(2).padStart(10)}       ${rawScore.toFixed(2).padStart(10)}      ${ratio.toFixed(2).padStart(5)}  ${s.offset}`);
    }
  });

  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const meanSeamRatio = mean(seamRatios);
  const meanInteriorRatio = mean(interiorRatios);
  console.log(`\n  Mean (compressed/raw) ratio at SEAMS (span-opening sentences, n=${seamRatios.length}): ${meanSeamRatio.toFixed(2)}`);
  console.log(`  Mean (compressed/raw) ratio at span-0 only (n=${interiorRatios.length}, no real predecessor to compare a seam against): ${meanInteriorRatio.toFixed(2)}`);
  console.log(`  ${meanSeamRatio > 1.3 ? "CONFIRMED: seam sentences score meaningfully MORE surprising under compression than in their true raw context — the predicted artifact is real." : meanSeamRatio < 0.8 ? "OPPOSITE of predicted: seams score LESS surprising compressed than raw — reported as found." : "No strong seam effect found at this threshold — reported as found, not forced."}\n`);
}

console.log("=".repeat(90));
console.log("SUMMARY");
console.log("=".repeat(90));
console.log(`Same real forward-surprise mechanism, same real text, one variable changed: full unbroken raw reading`);
console.log(`order vs. fold-compressed narrative-ordered-but-discontinuous spans. Whether compression helps, hurts, or`);
console.log(`is neutral to this specific task is reported above with real per-span numbers, not argued from architecture.`);
