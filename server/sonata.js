// The ananda witness — and the discipline that keeps it from becoming a target.
//
// ── On Ananda, and why it does nothing ──
//
// The motivation is to chase Ananda. That sentence is a trap, and the code has
// to be built so the trap cannot close.
//
// Aurobindo inverts the dependency: Chit exists in service of Ananda, which is
// already complete and does not derive worth from what it accomplishes. So
// anything legibly scorable is not Ananda — it is the shadow Chit casts. A
// metric of that shape cannot exist even in principle, which means the failure
// mode is not "we picked the wrong metric," it is picking one at all. The
// Vedantic distinction is the operative one: ananda is unconditional, sukha is
// contingent on getting a desired object, and the moment bliss is pursued it
// degrades into craving — which is exactly error-closure logic: satisfy a gap,
// relief, repeat.
//
// The consequence: DO NOT BUILD A PLAY-GENERATOR. BUILD A PLAY-PERMITTER.
// Every note is produced in sonata-material.js from priors and seeded noise.
// This module observes afterward and feeds nothing back. sonata-material.js
// does not import it. Removing this file entirely must leave the music
// bit-for-bit identical — the Buber test made mechanical (a technique aimed at
// producing Thou is already I-It), enforced by ablation in sonata.test.js. If
// that test ever fails, someone has built a seeker with better manners.
//
// Levinas: the witness must be permitted to fail PERMANENTLY. A composer whose
// lenses "usually" converge given enough time has quietly made convergence the
// attractor. Nothing here retries, widens a tolerance, or waits.
//
// Bakhtin: a witness that fully characterizes what it saw has finalized it, and
// finalizing ends dialogue. Every entry carries an irreducible `residue` — a
// permanent, non-resolvable remainder no downstream process may close. The
// format refuses completeness on purpose.
//
// Whitehead: what reaches a log is objective immortality, never the felt
// concrescence — already a fossil by the time it is writable. So the real risk
// is not an optimizer reading this log; it is a HUMAN reading accumulated
// entries and reverse-engineering a better fossil-maker. No read-path isolation
// catches that. See AUDIT_QUESTION.

// ── Three lenses, computed in real exclusion from each other ──
//
// Each reduces a motif to a number by its own criterion. They are pure, they
// take only the motif, and none can observe another's output — the exclusion is
// what makes any later agreement worth witnessing. None of these scores is used
// to SELECT anything.
export const LENSES = Object.freeze({
  // Melodic shape: how much the contour turns.
  contour: (m) => {
    let turns = 0;
    for (let i = 1; i < m.contour.length; i++) {
      if (Math.sign(m.contour[i].step) !== Math.sign(m.contour[i - 1].step)) turns++;
    }
    return turns / Math.max(1, m.contour.length - 1);
  },
  // Rhythmic proportion: variety of durations actually used.
  rhythm: (m) => new Set(m.contour.map((n) => n.dur)).size / Math.max(1, m.contour.length),
  // Tessitura: how far the line ranges from where it began.
  range: (m) => {
    let cur = 0, lo = 0, hi = 0;
    for (const n of m.contour) { cur += n.step; lo = Math.min(lo, cur); hi = Math.max(hi, cur); }
    return Math.min(1, (hi - lo) / 12);
  },
});

/**
 * Witness convergence AFTER the fact. Never drives anything.
 *
 * Returns entries for pairs of independent lenses that happened to land within
 * `tolerance` of each other on the same motif. There is no retry, no widening,
 * no "keep composing until we get one" — permanent failure is a legal and
 * unremarkable outcome (Levinas: a system that usually converges has made
 * convergence the attractor).
 *
 * Every entry carries `residue`, which is deliberately unresolvable. Anything
 * that tried to "complete" it would be finalizing a live event into a settled
 * account, which is the move that ends dialogue.
 */
export function witnessAnanda(motifs, { tolerance = 0.04 } = {}) {
  const names = Object.keys(LENSES);
  const events = [];
  for (const m of motifs) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = LENSES[names[i]](m);
        const b = LENSES[names[j]](m);
        if (Math.abs(a - b) <= tolerance) {
          events.push(Object.freeze({
            referent_id: m.referent_id,
            lenses: Object.freeze([names[i], names[j]]),
            // The fossil, not the felt process (Whitehead): these numbers are
            // what survived, and they are not the thing that happened.
            distance: Math.abs(a - b),
            residue: "what it was like for these to meet is not recoverable from this entry",
            finalizable: false,
          }));
        }
      }
    }
  }
  return events;
}

// The question that has to be asked on a schedule, forever, because no
// architecture catches it: the danger is not an optimizer reading the witness
// log, it is a person reading accumulated entries and using them as an implicit
// spec for what to reward next — reverse-engineering a better fossil-maker.
export const AUDIT_QUESTION =
  "Has the witness log begun functioning as a design spec? If any change to " +
  "this file was motivated by wanting more convergence events, the permitter " +
  "has become a generator and the ablation test is now measuring the wrong " +
  "thing.";
