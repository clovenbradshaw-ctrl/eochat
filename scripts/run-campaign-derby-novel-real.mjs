// eochat/scripts/run-campaign-derby-novel-real — the REAL-model counterpart
// to run-campaign-derby-novel.mjs. That script stubbed the network call
// with Claude-authored prose because this sandbox had no local model.
// Ollama is now installed and llama3.2:latest is pulled — this drives
// CAMPAIGN_DERBY_WORLD through writeNarrative() against a REAL local CPU
// model, exactly the way scripts/run-narrative.mjs already does for
// LIGHTHOUSE_WORLD. No hand-authored text anywhere in this run: whatever
// comes out is genuinely what the model wrote, mechanically checked.
//
// Usage: node scripts/run-campaign-derby-novel-real.mjs [--model NAME] [--scenes N]

import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { writeNarrative } from "../server/narrative-longform.js";
import { CAMPAIGN_DERBY_WORLD } from "./run-campaign-derby-novel.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const model = flag("model", "llama3.2:latest");
const maxScenes = Number(flag("scenes", "3"));
// CAMPAIGN_DERBY_WORLD declares a 900-1300 word target (chapter-scale, not
// LIGHTHOUSE_WORLD's 220-260-word scenes) — narrative-longform.js's
// DEFAULT_SCENE_TOKENS (420) would truncate every real scene well short of
// that. Sized generously (roughly 1.4 tokens/word, the same verbosity ratio
// LIGHTHOUSE_WORLD's own measured 340-tokens-too-few defect implied) rather
// than guessed.
const sceneTokens = Number(flag("scene-tokens", "2000"));

const outDir = new URL("../eval/narrative-runs/campaign-derby-novel-real", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const namePrefix = "campaign-derby-novel-real";
const logPath = `${outDir}/${namePrefix}-progress.log`;

writeFileSync(logPath, `=== campaign/derby novel run started, REAL model=${model}, capped at ${maxScenes} scene(s) ===\n`);
const onProgress = (msg) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
};

const t0 = Date.now();
const result = await writeNarrative(CAMPAIGN_DERBY_WORLD, { model, maxScenes, onProgress, sceneTokens });
const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

writeFileSync(`${outDir}/${namePrefix}.md`, `# Paper Trail (real ${model} run)\n\n${result.manuscript}`);

const report = [
  `# Paper Trail — REAL ${model} run report`,
  ``,
  `model: ${model} · scenes: ${result.sceneCount} · halted by: **${result.haltedBy}** · elapsed: ${elapsed} min`,
  ``,
  `## Mechanical continuity checks (never trusted on the model's say-so)`,
  ``,
  result.continuityFlags.length
    ? result.continuityFlags.map((f) => `- ${JSON.stringify(f)}`).join("\n")
    : "- none flagged",
  ``,
  `## Mechanical payoff checks`,
  ``,
  result.checks.length
    ? result.checks.map((c) => `- ${c.commitmentId} @ scene ${c.scene}: ${c.confirmed ? "CONFIRMED" : "not found"}`).join("\n")
    : "- none attempted within the scene cap",
  ``,
  `## Cube-progression checks (advisory — grain coarsening / production-order reversal on any single thread)`,
  ``,
  result.cubeFlags.length ? result.cubeFlags.map((f) => `- ${JSON.stringify(f)}`).join("\n") : "- none flagged",
  ``,
  `No fixed chapter count or content was declared beyond the ${maxScenes}-scene cap — nextMove() chose the sequence on its own from the real model's actual output.`,
].join("\n");
writeFileSync(`${outDir}/${namePrefix}-report.md`, report);

onProgress(`done in ${elapsed} min — wrote ${namePrefix}.md, ${namePrefix}-report.md`);
