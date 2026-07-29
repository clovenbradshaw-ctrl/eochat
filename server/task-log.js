// The append-only task log.
//
// The emergent order lives in the TASKS, not in a plan. So there is no tree
// here that a planner fills in and the executor walks. There is a log: entries
// are appended, never mutated, and the current shape of the work is a FOLD over
// that log. Revising a task appends an entry that supersedes an earlier one;
// the superseded entry stays, because the fact that the work was once seen that
// way is itself evidence.
//
// What this replaces. `holonic-task.js`'s HolonNode takes `level` as a
// CONSTRUCTOR ARGUMENT and caps it with `maxDepth`, then reads it back as
// ground truth via `nodesAtLevel()`. That is assigning a scale, which
// docs/holon-level.md forbids in as many words: whether X is above, below, or a
// peer of Y is DISCOVERED from existence-dependency and possibility-constraint,
// never from naming a depth. Here `level` is not stored at all. It is derived,
// every time, from what the entries claim about each other — and "peer" (no
// level relation) is a first-class result, not a failure to find one.
//
// Two disciplines carried over from the engine, because this module is the kind
// of thing that rots without them:
//
//   No clock. Ordering is `seq`, a logical counter supplied by the log itself.
//   There is no wall time and no shared epoch — a "tick" is local to this log.
//   (Callers may attach their own timestamps as opaque metadata; nothing here
//   reads them.)
//
//   No silent coercion. An entry that cannot be typed produces an explicit
//   null-with-reason, never a guess. A missing operator is `null` with a stated
//   basis, not a default of SEG.

// The Structure row of the canonical 3x3 (spec/operators/epoch.js):
// Differentiate / Relate / Generate. These are the only structural acts a task
// entry may carry. Existence (NUL/SIG/INS) and Interpretation (DEF/EVA/REC)
// address different questions and are deliberately not accepted here.
export const STRUCTURE_OPERATORS = Object.freeze({
  SEG: "SEG", // Differentiate — this work splits into parts that stand apart
  CON: "CON", // Relate — these parts bear on each other
  SYN: "SYN", // Generate — something holds only across the parts, not in any one
});

// How an entry's operator came to be what it is.
//
// The system is autopoietic: the log produces the entries that constitute the
// log. So the primary basis is neither "a classifier decided" nor "a planner
// declared" — it is PRODUCED, meaning the operator names the production rule
// that actually fired to bring the entry into being. An entry typed SYN is one
// that synthesis produced; the type is a record of an act, not a label applied
// to a thing afterward. That is what makes it discovered rather than assigned.
//
// The other bases remain representable because the system is structurally
// coupled, not solipsistic: a reader or planner can perturb it, and when an
// outside assertion disagrees with what production yielded, both are retained
// as CONTESTED rather than one silently overwriting the other.
export const OPERATOR_BASIS = Object.freeze({
  PRODUCED: "produced",   // the production rule that fired — the primary basis
  DERIVED: "derived",     // an evidence test produced it
  DECLARED: "declared",   // a planner/model asserted it from outside
  CONTESTED: "contested", // production and assertion disagreed; both retained
  ABSENT: "absent",       // not yet earned — carries a reason, never a default
});

export const ENTRY_KINDS = Object.freeze({
  PROPOSE: "propose",     // a task enters the log
  SUPERSEDE: "supersede", // a task is revised; the prior entry remains
  EVIDENCE: "evidence",   // spans admitted for a task
  RESULT: "result",       // output produced for a task
  RETRACT: "retract",     // a task is withdrawn (it stays in the log)
});

/** A new, empty log. `seq` is logical and starts at 0. */
export function createTaskLog() {
  return Object.freeze({ entries: Object.freeze([]), nextSeq: 0 });
}

/**
 * Append one entry. Returns a NEW log — the old one remains valid, which is
 * what makes "what did this look like before the revision" answerable.
 */
export function append(log, entry) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("append requires an entry object");
  }
  if (!Object.values(ENTRY_KINDS).includes(entry.kind)) {
    throw new TypeError(`append: unknown entry kind ${JSON.stringify(entry.kind)}`);
  }
  if (typeof entry.task_id !== "string" || !entry.task_id) {
    throw new TypeError("append: every entry needs a task_id");
  }
  if (entry.operator != null && !STRUCTURE_OPERATORS[entry.operator]) {
    throw new TypeError(
      `append: ${JSON.stringify(entry.operator)} is not a Structure operator (SEG/CON/SYN)`
    );
  }
  // An operator without a stated basis is the silent default this module
  // exists to prevent.
  if (entry.operator != null && !Object.values(OPERATOR_BASIS).includes(entry.operator_basis)) {
    throw new TypeError("append: an entry carrying an operator must state its operator_basis");
  }

  const sealed = Object.freeze({
    ...entry,
    seq: log.nextSeq,
    // `depends_on` is the existence-dependency claim: task_ids this task
    // CANNOT EXIST WITHOUT. It is the raw material for level derivation and is
    // never itself a level.
    depends_on: Object.freeze([...(entry.depends_on ?? [])]),
    evidence: Object.freeze([...(entry.evidence ?? [])]),
  });

  return Object.freeze({
    entries: Object.freeze([...log.entries, sealed]),
    nextSeq: log.nextSeq + 1,
  });
}

/**
 * Fold the log into the current set of live tasks.
 *
 * Later entries for a task_id win, superseded and retracted tasks drop out of
 * the live set — but nothing is deleted from `log.entries`.
 */
export function projectTasks(log) {
  const byId = new Map();
  const superseded = new Set();
  const retracted = new Set();

  for (const e of log.entries) {
    if (e.kind === ENTRY_KINDS.RETRACT) { retracted.add(e.task_id); continue; }
    if (e.supersedes) superseded.add(e.supersedes);

    const prior = byId.get(e.task_id) ?? {
      task_id: e.task_id,
      operator: null,
      operator_basis: OPERATOR_BASIS.ABSENT,
      operator_gap: "no structural act has been earned for this task yet",
      description: null,
      depends_on: [],
      evidence: [],
      result: null,
      first_seq: e.seq,
    };

    // Domain payload. The log is medium-agnostic — it knows about structure,
    // not about what the structure is made of — but a task has to be able to
    // carry its material or the fold hands downstream an empty shape. Dropping
    // unrecognized keys silently produced exactly that: a sonata whose sections
    // all survived projection with their motifs stripped, and zero notes.
    const RESERVED = new Set([
      "kind", "task_id", "seq", "supersedes", "operator", "operator_basis",
      "description", "depends_on", "evidence", "result",
    ]);
    const payload = {};
    for (const [key, value] of Object.entries(e)) {
      if (!RESERVED.has(key)) payload[key] = value;
    }

    byId.set(e.task_id, {
      ...prior,
      ...payload,
      // Evidence accumulates; it is admitted, not replaced.
      evidence: e.kind === ENTRY_KINDS.EVIDENCE
        ? [...prior.evidence, ...e.evidence]
        : prior.evidence,
      result: e.kind === ENTRY_KINDS.RESULT ? e.result : prior.result,
      description: e.description ?? prior.description,
      depends_on: e.depends_on.length ? [...e.depends_on] : prior.depends_on,
      operator: e.operator ?? prior.operator,
      operator_basis: e.operator != null ? e.operator_basis : prior.operator_basis,
      operator_gap: e.operator != null ? null : prior.operator_gap,
      last_seq: e.seq,
    });
  }

  return [...byId.values()]
    .filter((t) => !retracted.has(t.task_id) && !superseded.has(t.task_id))
    .sort((a, b) => a.first_seq - b.first_seq);
}

/**
 * Derive level relations. NOTHING here reads a stored level, because none is
 * stored.
 *
 * Two tests, per docs/holon-level.md:
 *   existence-dependency  — B cannot exist without A  => A is above B
 *   possibility-constraint — A constrains what B may be => A is above B
 *
 * A pair that passes neither is a PEER. That is a real answer, not a missing
 * one: not every nesting is a ladder, and forcing a rank where none was earned
 * is the exact failure this replaces.
 *
 * `depth` is reported only as a derived convenience for display — it is
 * recomputed from the dependency edges on every call and is never authoritative.
 */
export function deriveLevels(tasks) {
  const ids = new Set(tasks.map((t) => t.task_id));
  const above = new Map(tasks.map((t) => [t.task_id, new Set()]));

  for (const t of tasks) {
    for (const dep of t.depends_on) {
      // A dependency on something not in the live set is a typed gap, not an
      // edge to invent.
      if (ids.has(dep)) above.get(t.task_id).add(dep);
    }
  }

  const depthOf = (id, seen = new Set()) => {
    if (seen.has(id)) return 0; // cycle: report a peer-ish 0 rather than recurse
    const parents = above.get(id);
    if (!parents || parents.size === 0) return 0;
    const next = new Set(seen).add(id);
    return 1 + Math.max(...[...parents].map((p) => depthOf(p, next)));
  };

  const relations = [];
  for (const a of tasks) {
    for (const b of tasks) {
      if (a.task_id >= b.task_id) continue;
      const aAboveB = above.get(b.task_id).has(a.task_id);
      const bAboveA = above.get(a.task_id).has(b.task_id);
      relations.push({
        a: a.task_id,
        b: b.task_id,
        // "peer" is first-class and is what an unearned relation reports.
        relation: aAboveB ? "a-above-b" : bAboveA ? "b-above-a" : "peer",
        earned_by: aAboveB || bAboveA ? "existence-dependency" : null,
      });
    }
  }

  return {
    levels: tasks.map((t) => ({ task_id: t.task_id, depth: depthOf(t.task_id) })),
    relations,
  };
}

/**
 * One production step: the log producing the components that constitute it.
 *
 * This is what makes the structure autopoietic rather than merely append-only.
 * Nothing outside decides the shape of the work; the current fold is perturbed
 * by evidence and PRODUCES its own next entries. The three Structure operators
 * are the three production rules, and an entry's operator is simply which one
 * fired to bring it into being:
 *
 *   SEG (Differentiate) — a task's evidence does not cohere, so the task
 *       produces parts that stand apart. Fires on internal difference.
 *   CON (Relate)        — two live tasks bear on each other (shared evidence),
 *       so a relation between them comes into being.
 *   SYN (Generate)      — something holds only ACROSS tasks and in none of them
 *       alone, so a task is produced that exists only at that span. This is the
 *       only rule that can produce a task nothing else depends on the parts of.
 *
 * Each rule is supplied by the caller as a predicate over the live fold, so
 * this module stays free of any particular notion of "coheres" or "bears on" —
 * those are evidence questions belonging to the engine, not to the log. What
 * lives here is only the closure: fire, append, refold, repeat.
 *
 * Termination is operational closure — production yielding nothing new — NOT a
 * depth ceiling. `maxDepth` in holonic-task.js is an assigned bound of exactly
 * the kind holon-level.md forbids; a system that produces itself stops when it
 * is self-maintaining, which is a measured property, not a number picked in
 * advance. `maxSteps` below is only a runaway guard, and when it is what
 * stopped the loop that is reported rather than passed off as closure.
 */
export function produce(log, rules, { maxSteps = 64 } = {}) {
  if (!rules || typeof rules !== "object") {
    throw new TypeError("produce requires a { SEG, CON, SYN } rule set");
  }

  let current = log;
  let steps = 0;
  let closed = false;

  while (steps < maxSteps) {
    const tasks = projectTasks(current);
    const before = current.entries.length;

    // Order matters only in that differentiation precedes relation precedes
    // generation WITHIN a step; across steps the log re-folds, so an entry
    // produced by SEG can be related by CON on the next pass. No rule is
    // privileged beyond that.
    for (const op of ["SEG", "CON", "SYN"]) {
      const rule = rules[op];
      if (typeof rule !== "function") continue;
      for (const produced of rule(tasks, current) ?? []) {
        current = append(current, {
          ...produced,
          kind: produced.kind ?? ENTRY_KINDS.PROPOSE,
          operator: op,
          // The rule that fired IS the type. Nothing classified this.
          operator_basis: OPERATOR_BASIS.PRODUCED,
        });
      }
    }

    steps += 1;
    if (current.entries.length === before) { closed = true; break; }
  }

  return {
    log: current,
    steps,
    // Closure reached vs. guard tripped are different facts and must not read
    // alike — the second means the work may be unfinished.
    closed,
    halted_by: closed ? "operational-closure" : "max-steps-guard",
  };
}

/**
 * The mouth.
 *
 * The world folds before anything is said, so what reaches a single generation
 * is a working-memory-sized handful — not everything retrieval found and not
 * everything the log holds. Measured going the other way: handing one prompt 8
 * passages produced a 27,471-character system message and an answer consisting
 * of the single token "[7]".
 *
 * `k` defaults to 7, the top of the 4-7 range. It is a declared budget, so it
 * lives here as an argument rather than as a constant some organ discovers.
 */
export function foldToWorkingSet(tasks, { k = 7, score = null } = {}) {
  if (!Number.isInteger(k) || k < 1) throw new TypeError("foldToWorkingSet: k must be a positive integer");
  const rank = score ?? ((t) => t.evidence.length);
  const ordered = [...tasks].sort((x, y) => rank(y) - rank(x) || x.first_seq - y.first_seq);
  return {
    working: ordered.slice(0, k),
    // What did NOT reach the mouth, and how much. Silent truncation reads as
    // "this was everything" when it was not.
    withheld: ordered.length > k ? ordered.length - k : 0,
    withheld_ids: ordered.slice(k).map((t) => t.task_id),
  };
}
