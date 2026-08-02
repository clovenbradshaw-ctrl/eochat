// Standalone smoke test for ConversationStore — no engine/Ollama dependency, so it
// runs anywhere. Exercises: create/list/get, update, source-scope isolation, turn +
// answer lifecycle (streaming -> completed, stop -> interrupted, regenerate ->
// variant), soft delete + restore, and malformed-record recovery.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { ConversationStore, ConversationNotFoundError } from "../server/conversation-store.js";

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eochat-conv-test-"));
  const store = new ConversationStore({ dir });

  // create + list + get
  const a = await store.create({ title: "Frankenstein questions", sourceScope: null });
  const b = await store.create({ title: "Metamorphosis questions", sourceScope: ["pg84.txt"] });
  let list = await store.list();
  assert.equal(list.length, 2, "list should show both conversations");
  assert.ok(list.some(c => c.id === a.id) && list.some(c => c.id === b.id));

  const fetchedA = await store.get(a.id);
  assert.equal(fetchedA.title, "Frankenstein questions");

  // update (rename)
  await store.update(a.id, { title: "Renamed" });
  assert.equal((await store.get(a.id)).title, "Renamed");

  // per-conversation source scope isolation
  await store.update(b.id, { sourceScope: [] }); // all sources off
  const bAfter = await store.get(b.id);
  assert.deepEqual(bAfter.sourceScope, [], "empty array (all off) must not become null (no filter)");
  const aAfter = await store.get(a.id);
  assert.equal(aAfter.sourceScope, null, "conversation A's scope must be untouched by B's update");

  // turn + answer lifecycle
  const { turn } = await store.appendTurn(a.id, { question: "What does the creature demand?", sourceScope: null });
  const streaming = await store.addAnswer(a.id, turn.id, { model: "phi4-mini:latest" });
  assert.equal(streaming.status, "streaming");
  await store.patchAnswer(a.id, turn.id, streaming.id, { text: "A companion.", status: "completed", citations: [{ num: "1", resolved: true }] });
  let convA = await store.get(a.id);
  let liveTurn = convA.turns.find(t => t.id === turn.id);
  assert.equal(liveTurn.activeAnswerId, streaming.id);
  assert.equal(liveTurn.answers[0].status, "completed");
  assert.equal(liveTurn.answers[0].text, "A companion.");

  // stop -> interrupted
  const { turn: turn2 } = await store.appendTurn(a.id, { question: "Continue?", sourceScope: null });
  const streaming2 = await store.addAnswer(a.id, turn2.id, { model: "phi4-mini:latest" });
  await store.patchAnswer(a.id, turn2.id, streaming2.id, { text: "Partial answer before stop", status: "interrupted" });
  convA = await store.get(a.id);
  const t2 = convA.turns.find(t => t.id === turn2.id);
  assert.equal(t2.answers[0].status, "interrupted");
  assert.equal(t2.question, "Continue?", "stop must not lose the user turn");

  // regenerate -> new variant, same user turn
  const variant2 = await store.addAnswer(a.id, turn2.id, { model: "phi4-mini:latest" });
  await store.patchAnswer(a.id, turn2.id, variant2.id, { text: "Second attempt", status: "completed" });
  convA = await store.get(a.id);
  const t2b = convA.turns.find(t => t.id === turn2.id);
  assert.equal(t2b.answers.length, 2, "regenerate must add a variant, not replace");
  assert.equal(t2b.activeAnswerId, variant2.id, "regenerate's new variant becomes active");
  assert.equal(t2b.answers[0].status, "interrupted", "the original interrupted answer must be preserved");

  // soft delete + restore
  await store.remove(b.id);
  list = await store.list();
  assert.ok(!list.some(c => c.id === b.id), "removed conversation must not appear in list()");
  await assert.rejects(() => store.require(b.id), ConversationNotFoundError);
  const deleted = await store.listDeleted();
  assert.ok(deleted.some(c => c.id === b.id));
  const restored = await store.restore(b.id);
  assert.equal(restored.id, b.id);
  list = await store.list();
  assert.ok(list.some(c => c.id === b.id), "restored conversation must reappear in list()");

  // malformed record recovery
  const badId = "c-corrupt-test";
  await fs.writeFile(path.join(dir, `${badId}.json`), "{not json", "utf8");
  const listWithBad = await store.list(); // must not throw
  assert.ok(!listWithBad.some(c => c.id === badId));
  const corruptFiles = await fs.readdir(path.join(dir, ".corrupt")).catch(() => []);
  assert.ok(corruptFiles.length >= 1, "malformed record must be quarantined, not silently dropped");
  const stillGood = await store.get(a.id);
  assert.ok(stillGood, "a malformed sibling record must not break reads of good records");

  console.log("ALL CONVERSATION-STORE TESTS PASSED");
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
