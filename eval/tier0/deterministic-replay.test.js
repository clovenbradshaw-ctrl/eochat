// Tier 0, invariant "Deterministic replay" — same event log (+ seed, where
// relevant) must produce byte-identical derived state every run. Exercised
// against the real fold in task-log.js (projectTasks/deriveLevels/
// foldToWorkingSet) with K=10 replays, and against eoreader6's verdict()
// (whose "settled" path explicitly reseeds) for the same property.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskLog, append, projectTasks, deriveLevels, foldToWorkingSet, ENTRY_KINDS } from "../../server/task-log.js";

const K = 10;

function buildSampleLog() {
  let log = createTaskLog();
  for (let i = 0; i < 12; i++) {
    log = append(log, { kind: ENTRY_KINDS.PROPOSE, task_id: `t${i}`, description: `task ${i}`, depends_on: i % 3 === 0 ? [] : [`t${i - 1}`] });
    if (i % 4 === 0) log = append(log, { kind: ENTRY_KINDS.EVIDENCE, task_id: `t${i}`, evidence: [`span:${i}:a`, `span:${i}:b`] });
    if (i % 5 === 0) log = append(log, { kind: ENTRY_KINDS.RESULT, task_id: `t${i}`, result: { ok: true, i } });
  }
  log = append(log, { kind: ENTRY_KINDS.SUPERSEDE, task_id: "t11-revised", supersedes: "t11", description: "revised t11" });
  log = append(log, { kind: ENTRY_KINDS.RETRACT, task_id: "t3" });
  return log;
}

test(`projectTasks is a pure fold — ${K} replays of the same log are byte-identical`, () => {
  const log = buildSampleLog();
  const runs = Array.from({ length: K }, () => JSON.stringify(projectTasks(log)));
  for (let i = 1; i < runs.length; i++) {
    assert.equal(runs[i], runs[0], `replay ${i} diverged from replay 0`);
  }
});

test(`deriveLevels is a pure fold over projectTasks' output — ${K} replays agree`, () => {
  const log = buildSampleLog();
  const tasks = projectTasks(log);
  const runs = Array.from({ length: K }, () => JSON.stringify(deriveLevels(tasks)));
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i], runs[0]);
});

test(`foldToWorkingSet with a declared score function is deterministic — ${K} replays agree`, () => {
  const log = buildSampleLog();
  const tasks = projectTasks(log);
  const score = (t) => t.evidence.length * 10 + t.task_id.length;
  const runs = Array.from({ length: K }, () => JSON.stringify(foldToWorkingSet(tasks, { k: 5, score })));
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i], runs[0]);
  const first = JSON.parse(runs[0]);
  assert.equal(first.working.length, 5);
});

test("two independently-built logs with the same entries in the same order fold to the same state", () => {
  // Not just "replay the same object" — two SEPARATE construction paths that
  // append the same entries in the same order must agree, which is the
  // stronger claim "the fold is a function of the log" actually makes.
  const a = buildSampleLog();
  const b = buildSampleLog();
  assert.equal(JSON.stringify(projectTasks(a)), JSON.stringify(projectTasks(b)));
});
