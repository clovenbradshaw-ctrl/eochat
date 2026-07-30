// Pitch tracking and motion histograms — ONE implementation.
//
// This is shared deliberately. The system derives a motion prior from a
// recording, then re-listens to its own output to see whether what it made
// moves the way the source moves. If those two passes used different trackers,
// the comparison would measure the difference between two analysers rather than
// the difference between two pieces of music, and every "revision" would be
// chasing an artifact. Same ears on both.
//
// (This is the "consistently reinvented" rule from AGENTS.md applied before the
// second copy exists rather than after.)

/** Normalized autocorrelation pitch detection over mono float samples. */
export function trackPitches(x, { sr = 8000, frame = 1024, hop = 256, minHz = 55, maxHz = 800, clarityMin = 0.62, rmsMin = 0.008 } = {}) {
  const minLag = Math.floor(sr / maxHz);
  const maxLag = Math.floor(sr / minHz);
  const frames = [];
  let unvoiced = 0;

  for (let start = 0; start + frame <= x.length; start += hop) {
    let r0 = 0;
    for (let i = 0; i < frame; i++) r0 += x[start + i] * x[start + i];
    if (Math.sqrt(r0 / frame) < rmsMin) { frames.push(null); unvoiced++; continue; }

    let bestLag = -1, bestVal = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0, e2 = 0;
      const lim = frame - lag;
      for (let i = 0; i < lim; i++) {
        acc += x[start + i] * x[start + i + lag];
        e2 += x[start + i + lag] * x[start + i + lag];
      }
      const v = acc / (Math.sqrt(r0 * e2) || 1);
      if (v > bestVal) { bestVal = v; bestLag = lag; }
    }
    if (bestVal < clarityMin || bestLag < 0) { frames.push(null); unvoiced++; continue; }
    frames.push({ midi: 69 + 12 * Math.log2((sr / bestLag) / 440), clarity: bestVal });
  }
  return { frames, unvoiced, hop, sr };
}

/** Segment frames into notes: runs holding one pitch within a semitone. */
export function segmentNotes({ frames, hop, sr }, { minFrames = 4 } = {}) {
  const notes = [];
  let run = [];
  const flush = () => {
    if (run.length >= minFrames) {
      const s = run.map((f) => f.midi).sort((a, b) => a - b);
      notes.push({ midi: Math.round(s[Math.floor(s.length / 2)]), seconds: (run.length * hop) / sr });
    }
    run = [];
  };
  for (const f of frames) {
    if (!f) { flush(); continue; }
    if (run.length && Math.abs(f.midi - run[run.length - 1].midi) > 1.0) flush();
    run.push(f);
  }
  flush();
  return notes;
}

/**
 * Motion histogram: semitone intervals between consecutive notes.
 *
 * Transposition-invariant by construction, so it describes how a line MOVES
 * rather than which pitches it used. Exact octaves are excluded as
 * autocorrelation octave errors — a periodicity detector locking onto a
 * harmonic, not a line that leapt — and the exclusions are counted, never
 * silently dropped.
 */
export function motionHistogram(notes) {
  const counts = new Map();
  let octaveErrors = 0, overRange = 0;
  for (let i = 1; i < notes.length; i++) {
    const step = notes[i].midi - notes[i - 1].midi;
    if (Math.abs(step) > 12) { overRange++; continue; }
    if (Math.abs(step) === 12) { octaveErrors++; continue; }
    counts.set(step, (counts.get(step) || 0) + 1);
  }
  return { counts, octaveErrors, overRange, total: [...counts.values()].reduce((a, b) => a + b, 0) };
}

/** Weighted-list form, as priors carry it. */
export function toWeighted(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, weight]) => ({ value, weight }));
}

/**
 * How far apart two motion distributions are, in [0, 1].
 *
 * Total variation distance over the union of supports. Chosen because it is
 * bounded, symmetric, and needs no smoothing fudge for steps one distribution
 * never used — an interval absent from the output is a real difference, not a
 * divide-by-zero to paper over.
 */
export function motionDistance(aWeighted, bWeighted) {
  const norm = (w) => {
    const total = w.reduce((n, x) => n + x.weight, 0) || 1;
    return new Map(w.map((x) => [x.value, x.weight / total]));
  };
  const A = norm(aWeighted), B = norm(bWeighted);
  let d = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    d += Math.abs((A.get(k) ?? 0) - (B.get(k) ?? 0));
  }
  return d / 2;
}
