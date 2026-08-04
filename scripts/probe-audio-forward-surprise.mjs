#!/usr/bin/env node
// probe-audio-forward-surprise.mjs — why stop at natural language? Text's
// significanceSpine (KL-divergence of a sentence's word distribution
// against a decaying local window of recently-read sentences, scored
// sequentially and forward-only) found a genuine narrative turning point in
// the Odyssey. The audio perceiver's own organs (spectral-flux CV, holon
// separation, onset/tempo) already showed CLEANER real-structure-vs-noise
// discrimination than text managed on Greek — but this investigation never
// built audio's own version of the forward-surprise MECHANISM itself, only
// separate structural organs. This does that directly: an audio-native
// forward-surprise detector, same architecture as significanceSpine (local
// decaying window, sequential, forward-only, no lookahead), scored over
// real continuous field vectors instead of discrete word counts.
//
// Text's forwardScore uses discrete KL-divergence because a sentence is
// naturally a BAG of many word-tokens. A single audio frame (~186ms) is not
// a bag of anything — it's one continuous 30-dim vector (12 chroma + 13
// timbre + 5 moments). The faithful analog of "KL-divergence against recent
// history" for a continuous signal is a local Gaussian model: track each
// dimension's running mean/variance over the last WINDOW frames, score a
// new frame's surprise as its summed per-dimension z-scored squared
// deviation (a diagonal-covariance Mahalanobis distance) — the same
// "how much does this depart from what recent context predicted" question,
// asked in the vocabulary continuous signals actually have.
//
// Run against: the real recording, AND the same three noise controls
// established in probe-organs-real-deployment-audio.mjs (fixed-grid shuffle,
// variable-grid shuffle, white noise) — so "does this discriminate real
// structure from noise" gets asked of the surprise MECHANISM itself, not
// just of the separate holon/onset organs already tested.
//
// Usage: node scripts/probe-audio-forward-surprise.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_ENGINE_ROOT, REPO_ROOT } from "../server/paths.js";

function importFromLegacyEngine(relPath) {
  const abs = path.join(LEGACY_ENGINE_ROOT, "packages", "engine", relPath);
  if (!fs.existsSync(abs)) throw new Error(`eoreader5 organ not found at ${abs}`);
  return import(pathToFileURL(abs).href);
}

const [
  { decodeWav },
  { extractFrameFields, TARGET_SAMPLE_RATE, HOP_SIZE },
  { monoSum, resampleLinear },
] = await Promise.all([
  importFromLegacyEngine("perceiver/audio/wav.js"),
  importFromLegacyEngine("perceiver/audio/reading.js"),
  importFromLegacyEngine("perceiver/audio/resample.js"),
]);

function mulberry32(seed) {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ── Real material ──
const WAV_PATH = path.join(REPO_ROOT, "frankenstein-overture.wav");
const bytes = fs.readFileSync(WAV_PATH);
const { sampleRate, channelData } = decodeWav(bytes);
const mono = monoSum(channelData);
const durationSec = mono.length / sampleRate;
console.log(`Real material: ${path.basename(WAV_PATH)}, ${durationSec.toFixed(1)}s.\n`);

// ── Noise controls, same construction as probe-organs-real-deployment-audio.mjs ──
const CHUNK_SEC = 0.5;
const chunkLen = Math.round(CHUNK_SEC * sampleRate);
const chunkCount = Math.floor(mono.length / chunkLen);
const fixedOrder = shuffle(Array.from({ length: chunkCount }, (_, i) => i), mulberry32(84));
const fixedShuffled = new Float32Array(chunkCount * chunkLen);
for (let i = 0; i < chunkCount; i++) fixedShuffled.set(mono.subarray(fixedOrder[i] * chunkLen, fixedOrder[i] * chunkLen + chunkLen), i * chunkLen);

const varRand = mulberry32(84);
const varChunks = [];
{ let pos = 0; while (pos < mono.length) { const len = Math.round((0.3 + varRand() * 0.9) * sampleRate); varChunks.push([pos, Math.min(pos + len, mono.length)]); pos += len; } }
const varOrder = shuffle(Array.from({ length: varChunks.length }, (_, i) => i), mulberry32(1084));
const varParts = varOrder.map((i) => mono.subarray(varChunks[i][0], varChunks[i][1]));
const varShuffled = new Float32Array(varParts.reduce((s, p) => s + p.length, 0));
{ let o = 0; for (const p of varParts) { varShuffled.set(p, o); o += p.length; } }

let sq = 0; for (let i = 0; i < mono.length; i++) sq += mono[i] * mono[i];
const rms = Math.sqrt(sq / mono.length);
const whiteRand = mulberry32(84);
const whiteNoise = new Float32Array(mono.length);
for (let i = 0; i < whiteNoise.length; i++) whiteNoise[i] = (whiteRand() * 2 - 1) * rms * 1.73;

// ── Audio-native forward-surprise: local Gaussian model, sequential, forward-only ──
//
// Two bugs caught in the first version of this function before trusting any
// result from it, the same discipline as every self-caught bug earlier in
// this investigation:
//
//   1. NO WARM-UP GUARD. Scoring began once 5 frames had accumulated — text's
//      significanceSpine explicitly warns against exactly this ("forward
//      surprise against an empty/thin history is inflated by construction...
//      a unit is scored only once h prior units have accumulated," its own
//      minHistory parameter). 5 frames is nowhere near enough to estimate a
//      30-dimensional variance reliably; the first run's #1 "peak" was
//      29,000x larger than #2 — a cold-start artifact, not a musical event.
//
//   2. ONE SHARED EPSILON FLOOR ACROSS DIMENSIONS OF WILDLY DIFFERENT SCALE.
//      Spectral flux runs in the hundreds; a chroma bin is much smaller. A
//      single 1e-6 variance floor is effectively zero for the small-scale
//      dimensions and lets an accidentally-low-variance window blow up the
//      z-score for any one dimension, dominating the summed score. Fixed by
//      flooring each dimension's variance at a small fraction of that
//      dimension's OWN variance over the whole recording (computed once,
//      upfront) instead of one constant for all 30 dimensions.
const WINDOW = 150; // ~28s of recent context at this hop/frame rate
const MIN_HISTORY = 60; // ~11s warm-up before any score is trusted
function audioForwardSurprise(samples, label) {
  const resampled = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
  const { frames } = extractFrameFields(resampled, TARGET_SAMPLE_RATE);
  const dims = 12 + 13 + 5;
  const vectors = frames.map((f) => [...f.chroma, ...f.timbre, ...f.moments]);

  // Global per-dimension variance, once, for a scale-appropriate floor.
  const globalMean = new Array(dims).fill(0);
  for (const v of vectors) for (let d = 0; d < dims; d++) globalMean[d] += v[d];
  for (let d = 0; d < dims; d++) globalMean[d] /= vectors.length;
  const globalVar = new Array(dims).fill(0);
  for (const v of vectors) for (let d = 0; d < dims; d++) globalVar[d] += (v[d] - globalMean[d]) ** 2;
  for (let d = 0; d < dims; d++) globalVar[d] = Math.max(globalVar[d] / vectors.length, 1e-9);
  const floors = globalVar.map((v) => v * 0.01); // 1% of this dimension's OWN global variance

  const window = [];
  const scores = new Array(vectors.length).fill(0);
  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];
    if (window.length >= MIN_HISTORY) {
      const mean = new Array(dims).fill(0), variance = new Array(dims).fill(0);
      for (const w of window) for (let d = 0; d < dims; d++) mean[d] += w[d];
      for (let d = 0; d < dims; d++) mean[d] /= window.length;
      for (const w of window) for (let d = 0; d < dims; d++) variance[d] += (w[d] - mean[d]) ** 2;
      for (let d = 0; d < dims; d++) variance[d] = Math.max(variance[d] / window.length, floors[d]);
      let score = 0;
      for (let d = 0; d < dims; d++) score += (vec[d] - mean[d]) ** 2 / variance[d];
      scores[i] = score / dims;
    }
    window.push(vec);
    if (window.length > WINDOW) window.shift();
  }
  const hopSeconds = HOP_SIZE / TARGET_SAMPLE_RATE;
  return { frames, scores, hopSeconds };
}

function report(samples, label) {
  const { frames, scores, hopSeconds } = audioForwardSurprise(samples, label);
  const valid = scores.filter((s) => s > 0);
  const mean = valid.reduce((a, b) => a + b, 0) / (valid.length || 1);
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / (valid.length || 1);
  const cv = mean ? Math.sqrt(variance) / mean : 0;
  const ranked = scores.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  console.log(`  ${label.padEnd(28)} frames=${frames.length}  mean=${mean.toFixed(2)}  CV=${cv.toFixed(2)}  top score=${ranked[0]?.s.toFixed(2)} at t=${(ranked[0]?.i * hopSeconds).toFixed(1)}s`);
  return { frames, scores, hopSeconds, ranked, cv };
}

console.log("=".repeat(78));
console.log("Audio-native forward-surprise (local Gaussian model over real field vectors), real vs. noise controls");
console.log("=".repeat(78));
const real = report(mono, "REAL (ordered)");
const fixedNoise = report(fixedShuffled, "NOISE (fixed 0.5s grid)");
const varNoise = report(varShuffled, "NOISE (variable grid)");
const white = report(whiteNoise, "WHITE NOISE (RMS-matched)");

console.log(`\nFINDING: real CV=${real.cv.toFixed(2)} vs fixed-grid noise CV=${fixedNoise.cv.toFixed(2)} vs variable-grid noise CV=${varNoise.cv.toFixed(2)} vs white noise CV=${white.cv.toFixed(2)}.`);
console.log(real.cv > varNoise.cv
  ? `Real audio IS more variable in local surprise than its variable-grid-shuffled counterpart — this mechanism discriminates`
  : `Real audio is NOT more variable than its shuffled counterpart by this measure — reported as found, not adjusted to fit.`);

// ── What IS the top real-audio surprise moment, concretely? ──
console.log("\n" + "=".repeat(78));
console.log("The top 5 real-audio surprise peaks — with the underlying acoustic features at each, for a sanity check");
console.log("=".repeat(78));
const { frames: realFrames, hopSeconds } = audioForwardSurprise(mono, "real");
real.ranked.slice(0, 5).forEach((p, rank) => {
  const f = realFrames[p.i];
  const t = p.i * hopSeconds;
  const rmsFeature = f.moments[4]; // computeMoments returns [centroid, flux, rolloff, flatness, rms]
  const centroid = f.moments[0];
  console.log(`  #${rank + 1} t=${t.toFixed(1)}s  surprise=${p.s.toFixed(2)}  RMS=${rmsFeature.toFixed(4)}  spectral_centroid=${centroid.toFixed(0)}Hz`);
});
console.log(`\n(RMS/centroid at each peak are reported as an honest, numeric sanity check on whether these moments correspond to`);
console.log(`something real — a genuine dynamic or timbral event, not this script's own artifact — without needing to listen`);
console.log(`to the file directly. A peak with unremarkable RMS/centroid relative to its neighbors would be worth doubting.)`);

// Compare adjacent-frame RMS to spot whether top peaks coincide with real
// dynamic events (a jump in RMS relative to the few frames just before).
console.log(`\nDynamic-jump cross-check at each peak (RMS this frame vs. mean RMS of the preceding 20 frames):`);
real.ranked.slice(0, 5).forEach((p, rank) => {
  const start = Math.max(0, p.i - 20);
  const prevRms = realFrames.slice(start, p.i).reduce((a, f) => a + f.moments[4], 0) / Math.max(1, p.i - start);
  const curRms = realFrames[p.i].moments[4];
  const jump = prevRms > 0 ? curRms / prevRms : null;
  console.log(`  #${rank + 1} t=${(p.i * hopSeconds).toFixed(1)}s  RMS jump vs. preceding 20 frames = ${jump ? jump.toFixed(2) + "x" : "n/a"}`);
});

console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`Built audio's own forward-surprise mechanism — same sequential, forward-only, local-window-relative design as`);
console.log(`text's significanceSpine, expressed in the vocabulary a continuous signal actually has (a local Gaussian model`);
console.log(`instead of discrete word counts) rather than forcing text's exact machinery onto audio. Whether it discriminates`);
console.log(`real structure from noise, and what its top real peaks actually correspond to acoustically, are reported above`);
console.log(`with real numbers from the one real recording available in this environment — not assumed from the architecture`);
console.log(`alone, the same discipline as every other probe in this investigation.`);
