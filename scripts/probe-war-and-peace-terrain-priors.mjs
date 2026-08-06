#!/usr/bin/env node
// probe-war-and-peace-terrain-priors.mjs — real material, real organs: fold
// War and Peace from the Paradigm terrain DOWN to the Entity terrain for
// five real named characters, then test whether two OTHER real novels used
// as external priors sharpen or dilute what that fold surfaces.
//
// This is a direct extension of two existing investigations, not a fresh
// claim built from nothing:
//
//   1. vendor/eoreader5/CLAUDE.md's own "Measured dead ends" section
//      documents THREE independent attempts to derive a reader-salience
//      prior from other text, all of which "collapse toward the text, by
//      way of vocabulary" — a prior computed from what texts contain can
//      only be a statement about what texts contain. That finding was made
//      on Moby-Dick/Melville/Doyle material, never on War and Peace, and
//      never framed against the 9-terrain ladder specifically.
//   2. eochat's ORGAN-STACK-REAL-DEPLOYMENT.md ran the analogous test on the
//      real Odyssey (Iliad = same-tradition prior, Herodotus = unrelated
//      prior, then a 13-work aggregate): same-tradition priors measurably
//      WORSENED both entity-level surprise ranking and structural boundary
//      detection; a genuinely unrelated prior was competitive but never
//      clearly beat the within-text baseline; and the "relatedness predicts
//      performance" story that looked clean at N=3 collapsed to a
///      near-zero correlation at N=13 (scripts/select-best-priors.mjs).
//
// Both findings point the same direction. This probe does NOT assume they
// generalize a third time — it reruns the same discipline (real texts, a
// same-tradition prior AND a genuinely unrelated prior, kept strictly on
// the scoring side, real quoted evidence) on a different subject text and a
// different target signal (the 9-terrain ladder in
// emergence/summary/fold-field-surfer.js, Void..Paradigm, instead of raw
// forward-surprise) to see whether the dead end holds a third time or the
// terrain framing changes the answer.
//
// Texts (all real, fetched from Project Gutenberg, cached locally):
//   - War and Peace, tr. Louise & Aylmer Maude, Gutenberg #2600 — the SAME
//     source pg2600 already pinned as sourcePath in this repo's own
//     priors/coref/war-and-peace.json, and the SAME book cube/index.js's own
//     header cites as the case that broke the old first-match-wins
//     classifier (99.2% of frames landing Void/Entity, Atmosphere/Lens/
//     Paradigm structurally unreachable) and motivated the scored-amplitude
//     rewrite this probe now exercises for real.
//   - Anna Karenina, Gutenberg #1399 — SAME author/tradition prior (the
//     Iliad's role in the Odyssey probe).
//   - Middlemarch, Gutenberg #145 (George Eliot) — a genuinely UNRELATED
//     prior: different author, different nation, no shared characters or
//     plot, but a comparable era and form (Herodotus's role in the Odyssey
//     probe: distant enough that a naive frequency blend does not just
//     dilute local contrast with near-identical diction).
//
// Character cast and every name/surface below is copied VERBATIM from this
// repo's own priors/coref/war-and-peace.json (grep-verified against the
// pg2600 text per that file's own stated discipline) — reused, not
// reinvented. Presence detection here is a simple substring match on those
// names, NOT the full admitReferent/individuation pipeline that file exists
// to feed — stated plainly because that pipeline resolves pronouns and
// descriptor aliases this probe's simple match will miss, and because the
// coref file's own "KNOWN GAPS" (bare-surname ambiguity) apply here too.
//
// Usage: node scripts/probe-war-and-peace-terrain-priors.mjs

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
  { classifyAmplitudes },
  { frameText, splitSentences },
  { wordFrequencies, klDivergence },
  { significanceSpine },
] = await Promise.all([
  importFromLegacyEngine("cube/index.js"),
  importFromLegacyEngine("emergence/summary/text-organ.js"),
  importFromLegacyEngine("emergence/surprise/index.js"),
  importFromLegacyEngine("emergence/summary/spine.js"),
]);

const TERRAIN_LADDER = ["Void", "Entity", "Kind", "Field", "Link", "Network", "Atmosphere", "Lens", "Paradigm"];
const TOP_DOWN = [...TERRAIN_LADDER].reverse(); // Paradigm first, per the user's ask

const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

function stripGutenberg(raw, label) {
  const startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
  const endRe = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
  const s = raw.indexOf(raw.match(startRe)?.[0] ?? "");
  const e = raw.search(endRe);
  if (s < 0 || e < 0 || e <= s) throw new Error(`${label}: could not find Gutenberg START/END markers`);
  const startIdx = s + (raw.match(startRe)?.[0].length ?? 0);
  return raw.slice(startIdx, e).trim();
}

async function ensureGutenberg(id, filename, label) {
  const cachePath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8");
  const url = `https://www.gutenberg.org/files/${id}/${id}-0.txt`;
  console.log(`Fetching ${label}: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${label}: ${res.status}`);
  const raw = await res.text();
  const text = stripGutenberg(raw, label);
  fs.writeFileSync(cachePath, text, "utf8");
  console.log(`  cached ${text.length.toLocaleString()} chars -> ${path.relative(REPO_ROOT, cachePath)}`);
  return text;
}

const warAndPeace = await ensureGutenberg(2600, "war-and-peace-en.txt", "War and Peace (Maude translation, pg2600)");
const annaKarenina = await ensureGutenberg(1399, "anna-karenina-en.txt", "Anna Karenina (pg1399) — SAME-tradition prior");
const middlemarch = await ensureGutenberg(145, "middlemarch-en.txt", "Middlemarch (pg145) — UNRELATED prior");

console.log(`\nWar and Peace (subject text): ${warAndPeace.length.toLocaleString()} chars`);
console.log(`Anna Karenina (same-author/tradition prior): ${annaKarenina.length.toLocaleString()} chars`);
console.log(`Middlemarch (unrelated prior): ${middlemarch.length.toLocaleString()} chars\n`);

// Cast copied verbatim from priors/coref/war-and-peace.json — five entities
// chosen to span the book's own register range: Pierre's arc is explicitly
// a search for meaning (a Paradigm-terrain claim worth testing for real,
// not assuming); Napoleon and Kutúzov are historical/military figures
// (Network-terrain candidates); Natásha and Andrew span the domestic/
// romantic and the philosophical-crisis registers respectively.
const CAST = [
  { id: "pierre", display: "Pierre Bezúkhov", names: ["Pierre"] },
  { id: "andrew", display: "Prince Andrew Bolkónski", names: ["Andrew", "Prince Andrew"] },
  { id: "natasha", display: "Natásha Rostóva", names: ["Natásha"] },
  { id: "napoleon", display: "Napoleon Bonaparte", names: ["Napoleon"] },
  { id: "kutuzov", display: "Field Marshal Kutúzov", names: ["Kutúzov"] },
];

const roughTokens = (chars) => Math.round(chars / 4);

// ══════════════════════════════════════════════════════════════════════════
// PART 1 — TERRAIN LADDER, PARADIGM DOWN TO ENTITY, PER CHARACTER
// ══════════════════════════════════════════════════════════════════════════
console.log("=".repeat(78));
console.log("PART 1 — War and Peace, terrain ladder Paradigm -> Void, per character");
console.log("(classifyAmplitudes: the scored, uncollapsed fold — cube/index.js)");
console.log("=".repeat(78));

const wpFrames = frameText(warAndPeace);
console.log(`\n${wpFrames.length.toLocaleString()} 2000-char frames (1000-char hop) across the real Maude translation.\n`);

// Book-wide baseline: the terrain profile of War and Peace itself, averaged
// over EVERY frame — this is the within-text prior every character's
// profile below gets compared against first, before any external novel.
function averageTerrainProfile(frames) {
  const sums = new Map(TERRAIN_LADDER.map((t) => [t, 0]));
  for (const f of frames) {
    const amps = classifyAmplitudes(f.text).terrain;
    for (const a of amps) sums.set(a.label, sums.get(a.label) + a.amplitude);
  }
  const n = frames.length || 1;
  return new Map([...sums].map(([t, s]) => [t, s / n]));
}

console.log(`Computing War and Peace's own book-wide terrain baseline (${wpFrames.length.toLocaleString()} frames)...`);
const wpBaseline = averageTerrainProfile(wpFrames);

function bar(amplitude, width = 30) {
  const n = Math.round(amplitude * width * 4); // *4: amplitudes are small fractions of 9 terrains
  return "#".repeat(Math.min(width, n)).padEnd(width, ".");
}

console.log("\nWar and Peace, whole-book terrain baseline (Paradigm -> Void):");
for (const t of TOP_DOWN) {
  console.log(`  ${t.padEnd(10)} ${bar(wpBaseline.get(t))} ${(wpBaseline.get(t) * 100).toFixed(2)}%`);
}

const castFrames = {};
const castProfiles = {};
for (const c of CAST) {
  const present = wpFrames.filter((f) => c.names.some((n) => f.text.includes(n)));
  castFrames[c.id] = present;
  castProfiles[c.id] = averageTerrainProfile(present);
  console.log(`\n${"-".repeat(78)}`);
  console.log(`${c.display} — present in ${present.length} of ${wpFrames.length} frames (${(present.length / wpFrames.length * 100).toFixed(1)}%)`);
  console.log(`Terrain profile, Paradigm -> Void, vs. the book's own baseline in parentheses:`);
  for (const t of TOP_DOWN) {
    const v = castProfiles[c.id].get(t);
    const base = wpBaseline.get(t);
    const delta = base > 0 ? ((v - base) / base * 100) : 0;
    const sign = delta >= 0 ? "+" : "";
    console.log(`  ${t.padEnd(10)} ${bar(v)} ${(v * 100).toFixed(2)}%  (book baseline ${(base * 100).toFixed(2)}%, ${sign}${delta.toFixed(0)}%)`);
  }
  // Real quoted evidence for this character's single highest-Paradigm frame
  // and single highest-Lens frame — the two rarest, highest rungs.
  for (const terrain of ["Paradigm", "Lens"]) {
    let best = null, bestAmp = -1;
    for (const f of present) {
      const amps = classifyAmplitudes(f.text).terrain;
      const a = amps.find((x) => x.label === terrain)?.amplitude ?? 0;
      if (a > bestAmp) { bestAmp = a; best = f; }
    }
    if (best && bestAmp > 0) {
      const excerpt = best.text.replace(/\s+/g, " ").trim().slice(0, 220);
      console.log(`\n  Highest-${terrain} frame (amplitude ${bestAmp.toFixed(3)}, offset ${best.offset}):`);
      console.log(`    "${excerpt}..."`);
    } else {
      console.log(`\n  No ${terrain}-terrain signal found in any of ${c.display}'s ${present.length} present frames.`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PART 2 — OTHER NOVELS AS TERRAIN-PROFILE PRIORS
// ══════════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(78));
console.log("PART 2 — Anna Karenina + Middlemarch as priors: is War and Peace's own");
console.log("terrain profile, and each character's, distinctive or just what novels do?");
console.log("=".repeat(78));

const akFrames = frameText(annaKarenina);
const mmFrames = frameText(middlemarch);
console.log(`\nAnna Karenina: ${akFrames.length.toLocaleString()} frames. Middlemarch: ${mmFrames.length.toLocaleString()} frames.`);
console.log(`Computing each novel's own whole-book terrain baseline (same measurement as Part 1, different books)...\n`);
const akBaseline = averageTerrainProfile(akFrames);
const mmBaseline = averageTerrainProfile(mmFrames);

console.log(`${"terrain".padEnd(10)} ${"War&Peace".padEnd(10)} ${"AnnaK(same-trad)".padEnd(18)} ${"Middlemarch(unrel)".padEnd(19)}`);
for (const t of TOP_DOWN) {
  const w = wpBaseline.get(t) * 100, a = akBaseline.get(t) * 100, m = mmBaseline.get(t) * 100;
  console.log(`${t.padEnd(10)} ${w.toFixed(2).padEnd(10)} ${a.toFixed(2).padEnd(18)} ${m.toFixed(2).padEnd(19)}`);
}

console.log(`\nReading: if a terrain's War-and-Peace value sits inside the range the two OTHER real novels`);
console.log(`already occupy, that terrain's prevalence in W&P is not distinctive — it's what this classifier`);
console.log(`finds in realist prose generally, and reading it as a claim specific to Tolstoy or to this book`);
console.log(`would be a scope error of exactly the kind LAWS.md L7 exists to catch (see the terrain_report fix).`);

console.log(`\nPer-character check: is each character's departure from the W&P baseline (Part 1) ALSO larger than`);
console.log(`the natural book-to-book spread the two priors establish? (i.e. bigger than |AnnaK - Middlemarch|)`);
for (const c of CAST) {
  console.log(`\n${c.display}:`);
  for (const t of ["Paradigm", "Lens", "Atmosphere", "Network"]) {
    const charV = castProfiles[c.id].get(t);
    const wpV = wpBaseline.get(t);
    const spread = Math.abs(akBaseline.get(t) - mmBaseline.get(t));
    const charDelta = Math.abs(charV - wpV);
    const exceeds = charDelta > spread;
    console.log(`  ${t.padEnd(10)} character-vs-book delta=${(charDelta * 100).toFixed(3)}pp, natural book-to-book spread=${(spread * 100).toFixed(3)}pp -> ${exceeds ? "EXCEEDS natural spread (real character-level signal)" : "within natural book-to-book spread (not clearly distinctive)"}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PART 3 — SURPRISE-DRIVEN DRILL-DOWN for Pierre, three priors kept separate
// (same architecture as probe-unrelated-prior.mjs: local window vs.
// same-tradition external vs. unrelated external, never blended)
// ══════════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(78));
console.log("PART 3 — Pierre's highest-surprise moment: within-text baseline vs. Anna Karenina prior vs. Middlemarch prior");
console.log("=".repeat(78));

const wpSentences = splitSentences(warAndPeace);
const pierreSentenceIdx = wpSentences
  .map((s, i) => ({ i, present: s.text.includes("Pierre") }))
  .filter((x) => x.present)
  .map((x) => x.i);
console.log(`\n${wpSentences.length.toLocaleString()} sentences total; Pierre present (name match) in ${pierreSentenceIdx.length.toLocaleString()} of them.`);

const akDist = wordFrequencies(annaKarenina);
const mmDist = wordFrequencies(middlemarch);

function scoreLocalWindow(sentences, WINDOW = 60) {
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
function scoreAgainstFixedPrior(sentences, priorDist) {
  return sentences.map((s) => {
    if (s.text.split(/\s+/).filter(Boolean).length < 4) return 0;
    return klDivergence(wordFrequencies(s.text), priorDist);
  });
}

console.log(`\nScoring all ${wpSentences.length.toLocaleString()} sentences three separate ways (never blended)...`);
const localScores = scoreLocalWindow(wpSentences);
const akScores = scoreAgainstFixedPrior(wpSentences, akDist);
const mmScores = scoreAgainstFixedPrior(wpSentences, mmDist);

function topWithin(scores, idxSet, label) {
  let best = -1, bestI = -1;
  for (const i of idxSet) if (scores[i] > best) { best = scores[i]; bestI = i; }
  const excerpt = wpSentences[bestI]?.text.replace(/\s+/g, " ").trim().slice(0, 200);
  const terrain = classifyAmplitudes(wpSentences[bestI]?.text ?? "").terrain[0];
  console.log(`\n  ${label}`);
  console.log(`    score=${best.toFixed(3)} sentence#${bestI} dominant-terrain=${terrain.label} (amp ${terrain.amplitude.toFixed(3)})`);
  console.log(`    "${excerpt}..."`);
  return bestI;
}

const localTop = topWithin(localScores, pierreSentenceIdx, "Within-text local-window baseline (validated mechanism, no external prior):");
const akTop = topWithin(akScores, pierreSentenceIdx, "Anna Karenina prior (SAME-tradition, same author):");
const mmTop = topWithin(mmScores, pierreSentenceIdx, "Middlemarch prior (UNRELATED — different author/nation):");

console.log(`\n${localTop === akTop && akTop === mmTop ? "All three methods agree on the same sentence." : "The three methods pick DIFFERENT top sentences — reported honestly, not reconciled."}`);

// ══════════════════════════════════════════════════════════════════════════
// SUMMARY — connect back to the codebase's own prior findings
// ══════════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`vendor/eoreader5/CLAUDE.md's "Measured dead ends" and eochat's ORGAN-STACK-REAL-DEPLOYMENT.md both`);
console.log(`already found that a prior derived from OTHER text collapses toward vocabulary and does not reliably`);
console.log(`beat a within-text baseline (Odyssey: same-tradition Iliad prior measurably WORSENED ranking; a`);
console.log(`genuinely unrelated Herodotus prior was competitive but never clearly won; the relatedness-predicts-`);
console.log(`performance story collapsed at N=13). This probe reruns that same test a third way — on a different`);
console.log(`subject text (War and Peace, not the Odyssey), against the 9-TERRAIN ladder rather than raw`);
console.log(`forward-surprise — and Part 3's numbers above show directly whether it reproduces, complicates, or`);
console.log(`diverges from that finding on this run. Part 2's book-to-book comparison is the one genuinely NEW`);
console.log(`use of "other novels as priors" here: not as a scoring blend (already tested, already found weak),`);
console.log(`but as a control group that tells you whether a terrain's prevalence is Tolstoy-specific or just`);
console.log(`what the classifier finds in realist prose generally — a distinction Part 2's exceeds/within-spread`);
console.log(`lines above answer with real numbers, not by assumption.`);
