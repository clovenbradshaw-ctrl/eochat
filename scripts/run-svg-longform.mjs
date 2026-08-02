// eochat/scripts/run-svg-longform — drive svg-longform.js's self-planning,
// self-verifying diagram build to completion. Same L1 (no dead air)
// discipline as run-code-longform.mjs: progress streamed per element, not
// batched.
//
// Usage: node scripts/run-svg-longform.mjs "<request>" [--model NAME] [--out FILE]

import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeDiagram } from "../server/svg-longform.js";

const args = process.argv.slice(2);
const request = args.find((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const model = flag("model", "llama3.2:latest");
const outPath = flag("out", "./work-diagram/diagram.svg");

if (!request) {
  console.error('usage: node scripts/run-svg-longform.mjs "<request>" [--model NAME] [--out FILE]');
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
const logPath = `${dirname(outPath)}/build-progress.log`;
writeFileSync(logPath, `=== svg-longform build started, model=${model} ===\nrequest: ${request}\n`);
const onProgress = (msg) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
};

const t0 = Date.now();
const result = await writeDiagram(request, { model, outPath, onProgress });
const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

const report = [
  `# svg-longform build report`,
  ``,
  `request: ${request}`,
  `model: ${model} · elements: ${result.elements.length} · elapsed: ${elapsed} min`,
  `layout: ${result.layout.cols}x${result.layout.rows} grid`,
  ``,
  ...(result.gaps.length ? [`## Plan gaps (malformed elements dropped, never silently merged)`, ``, ...result.gaps.map((g) => `- ${g.id ?? "(no id)"}: ${g.reason}`), ``] : []),
  `## Elements`,
  ``,
  ...result.elements.map((e) => `- ${e.id} (${e.kind})${e.from ? ` — ${e.from} → ${e.to}` : ""}`),
  ``,
  `## Syntax verification (REAL xmllint check)`,
  ``,
  ...result.verifications.map((v) => `- ${v.id}: ${v.syntaxOk ? "OK" : `FAILED — ${v.syntaxReason}`}`),
  ``,
  `## Cross-reference continuity (does every href/url(#...) resolve to a declared id)`,
  ``,
  ...(result.continuityFlags.length
    ? result.continuityFlags.map((f) =>
        f.resolved
          ? `- ${f.id}: CORRECTED after ${f.attempts} attempt(s)`
          : `- ${f.id}: references undeclared "${f.ref}" (unresolved after ${f.attempts} attempt(s))`,
      )
    : ["- none flagged — every reference resolves to a real declared id"]),
].join("\n");
writeFileSync(`${dirname(outPath)}/BUILD_REPORT.md`, report);

onProgress(`done in ${elapsed} min — wrote ${outPath}`);
