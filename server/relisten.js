// Re-listening: the system perceives its own output and revises.
//
// This closes the autopoietic loop. Until now production was one-directional —
// priors and noise in, notes out, nothing looked back. Here the piece is
// rendered to audio, run through the SAME tracker that heard the source
// recording, and the motion it actually exhibits is compared to the motion the
// prior described. Where a section drifts, a superseding entry is appended. The
// log revises rather than mutates, so what the section was before its revision
// stays answerable.
//
// ── What this loop may and may not close ──
//
// It closes a FIDELITY residual: does what I made move the way the source
// moves? That is checkable, bounded, and has an honest zero.
//
// It must NEVER close on ananda. Revising toward more convergence events would
// convert the permitter into a seeker, which is the one thing the whole design
// forbids — and it would do so through the most plausible-looking door, an
// improvement loop. `witnessAnanda` is not imported here, and the revision
// score cannot see it. Same wall as the composer, for the same reason.
//
// The distinction is the one Aurobindo's vocabulary already draws: closing a
// gap between intent and result is ordinary craft. Pursuing bliss as an object
// is sukha, and it degrades into craving — satisfy, relief, repeat.

import { trackPitches, segmentNotes, motionHistogram, toWeighted, motionDistance } from "./pitch-track.js";
import { append, projectTasks, ENTRY_KINDS, OPERATOR_BASIS } from "./task-log.js";

/**
 * Render notes to mono float samples. Deliberately the same simple additive
 * voice used for the final WAV — re-listening to a DIFFERENT synthesis than the
 * one shipped would be measuring a rendering, not the piece.
 */
export function renderFloat(notes, { bpm = 84, sr = 8000 } = {}) {
  if (!notes.length) return new Float32Array(0);
  const spb = 60 / bpm;
  const totalSec = Math.max(...notes.map((n) => n.start + n.dur)) * spb + 0.5;
  const buf = new Float32Array(Math.ceil(totalSec * sr));
  for (const n of notes) {
    const f = 440 * Math.pow(2, (n.pitch - 69) / 12);
    const t0 = Math.floor(n.start * spb * sr);
    const len = Math.floor(n.dur * spb * sr);
    const attack = Math.floor(sr * 0.02);
    for (let i = 0; i < len && t0 + i < buf.length; i++) {
      const env = i < attack ? i / attack : Math.exp(-3.1 * (i - attack) / Math.max(1, len - attack));
      buf[t0 + i] += (Math.sin(2 * Math.PI * f * (i / sr)) + 0.3 * Math.sin(4 * Math.PI * f * (i / sr))) * env * 0.3;
    }
  }
  return buf;
}

/**
 * Hear one section back and measure its drift from the prior it was composed
 * from. Returns null when the section is too short to hear — an unmeasurable
 * section is a typed gap, not a drift of zero.
 */
export function hearSection(notes, priorMotion, { bpm = 84, sr = 8000 } = {}) {
  const audio = renderFloat(notes, { bpm, sr });
  const tracked = segmentNotes(trackPitches(audio, { sr }));
  if (tracked.length < 4) {
    return { gap: `only ${tracked.length} note(s) recovered on re-listening — too little to measure drift`, drift: null, tracked };
  }
  const hist = motionHistogram(tracked);
  if (hist.total < 3) {
    return { gap: `only ${hist.total} interval(s) survived re-listening — drift not measurable`, drift: null, tracked };
  }
  return { gap: null, drift: motionDistance(toWeighted(hist.counts), priorMotion), tracked, heard: toWeighted(hist.counts) };
}

/**
 * One revision pass.
 *
 * Every section is heard back. Those drifting beyond `tolerance` get a
 * superseding entry carrying a fresh `variation` the recomposer will use to try
 * again. Nothing is mutated and nothing is deleted.
 *
 * Returns the new log plus the measured residual, so a caller can stop when the
 * residual stops improving rather than after a fixed number of rounds.
 */
export function revisePass(log, notesBySection, priorMotion, { tolerance = 0.42, bpm = 84 } = {}) {
  const tasks = projectTasks(log);
  const measured = [];
  let next = log;

  for (const t of tasks) {
    const notes = notesBySection.get(t.task_id) ?? [];
    if (!notes.length) continue;
    const { drift, gap, heard } = hearSection(notes, priorMotion, { bpm });
    measured.push({ task_id: t.task_id, drift, gap });
    if (drift === null || drift <= tolerance) continue;

    // Append a revision. The prior entry stays — this is a record of having
    // heard something and changed course, which is itself evidence.
    next = append(next, {
      kind: ENTRY_KINDS.SUPERSEDE,
      task_id: `${t.task_id}@r${(t.variation ?? 0) + 1}`,
      supersedes: t.task_id,
      description: t.description,
      depends_on: t.depends_on,
      operator: t.operator,
      operator_basis: OPERATOR_BASIS.PRODUCED,
      depth: t.depth,
      narratedBy: t.narratedBy,
      extent: t.extent,
      // What the recomposer varies. Carried so the revision is reproducible.
      variation: (t.variation ?? 0) + 1,
      // Why it was revised, in the entry, so the log explains itself.
      revised_because: `heard back at motion-distance ${drift.toFixed(3)} from the prior (tolerance ${tolerance})`,
      heard,
    });
  }

  const drifts = measured.map((m) => m.drift).filter((d) => d !== null);
  return {
    log: next,
    measured,
    residual: drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : null,
    revised: next.entries.length - log.entries.length,
  };
}
