// Independently-authored held-out oracle — a different JSONL fixture than
// the seeded check.mjs, plus an edge case (a trailing blank line, which real
// JSONL files often have) the seed never exercised.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function evaluate(sandboxDir) {
  const checks = [];
  const check = (name, fn) => {
    try { checks.push({ name, pass: !!fn(), message: "" }); }
    catch (err) { checks.push({ name, pass: false, message: err.message }); }
  };

  const run = (jsonl) => {
    const p = join(sandboxDir, `._held_out_${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(p, jsonl);
    const out = execFileSync("node", ["summarize.js", p], { cwd: sandboxDir, encoding: "utf8", timeout: 10_000 });
    return Number(out.trim());
  };

  check("REGRESSION (the seeded quirk): line-delimited JSON, three records", () => {
    const v = run('{"amount":1}\n{"amount":2}\n{"amount":3}\n');
    return Math.abs(v - 6) < 1e-9;
  });

  check("held-out generalization: a trailing blank line after the last record", () => {
    const v = run('{"amount":4}\n{"amount":4}\n\n');
    return Math.abs(v - 8) < 1e-9;
  });

  check("held-out generalization: a single record", () => {
    const v = run('{"amount":42}\n');
    return Math.abs(v - 42) < 1e-9;
  });

  return { checks };
}
