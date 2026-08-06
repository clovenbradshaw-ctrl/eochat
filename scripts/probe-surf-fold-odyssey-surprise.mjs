#!/usr/bin/env node
// probe-surf-fold-odyssey-surprise.mjs — rebuild the "surf" trigger on what
// it should actually be built on: reader SURPRISE, not word occurrence, and
// surprise measured against a prior from OUTSIDE the text being read, walked
// forward sentence-by-sentence the way a reader actually encounters it.
//
// probe-surf-fold-odyssey.mjs's drill-down trigger was `text.includes(needle)`
// — a keyword grep. That is exactly the "flooding by occurrence" problem this
// whole exercise exists to get past, just done in miniature. This script
// replaces it with the organ this codebase already has for the real job
// (emergence/surprise/index.js::klDivergence + wordFrequencies, the same
// primitives summary/spine.js's significanceSpine is built from), but fixes
// what was wrong with using spine as-is: forwardScore's "expected"
// distribution is built ONLY from the same document's own preceding
// sentences — a self-referential prior. A reader's actual surprise comes
// from what they already know walking in (genre convention, formulaic
// diction, cultural background), which this text cannot supply about
// itself. This script builds that prior from a genuinely SEPARATE work —
// the Iliad, same author/tradition, same formulaic epic diction, fetched
// and cached independently — exactly the discipline scripts/derive-audio-
// prior.mjs's header already states for music: "The prior is derived from a
// DIFFERENT work than the one it will help compose... the documented
// corpus-prior dead end... applies to music exactly as it applies to text."
//
// The read is strictly sequential and forward-only (no lookahead, ever):
// one pass over the Odyssey's sentences in document order, each sentence's
// surprise measured against a BLEND of (a) the fixed external Iliad prior —
// "what a Homeric-literate reader already expects" — and (b) a decaying
// local window of the last N sentences actually read — "what's fresh in
// THIS reading right now," the same bounded-window mechanism spine.js
// already uses. That blend, walked forward, is the "activation based way
// the writer wants the content read" this probe is chasing: not a static
// whole-document batch score, not a keyword search, a moving prior that
// only ever sees what has already been read.
//
// Usage: node scripts/probe-surf-fold-odyssey-surprise.mjs

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
fs.mkdirSync(CACHE_DIR, { recursive: true });

function teiToPlainText(xml, title) {
  // Attribute order and case are NOT stable across Perseus TEI files: the
  // Odyssey has `<div n="1" type="textpart" subtype="book">`, the Iliad has
  // `<div type="textpart" subtype="Book" n="1">` (different order, "Book"
  // capitalized). Matching a rigid attribute sequence — which the earlier
  // Odyssey-only probe did — broke silently on the Iliad. Fixed here to be
  // order- and case-independent: match any <div ...> whose full attribute
  // string contains type="textpart" and subtype="book" (either case) in any
  // order, and pull n="..." out separately.
  const openRe = /<div\b([^>]*)>/g;
  const lineRe = /<l\b[^>]*>([\s\S]*?)<\/l>/g;
  const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const opens = [];
  let dm;
  while ((dm = openRe.exec(xml))) {
    const attrs = dm[1];
    if (!/type="textpart"/i.test(attrs) || !/subtype="book"/i.test(attrs)) continue;
    const nMatch = attrs.match(/\bn="(\d+)"/);
    if (!nMatch) continue;
    opens.push({ n: nMatch[1], start: dm.index + dm[0].length });
  }
  if (opens.length === 0) throw new Error(`teiToPlainText matched 0 books for ${title}`);
  const out = [title, ""];
  let lineCount = 0;
  for (let i = 0; i < opens.length; i++) {
    const end = i + 1 < opens.length ? opens[i + 1].start : xml.length;
    const bookXml = xml.slice(opens[i].start, end);
    out.push(`\n[BOOK ${opens[i].n}]`);
    let lm; lineRe.lastIndex = 0;
    while ((lm = lineRe.exec(bookXml))) { const t = stripTags(lm[1]); if (t) { out.push(t); lineCount++; } }
  }
  return { text: out.join("\n"), bookCount: opens.length, lineCount };
}

async function ensureCached(cachePath, url, title) {
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8");
  console.log(`Fetching ${title}: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${title}: ${res.status}`);
  const xml = await res.text();
  const { text, bookCount, lineCount } = teiToPlainText(xml, title);
  fs.writeFileSync(cachePath, text, "utf8");
  console.log(`  cached ${bookCount} books, ${lineCount} lines -> ${path.relative(REPO_ROOT, cachePath)}`);
  return text;
}

const odysseyText = await ensureCached(
  path.join(CACHE_DIR, "odyssey-grc.txt"),
  "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/master/data/tlg0012/tlg002/tlg0012.tlg002.perseus-grc2.xml",
  "THE ODYSSEY OF HOMER"
);
const iliadText = await ensureCached(
  path.join(CACHE_DIR, "iliad-grc.txt"),
  "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/master/data/tlg0012/tlg001/tlg0012.tlg001.perseus-grc2.xml",
  "THE ILIAD OF HOMER"
);
console.log(`\nOdyssey: ${odysseyText.length.toLocaleString()} chars.  Iliad (EXTERNAL prior source, genuinely separate work): ${iliadText.length.toLocaleString()} chars.\n`);

// ── The external prior: derived ONLY from the Iliad, never touches the Odyssey ──
const externalDist = wordFrequencies(iliadText);
console.log(`External prior: ${externalDist.size.toLocaleString()} distinct word-forms from the Iliad alone.\n`);

// ── Mixing two probability distributions (both already sum to 1) ──
function mix(distA, weightA, distB, weightB) {
  const out = new Map();
  for (const [w, p] of distA) out.set(w, (out.get(w) ?? 0) + p * weightA);
  for (const [w, p] of distB) out.set(w, (out.get(w) ?? 0) + p * weightB);
  return out;
}

const WINDOW = 60; // same bound spine.js uses, for direct comparability

// One forward pass, one score per sentence, at a given external-prior weight
// alpha. alpha=0 reproduces spine.js's own within-text-only mechanism
// (recomputed here, not imported, so the SAME blend function produces both
// the baseline and the treatment — no risk of comparing apples to a
// differently-shaped baseline).
function scoreSequential(sentences, alpha) {
  const localWindow = [];
  const scores = new Array(sentences.length).fill(0);
  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i].text;
    if (text.split(/\s+/).filter(Boolean).length < 4) continue; // spine's minWords-style floor
    const unitDist = wordFrequencies(text);
    let localDist = new Map();
    if (localWindow.length > 0) {
      const combined = new Map();
      let total = 0;
      for (const h of localWindow) for (const [w, p] of wordFrequencies(h)) { combined.set(w, (combined.get(w) ?? 0) + p); total++; }
      for (const [w, p] of combined) localDist.set(w, p / total);
    }
    const blended = alpha >= 1
      ? externalDist
      : localWindow.length === 0
        ? externalDist // cold start: no local history yet, fall back to the external prior instead of spine's "self-entropy" special case — a reader never starts with zero priors
        : mix(externalDist, alpha, localDist, 1 - alpha);
    scores[i] = klDivergence(unitDist, blended);
    localWindow.push(text);
    if (localWindow.length > WINDOW) localWindow.shift();
  }
  return scores;
}

console.log("=".repeat(78));
console.log("Sequential, forward-only surprise over the FULL Odyssey — spine's own mechanism (alpha=0)");
console.log("vs. the same blend function with a genuine EXTERNAL (Iliad-derived) prior mixed in (alpha=0.5, alpha=1.0)");
console.log("=".repeat(78));

const sentences = splitSentences(odysseyText);
console.log(`${sentences.length.toLocaleString()} sentences, reading order, single forward pass.\n`);

const ALPHAS = [0, 0.5, 1.0];
const allScores = {};
for (const alpha of ALPHAS) {
  const t0 = Date.now();
  allScores[alpha] = scoreSequential(sentences, alpha);
  console.log(`alpha=${alpha} (${alpha === 0 ? "within-text only, spine-equivalent" : alpha === 1 ? "external Iliad prior only" : "blended"}) scored in ${Date.now() - t0}ms`);
}

// ── Where does Athena's Book-1 disguise line actually rank, under each scheme? ──
const mentesIdx = sentences.findIndex((s) => s.text.includes("Μέντ"));
console.log(`\nAthena's disguise-name line (contains "Μέντ") found at sentence index ${mentesIdx} of ${sentences.length}:`);
console.log(`  "${sentences[mentesIdx]?.text}"\n`);

for (const alpha of ALPHAS) {
  const scores = allScores[alpha];
  const ranked = scores.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const rank = ranked.findIndex((x) => x.i === mentesIdx);
  // rank is 0-indexed position in descending-surprise order (0 = most
  // surprising sentence in the document). "top N%" = rank/length; percentile
  // of surprise (higher = more surprising) = 100 * (1 - rank/length). These
  // are the same number stated two ways, not two different computations —
  // an earlier version of this line computed a second, inconsistent value.
  const topPct = rank >= 0 ? (100 * rank / ranked.length) : null;
  const percentile = rank >= 0 ? (100 - topPct) : null;
  console.log(`  alpha=${alpha}: score=${scores[mentesIdx]?.toFixed(3)}, rank ${rank >= 0 ? rank + 1 : "n/a"} of ${ranked.length} scored sentences` + (topPct != null ? ` (top ${topPct.toFixed(2)}% most surprising, i.e. ${percentile.toFixed(2)}th percentile of surprise)` : ""));
}

// ── Does the external prior also help the earlier real-vs-noise discrimination question? ──
// (probe-organs-real-deployment.mjs found spine's CV flat, real vs. word-
// shuffled, on this same text — diagnosed to Greek's inflectional sparsity
// making exact-token repetition rare regardless of order. Re-test with the
// external prior mixed in: does a bigger, independent vocabulary sample
// change that finding, or is the sparsity problem orthogonal to it?)
console.log("\n" + "=".repeat(78));
console.log("Does the external prior change the earlier real-vs-shuffled (CV) finding?");
console.log("=".repeat(78));

function mulberry32(seed) {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const words = odysseyText.split(/(\s+)/);
const idx = words.map((w, i) => i).filter((i) => i % 2 === 0);
const shuffled = shuffle(idx, mulberry32(84));
const noiseArr = words.slice();
for (let k = 0; k < idx.length; k++) noiseArr[idx[k]] = words[shuffled[k]];
const noiseSentences = splitSentences(noiseArr.join(""));

function cv(scores) {
  const s = scores.filter((x) => x > 0);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length || 1);
  return mean ? Math.sqrt(variance) / mean : 0;
}

for (const alpha of ALPHAS) {
  const realCv = cv(allScores[alpha]);
  const noiseCv = cv(scoreSequential(noiseSentences, alpha));
  console.log(`  alpha=${alpha}: real CV=${realCv.toFixed(3)}, word-shuffled CV=${noiseCv.toFixed(3)}, difference=${(realCv - noiseCv).toFixed(3)}`);
}

console.log(`\nSUMMARY`);
console.log(`This does not just search for a keyword — it computes forward, sequential, per-sentence surprise (KL`);
console.log(`divergence, the same primitive spine.js uses) against a moving blend of a genuine external prior (the`);
console.log(`Iliad, fetched and cached independently, never touching the Odyssey) and a decaying local-context window,`);
console.log(`read once, forward, in document order. Whether that ranks the real narrative turning point (Athena's`);
console.log(`disguise as Mentes) near the top, and whether the external prior changes the earlier flat-CV finding, are`);
console.log(`reported above as measured — not assumed to work because the theory sounds right.`);
