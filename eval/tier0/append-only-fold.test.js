// Tier 0, invariant "Append-only fold" — against the real append-only log in
// eochat/server/task-log.js (createTaskLog/append/projectTasks), the same
// spine code-longform.js, narrative-longform.js, svg-longform.js and
// holonic-task.js all reuse rather than re-implement. No mutation of past
// entries; the current state is always a pure fold over the log.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as taskLog from "../../server/task-log.js";
const { createTaskLog, append, projectTasks, ENTRY_KINDS } = taskLog;

const propose = (task_id, extra = {}) => ({ kind: ENTRY_KINDS.PROPOSE, task_id, ...extra });

test("append never mutates the log it was given — the old log stays valid", () => {
  let log = createTaskLog();
  log = append(log, propose("t1", { description: "first" }));
  const before = JSON.stringify(log);

  const log2 = append(log, propose("t2", { description: "second" }));

  assert.equal(JSON.stringify(log), before, "the input log object must read identically after append() returns");
  assert.notEqual(log2, log, "append must return a NEW log, not the same reference");
  assert.equal(log.entries.length, 1, "the old log's entry count must not grow");
  assert.equal(log2.entries.length, 2);
});

test("the log and every sealed entry are frozen — mutation is structurally impossible, not merely unused", () => {
  let log = createTaskLog();
  log = append(log, propose("t1", { depends_on: ["x"], evidence: ["span:a"] }));

  assert.ok(Object.isFrozen(log), "the log object itself");
  assert.ok(Object.isFrozen(log.entries), "the entries array");
  assert.ok(Object.isFrozen(log.entries[0]), "an individual entry");
  assert.ok(Object.isFrozen(log.entries[0].depends_on), "an entry's depends_on array");
  assert.ok(Object.isFrozen(log.entries[0].evidence), "an entry's evidence array");

  // A hostile patch attempting in-place mutation must fail at the language
  // level, not merely go untested. Array.prototype.push on a frozen array
  // throws TypeError unconditionally (strict or not) because it must set
  // .length, which a frozen array refuses.
  assert.throws(() => log.entries.push(propose("hostile")), TypeError);
  assert.throws(() => { log.entries[0] = propose("hostile"); }, TypeError);
  assert.throws(() => { log.nextSeq = 999; }, TypeError);
});

test("a revision supersedes without erasing — the prior entry is still in the log", () => {
  let log = createTaskLog();
  log = append(log, propose("t1", { description: "first reading" }));
  log = append(log, { kind: ENTRY_KINDS.SUPERSEDE, task_id: "t2", supersedes: "t1", description: "revised reading" });

  const live = projectTasks(log);
  assert.deepEqual(live.map((t) => t.task_id), ["t2"]);
  assert.equal(log.entries.length, 2, "nothing was deleted from log.entries");
  assert.equal(log.entries[0].description, "first reading", "the earlier view is still answerable");
});

// The "structurally impossible, not just unused" bar from the spec: assert
// the module's export surface is EXACTLY the known safe set. A new export
// appearing here (e.g. a `mutate`/`removeEntry` helper someone adds later)
// fails this test until it is deliberately added to the allow-list — the
// same ratchet discipline as eoreader6/conformance/reproducibility.test.js's
// absolute-path debt list, inverted: this one may only grow by a conscious
// edit, never silently.
const KNOWN_SAFE_EXPORTS = [
  "STRUCTURE_OPERATORS", "OPERATOR_BASIS", "ENTRY_KINDS",
  "createTaskLog", "append", "projectTasks", "deriveLevels", "produce", "foldToWorkingSet",
].sort();

test("task-log.js exposes no mutator beyond the known safe surface", () => {
  assert.deepEqual(Object.keys(taskLog).sort(), KNOWN_SAFE_EXPORTS,
    "task-log.js's export surface changed — if this is a new, deliberately-added safe export, " +
    "add it to KNOWN_SAFE_EXPORTS in this test; if it is a mutator, it must not exist");
});
