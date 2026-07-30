#!/usr/bin/env node
// Derive a MOTION PRIOR from real audio.
//
// This is the omnimodal case in its hardest form: a recording has no names, no
// stable surfaces, nothing to string-match. What can be recovered is motion —
// how a line moves, how long its notes last — and that is exactly the kind of
// witness knowledge a prior is supposed to carry.
//
// Discipline this file is built to respect:
//
//   The prior is derived from a DIFFERENT work than the one it will help
//   compose. A prior computed from the thing being written can only be a
//   statement about the thing being written — that is the documented corpus-
//   prior dead end, and it applies to music exactly as it applies to text.
//
//   The method is stated with its weaknesses in the artifact itself, and low-
//   confidence frames become a typed gap rather than a quietly-included guess.
//   Monophonic pitch tracking over POLYPHONIC orchestral audio recovers a
//   dominant line at best; claiming otherwise would be the fabrication this
//   project treats as the cardinal regression.
//
// Usage: node scripts/derive-audio-prior.mjs <pcm-file> <out.json> [--sr 8000] [--label "..."] [--source "..."]

import fs from "node:fs";

const args = process.argv.slice(2);
const pcmPath = args[0];
const outPath = args[1];
const argOf = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const SR = Number(argOf("sr", 8000));
const LABEL = argOf("label", "unnamed recording");
const SOURCE = argOf("source", pcmPath);

if (!pcmPath || !outPath) {
  console.error("usage: derive-audio-prior.mjs <pcm-file> <out.json> [--sr N] [--label L] [--source S]");
  process.exit(1);
}

// ── Read mono s16le PCM ──
const raw = fs.readFileSync(pcmPath);
const n = Math.floor(raw.length / 2);
const x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = raw.readInt16LE(i * 2) / 32768;
console.error(`read ${n} samples (${(n / SR).toFixed(1)}s @ ${SR}Hz)`);

// ── Frame-wise pitch detection (normalized autocorrelation) ──
//
// Not YIN, not a neural tracker — plain normalized autocorrelation with a
// clarity threshold. It is the honest floor: it finds a strong periodicity when
// one dominates and reports nothing when none does, which is the behaviour we
// want at a boundary where over-claiming would poison the prior.
const FRAME = 1024;
const HOP = 256;
const MIN_HZ = 55;   // ~A1
const MAX_HZ = 800;  // ~G5
const MIN_LAG = Math.floor(SR / MAX_HZ);
const MAX_LAG = Math.floor(SR / MIN_HZ);
const CLARITY_MIN = 0.62; // below this the frame is UNVOICED, not a guess

const frames = [];
let unvoiced = 0;

for (let start = 0; start + FRAME <= n; start += HOP) {
  // RMS gate: silence is not a pitch.
  let energy = 0;
  for (let i = 0; i < FRAME; i++) energy += x[start + i] * x[start + i];
  const rms = Math.sqrt(energy / FRAME);
  if (rms < 0.008) { frames.push(null); unvoiced++; continue; }

  let bestLag = -1, bestVal = 0;
  // r(0) once, reused as the normalizer.
  let r0 = 0;
  for (let i = 0; i < FRAME; i++) r0 += x[start + i] * x[start + i];

  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let acc = 0, e2 = 0;
    const lim = FRAME - lag;
    for (let i = 0; i < lim; i++) {
      acc += x[start + i] * x[start + i + lag];
      e2 += x[start + i + lag] * x[start + i + lag];
    }
    // Normalized so a loud low partial cannot outrank a clear fundamental.
    const norm = Math.sqrt(r0 * e2) || 1;
    const v = acc / norm;
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }

  if (bestVal < CLARITY_MIN || bestLag < 0) { frames.push(null); unvoiced++; continue; }
  const hz = SR / bestLag;
  // 69 = A4 = 440Hz. Pitch as a continuous MIDI number, no note NAME anywhere.
  frames.push({ midi: 69 + 12 * Math.log2(hz / 440), clarity: bestVal });
}

console.error(`frames ${frames.length}, unvoiced ${unvoiced} (${(100 * unvoiced / frames.length).toFixed(1)}%)`);

// ── Segment frames into notes ──
//
// A note is a run of frames holding the same pitch within a semitone. Runs
// shorter than MIN_FRAMES are discarded as tracker jitter rather than admitted
// as very short notes.
const MIN_FRAMES = 4; // ~128ms at hop 256 / 8kHz
const notes = [];
let run = [];
const flush = () => {
  if (run.length >= MIN_FRAMES) {
    const sorted = [...run].map((f) => f.midi).sort((a, b) => a - b);
    notes.push({
      midi: Math.round(sorted[Math.floor(sorted.length / 2)]), // median resists jitter
      frames: run.length,
      seconds: (run.length * HOP) / SR,
    });
  }
  run = [];
};
for (const f of frames) {
  if (!f) { flush(); continue; }
  if (run.length && Math.abs(f.midi - run[run.length - 1].midi) > 1.0) flush();
  run.push(f);
}
flush();

console.error(`notes ${notes.length}`);

// ── Histograms: motion and duration ──
//
// Motion is the interval BETWEEN consecutive notes in semitones. It is
// transposition-invariant by construction — which is what makes it a statement
// about how the music moves rather than about which pitches it happened to use.
// A prior keyed to absolute pitch would be naming things.
const motionCounts = new Map();
let leapsDropped = 0;
let octavesDropped = 0;
for (let i = 1; i < notes.length; i++) {
  const step = notes[i].midi - notes[i - 1].midi;
  // Intervals beyond an octave across a segmentation boundary are far more
  // likely tracker octave-errors than real leaps; excluded and COUNTED, not
  // silently dropped.
  if (Math.abs(step) > 12) { leapsDropped++; continue; }
  // EXACTLY an octave is the classic autocorrelation failure — the tracker
  // locks onto a harmonic or subharmonic and reports a jump the music never
  // made. Measured here: +12 and -12 came back as the 2nd and 3rd most common
  // "intervals" at 45 and 46 occurrences, which is not how orchestral lines
  // behave; it is how a periodicity detector behaves. Admitting them would
  // have made the composed music leap octaves constantly and called a tracker
  // artifact a property of the source.
  if (Math.abs(step) === 12) { octavesDropped++; continue; }
  motionCounts.set(step, (motionCounts.get(step) || 0) + 1);
}

// Durations quantized to a beat grid inferred from the median note length, so
// the prior carries proportion rather than absolute seconds.
const secs = notes.map((x) => x.seconds).sort((a, b) => a - b);
const medianSec = secs[Math.floor(secs.length / 2)] || 0.25;
const durCounts = new Map();
for (const nt of notes) {
  const beats = Math.max(0.5, Math.round((nt.seconds / medianSec) * 2) / 2);
  if (beats > 4) continue;
  durCounts.set(beats, (durCounts.get(beats) || 0) + 1);
}

const toWeighted = (m) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, weight]) => ({ value, weight }));

const gaps = [];
const unvoicedPct = (100 * unvoiced) / frames.length;
if (unvoicedPct > 50) {
  gaps.push(`${unvoicedPct.toFixed(1)}% of frames had no clear fundamental — this prior describes only the passages where one line dominated`);
}
if (leapsDropped) {
  gaps.push(`${leapsDropped} interval(s) exceeded an octave and were excluded as probable tracking errors, not admitted as leaps`);
}
if (octavesDropped) {
  gaps.push(`${octavesDropped} interval(s) were exactly +/-12 semitones and were excluded as autocorrelation octave errors — a periodicity detector locking onto a harmonic, not a line that leapt`);
}
if (notes.length < 200) {
  gaps.push(`only ${notes.length} notes segmented — the histogram is thin and should not be treated as characteristic of the work`);
}

const prior = {
  schema: "MotionPrior@1",
  id: "music-motion-overture",
  label: LABEL,
  // Provenance is the whole point: this says exactly how the numbers were got,
  // so nobody later mistakes a tracked approximation for a transcription.
  provenance: {
    basis: "derived",
    source: SOURCE,
    method: "normalized autocorrelation pitch tracking over monophonic-reduced audio",
    sample_rate: SR,
    frame: FRAME,
    hop: HOP,
    clarity_threshold: CLARITY_MIN,
    known_weakness:
      "the source is POLYPHONIC orchestral audio; monophonic tracking recovers a dominant line at best, " +
      "so this is a statement about salient motion, never a transcription",
    notes_segmented: notes.length,
    unvoiced_fraction: Number((unvoiced / frames.length).toFixed(4)),
  },
  // Semitone steps between consecutive notes, transposition-invariant.
  motion: toWeighted(motionCounts),
  // Durations in beats, relative to the median note length.
  duration: toWeighted(durCounts),
  gaps,
};

fs.writeFileSync(outPath, JSON.stringify(prior, null, 2));
console.error(`\nwrote ${outPath}`);
console.log(`notes ${notes.length} · motion classes ${prior.motion.length} · duration classes ${prior.duration.length}`);
console.log("top motion (semitones):", prior.motion.slice(0, 9).map((m) => `${m.value >= 0 ? "+" : ""}${m.value}:${m.weight}`).join("  "));
console.log("top durations (beats):", prior.duration.slice(0, 6).map((d) => `${d.value}:${d.weight}`).join("  "));
for (const g of gaps) console.log("gap:", g);
