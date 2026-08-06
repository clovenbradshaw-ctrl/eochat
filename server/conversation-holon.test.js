import test from "node:test";
import assert from "node:assert/strict";
import { createConversationHolon, recordTurn } from "./conversation-holon.js";

test("a fresh turn with no shared evidence stays a peer and does not promote", () => {
  let log = createConversationHolon();
  ({ log } = recordTurn(log, { turnId: "t1", sourceIds: ["doc-a"] }));
  const result = recordTurn(log, { turnId: "t2", sourceIds: ["doc-b"] });

  assert.equal(result.promoted, false);
  assert.equal(result.depth, 0);
});

test("a turn that shares grounding with a prior turn is discovered dependent and promotes", () => {
  let log = createConversationHolon();
  ({ log } = recordTurn(log, { turnId: "t1", sourceIds: ["doc-a", "doc-b"] }));
  const result = recordTurn(log, { turnId: "t2", sourceIds: ["doc-b", "doc-c"] });

  assert.equal(result.promoted, true);
  assert.equal(result.depth, 1);
});

test("a chain of dependent turns keeps deepening — never assigned, only discovered", () => {
  let log = createConversationHolon();
  ({ log } = recordTurn(log, { turnId: "t1", sourceIds: ["doc-a"] }));
  ({ log } = recordTurn(log, { turnId: "t2", sourceIds: ["doc-a"] }));
  const result = recordTurn(log, { turnId: "t3", sourceIds: ["doc-a"] });

  assert.equal(result.promoted, true);
  assert.equal(result.depth, 2);
});

test("a turn with no retrieved sources cannot be found dependent on anything", () => {
  let log = createConversationHolon();
  ({ log } = recordTurn(log, { turnId: "t1", sourceIds: ["doc-a"] }));
  const result = recordTurn(log, { turnId: "t2", sourceIds: [] });

  assert.equal(result.promoted, false);
  assert.equal(result.depth, 0);
});

test("recordTurn requires a turnId", () => {
  const log = createConversationHolon();
  assert.throws(() => recordTurn(log, { sourceIds: ["doc-a"] }), TypeError);
});
