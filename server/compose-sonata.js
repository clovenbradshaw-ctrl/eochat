// Fold the task log into a sonata.
//
// This is the only place the pieces meet, and the order matters: the music is
// finished before the witness is ever called. `witnessAnanda` is not imported
// here at all — the composer cannot reach it, so it cannot be steered by it,
// and the ablation test in sonata.test.js has something real to verify rather
// than a promise in a comment.

import { createTaskLog, append, projectTasks, deriveLevels, produce, foldToWorkingSet, ENTRY_KINDS } from "./task-log.js";
import { DEFAULT_PRIORS, sonataRules, realize, makeNoiseFor, admitMotifs } from "./sonata-material.js";

/**
 * compose({ seed, priors, k }) -> { notes, tasks, levels, motifs, withheld, closure }
 *
 * `k` is the mouth: how many sections reach realization at once. It is a
 * declared budget in the 4-7 range, not a number some organ discovered.
 */
export function compose({ seed = 1, priors = DEFAULT_PRIORS, k = 7 } = {}) {
  const noise = makeNoiseFor(seed);

  // Motifs are admitted from priors and noise ALONE. Nothing about which
  // material becomes thematic consults a lens score or a convergence event —
  // that is what keeps this a permitter rather than a generator.
  const motifs = admitMotifs(noise, priors, 2);

  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "sonata", description: "sonata movement" });

  // The log produces its own entries until it is self-maintaining.
  const closure = produce(log, sonataRules(motifs));
  const tasks = projectTasks(closure.log);
  const { levels } = deriveLevels(tasks);

  // Only sections carrying material are realized; `sonata` is the whole, and a
  // whole is not played, its parts are.
  const playable = tasks.filter((t) => t.motif);

  // The mouth. Ordered by derived depth then by when they entered the log, so
  // the sounding order follows the structure that was earned.
  const depth = (id) => levels.find((l) => l.task_id === id)?.depth ?? 0;
  const ordered = [...playable].sort((a, b) => depth(a.task_id) - depth(b.task_id) || a.first_seq - b.first_seq);
  const { working, withheld } = foldToWorkingSet(ordered, { k, score: () => 0 });

  // Re-sort after the fold: foldToWorkingSet ranks, it does not sequence.
  const sequence = [...working].sort((a, b) => depth(a.task_id) - depth(b.task_id) || a.first_seq - b.first_seq);

  const notes = [];
  let beat = 0;
  for (const t of sequence) {
    const r = realize(t, { tonic: 60, startBeat: beat });
    notes.push(...r.notes);
    beat = r.endBeat + 1; // a breath between sections
  }

  return { notes, tasks: ordered, levels, motifs, withheld, closure };
}
