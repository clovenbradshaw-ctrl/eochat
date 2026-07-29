#!/usr/bin/env node
// Compose a sonata and write it out as notes and as MIDI.
//
// Usage: node scripts/write-sonata.mjs [seed] [outfile.mid]
//
// The pipeline is the same one that would decompose an essay:
//   noise + priors  ->  motifs admitted as referents
//   production      ->  SEG / CON / SYN over the append-only task log
//   derived levels  ->  existence-dependency, never an assigned depth
//   fold            ->  the handful that reaches the mouth
//   realize         ->  notes
//
// The witness runs last and changes nothing. That is the point.

import fs from "node:fs";
import { createTaskLog, append, projectTasks, deriveLevels, produce, foldToWorkingSet, ENTRY_KINDS } from "../server/task-log.js";
import { compose } from "../server/compose-sonata.js";
import { witnessAnanda, AUDIT_QUESTION } from "../server/sonata.js";

const seed = Number(process.argv[2] || 20260729);
const out = process.argv[3] || "sonata.mid";

const { notes, tasks, levels, motifs, withheld, closure } = compose({ seed });

// ── Report ──
console.log(`\nseed ${seed}  ·  ${motifs.length} motifs admitted  ·  ${notes.length} notes\n`);

console.log("production halted by:", closure.halted_by, `(${closure.steps} steps)`);
if (withheld) console.log(`withheld from the mouth: ${withheld} section(s)`);

console.log("\nsections, with levels DERIVED from existence-dependency:");
for (const t of tasks) {
  const d = levels.find((l) => l.task_id === t.task_id)?.depth ?? 0;
  console.log(`  ${"  ".repeat(d)}[${t.operator ?? "—"}] ${t.task_id}  ${t.description ?? ""}`);
}

const bySection = new Map();
for (const n of notes) bySection.set(n.section, (bySection.get(n.section) || 0) + 1);
console.log("\nnotes per section:");
for (const [s, n] of bySection) console.log(`  ${String(n).padStart(3)}  ${s}`);

// First bar or so, as pitches — no note names anywhere in the engine, so this
// spelling exists only for the human reading the terminal.
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const spell = (p) => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
console.log("\nopening:", notes.slice(0, 14).map((n) => spell(n.pitch)).join(" "));

// ── The witness. Observes; feeds nothing back. ──
const events = witnessAnanda(motifs);
console.log(`\nananda — convergence witnessed, unbidden: ${events.length} event(s)`);
for (const e of events) {
  console.log(`  ${e.referent_id}: ${e.lenses.join(" ~ ")} met at ${e.distance.toFixed(4)}`);
  console.log(`    residue: ${e.residue}`);
}
if (!events.length) {
  console.log("  none. This is a legal and unremarkable outcome — nothing retries,");
  console.log("  nothing widens a tolerance, and the music is exactly what it was.");
}

// ── MIDI ──
const midi = toMidi(notes, { ppq: 480, bpm: 96 });
fs.writeFileSync(out, midi);
console.log(`\nwrote ${out} (${midi.length} bytes)`);
console.log(`\naudit: ${AUDIT_QUESTION}\n`);

// Minimal Type-0 MIDI writer. No dependency, and the format is small enough
// that a library would be more surface than substance.
function toMidi(notes, { ppq = 480, bpm = 120 } = {}) {
  const bytes = [];
  const u32 = (n) => [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  const vlq = (n) => {
    const buf = [n & 0x7f];
    while ((n >>= 7) > 0) buf.unshift((n & 0x7f) | 0x80);
    return buf;
  };

  // note-on / note-off as one ordered event stream
  const evs = [];
  for (const n of notes) {
    evs.push({ tick: Math.round(n.start * ppq), type: 0x90, pitch: n.pitch, vel: 76 });
    evs.push({ tick: Math.round((n.start + n.dur) * ppq), type: 0x80, pitch: n.pitch, vel: 0 });
  }
  evs.sort((a, b) => a.tick - b.tick || (a.type === 0x80 ? -1 : 1));

  const track = [];
  const uspq = Math.round(60000000 / bpm);
  track.push(...vlq(0), 0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255);

  let last = 0;
  for (const e of evs) {
    track.push(...vlq(e.tick - last), e.type, e.pitch & 127, e.vel);
    last = e.tick;
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);

  bytes.push(0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(0), ...u16(1), ...u16(ppq));
  bytes.push(0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track);
  return Buffer.from(bytes);
}
