// eochat/scripts/run-minimal-narrative-real — a stress test of entity
// MINTING, not entity FOLLOWING. campaign-derby-novel's world pre-declares
// most of what matters (roster, entity descriptions, commitment facts); the
// model's job there is mostly to render prose around already-decided facts.
// Here almost nothing is declared: empty roster, EMPTY entities ({}), one
// single connective commitment with no requires. Nearly every named person,
// place, and thing in the resulting manuscript has to be invented by the
// model and picked up by extractNewNames/proposeDiscovered — this is the
// real test of whether "entities get minted properly and tracked" holds up
// when the ad hoc mechanism is doing ALL the work, not just some of it (see
// campaign-derby-novel-real's own Scene 1 "Eclipse" vs Scene 3 "Paper Trail"
// collision — an ad hoc invention colliding with a LATER declared entity;
// this run has no declared entities at all for anything to collide with).
//
// Usage: node scripts/run-minimal-narrative-real.mjs [--model NAME] [--scenes N]

import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { writeNarrative } from "../server/narrative-longform.js";
import { projectTasks } from "../server/task-log.js";

export const MINIMAL_WORLD = {
  premise: "A single day unfolds in a small mountain town, one scene at a time — who lives there, what they're doing, discovered as it goes rather than decided in advance.",
  roster: [], // MINIMAL: nobody pre-named. Every person who appears has to be minted by extractNewNames.
  motifs: [],
  openingBeat: "Open on the town at first light. Let the reader meet whoever is naturally there, doing whatever they'd actually be doing at that hour. End on one small, specific, concrete detail that naturally invites a next scene.",
  style: "a warm, observational, character-driven literary style, closely physical and specific, no melodrama",
  targetWords: [220, 300],
  entities: {}, // MINIMAL: zero declared entities — the whole point of this run.
  commitments: {
    // One single connective thread, no requires, so the engine has
    // something to plant/beat/resolve across several scenes instead of
    // closing after scene 1 (an empty entities+commitments world would
    // legally close immediately — see nextMove's own "openCommitments.length
    // > 0 ? beat : close" branch).
    "quiet-shift": {
      fact: "Something quietly shifts for at least one person in the town today — small, real, not explained away, that changes in some small way how they see their own place in it.",
      checkTerms: ["changed", "shift", "realized", "different now", "from now on", "wasn't the same"],
      cooldownScenes: 2,
    },
  },
  beatPrompts: [
    "A quiet, ordinary moment in a DIFFERENT part of town, with whoever is naturally there — a new person may appear if the scene calls for one. Do not resolve anything open.",
    "A small, specific interaction between two people already established (or one new one) that reveals something about them without resolving the open thread. Do not resolve anything open.",
  ],
};

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const model = flag("model", "llama3.2:latest");
const maxScenes = Number(flag("scenes", "8"));
const sceneTokens = Number(flag("scene-tokens", "600"));

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = new URL("../eval/narrative-runs/minimal-seeding-real", import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });
  const namePrefix = "minimal-seeding-real";
  const logPath = `${outDir}/${namePrefix}-progress.log`;

  writeFileSync(logPath, `=== minimal-seeding narrative run started, REAL model=${model}, zero declared entities ===\n`);
  const onProgress = (msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    console.log(line);
    appendFileSync(logPath, line + "\n");
  };

  const t0 = Date.now();
  const result = await writeNarrative(MINIMAL_WORLD, { model, maxScenes, onProgress, sceneTokens });
  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

  writeFileSync(`${outDir}/${namePrefix}.md`, `# Untitled (minimal-seeding real run)\n\n${result.manuscript}`);

  // The actual claim under test: every entity in the live task set was
  // MINTED by extractNewNames (task_id starts with "entity:" and NONE were
  // declared in MINIMAL_WORLD.entities, which is empty) — so if any exist at
  // all, they are proof the ad hoc mechanism did all the work, not some of it.
  const tasks = projectTasks(result.log);
  const mintedEntities = tasks.filter((t) => t.task_id.startsWith("entity:"));

  const report = [
    `# Minimal-seeding narrative — REAL ${model} run report`,
    ``,
    `model: ${model} · scenes: ${result.sceneCount} · halted by: **${result.haltedBy}** · elapsed: ${elapsed} min`,
    `declared entities in the world: **0** (MINIMAL_WORLD.entities = {})`,
    `entities actually minted by extractNewNames during the run: **${mintedEntities.length}**`,
    ``,
    `## Every minted entity — its cube cell, and the scene that surfaced it`,
    ``,
    mintedEntities.length
      ? mintedEntities.map((t) => `- \`${t.task_id}\` — "${t.description}" — cell: ${t.operator}/${t.grain} (${t.cell?.terrain ?? "no cell"}) — depends_on: ${JSON.stringify(t.depends_on)}`).join("\n")
      : "- NONE MINTED — a real, reportable finding if the model's prose never repeated a proper noun non-sentence-initially, not silently glossed over",
    ``,
    `## Mechanical continuity checks (never trusted on the model's say-so)`,
    ``,
    result.continuityFlags.length ? result.continuityFlags.map((f) => `- ${JSON.stringify(f)}`).join("\n") : "- none flagged (expected — MINIMAL_WORLD declares no conflictTerms/numericLocks; there is nothing FOR this check to catch here by construction)",
    ``,
    `## Mechanical payoff checks`,
    ``,
    result.checks.length ? result.checks.map((c) => `- ${c.commitmentId} @ scene ${c.scene}: ${c.confirmed ? "CONFIRMED" : "not found"}`).join("\n") : "- none attempted",
    ``,
    `## Cube-progression checks (advisory)`,
    ``,
    result.cubeFlags.length ? result.cubeFlags.map((f) => `- ${JSON.stringify(f)}`).join("\n") : "- none flagged",
  ].join("\n");
  writeFileSync(`${outDir}/${namePrefix}-report.md`, report);

  onProgress(`done in ${elapsed} min — ${mintedEntities.length} entit${mintedEntities.length === 1 ? "y" : "ies"} minted from ZERO declared — wrote ${namePrefix}.md, ${namePrefix}-report.md`);
}
