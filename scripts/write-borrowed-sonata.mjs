#!/usr/bin/env node
// Music with borrowed form: material from a recording, structure from a book.
//
//   material  <- vendor/eoPriors/priors/music-motion-overture.json
//                (semitone motion + durations tracked from real orchestral audio)
//   form      <- Frankenstein's frame narrative, EARNED from narrator spans in
//                vendor/eoPriors/priors/coref/pg84-frankenstein.json
//
// Both halves come through the priors system. Neither is hand-typed here, and a
// missing prior is a typed gap that stops the run rather than a default that
// quietly invents a source.
//
// Usage: node scripts/write-borrowed-sonata.mjs [seed] [out-basename]

import fs from "node:fs";
import path from "node:path";
import { outlineOfText } from "../server/engine-ground.js";
import { loadMotionPrior, loadCorefPrior, earnNesting } from "../server/borrowed-form.js";
import { createTaskLog, append, projectTasks, deriveLevels, foldToWorkingSet, ENTRY_KINDS, OPERATOR_BASIS } from "../server/task-log.js";
import { makeNoiseFor } from "../server/sonata-material.js";
import { witnessAnanda } from "../server/sonata.js";
import { revisePass } from "../server/relisten.js";

const seed = Number(process.argv[2] || 20260729);
const base = process.argv[3] || "frankenstein-overture";
const TEXT = path.resolve("../pg84.txt");

// ── Priors ──
const { prior: motion, gap: motionGap } = loadMotionPrior("music-motion-overture");
const { prior: coref, gap: corefGap } = loadCorefPrior("pg84-frankenstein");
if (motionGap || corefGap) {
  console.error("GAP:", motionGap || corefGap);
  process.exit(1);
}
console.log(`material prior: ${motion.label}`);
console.log(`  ${motion.provenance.notes_segmented} notes tracked · ${motion.motion.length} motion classes · basis=${motion.provenance.basis}`);
for (const g of motion.gaps) console.log(`  gap: ${g}`);

// ── Form, earned from the text ──
const text = fs.readFileSync(TEXT, "utf8");
const sections = outlineOfText(text, { max: 60 }).headings;
const { nodes, spans, gaps: formGaps } = earnNesting(text, sections, coref);
console.log(`\nform: ${sections.length} sections · ${spans.length} narrator frames resolved · ${formGaps.length} gaps`);

// ── Into the log ──
//
// Operator is the production that brought each entry into being:
//   SEG  a section standing apart at its own depth
//   CON  a section that crosses a frame boundary — it relates two depths
//   SYN  a section at the outer frame AFTER an inner frame closed: it holds
//        only across what it contained, and cannot exist without it
let log = createTaskLog();
let deepestSeen = 0;
for (const n of nodes) {
  const prev = nodes[n.index - 1];
  const crossing = prev && prev.depth !== n.depth;
  deepestSeen = Math.max(deepestSeen, n.depth);
  const returning = n.depth === 0 && deepestSeen > 0;

  const operator = crossing ? "CON" : returning ? "SYN" : "SEG";
  log = append(log, {
    kind: ENTRY_KINDS.PROPOSE,
    task_id: `s${n.index}`,
    description: n.section.label,
    depends_on: n.depends_on_index != null ? [`s${n.depends_on_index}`] : [],
    operator,
    // Produced by the structure of the source, not declared by anyone.
    operator_basis: OPERATOR_BASIS.PRODUCED,
    depth: n.depth,
    narratedBy: n.narratedBy,
    extent: n.end - n.start,
  });
}

const tasks = projectTasks(log);
const { levels } = deriveLevels(tasks);

// ── The mouth ──
//
// 32 sections; a handful reaches sound.
//
// What to keep is the FORM, and the form of this book is outer -> inner ->
// outer. Ranking by extent alone (measured: `extent * (1 + depth)`) selected all
// six chapters of the creature's narrative and exactly one outer section, which
// is a faithful ranking of BULK and a poor rendering of SHAPE — the frame
// nearly disappeared, and a frame narrative with no frame is just a narrative.
//
// So the sections that CARRY the nesting are weighted up: the ones that cross a
// frame boundary (CON) or close over one (SYN) are where the structure actually
// happens. Extent still matters, it just no longer decides alone.
const structuralWeight = { CON: 6, SYN: 5, SEG: 1 };
const { working, withheld, withheld_ids } = foldToWorkingSet(tasks, {
  k: 7,
  score: (t) => Math.sqrt(t.extent) * (structuralWeight[t.operator] ?? 1),
});
const sequence = [...working].sort((a, b) => a.first_seq - b.first_seq);

console.log(`\nreaching the mouth: ${sequence.length} of ${tasks.length} (withheld ${withheld})`);
for (const t of sequence) {
  const d = levels.find((l) => l.task_id === t.task_id).depth;
  console.log(`  ${"  ".repeat(t.depth)}[${t.operator}] ${t.description.slice(0, 34).padEnd(34)} depth=${t.depth} derived=${d} ${t.narratedBy ? "· narrated by " + t.narratedBy : ""}`);
}

// ── Realize ──
//
// Pitch motion is drawn from the tracked prior. Depth sets register: the inner
// narrative speaks lower and slower, because it is the voice the frame had to
// open to admit. Extent sets length, so the proportions are the book's.
const noise = makeNoiseFor(seed);
const pick = (weighted) => {
  const total = weighted.reduce((n, w) => n + w.weight, 0);
  let r = noise() * total;
  for (const w of weighted) { r -= w.weight; if (r <= 0) return w.value; }
  return weighted[weighted.length - 1].value;
};

const totalExtent = sequence.reduce((n, t) => n + t.extent, 0);
const TARGET_BEATS = 240;

// Realization is a function of the section list so a revision pass can hear the
// result and recompose the sections that drifted.
function realizeAll(seq) {
const notes = [];
let beat = 0;
const motifs = [];
const bySection = new Map();

for (const t of seq) {
  const share = Math.max(8, Math.round((t.extent / totalExtent) * TARGET_BEATS));
  // Deeper frame => lower register. Not a name; a transposition.
  const centre = 62 - t.depth * 12;
  let pitch = centre;
  const contour = [];
  const end = beat + share;

  while (beat < end) {
    const step = pick(motion.motion);
    const dur = pick(motion.duration);
    pitch += step;
    // Keep the line in a singable band by folding octaves, never by clamping —
    // clamping would flatten the contour into a wall.
    while (pitch > centre + 14) pitch -= 12;
    while (pitch < centre - 14) pitch += 12;
    contour.push({ step, dur });
    notes.push({ pitch, start: beat, dur: dur * (t.depth ? 1.5 : 1), section: t.task_id, depth: t.depth });
    beat += dur * (t.depth ? 1.5 : 1);
  }
  motifs.push({ referent_id: t.task_id, contour });
  bySection.set(t.task_id, notes.filter((n) => n.section === t.task_id));
  beat += 2; // a breath between sections
}
return { notes, motifs, bySection, beat };
}

let { notes, motifs, bySection, beat } = realizeAll(sequence);
console.log(`\n${notes.length} notes · ${beat.toFixed(0)} beats`);

// ── Re-listen and revise ──
//
// The piece is rendered, heard back through the same tracker that heard the
// overture, and sections whose motion drifted from the prior are superseded.
// Loop stops when the residual stops improving — closure, not a round count.
console.log("\nre-listening:");
let curLog = log, curSeq = sequence, prevResidual = Infinity, rounds = 0;
while (rounds < 4) {
  const pass = revisePass(curLog, bySection, motion.motion, { tolerance: 0.42, bpm: 84 });
  if (pass.residual === null) { console.log("  residual not measurable — stopping"); break; }
  console.log(`  round ${rounds + 1}: residual ${pass.residual.toFixed(3)} · ${pass.revised} section(s) revised`);
  if (pass.revised === 0) { console.log("  nothing drifted beyond tolerance — closed"); break; }
  if (pass.residual >= prevResidual - 0.005) { console.log("  residual stopped improving — closed"); break; }
  prevResidual = pass.residual;
  curLog = pass.log;
  // Re-fold. A revision pass must go back through the mouth like everything
  // else — taking every live task instead re-admitted the 25 sections the fold
  // had withheld, and the piece went from 210 notes to 582. Revising is not a
  // licence to say more.
  const revisedTasks = projectTasks(curLog).filter((t) => t.extent);
  const refolded = foldToWorkingSet(revisedTasks, {
    k: 7,
    score: (t) => Math.sqrt(t.extent) * (structuralWeight[t.operator] ?? 1),
  });
  curSeq = refolded.working.sort((a, b) => a.first_seq - b.first_seq);
  ({ notes, motifs, bySection, beat } = realizeAll(curSeq));
  rounds++;
}
console.log(`  after revision: ${notes.length} notes · log holds ${curLog.entries.length} entries (nothing erased)`);

// ── The witness, last, changing nothing ──
const events = witnessAnanda(motifs);
console.log(`\nananda — convergence witnessed, unbidden: ${events.length}`);
for (const e of events.slice(0, 4)) {
  console.log(`  ${e.referent_id}: ${e.lenses.join(" ~ ")} met at ${e.distance.toFixed(4)}`);
}
if (!events.length) console.log("  none. Legal, unremarkable, and the music is exactly what it was.");

// ── Render ──
const BPM = 84;
fs.writeFileSync(`${base}.mid`, toMidi(notes, { ppq: 480, bpm: BPM }));
const wav = synth(notes, { bpm: BPM, sr: 44100 });
fs.writeFileSync(`${base}.wav`, wav);
console.log(`\nwrote ${base}.mid and ${base}.wav (${(wav.length / 1024 / 1024).toFixed(1)} MB, ${(beat * 60 / BPM).toFixed(0)}s)`);

// ── Audio synthesis ──
//
// Additive, three partials, with a soft attack and an exponential tail. Two
// timbres: the outer frame brighter, the inner narrative darker — the same
// distinction the form earned, made audible rather than annotated.
function synth(notes, { bpm = 84, sr = 44100 } = {}) {
  const spb = 60 / bpm;
  const totalSec = Math.max(...notes.map((n) => n.start + n.dur)) * spb + 2;
  const buf = new Float32Array(Math.ceil(totalSec * sr));

  for (const n of notes) {
    const f = 440 * Math.pow(2, (n.pitch - 69) / 12);
    const t0 = Math.floor(n.start * spb * sr);
    const len = Math.floor(n.dur * spb * sr);
    const inner = n.depth > 0;
    // Inner voice: fewer upper partials, slower attack.
    const partials = inner ? [[1, 1], [2, 0.18], [3, 0.06]] : [[1, 1], [2, 0.34], [3, 0.16], [4, 0.07]];
    const attack = Math.floor(sr * (inner ? 0.045 : 0.012));

    for (let i = 0; i < len && t0 + i < buf.length; i++) {
      const tt = i / sr;
      const env = i < attack
        ? i / attack
        : Math.exp(-3.1 * (i - attack) / Math.max(1, len - attack));
      let s = 0;
      for (const [h, a] of partials) s += a * Math.sin(2 * Math.PI * f * h * tt);
      buf[t0 + i] += (s / partials.length) * env * 0.26;
    }
  }

  // Normalize with headroom rather than hard-clipping.
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.89 / peak : 1;

  const out = Buffer.alloc(44 + buf.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + buf.length * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(buf.length * 2, 40);
  for (let i = 0; i < buf.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf[i] * g * 32767))), 44 + i * 2);
  }
  return out;
}

function toMidi(notes, { ppq = 480, bpm = 120 } = {}) {
  const u32 = (n) => [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7) > 0) b.unshift((n & 0x7f) | 0x80); return b; };
  const evs = [];
  for (const n of notes) {
    evs.push({ tick: Math.round(n.start * ppq), type: 0x90, pitch: n.pitch, vel: n.depth ? 62 : 78 });
    evs.push({ tick: Math.round((n.start + n.dur) * ppq), type: 0x80, pitch: n.pitch, vel: 0 });
  }
  evs.sort((a, b) => a.tick - b.tick || (a.type === 0x80 ? -1 : 1));
  const track = [];
  const uspq = Math.round(60000000 / bpm);
  track.push(...vlq(0), 0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255);
  let last = 0;
  for (const e of evs) { track.push(...vlq(e.tick - last), e.type, e.pitch & 127, e.vel); last = e.tick; }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);
  return Buffer.from([0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(0), ...u16(1), ...u16(ppq),
                      0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track]);
}
