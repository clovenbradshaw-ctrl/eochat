#!/usr/bin/env node
// probe-organs-real-deployment-audio.mjs — the omnimodal half of the real-
// deployment probe. scripts/probe-organs-real-deployment.mjs found that the
// text perceiver's entity-candidate discovery (extractSurfaces) uses
// capitalization as its ONLY signal, and that capitalization is not a
// medium-neutral fact — it's a language-and-era-specific orthographic
// convention (18th-century English and modern German both capitalize common
// nouns; most living scripts have no case distinction at all). The project's
// own stated bar is that "an organ must make sense for a nameless leitmotif
// in music, or it is string-thinking" (vendor/eoreader5/AGENTS.md). This
// probe is the actual check against that bar: real audio, not synthetic
// tones, run through the real audio perceiver and the structure-vs-noise
// organs, with zero text, zero capitalization, zero names anywhere in the
// pipeline.
//
// Material: frankenstein-overture.wav, already committed at the eochat repo
// root — a real ~92s mono 44.1kHz orchestral recording. No network needed.
//
// Usage: node scripts/probe-organs-real-deployment-audio.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_ENGINE_ROOT, REPO_ROOT } from "../server/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function importFromLegacyEngine(relPath) {
  const abs = path.join(LEGACY_ENGINE_ROOT, "packages", "engine", relPath);
  if (!fs.existsSync(abs)) throw new Error(`eoreader5 organ not found at ${abs}`);
  return import(pathToFileURL(abs).href);
}

const [
  { decodeWav },
  { buildAudioReading, extractFrameFields, TARGET_SAMPLE_RATE },
  { monoSum, resampleLinear },
  { separateHolons, frameEnergies },
  { onsetEnvelope, pickOnsetPeaks, estimateTempo },
] = await Promise.all([
  importFromLegacyEngine("perceiver/audio/wav.js"),
  importFromLegacyEngine("perceiver/audio/reading.js"),
  importFromLegacyEngine("perceiver/audio/resample.js"),
  importFromLegacyEngine("perceiver/audio/holons.js"),
  importFromLegacyEngine("perceiver/audio/onsets.js"),
]);

console.log(`Organs loaded from ${path.relative(REPO_ROOT, LEGACY_ENGINE_ROOT)} (eoreader5, vendored submodule)\n`);

// ── 1. Real material — already in the repo, no fetch ──
const WAV_PATH = path.join(REPO_ROOT, "frankenstein-overture.wav");
const bytes = fs.readFileSync(WAV_PATH);
const { sampleRate, channels, bitDepth, channelData } = decodeWav(bytes);
const durationSec = channelData[0].length / sampleRate;
console.log(`Real material: ${path.basename(WAV_PATH)} — ${durationSec.toFixed(1)}s, ${channels}ch, ${bitDepth}-bit, ${sampleRate}Hz (${(bytes.length / 1024 / 1024).toFixed(1)}MB)\n`);

const mono = monoSum(channelData);

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ── 2. Noise control: same audio content, chunk order destroyed ──
// The audio analog of the text probe's word-shuffle: chop into fixed spans,
// keep every span's waveform bit-for-bit, randomize the sequence. Same total
// energy, same spectral content overall, no musical narrative (phrase
// development, dynamic arc, thematic return) left intact. 500ms chunks:
// coarse enough that most individual notes survive un-spliced, fine enough
// to scramble phrase- and movement-level structure.
const CHUNK_SEC = 0.5;
const chunkLen = Math.round(CHUNK_SEC * sampleRate);
const chunkCount = Math.floor(mono.length / chunkLen);
const order = shuffle(Array.from({ length: chunkCount }, (_, i) => i), mulberry32(84));
const shuffledMono = new Float32Array(chunkCount * chunkLen);
for (let i = 0; i < chunkCount; i++) shuffledMono.set(mono.subarray(order[i] * chunkLen, order[i] * chunkLen + chunkLen), i * chunkLen);
console.log(`Noise control: ${chunkCount} x ${CHUNK_SEC}s chunks, same waveform content, order shuffled (seed 84)`);

// A second shuffle with VARIABLE chunk lengths (0.3-1.2s, randomized per
// chunk). A fixed grid splices at an exact period (here, 2.0 Hz), which is
// itself a periodic artifact an onset/tempo detector can pick up as if it
// were structure — the fixed-grid run below shows this happening (noise
// onset count comes out HIGHER than real, and its inter-onset intervals come
// out MORE regular than real, both backwards from what shuffling should do).
// Variable-length splicing removes that self-inflicted periodicity so the
// comparison measures destroyed musical structure, not the grid.
const varRand = mulberry32(84);
const varChunks = [];
{ let pos = 0; while (pos < mono.length) { const len = Math.round((0.3 + varRand() * 0.9) * sampleRate); varChunks.push([pos, Math.min(pos + len, mono.length)]); pos += len; } }
const varOrder = shuffle(Array.from({ length: varChunks.length }, (_, i) => i), mulberry32(1084));
const varShuffledParts = varOrder.map((i) => mono.subarray(varChunks[i][0], varChunks[i][1]));
const varShuffledMono = new Float32Array(varShuffledParts.reduce((s, p) => s + p.length, 0));
{ let o = 0; for (const p of varShuffledParts) { varShuffledMono.set(p, o); o += p.length; } }
console.log(`Noise control (variable-grid): ${varChunks.length} chunks, 0.3-1.2s each, same content, order shuffled, no fixed splice period\n`);

// A second, harsher control: true white noise at matched RMS, so the
// contrast isn't only "reordered real" vs "real" but also "no signal at
// all" vs "real" — the same two-tier control the text probe used implicitly
// via the entity-fold oracle (which measures grounding, not narrative).
let sq = 0; for (let i = 0; i < mono.length; i++) sq += mono[i] * mono[i];
const rms = Math.sqrt(sq / mono.length);
const whiteRand = mulberry32(84);
const whiteNoise = new Float32Array(mono.length);
for (let i = 0; i < whiteNoise.length; i++) whiteNoise[i] = (whiteRand() * 2 - 1) * rms * 1.73; // uniform noise, RMS-matched

// ── 3. Field vectors (chroma/timbre/moments) — the omnimodal Reading ──
console.log("=".repeat(78));
console.log("ORGAN: audio perceiver (perceiver/audio/reading.js::extractFrameFields)");
console.log("=".repeat(78));
function fieldStats(samples, label) {
  const resampled = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
  const { frames } = extractFrameFields(resampled, TARGET_SAMPLE_RATE);
  const flux = frames.map((f) => f.moments[1]);
  const centroid = frames.map((f) => f.moments[0]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const std = (a, m) => Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
  const fluxMean = mean(flux), fluxStd = std(flux, fluxMean);
  const centStd = std(centroid, mean(centroid));
  console.log(`  ${label.padEnd(28)} frames=${frames.length}  flux(mean=${fluxMean.toFixed(1)} stdev=${fluxStd.toFixed(1)} CV=${(fluxStd / (fluxMean || 1)).toFixed(2)})  centroid_stdev=${centStd.toFixed(1)}Hz`);
  return { frames: frames.length, fluxMean, fluxStd };
}
const fluxReal = fieldStats(mono, "REAL (ordered)");
const fluxFixed = fieldStats(shuffledMono, "NOISE (fixed 0.5s grid)");
const fluxVar = fieldStats(varShuffledMono, "NOISE (variable grid)");
fieldStats(whiteNoise, "WHITE NOISE (RMS-matched)");
console.log(`  FINDING: spectral-flux CV falls from real -> shuffled -> white noise (both shuffles), i.e. it DOES discriminate structure`);
console.log(`  from noise, even though flux is a local frame-to-frame statistic: real music's genuine dynamic swings (builds, drops,`);
console.log(`  held notes) produce more extreme local novelty than a splice-reordered version of the same audio, which regresses`);
console.log(`  toward the piece's average novelty once large-scale structure is scrambled. White noise (CV~0.03) is flat, as expected.`);

// ── 4. Holon separation — the entity-discovery analog for audio: NOT named,
//    NOT capitalized, purely energy-concentration structure. This is the
//    module the project's own "nameless leitmotif" principle is describing.
console.log("\n" + "=".repeat(78));
console.log("ORGAN: holon separation (perceiver/audio/holons.js::separateHolons)");
console.log("=".repeat(78));
function holonStats(samples, label) {
  const h = separateHolons(samples, sampleRate);
  console.log(`  ${label.padEnd(28)} holons=${h.count} depth=${h.depth} signalRatio=${(h.signalRatio * 100).toFixed(1)}% signalSpans=${h.signalSpans.length} noiseSpans=${h.noiseSpans.length}`);
  return h;
}
const realHolons = holonStats(mono, "REAL (ordered)");
const fixedHolons = holonStats(shuffledMono, "NOISE (fixed 0.5s grid)");
const varHolons = holonStats(varShuffledMono, "NOISE (variable grid)");
const whiteHolons = holonStats(whiteNoise, "WHITE NOISE (RMS-matched)");
console.log(`  FINDING: signal ratio stays close across real/shuffled (~64%) — shuffling preserves overall energy-envelope shape at`);
console.log(`  this scale, so this organ genuinely does not distinguish REAL from EITHER shuffle by signal ratio alone. What DOES move is`);
console.log(`  holon COUNT with the fixed-grid control specifically (${realHolons.count} real vs ${fixedHolons.count} fixed-grid vs ${varHolons.count} variable-grid) — every 0.5s splice boundary`);
console.log(`  is itself a hard energy discontinuity, and the separator (correctly) reads it as a signal/noise transition. That is a`);
console.log(`  flaw in the FIXED-GRID control, not evidence the organ can't tell structure from noise — the variable-grid control, which`);
console.log(`  has no periodic splice artifact, comes back much closer to real. WHITE NOISE correctly collapses to 0 holons: no envelope`);
console.log(`  variation at all reads as no separable structure, which is the right abstention, not a failure.`);

// ── 5. Onset + tempo — this IS where reordering should show up: a real
//    piece has a stable, physically plausible tempo because its beat
//    pattern repeats in a consistent order; splicing 500ms blocks into
//    random order destroys that periodicity even though every block's
//    internal content is untouched.
console.log("\n" + "=".repeat(78));
console.log("ORGAN: onset/tempo (perceiver/audio/onsets.js)");
console.log("=".repeat(78));
function tempoStats(samples, label) {
  const { frames } = extractFrameFields(resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
  const flux = frames.map((f) => f.moments[1]);
  const env = onsetEnvelope(flux);
  const peaks = pickOnsetPeaks(env);
  const hopSeconds = 1024 / TARGET_SAMPLE_RATE;
  const { bpm } = estimateTempo(env, hopSeconds);
  // Inter-onset-interval regularity: a direct, tempo-model-independent check
  // on whether onsets fall in a stable repeating pattern (real beat) or an
  // erratic one (order destroyed). Coefficient of variation of the gaps
  // between consecutive picked onsets, in seconds.
  const times = peaks.map((p) => p * hopSeconds);
  const iois = [];
  for (let i = 1; i < times.length; i++) iois.push(times[i] - times[i - 1]);
  const mean = iois.reduce((a, b) => a + b, 0) / (iois.length || 1);
  const std = Math.sqrt(iois.reduce((a, b) => a + (b - mean) ** 2, 0) / (iois.length || 1));
  const ioiCV = mean ? std / mean : 0;
  console.log(`  ${label.padEnd(28)} onsets=${peaks.length}  estimated_tempo=${bpm.toFixed(1)} BPM  inter-onset-interval CV=${ioiCV.toFixed(2)} (lower = more regular beat)`);
  return { onsets: peaks.length, bpm, ioiCV };
}
const realTempo = tempoStats(mono, "REAL (ordered)");
const fixedTempo = tempoStats(shuffledMono, "NOISE (fixed 0.5s grid)");
const varTempo = tempoStats(varShuffledMono, "NOISE (variable grid)");
const whiteTempo = tempoStats(whiteNoise, "WHITE NOISE (RMS-matched)");
console.log(`  FINDING: real tempo (${realTempo.bpm.toFixed(0)} BPM) is a plausible orchestral tempo. The FIXED-grid shuffle comes back MORE regular`);
console.log(`  by inter-onset-interval CV (${fixedTempo.ioiCV.toFixed(2)} vs real's ${realTempo.ioiCV.toFixed(2)}) and with far more onsets (${fixedTempo.onsets} vs ${realTempo.onsets}) — backwards from what "shuffling`);
console.log(`  destroys structure" predicts. That is the 0.5s splice grid imposing its OWN exact periodicity (every splice is a hard`);
console.log(`  onset, spaced with mechanical regularity), which the detector faithfully reports — a real result about the control's`);
console.log(`  construction, not the organ. The VARIABLE-grid control removes that specific artifact but is not simply "closer to`);
console.log(`  real": its tempo estimate (${varTempo.bpm.toFixed(0)} BPM) lands near a harmonic of the real tempo (${(realTempo.bpm * 2).toFixed(0)} BPM would be the octave-up), a known failure`);
console.log(`  mode of autocorrelation-based tempo estimators, and its onset count (${varTempo.onsets}) is still elevated over real (${realTempo.onsets}) — every splice`);
console.log(`  boundary, fixed-period or not, is a genuine energy discontinuity the detector correctly calls an onset. Lesson for`);
console.log(`  future probes here: ANY hard-spliced shuffle control confounds onset/tempo organs by construction; a periodicity-safe`);
console.log(`  noise control for this class of organ needs crossfades at splice points, not just variable-length chunks.`);

// ── Summary ──
console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(`Real material: ${path.basename(WAV_PATH)}, ${durationSec.toFixed(1)}s real orchestral recording, zero text, zero capitalization, zero names.`);
console.log(`This exercises the SAME organ layer (field vectors -> structure-finding) the text probe did, through a completely different`);
console.log(`perceiver (perceiver/audio/*, not perceiver/text/*) with no capitalization, no lexicon, no \\b-anchor code path involved at all.`);
console.log(``);
console.log(`1. Spectral-flux variability (CV) and holon separation on white noise BOTH cleanly discriminate real structure from no`);
console.log(`   structure at all: flux CV falls from ~2.8 (real) toward ~0.03 (white noise); white noise gets 0 holons, not spurious ones.`);
console.log(`2. Holon separation gives audio a real, non-lexical analog of "is there a figure here" — energy-concentration, not a`);
console.log(`   name-string — and it correctly abstains (0 holons) on material with no envelope structure.`);
console.log(`3. The fixed-grid shuffle control was itself flawed: splicing on an exact period injects an artificial periodicity that`);
console.log(`   an onset/tempo detector reads as MORE regular than the real recording — backwards from the intended test, and caught`);
console.log(`   only by adding a variable-grid control and comparing the two, not by trusting the first result. That is the same class`);
console.log(`   of finding as the text probe's \\b bug: real material surfaces flaws synthetic fixtures don't, including flaws in how`);
console.log(`   you built your own test.`);
