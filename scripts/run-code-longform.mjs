// eochat/scripts/run-code-longform — drive code-longform.js's self-planning,
// self-verifying multi-file build to completion. Same L1 (no dead air)
// discipline as run-narrative.mjs: progress streamed per file, not batched.
//
// Usage: node scripts/run-code-longform.mjs "<request>" [--model NAME] [--out DIR]

import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { writeProject } from "../server/code-longform.js";

const args = process.argv.slice(2);
const request = args.find((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const model = flag("model", "llama3.2:latest");
const outDir = flag("out", "./work-website");

if (!request) {
  console.error('usage: node scripts/run-code-longform.mjs "<request>" [--model NAME] [--out DIR]');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const logPath = `${outDir}/build-progress.log`;
writeFileSync(logPath, `=== code-longform build started, model=${model} ===\nrequest: ${request}\n`);
const onProgress = (msg) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
};

const t0 = Date.now();
const result = await writeProject(request, { model, outDir, onProgress });
const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

const report = [
  `# code-longform build report`,
  ``,
  `request: ${request}`,
  `model: ${model} · files: ${result.files.length} · elapsed: ${elapsed} min`,
  ``,
  `## Files`,
  ``,
  ...result.files.map((f) => `- ${f.path} (${f.language}) — requires: ${(f.requires ?? []).join(", ") || "none"}`),
  ``,
  `## Syntax verification (real check for JS, well-formedness floor for HTML/CSS)`,
  ``,
  ...result.verifications.map((v) => `- ${v.path}: ${v.syntaxOk ? "OK" : `FAILED — ${v.syntaxReason}`}`),
  ``,
  `## Cross-file continuity (does every CSS/JS reference an id or class that actually exists in the HTML)`,
  ``,
  ...(result.continuityFlags.length
    ? result.continuityFlags.map((f) =>
        // MEASURED: unresolved flags come straight from checkCrossFileReferences
        // and use its key "file", not "path" — only the resolved-case object
        // (pushed separately in code-longform.js) has "path". Reading f.path
        // unconditionally printed "undefined:" for every unresolved flag on a
        // real run.
        f.resolved
          ? `- ${f.path}: CORRECTED after ${f.attempts} attempt(s)`
          : `- ${f.file}: references undeclared ${f.kind === "undeclared-id" ? "id" : "class"} "${f.ref}" (unresolved after ${f.attempts} attempt(s))`,
      )
    : ["- none flagged — every reference resolves to something the HTML actually declares"]),
].join("\n");
writeFileSync(`${outDir}/BUILD_REPORT.md`, report);

onProgress(`done in ${elapsed} min — wrote ${result.files.length} files to ${outDir}`);
