// Independently-authored oracle for a Level 4 (bug-fix-from-symptom) task —
// "independently authored" in the strongest sense here: this does not even
// write new assertions. It runs the REAL, pre-existing conformance suite
// from clovenbradshaw-ctrl/eo-constitution (conformance/assay.test.js, 30
// assertions, written for that project, not for this eval) and trusts it as
// ground truth. The only assertions THIS file adds are integrity guards: the
// agent must fix the real defect, not edit the oracle or the fixtures out
// from under it.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, "seed");

function untouchedFiles(sandboxDir) {
  const claimFiles = readdirSync(join(SEED_DIR, "claims")).map((f) => `claims/${f}`);
  const guarded = ["conformance/assay.test.js", ...claimFiles];
  const tampered = [];
  for (const rel of guarded) {
    const seedPath = join(SEED_DIR, rel);
    const sandboxPath = join(sandboxDir, rel);
    if (!existsSync(sandboxPath) || readFileSync(seedPath, "utf8") !== readFileSync(sandboxPath, "utf8")) {
      tampered.push(rel);
    }
  }
  return tampered;
}

export async function evaluate(sandboxDir) {
  const checks = [];

  const tampered = untouchedFiles(sandboxDir);
  checks.push({
    name: "the real conformance test file and every real claim fixture are byte-identical to the ground truth (no gaming the oracle)",
    pass: tampered.length === 0,
    detail: tampered.length === 0 ? "all untouched" : `modified or missing: ${tampered.join(", ")}`,
  });

  let output = "";
  let exitedZero = false;
  try {
    output = execFileSync("node", ["--test", "conformance/assay.test.js"], {
      cwd: sandboxDir, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    });
    exitedZero = true;
  } catch (err) {
    output = String(err.stdout ?? "") + String(err.stderr ?? "");
    exitedZero = false;
  }
  const failMatch = output.match(/# fail (\d+)/);
  const passMatch = output.match(/# pass (\d+)/);
  const failCount = failMatch ? Number(failMatch[1]) : null;

  checks.push({
    name: "the real, unmodified conformance/assay.test.js suite (30 pre-existing assertions) passes in full",
    pass: exitedZero && failCount === 0,
    detail: `exitedZero=${exitedZero} pass=${passMatch?.[1] ?? "?"} fail=${failMatch?.[1] ?? "?"}`,
  });

  return { checks };
}
