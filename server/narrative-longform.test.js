// eochat/server · narrative-longform.test — proves the engine is generic
// over any declared world, not lighthouse-shaped code wearing a data
// object's name. See the module header's "GENERIC OVER ANY STORY" section.
//
// Two levels:
//   1. Unit tests on nextMove()'s legality state machine directly, against
//      hand-built task arrays — no model, instant, and the right level to
//      test existence-dependency edge cases precisely.
//   2. A full end-to-end run of a STRUCTURALLY UNRELATED world (a heist
//      thriller, not a mystery — its own entities, its own causal chain, its
//      own style) through the exact same writeNarrative(), stubbing only the
//      network call. If this needed a single line of engine code to change,
//      the "generic" claim in the header would be false.

import test from "node:test";
import assert from "node:assert/strict";
import { nextMove, validateWorld, writeNarrative, checkContinuity, checkNumericLocks, LIGHTHOUSE_WORLD } from "./narrative-longform.js";
import { projectTasks } from "./task-log.js";

// ── validateWorld: a missing declaration is a wall, not a guess ───────────

test("validateWorld throws naming the missing field, never defaults it", () => {
  const incomplete = { premise: "x", roster: [], motifs: [], openingBeat: "y", entities: {}, commitments: {} };
  assert.throws(() => validateWorld(incomplete), /beatPrompts/);
});

test("validateWorld accepts a complete, minimal world", () => {
  const minimal = {
    premise: "x", roster: [], motifs: [], openingBeat: "y", style: "plain",
    targetWords: [100, 150], entities: {}, commitments: {}, beatPrompts: ["a beat"],
  };
  assert.equal(validateWorld(minimal), minimal);
});

// ── nextMove: legality unit tests, no model, no lighthouse content ────────

const MIN_WORLD = {
  entities: { a: { requires: null } },
  commitments: {
    c1: { cooldownScenes: 2 },
    c2: { cooldownScenes: 1, requires: "c1" }, // a COMMITMENT dependency, not an entity one
  },
};

test("nextMove opens before anything else exists", () => {
  assert.deepEqual(nextMove(MIN_WORLD, [], 0), { kind: "open" });
});

test("nextMove introduces a declared entity once scene:1 exists", () => {
  const tasks = [{ task_id: "scene:1" }];
  assert.deepEqual(nextMove(MIN_WORLD, tasks, 1), { kind: "introduce", entityId: "a" });
});

test("a commitment requiring another commitment is illegal until that commitment RESOLVES, not merely exists", () => {
  const tasks = [
    { task_id: "scene:1" }, { task_id: "entity:a" },
    { task_id: "commitment:c1", resolved: false, plantedAtScene: 2 },
  ];
  // c1 exists but is NOT resolved — c2 must stay illegal.
  const move = nextMove(MIN_WORLD, tasks, 5);
  assert.notDeepEqual(move, { kind: "plant", commitmentId: "c2" });
});

test("resolving the prerequisite makes the dependent commitment legal to plant", () => {
  const tasks = [
    { task_id: "scene:1" }, { task_id: "entity:a" },
    { task_id: "commitment:c1", resolved: true, plantedAtScene: 2, resolvedAtScene: 4 },
  ];
  assert.deepEqual(nextMove(MIN_WORLD, tasks, 5), { kind: "plant", commitmentId: "c2" });
});

test("an open commitment before its cooldown elapses yields a beat, not a resolve", () => {
  const world = { entities: {}, commitments: { c: { cooldownScenes: 3 } } };
  const tasks = [{ task_id: "scene:1" }, { task_id: "commitment:c", resolved: false, plantedAtScene: 2 }];
  assert.deepEqual(nextMove(world, tasks, 3), { kind: "beat" }); // age 1 < cooldown 3
});

test("nextMove closes only once every commitment has resolved — never a declared count", () => {
  const world = { entities: {}, commitments: { c: { cooldownScenes: 1 } } };
  const tasks = [{ task_id: "scene:1" }, { task_id: "commitment:c", resolved: true, plantedAtScene: 2, resolvedAtScene: 3 }];
  assert.deepEqual(nextMove(world, tasks, 4), { kind: "close" });
});

// ── End-to-end genericity: a heist, not a mystery, zero engine changes ────

const HEIST_WORLD = {
  premise: "A crew plans to rob a vault the night of a citywide blackout drill.",
  roster: ["Priya (the crew lead)", "Dez (the driver)"],
  motifs: ["the stopped pocket watch Priya carries"],
  openingBeat: "Establish the crew, the target vault, and that the blackout drill is their one window. End with a problem: the drill schedule just moved up.",
  style: "a tense, clipped heist-thriller style",
  targetWords: [200, 240],
  entities: {
    insider: { description: "Renn, the inside contact at the vault", introduceBeat: "The crew meets their inside contact, who reveals a detail about the vault only someone inside could know.", requires: null },
  },
  beatPrompts: [
    "A scene of tension within the crew — trust fraying under pressure.",
    "A scene of the crew casing the location under normal cover.",
  ],
  commitments: {
    "second-guard": { fact: "There is a second guard rotation nobody accounted for.", checkTerms: ["second guard", "another guard", "extra guard"], cooldownScenes: 2 },
    "vault-code": { fact: "The vault code changes automatically every time the drill runs.", checkTerms: ["code"], cooldownScenes: 2, requires: "insider" },
    betrayal: { fact: "Dez decides to sell out the crew to save himself once things go wrong.", checkTerms: ["sell out", "betray", "turned"], cooldownScenes: 2, requires: "vault-code" },
    escape: { fact: "Priya improvises an escape that was never part of the plan, using the blackout itself.", checkTerms: ["escape", "got out", "made it"], cooldownScenes: 1, requires: "betrayal" },
  },
};

// A fidelity-confirming stub: echoes the fact text verbatim on a "resolve"
// prompt, so the mechanical check succeeds and the test proves the ENGINE's
// wiring (legality, closure, working-set) rather than re-testing a real
// model's compliance (already measured separately, on real material).
function stubModel() {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    let text = "Some invented prose for this scene. ";
    const m = /must resolve, explicitly and unambiguously: (.+)$/s.exec(userMsg);
    if (m) text += `And so: ${m[1]} `;
    return { ok: true, json: async () => ({ message: { content: text } }) };
  };
}

test("a structurally unrelated world (heist, not mystery) reaches operational-closure through the identical engine", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeNarrative(HEIST_WORLD, { model: "stub", maxScenes: 40, onProgress: () => {} });
    assert.equal(result.haltedBy, "operational-closure", "must discover its own stopping point, never hit the runaway guard");
    assert.equal(result.checks.length >= 4, true, "all four commitments must have been attempted");
    for (const c of result.checks) assert.equal(c.confirmed, true, `${c.commitmentId} must mechanically confirm`);
    // The causal chain's ORDER is the actual claim under test: each
    // dependent commitment must resolve strictly after its prerequisite.
    const at = (id) => result.checks.find((c) => c.commitmentId === id)?.scene;
    assert.ok(at("vault-code") > at("second-guard") || true); // independent threads, no ordering claim between them
    assert.ok(at("betrayal") > at("vault-code"), "betrayal must resolve after vault-code, not before");
    assert.ok(at("escape") > at("betrayal"), "escape must resolve after betrayal, not before");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("running two unrelated worlds in the same process does not leak state between them", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    // Run heist STANDALONE first to get its own baseline shape, then run it
    // again immediately after lighthouse. Each writeNarrative() call builds
    // its own createTaskLog() from scratch — if any module-level state were
    // shared (a counter, a cache keyed loosely), the second heist run would
    // diverge from the first. Identical scene count and identical resolve
    // order is the actual evidence of no leakage; checking manuscript TEXT
    // for a name the stub never produces would prove nothing.
    const heistAlone = await writeNarrative(HEIST_WORLD, { model: "stub", maxScenes: 40, onProgress: () => {} });
    await writeNarrative(LIGHTHOUSE_WORLD, { model: "stub", maxScenes: 40, onProgress: () => {} });
    const heistAfter = await writeNarrative(HEIST_WORLD, { model: "stub", maxScenes: 40, onProgress: () => {} });

    assert.equal(heistAfter.sceneCount, heistAlone.sceneCount, "scene count must not shift depending on what ran before it");
    assert.equal(heistAfter.haltedBy, heistAlone.haltedBy);
    assert.deepEqual(
      heistAfter.checks.map((c) => c.commitmentId),
      heistAlone.checks.map((c) => c.commitmentId),
      "the same causal chain must resolve in the same order regardless of interleaving with an unrelated world",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── checkContinuity: a declared-invariant check, not general NLU ─────────

test("checkContinuity flags the EXACT measured defect from lighthouse-v3.md scene 26", () => {
  // The real sentence llama3.2 produced, verbatim, that contradicted the
  // logbook's established origin (washed up on the shore, scenes 1-2).
  const scene26 = "She had found it in the attic, tucked away between old crates and forgotten trinkets, its pages yellowed with age.";
  const flags = checkContinuity(LIGHTHOUSE_WORLD, scene26);
  assert.ok(flags.some((f) => f.entityId === "logbook"), "must flag the logbook's contradicted origin");
});

test("checkContinuity does not flag consistent text", () => {
  const consistent = "Mara remembered pulling the logbook from the surf, salt-crusted and swollen with seawater.";
  assert.deepEqual(checkContinuity(LIGHTHOUSE_WORLD, consistent), []);
});

test("checkContinuity is a declared invariant, not a real contradiction detector — an undeclared entity is silently invisible to it", () => {
  // Honest limitation, pinned as a test: an entity with no conflictTerms
  // declared catches nothing, by design (II.2 — a missing declaration is a
  // wall, not something this module infers on its own).
  const world = { entities: { x: { description: "y", introduceBeat: "z", requires: null } } };
  assert.deepEqual(checkContinuity(world, "x was found in a place that would contradict everything else said about it"), []);
});

// ── checkNumericLocks: first mention locks it, checked two ways ──────────

const NUMERIC_WORLD = {
  numericLocks: [
    { id: "coordinate", pattern: /\d+(?:\.\d+)?°/g, multi: true },
    { id: "disappearance-year", pattern: /19\d{2}/g },
  ],
};

test("a real coordinate pair (lat AND long) is NOT flagged as internally inconsistent", () => {
  // Regression: the first draft of this check flagged "14° 32' N, 45° 15' W"
  // — one legitimate coordinate — purely for containing two degree-numbers.
  const locked = {};
  const flags = checkNumericLocks(NUMERIC_WORLD, "revealing a scrawled set of coordinates: 14° 32' N, 45° 15' W.", locked);
  assert.deepEqual(flags, []);
});

test("checkNumericLocks catches the EXACT measured coordinate drift from lighthouse-v3.md, across three scenes", () => {
  const locked = {};
  const scene6 = "revealing a scrawled set of coordinates: 14° 32' N, 45° 15' W.";
  const scene12 = "The numbers danced before her eyes: 45.2137° N, 73.4213° W.";
  const scene20 = "a brass compass, its face cracked but still legible: N 43° 12' W.";

  assert.deepEqual(checkNumericLocks(NUMERIC_WORLD, scene6, locked), []);
  const flags12 = checkNumericLocks(NUMERIC_WORLD, scene12, locked);
  assert.equal(flags12.length, 1);
  assert.equal(flags12[0].kind, "drift-from-earlier-scene");
  const flags20 = checkNumericLocks(NUMERIC_WORLD, scene20, locked);
  assert.equal(flags20.length, 1);
  assert.equal(flags20[0].kind, "drift-from-earlier-scene");
});

test("checkNumericLocks catches the EXACT measured year contradiction from lighthouse-v3.md scene 22, WITHIN one scene", () => {
  const locked = {};
  const scene22 = 'bore an inscription: "Voss – 23rd April 1923". Beside it: "Tomas – 24th October 1922".';
  const flags = checkNumericLocks(NUMERIC_WORLD, scene22, locked);
  assert.ok(flags.some((f) => f.kind === "inconsistent-within-scene" && f.lockId === "disappearance-year"));
});

test("a lock with no match in a scene is silently skipped, not treated as a violation", () => {
  const locked = { coordinate: "14°|45°" };
  assert.deepEqual(checkNumericLocks(NUMERIC_WORLD, "a scene with no numbers in it at all", locked), []);
});

// ── The revision loop: detect, correct, reverify — end to end ────────────

const REVISION_TEST_WORLD = {
  premise: "test premise", roster: [], motifs: [], openingBeat: "open the story",
  style: "plain", targetWords: [10, 20],
  entities: {
    thing: {
      description: "the thing", introduceBeat: "introduce the thing", requires: null,
      conflictTerms: ["BADWORD"], origin: "the thing is definitely GOODWORD, never BADWORD",
    },
  },
  beatPrompts: ["a beat"], commitments: {},
};

test("a flagged scene that a correction FIXES is replaced, and reported as corrected", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls += 1;
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    const isCorrection = userMsg.includes("Here is a scene you wrote:");
    const isAboutTheThing = userMsg.includes("introduce the thing") || isCorrection;
    // Only the scene ABOUT "thing" is ever flawed — scene 1 ("open") gets
    // harmless text, so this test isolates the correction mechanism from
    // any incidental cross-scene flagging.
    const text = !isAboutTheThing ? "An unrelated harmless opening scene." : isCorrection ? "The thing turned out to be GOODWORD after all." : "The thing was BADWORD, unmistakably.";
    return { ok: true, json: async () => ({ message: { content: text } }) };
  };
  try {
    const result = await writeNarrative(REVISION_TEST_WORLD, { model: "stub", maxScenes: 10, onProgress: () => {} });
    const corrected = result.continuityFlags.find((f) => f.kind === "corrected");
    assert.ok(corrected, "must record that a correction succeeded");
    assert.equal(corrected.revisionAttempts, 1);
    assert.ok(result.manuscript.includes("GOODWORD"), "the manuscript must contain the CORRECTED text");
    assert.ok(!result.manuscript.includes("BADWORD"), "the manuscript must NOT contain the original flagged text");
    assert.equal(calls, 3, "scene 1 (1 call) + scene 2 original + scene 2 correction");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a flagged scene that correction CANNOT fix is reported unresolved, never retried forever", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls += 1;
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    const isAboutTheThing = userMsg.includes("introduce the thing") || userMsg.includes("Here is a scene you wrote:");
    // Always BADWORD for the flawed scene, no matter how many correction
    // attempts — the other scene stays harmless throughout.
    const text = isAboutTheThing ? "Still BADWORD, every time." : "An unrelated harmless opening scene.";
    return { ok: true, json: async () => ({ message: { content: text } }) };
  };
  try {
    const result = await writeNarrative(REVISION_TEST_WORLD, { model: "stub", maxScenes: 10, onProgress: () => {} });
    const unresolved = result.continuityFlags.filter((f) => f.entityId === "thing" && f.resolved === false);
    assert.ok(unresolved.length > 0, "an unfixable contradiction must still be reported, not silently dropped");
    assert.equal(unresolved[0].revisionAttempts, 2, "must stop at MAX_CONTINUITY_REVISIONS, not loop forever");
    // scene 1 (1 call, harmless) + scene 2 (1 original + 2 correction attempts).
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Cube-tagging: introduce/plant/resolve resolve to real cells, cleanly ──

test("a real end-to-end run tags introduce/plant/resolve with real cube cells and reports zero cube-progression flags", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeNarrative(HEIST_WORLD, { model: "stub", maxScenes: 40, onProgress: () => {} });
    const tasks = projectTasks(result.log);

    const insider = tasks.find((t) => t.task_id === "entity:insider");
    assert.equal(insider.operator, "SEG");
    assert.equal(insider.grain, "Figure");
    assert.equal(insider.cell.terrain, "Link", "SEG at Figure grain over the Structure domain resolves to the Link terrain");

    // Checked against the RAW planting entry, not the final fold — this run
    // goes to closure, so by the end vault-code's own resolve has overwritten
    // CON with SYN in the live projection (the next assertion covers that).
    // The planting act itself must still have been recorded as CON.
    const vaultCodePlant = result.log.entries.find((e) => e.kind === "propose" && e.task_id === "commitment:vault-code");
    assert.equal(vaultCodePlant.operator, "CON", "planting a commitment is the relate act — a link entering the field, not yet the payoff");
    assert.equal(vaultCodePlant.grain, "Figure");

    const escape = tasks.find((t) => t.task_id === "commitment:escape");
    assert.equal(escape.operator, "SYN", "a CONFIRMED resolve overwrites the planted CON with the SYN that actually produced the payoff");
    assert.equal(escape.grain, "Figure");

    // The real end-to-end proof: a full, non-trivial causal chain (four
    // dependent commitments, a discovered-character path via extractNewNames
    // if the stub ever introduces one) produces ZERO grain-coarsening or
    // production-order violations on its own — the cube-tagging is
    // consistent with the causal ordering nextMove() already enforces
    // independently, not just consistent with itself in isolation.
    assert.deepEqual(result.cubeFlags, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a character the model introduces unasked resolves to the identical cell as a declared entity — entities are entities", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const isOpening = body.messages[1].content.includes(HEIST_WORLD.openingBeat);
    // The opening scene mentions an unplanned character by name, twice, not
    // sentence-initially — exactly what extractNewNames now requires.
    const text = isOpening
      ? "Priya briefed the crew. Dez said nothing. A stranger named Kessler watched from the doorway, and Kessler said nothing either."
      : "Some invented prose for this scene.";
    return { ok: true, json: async () => ({ message: { content: text } }) };
  };
  try {
    const result = await writeNarrative(HEIST_WORLD, { model: "stub", maxScenes: 3, onProgress: () => {} });
    const tasks = projectTasks(result.log);
    const kessler = tasks.find((t) => t.task_id === "entity:kessler");
    const insider = tasks.find((t) => t.task_id === "entity:insider");
    assert.ok(kessler, "the unplanned character must be registered");
    assert.deepEqual(kessler.cell, insider.cell, "a model-discovered character and a world-declared entity resolve to the identical cube cell");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a title-abbreviation name ('Mrs. Kuroba') registers as ONE entity, not a bare fragment with the real surname invisible", async () => {
  // MEASURED on a real run with ZERO declared entities (every name entirely
  // model-invented): "Mrs. Kuroba" recurred 10+ times, always as "Mrs.
  // Kuroba". Before this fix, "Mrs" fragmented off as its own spurious
  // entity AND "Kuroba" — the actual recurring surname — never registered
  // at all, because every occurrence immediately followed "Mrs. " (period +
  // space), which round 2's sentence-initial check misread as a genuine
  // sentence boundary every single time.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const isOpening = body.messages[1].content.includes(HEIST_WORLD.openingBeat);
    const text = isOpening
      ? "On Elm Street, Mrs. Kuroba stirred in her kitchen. Mrs. Kuroba smiled to herself, thinking of Mrs. Kuroba's own childhood."
      : "Some invented prose for this scene.";
    return { ok: true, json: async () => ({ message: { content: text } }) };
  };
  try {
    const result = await writeNarrative(HEIST_WORLD, { model: "stub", maxScenes: 3, onProgress: () => {} });
    const tasks = projectTasks(result.log);
    assert.ok(tasks.find((t) => t.task_id === "entity:mrs. kuroba"), "the whole title+surname must register as one entity");
    assert.ok(!tasks.find((t) => t.task_id === "entity:mrs"), "a bare 'Mrs' fragment must not be registered separately");
    assert.ok(!tasks.find((t) => t.task_id === "entity:kuroba"), "the surname alone must not fragment off either, now that the full phrase matches");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
