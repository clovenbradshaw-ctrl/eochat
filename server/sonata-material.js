// Sonata material: priors, seeded noise, motifs-as-referents, production rules,
// and realization to notes.
//
// This module knows NOTHING about ananda. It does not import the witness and
// cannot observe a lens score, so no amount of future editing can accidentally
// let convergence steer what gets composed. The wall is the import graph, not a
// comment — see the witness module for why that matters, and sonata.test.js for
// ablation that proves it.

// ── Seeded noise (the one impure-by-declaration input) ──
//
// The engine has no randomness; a caller supplies the seed, so a run is
// reproducible and the noise is an input rather than an ambient accident.
// Same seed, same sonata — which is also what makes the ablation test possible.
export function makeNoiseFor(seed) {
  let s = (seed >>> 0) || 0x2545f491;
  return () => {
    // xorshift32 — small, deterministic, no library.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;
  };
}

// Weighted choice over [{value, weight}] using one draw of supplied noise.
function pick(noise, weighted) {
  const total = weighted.reduce((n, w) => n + w.weight, 0);
  let r = noise() * total;
  for (const w of weighted) { r -= w.weight; if (r <= 0) return w.value; }
  return weighted[weighted.length - 1].value;
}

// ── Priors: witness-tier, injected, never derived ──
//
// Scale-degree motion and durational proportion, declared rather than learned
// from the piece being written. Deriving these FROM the output would be the
// corpus-prior dead end in another medium: a prior computed from what the thing
// contains can only be a statement about what the thing contains.
export const DEFAULT_PRIORS = Object.freeze({
  id: "prior:sonata-motion@1",
  // Degree steps, as scale degrees. Stepwise motion is common, leaps are rarer
  // and mostly consonant. No note is named anywhere.
  motion: Object.freeze([
    { value: 1, weight: 26 }, { value: -1, weight: 24 },
    { value: 2, weight: 12 }, { value: -2, weight: 11 },
    { value: 4, weight: 7 },  { value: -4, weight: 6 },
    { value: 3, weight: 4 },  { value: -3, weight: 4 },
    { value: 0, weight: 6 },
  ]),
  // Durations in beats.
  duration: Object.freeze([
    { value: 0.5, weight: 20 }, { value: 1, weight: 34 },
    { value: 1.5, weight: 8 },  { value: 2, weight: 20 }, { value: 3, weight: 6 },
  ]),
  // Where a phrase may come to rest, as scale degrees. Declared, not inferred.
  cadenceDegrees: Object.freeze([0, 4, 2]),
});

// Major scale as semitone offsets. A scale is a structural fact about the
// space, not a name for anything in it.
const SCALE = Object.freeze([0, 2, 4, 5, 7, 9, 11]);

/** Realize a scale degree (may be negative or beyond an octave) to a semitone. */
function degreeToSemitone(degree) {
  const octave = Math.floor(degree / SCALE.length);
  const idx = ((degree % SCALE.length) + SCALE.length) % SCALE.length;
  return SCALE[idx] + 12 * octave;
}

// ── Motifs as referents ──
//
// Identity lives in the referent. `contour` is the scoped evidence: a sequence
// of (degree-step, duration). Two surfaces of the same referent — one
// transposed, one augmented — are the same motif, and nothing about that
// judgement consults a label.
let motifCounter = 0;
export function admitMotif(noise, priors, { length = 5 } = {}) {
  const contour = [];
  for (let i = 0; i < length; i++) {
    contour.push({
      step: pick(noise, priors.motion),
      dur: pick(noise, priors.duration),
    });
  }
  // Come to rest: the last step is bent toward a declared cadence degree.
  contour[contour.length - 1] = {
    step: priors.cadenceDegrees[Math.floor(noise() * priors.cadenceDegrees.length)] - contour.length,
    dur: 2,
  };
  return Object.freeze({
    referent_id: `motif:${++motifCounter}`,
    contour: Object.freeze(contour),
  });
}

// Surfaces of a motif — the same referent, differently scoped.
const transpose = (m, by) => ({ ...m, contour: m.contour.map((n, i) => (i === 0 ? { ...n, step: n.step + by } : n)) });
const invert    = (m) => ({ ...m, contour: m.contour.map((n) => ({ ...n, step: -n.step })) });
const augment   = (m, by = 2) => ({ ...m, contour: m.contour.map((n) => ({ ...n, dur: n.dur * by })) });
const fragment  = (m, n = 3) => ({ ...m, contour: m.contour.slice(0, n) });


/** Admit `n` motifs as referents from priors and noise alone. */
export function admitMotifs(noise, priors, n = 2) {
  return Array.from({ length: n }, (_, i) => admitMotif(noise, priors, { length: 5 + i }));
}

// ── Production rules over the append-only task log ──
//
// SEG / CON / SYN are the Structure row: Differentiate, Relate, Generate. Each
// is a production — the operator on a produced entry names the rule that fired,
// not a label applied afterward.
//
// Sonata form falls out of them rather than being encoded as a template:
//   SEG — the material differentiates into two subject areas that stand apart.
//   CON — they bear on each other, so a transition and a development come into
//         being; the development exists only because the two are in tension.
//   SYN — the recapitulation holds only ACROSS the exposition. Its second
//         subject in the home key CANNOT EXIST without the exposition having
//         put that subject elsewhere. That is a real existence-dependency, so
//         the level relation is earned by the same test used for prose.
export function sonataRules(motifs) {
  const has = (tasks, id) => tasks.some((t) => t.task_id === id);
  return {
    SEG: (tasks) => {
      if (!has(tasks, "sonata") || has(tasks, "exposition/first")) return [];
      return [
        { task_id: "exposition/first",  depends_on: ["sonata"], description: "first subject area",  motif: motifs[0], key: 0 },
        { task_id: "exposition/second", depends_on: ["sonata"], description: "second subject area", motif: motifs[1], key: 7 },
      ];
    },
    CON: (tasks) => {
      const out = [];
      if (has(tasks, "exposition/first") && has(tasks, "exposition/second")) {
        if (!has(tasks, "exposition/transition")) {
          out.push({
            task_id: "exposition/transition",
            depends_on: ["exposition/first", "exposition/second"],
            description: "transition relating the two subjects",
            motif: fragment(motifs[0], 3), key: 4, modulating: true,
          });
        }
        if (!has(tasks, "development")) {
          out.push({
            task_id: "development",
            depends_on: ["exposition/first", "exposition/second"],
            description: "development — the subjects worked against each other",
            motif: invert(fragment(motifs[0], 4)), key: 2, unstable: true,
          });
        }
      }
      return out;
    },
    SYN: (tasks) => {
      if (!has(tasks, "development") || has(tasks, "recapitulation/second")) return [];
      // Exists only across the exposition — the resolution of a tension that no
      // single section contains.
      return [
        { task_id: "recapitulation/first",  depends_on: ["development"], description: "first subject returns home", motif: motifs[0], key: 0 },
        { task_id: "recapitulation/second", depends_on: ["development", "exposition/second"], description: "second subject resolved into the home key", motif: motifs[1], key: 0 },
        { task_id: "coda", depends_on: ["recapitulation/second"], description: "coda", motif: augment(fragment(motifs[0], 3)), key: 0 },
      ];
    },
  };
}

/** Realize one task's motif into absolute notes at a starting beat. */
export function realize(task, { tonic = 60, startBeat = 0 } = {}) {
  const notes = [];
  let degree = 0;
  let beat = startBeat;
  const motif = task.motif;
  if (!motif) return { notes, endBeat: beat };

  // A section states its motif, then answers it — the answer is a surface of
  // the same referent, so the section coheres without repeating literally.
  const statements = task.unstable
    ? [motif, transpose(invert(motif), 2), fragment(motif, 3)]
    : [motif, transpose(motif, 2)];

  for (const s of statements) {
    for (const n of s.contour) {
      degree += n.step;
      notes.push({
        // MIDI pitch. `key` transposes the whole section — this is what makes
        // the recapitulation's resolution audible rather than asserted.
        pitch: tonic + task.key + degreeToSemitone(degree),
        start: beat,
        dur: n.dur,
        section: task.task_id,
      });
      beat += n.dur;
    }
  }
  return { notes, endBeat: beat };
}

