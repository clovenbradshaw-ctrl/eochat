// eochat/scripts/run-narrative — drive narrative-longform.js's self-producing
// scene loop to completion (or the safety guard) and write the result.
//
// L1 (no dead air): progress is streamed per scene as it completes, not
// batched at the end — the default onProgress in narrative-longform.js
// already logs per-scene timing; this just also persists it, since a
// multi-minute-per-scene local model run is exactly the case LAWS.md's L1
// measurement section calls out (a long operation is only compliant if it
// keeps reporting, not just because it eventually finishes).
//
// Usage: node scripts/run-narrative.mjs [--model NAME] [--out DIR] [--name PREFIX]

import { writeFileSync, appendFileSync } from "node:fs";
import { writeNarrative, LIGHTHOUSE_WORLD } from "../server/narrative-longform.js";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const model = flag("model", "llama3.2:latest");
const outDir = flag("out", ".");
const namePrefix = flag("name", "lighthouse-narrative");
const logPath = `${outDir}/${namePrefix}-progress.log`;

writeFileSync(logPath, `=== narrative run started, model=${model} ===\n`);
const onProgress = (msg) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
};

const t0 = Date.now();
const result = await writeNarrative(LIGHTHOUSE_WORLD, { model, onProgress });
const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

writeFileSync(`${outDir}/${namePrefix}.md`, `# The Compass Light\n\n${result.manuscript}`);

const report = [
  `# The Compass Light — narrative-longform run report`,
  ``,
  `model: ${model} · scenes: ${result.sceneCount} · halted by: **${result.haltedBy}** · elapsed: ${elapsed} min`,
  ``,
  `## Mechanical payoff checks (never trusted on the model's say-so)`,
  ``,
  ...result.checks.map((c) => `- ${c.commitmentId} @ scene ${c.scene}: ${c.confirmed ? "CONFIRMED" : "not found"}`),
  ``,
  `## Continuity: detected, corrected where possible, reported honestly either way`,
  ``,
  ...(result.continuityFlags.length
    ? result.continuityFlags.map((f) => {
        if (f.kind === "corrected") return `- scene ${f.scene}: CORRECTED after ${f.revisionAttempts} revision attempt(s)`;
        const unresolvedNote = ` (unresolved after ${f.revisionAttempts} revision attempt(s))`;
        if (f.entityId) return `- scene ${f.scene}: contradicts "${f.entityId}" — contains "${f.term}"${unresolvedNote}`;
        if (f.kind === "inconsistent-within-scene") return `- scene ${f.scene}: "${f.lockId}" is internally inconsistent — ${f.values.join(" vs ")}${unresolvedNote}`;
        return `- scene ${f.scene}: "${f.lockId}" drifted — locked as ${f.locked}, now ${f.found}${unresolvedNote}`;
      })
    : ["- none flagged"]),
  ``,
  `No fixed scene count was declared anywhere in this run — nextMove() decided`,
  `one step at a time from the task-log's own state, and the loop stopped when`,
  `it reported \`${result.haltedBy}\`, not when a plan said to.`,
].join("\n");
writeFileSync(`${outDir}/${namePrefix}-report.md`, report);

onProgress(`done in ${elapsed} min — wrote ${namePrefix}.md, ${namePrefix}-report.md`);
