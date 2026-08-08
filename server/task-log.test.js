import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaskLog, append, projectTasks, deriveLevels, foldToWorkingSet, produce,
  proposeDiscovered, isGrainProgression, isProductionOrder, checkCubeProgression,
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

test("a grain without its operator has no cell to belong to", () => {
  const log = createTaskLog();
  assert.throws(
    () => append(log, propose("t", { grain: "Figure" })),
    /operator that shares its cell/
  );
});

test("an unrecognized grain is a type error, never a coerced value", () => {
  const log = createTaskLog();
  assert.throws(
    () => append(log, propose("t", {
      operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Depth",
    })),
    /three grains/
  );
});

test("operator + grain together resolve the full cell — terrain and stance for free", () => {
  let log = createTaskLog();
  log = append(log, propose("t", {
    operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure",
  }));
  const [t] = projectTasks(log);
  assert.equal(t.grain, "Figure");
  assert.equal(t.grain_gap, null);
  assert.deepEqual(t.cell, {
    operator: "SEG", mode: "Differentiate", domain: "Structure",
    grain: "Figure", terrain: "Link", stance: "Dissecting",
  });
});

test("a task with an operator but no grain reports its own gap, not a fabricated cell", () => {
  let log = createTaskLog();
  log = append(log, propose("t", { operator: "CON", operator_basis: OPERATOR_BASIS.PRODUCED }));
  const [t] = projectTasks(log);
  assert.equal(t.cell, null);
  assert.match(t.grain_gap, /no grain has been earned/);
});

test("revising the operator without repeating the grain lapses the stale cell", () => {
  let log = createTaskLog();
  log = append(log, propose("t", { operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Ground" }));
  log = append(log, { kind: ENTRY_KINDS.SUPERSEDE, task_id: "t2", supersedes: "t", operator: "CON", operator_basis: OPERATOR_BASIS.PRODUCED });
  const [t] = projectTasks(log);
  // CON.Ground was never affirmed together for this task — SEG was earned at
  // Ground, not CON — so neither the old grain nor a cell built from it
  // carries over onto the new operator; citing either would be a fabrication.
  assert.equal(t.operator, "CON");
  assert.equal(t.cell, null);
  assert.equal(t.grain, null);
  assert.match(t.grain_gap, /no grain has been earned/);
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

// ── proposeDiscovered: entities are entities, one registration path ───────

test("proposeDiscovered tags every discovery SEG at Figure grain, regardless of what domain it came from", () => {
  let log = createTaskLog();
  log = proposeDiscovered(log, [
    { task_id: "entity:merritt", description: "a character the model introduced unasked", depends_on: ["scene:1"] },
    { task_id: "file:js/util.js", description: "a file referenced but not in the original plan", depends_on: ["file:index.html"] },
  ]);
  const tasks = projectTasks(log);
  const [character, file] = tasks;
  assert.equal(character.operator, "SEG");
  assert.equal(character.grain, "Figure");
  assert.equal(character.cell.terrain, file.cell.terrain, "a discovered character and a discovered file resolve to the identical cube address");
  assert.deepEqual(character.cell, file.cell, "not merely analogous — the literal same cell");
});

test("proposeDiscovered preserves each discovery's own domain payload", () => {
  let log = createTaskLog();
  log = proposeDiscovered(log, [{ task_id: "file:x.css", description: "d", depends_on: [], language: "css", discoveredFrom: "index.html" }]);
  const [t] = projectTasks(log);
  assert.equal(t.language, "css");
  assert.equal(t.discoveredFrom, "index.html");
});

test("proposeDiscovered requires a task_id per discovery, same discipline as append", () => {
  const log = createTaskLog();
  assert.throws(() => proposeDiscovered(log, [{ description: "no id" }]), TypeError);
});

// ── Navigating the cube: grain deepens, production order holds ────────────

test("isGrainProgression: Ground -> Figure -> Pattern is legal, the reverse is not", () => {
  assert.equal(isGrainProgression("Ground", "Figure"), true);
  assert.equal(isGrainProgression("Figure", "Pattern"), true);
  assert.equal(isGrainProgression("Ground", "Ground"), true, "revisiting the same grain is not a coarsening");
  assert.equal(isGrainProgression("Pattern", "Ground"), false);
  assert.equal(isGrainProgression("Pattern", "Figure"), false);
});

test("isGrainProgression on an unrecognized grain is a typed absence, not a guessed verdict", () => {
  assert.equal(isGrainProgression("Ground", "Nonsense"), null);
});

test("isProductionOrder: SEG before CON before SYN, never backward", () => {
  assert.equal(isProductionOrder("SEG", "CON"), true);
  assert.equal(isProductionOrder("CON", "SYN"), true);
  assert.equal(isProductionOrder("SYN", "SEG"), false);
  assert.equal(isProductionOrder("CON", "SEG"), false);
  assert.equal(isProductionOrder("SEG", "SEG"), true, "the same operator again is not a reversal");
});

test("checkCubeProgression does not compare across different task_ids — no shared trajectory to have an opinion about", () => {
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t1", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Pattern" });
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t2", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Ground" });
  assert.deepEqual(checkCubeProgression(log), []);
});

test("checkCubeProgression flags a single thread that coarsens its own grain", () => {
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Pattern" });
  log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: "t", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Ground" });
  const flags = checkCubeProgression(log);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, "grain-coarsened");
  assert.equal(flags[0].task_id, "t");
});

test("checkCubeProgression flags a thread whose operator runs backward against production order", () => {
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t", operator: "SYN", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure" });
  log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: "t", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Pattern" });
  const flags = checkCubeProgression(log);
  assert.ok(flags.some((f) => f.kind === "production-order-reversed" && f.from === "SYN" && f.to === "SEG"));
});

test("checkCubeProgression is silent on a clean, monotonic thread", () => {
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Ground" });
  log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: "t", operator: "CON", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure" });
  log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: "t", operator: "SYN", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Pattern" });
  assert.deepEqual(checkCubeProgression(log), []);
});

test("checkCubeProgression ignores entries carrying no cube address at all", () => {
  let log = createTaskLog();
  log = append(log, propose("t"));
  log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: "t", evidence: ["x"] });
  assert.deepEqual(checkCubeProgression(log), []);
});

// ── checkCubeProgression follows supersede links as one spiral thread ─────

test("checkCubeProgression catches a coarsening that crosses a supersede link — the spiral, not just one task_id", () => {
  // Regression: grouping by literal task_id meant t2-supersedes-t1 produced
  // two one-entry groups with nothing to compare, silently permitting exactly
  // the "spiral, not a flat loop" violation this module's header forbids.
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t1", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Pattern" });
  log = append(log, { kind: ENTRY_KINDS.SUPERSEDE, task_id: "t2", supersedes: "t1", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Ground" });

  const flags = checkCubeProgression(log);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, "grain-coarsened");
  assert.equal(flags[0].from, "Pattern");
  assert.equal(flags[0].to, "Ground");
  assert.equal(flags[0].task_id, "t2", "flagged at the entry where the coarsening actually landed");
});

test("checkCubeProgression stays silent across a supersede chain that keeps deepening", () => {
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t1", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Ground" });
  log = append(log, { kind: ENTRY_KINDS.SUPERSEDE, task_id: "t2", supersedes: "t1", operator: "CON", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Figure" });
  log = append(log, { kind: ENTRY_KINDS.SUPERSEDE, task_id: "t3", supersedes: "t2", operator: "SYN", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Pattern" });
  assert.deepEqual(checkCubeProgression(log), []);
});

test("checkCubeProgression does not merge threads that were never linked by supersedes, even with similar ids", () => {
  let log = createTaskLog();
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t1", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Pattern" });
  log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: "t2", operator: "SEG", operator_basis: OPERATOR_BASIS.PRODUCED, grain: "Ground" });
  assert.deepEqual(checkCubeProgression(log), [], "no supersedes edge exists between t1 and t2 — they stay two unrelated threads");
});
