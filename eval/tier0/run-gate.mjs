#!/usr/bin/env node
// Runs the whole Tier 0 invariant gate (node's own test runner over every
// *.test.js in this directory) and reports one pass/fail verdict, in the
// exact shape eval/harness.mjs expects. Also runnable standalone:
//
//   node eval/tier0/run-gate.mjs
//
// L1d ("no dead air" under concurrent ingest) is intentionally NOT
// reimplemented here — eochat/scripts/check-laws.mjs::checkConcurrentLoad
// already covers it end-to-end against a live proxy server with real
// ingestion, which this gate has no such server running to reuse. Duplicating
// it against a fake server would test the fake, not the invariant. Run
// `npm run check:laws` (from the eochat root, proxy running) for that one.

import { run } from "node:test";
import { tap } from "node:test/reporters";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runTier0Gate({ quiet = false } = {}) {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort().map((f) => join(__dirname, f));

  let passed = 0, failed = 0;
  const failures = [];
  const stream = run({ files, concurrency: false });

  stream.on("test:pass", () => { passed += 1; });
  stream.on("test:fail", (e) => {
    failed += 1;
    failures.push({ file: e.file, name: e.name, message: e.details?.error?.message || String(e.details?.error || "") });
  });

  if (!quiet) {
    const tapStream = stream.compose(tap);
    tapStream.pipe(process.stdout);
    await finished(tapStream);
  } else {
    for await (const _ of stream) { /* drain silently */ }
  }

  return {
    pass: failed === 0,
    passed,
    failed,
    failures,
    delegated: [
      { invariant: "L1d non-blocking (concurrent ingest)", coveredBy: "eochat/scripts/check-laws.mjs::checkConcurrentLoad (requires a live proxy server, out of scope for this static/unit gate)" },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runTier0Gate({ quiet: process.argv.includes("--quiet") });
  if (!result.pass) {
    console.error(`\nTIER 0 GATE: FAILED (${result.failed} failure(s))`);
    process.exitCode = 1;
  } else {
    console.error(`\nTIER 0 GATE: PASS (${result.passed} assertions)`);
  }
}
