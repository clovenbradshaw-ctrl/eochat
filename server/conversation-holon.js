// conversation-holon.js — the log that decides when a blink needs to expand.
//
// One turn is a blink: the smallest complete unit, in the Walter Murch sense —
// a single cut that reads as whole on its own. Whether a GIVEN blink should run
// long is not a property of that turn in isolation; it is a property of where
// the turn sits in the conversation's own structure. This module is that
// structure, built on task-log.js's spine exactly as narrative-longform.js and
// longform.js already build outlines on it — nothing here reimplements level
// derivation or invents a second holon mechanism.
//
// What "structure" means here, concretely: the sources a turn's answer actually
// drew on (`groundResult.citations[].source_id`, already computed by retrieval
// before generation — see turn-controller.js's engine-grounding branch). If this
// turn's sources overlap a PRIOR turn's sources, this turn exists dependent on
// that prior turn (existence-dependency, task-log.js's own test) rather than
// standing alone. A run of dependent turns is a thread the reader is pulling on,
// not a new question each time, and that is what earns a longer blink — never a
// classification of the question's text itself. See holonic-task.js's `level`
// (assigned) vs. this module's `deriveLevels` (discovered) for exactly the
// distinction task-log.js's own header calls out.
//
// One log per conversation, not per turn — a turn's task_id is the turn id, so
// the whole conversation folds into one dependency graph as it grows.

import { createTaskLog, append, projectTasks, deriveLevels, ENTRY_KINDS } from "./task-log.js";

/** A new, empty per-conversation holon log. */
export function createConversationHolon() {
  return createTaskLog();
}

/**
 * Record this turn in the log and report whether it should be promoted to a
 * longer blink.
 *
 * `sourceIds` is the set of source_ids this turn's retrieval actually grounded
 * on (may be empty — an uncited or web-search turn just proposes with no
 * evidence and cannot be found dependent on anything, which is the correct,
 * honest answer, not a guess).
 *
 * Returns `{ log, promoted, depth }` — a new log (the old one remains valid,
 * per task-log.js's append contract) plus the decision for THIS turn only.
 */
export function recordTurn(log, { turnId, sourceIds = [] } = {}) {
  if (!turnId) throw new TypeError("recordTurn requires a turnId");

  const priorTasks = projectTasks(log);
  const ids = new Set(sourceIds);
  // depends_on is an existence-dependency CLAIM, not a guess: this turn only
  // depends on a prior turn if they actually share cited ground.
  const depends_on = priorTasks
    .filter((t) => t.evidence.some((src) => ids.has(src)))
    .map((t) => t.task_id);

  const nextLog = append(log, {
    kind: ENTRY_KINDS.PROPOSE,
    task_id: turnId,
    depends_on,
    evidence: sourceIds,
  });

  const tasks = projectTasks(nextLog);
  const { levels } = deriveLevels(tasks);
  const mine = levels.find((l) => l.task_id === turnId);
  const depth = mine ? mine.depth : 0;

  // Promoted when this turn is discovered to sit ABOVE at least one prior
  // turn (depth > 0) — it is continuing a thread, not opening a fresh one.
  // Never derived from the question's own text.
  return { log: nextLog, promoted: depth > 0, depth };
}
