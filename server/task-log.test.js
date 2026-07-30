import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaskLog, append, projectTasks, deriveLevels, foldToWorkingSet, produce,
  ENTRY_KINDS, OPERATOR_BASIS,
} from "./task-log.js";

const propose = (task_id, extra = {}) => ({ kind: ENTRY_KINDS.PROPOSE, task_id, ...extra });

test("the log is append-only — a revision supersedes without erasing", () => {
  let log = createTaskLog();
  log = append(log, propose("t1", { description: "first reading" }));
  log = append(log, { kind: ENTRY_KINDS.SUPERSEDE, task_id: "t2", supersedes: "t1", description: "revised reading" });

  const live = projectTasks(log);
  assert.deepEqual(live.map((t) => t.task_id), ["t2"], "superseded task leaves the live set");
  // The point of an append-only log: the earlier view is still answerable.
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].description, "first reading");
});

test("level is derived from existence-dependency, never stored", () => {
  let log = createTaskLog();
  log = append(log, propose("whole"));
  log = append(log, propose("part", { depends_on: ["whole"] }));

  const { levels, relations } = deriveLevels(projectTasks(log));
  assert.equal(levels.find((l) => l.task_id === "whole").depth, 0);
  assert.equal(levels.find((l) => l.task_id === "part").depth, 1);

  const rel = relations.find((r) => r.a === "part" && r.b === "whole");
  assert.equal(rel.relation, "b-above-a");
  assert.equal(rel.earned_by, "existence-dependency");
});

test("peer is a first-class result, not a failed ranking", () => {
  let log = createTaskLog();
  log = append(log, propose("a"));
  log = append(log, propose("b"));

  const { relations } = deriveLevels(projectTasks(log));
  assert.equal(relations.length, 1);
  assert.equal(relations[0].relation, "peer");
  // Nothing was earned, so nothing is claimed.
  assert.equal(relations[0].earned_by, null);
});

test("an operator may not be carried without stating how it came to be", () => {
  const log = createTaskLog();
  assert.throws(
    () => append(log, propose("t", { operator: "SEG" })),
    /operator_basis/,
    "a bare operator is the silent default this module exists to prevent"
  );
});

test("only Structure operators are admissible", () => {
  const log = createTaskLog();
  // REC is Interpretation/Generate — a real operator, wrong row.
  assert.throws(
    () => append(log, propose("t", { operator: "REC", operator_basis: OPERATOR_BASIS.PRODUCED })),
    /Structure operator/
  );
});

test("a task with no operator reports a gap rather than defaulting to SEG", () => {
  let log = createTaskLog();
  log = append(log, propose("t"));
  const [t] = projectTasks(log);
  assert.equal(t.operator, null);
  assert.equal(t.operator_basis, OPERATOR_BASIS.ABSENT);
  assert.match(t.operator_gap, /has been earned/);
});

test("production types each entry by the rule that fired, and halts at closure", () => {
  let log = createTaskLog();
  log = append(log, propose("root", { description: "incoherent evidence" }));

  // SEG fires once, on a task that has not already been differentiated.
  const rules = {
    SEG: (tasks) =>
      tasks
        .filter((t) => t.task_id === "root" && !tasks.some((x) => x.task_id === "root/part"))
        .map(() => ({ task_id: "root/part", depends_on: ["root"], description: "a part" })),
  };

  const { log: out, closed, halted_by, steps } = produce(log, rules);
  const live = projectTasks(out);
  const part = live.find((t) => t.task_id === "root/part");

  assert.equal(part.operator, "SEG", "the type is the rule that fired");
  assert.equal(part.operator_basis, OPERATOR_BASIS.PRODUCED, "not classified, not declared — produced");
  assert.equal(closed, true);
  assert.equal(halted_by, "operational-closure");
  assert.ok(steps >= 2, "one step to produce, one to observe nothing new");

  // And the derived level follows from the dependency the rule created.
  const { levels } = deriveLevels(live);
  assert.equal(levels.find((l) => l.task_id === "root/part").depth, 1);
});

test("a runaway production reports the guard, not closure", () => {
  let log = createTaskLog();
  log = append(log, propose("seed"));
  // Never stops producing — the guard must not be mistaken for self-maintenance.
  const rules = { SYN: (tasks) => [{ task_id: `t${tasks.length}`, description: "another" }] };

  const { closed, halted_by } = produce(log, rules, { maxSteps: 5 });
  assert.equal(closed, false);
  assert.equal(halted_by, "max-steps-guard");
});

test("the mouth takes a handful and says what it withheld", () => {
  let log = createTaskLog();
  for (let i = 0; i < 12; i++) {
    log = append(log, propose(`t${i}`));
    // Distinct span ids: evidence is DEDUPED on projection, because the same
    // span admitted twice is one piece of evidence, not two.
    log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: `t${i}`, evidence: Array.from({ length: i }, (_, j) => `span:${i}:${j}`) });
  }

  const { working, withheld, withheld_ids } = foldToWorkingSet(projectTasks(log), { k: 7 });
  assert.equal(working.length, 7);
  assert.equal(withheld, 5, "truncation is reported, never silent");
  assert.equal(withheld_ids.length, 5);
  // Ranked by evidence, so the best-evidenced task reaches the mouth.
  assert.equal(working[0].task_id, "t11");
});

test("evidence attached at propose time survives projection", () => {
  // Regression: evidence was accumulated only from EVIDENCE-kind entries, so a
  // task proposed WITH its evidence — the normal case when the evidence is what
  // produced the task — projected empty, and every section downstream had
  // nothing to cite.
  let log = createTaskLog();
  log = append(log, propose("t", { evidence: ["span:a", "span:b"] }));
  const [t] = projectTasks(log);
  assert.deepEqual(t.evidence, ["span:a", "span:b"]);
});
