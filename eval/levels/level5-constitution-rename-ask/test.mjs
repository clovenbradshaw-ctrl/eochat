// Independently-authored oracle for the Level 5 (cross-file consistency)
// task: a real CLI subcommand renamed everywhere it is genuinely that
// command, and nowhere it is merely the English word. Checks span two real
// files (assay/route.mjs behavior, README.md prose) plus a negative check
// that an unrelated real file using the same English word was left alone.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, "seed");

function runRoute(sandboxDir, args) {
  try {
    const out = execFileSync("node", ["assay/route.mjs", ...args], { cwd: sandboxDir, encoding: "utf8", timeout: 10_000 });
    return { exit: 0, out };
  } catch (err) {
    return { exit: typeof err.status === "number" ? err.status : 1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

export async function evaluate(sandboxDir) {
  const checks = [];

  const renamed = runRoute(sandboxDir, ["classify", "claims/holonic-task.claim.json"]);
  checks.push({
    name: "the new `classify` subcommand works and routes a real claim",
    pass: renamed.exit === 0 && /ROUTED:/.test(renamed.out),
    detail: `exit=${renamed.exit} output_head=${renamed.out.slice(0, 100)}`,
  });

  const old = runRoute(sandboxDir, ["ask", "claims/holonic-task.claim.json"]);
  checks.push({
    name: "the old `ask` name no longer works — this was a rename, not an alias",
    pass: old.exit !== 0 && /unknown mode/i.test(old.out),
    detail: `exit=${old.exit} output_head=${old.out.slice(0, 100)}`,
  });

  const stillWorks = runRoute(sandboxDir, ["check", "claims/holonic-task.claim.json"]);
  checks.push({
    name: "the unrelated `check` subcommand still works (no collateral damage)",
    pass: stillWorks.exit === 0 && /PLACEMENT SUSTAINED/.test(stillWorks.out),
    detail: `exit=${stillWorks.exit}`,
  });

  const readmePath = join(sandboxDir, "README.md");
  const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  const readmeUpdated = readme.includes("classify") && !/route\.mjs\s*(--\s*)?ask\b/.test(readme) && !/`ask`/.test(readme);
  checks.push({
    name: "README.md's documented CLI usage now says classify, not ask",
    pass: readmeUpdated,
    detail: readmeUpdated ? "updated" : "README.md still references the old `ask` command name",
  });

  const amendmentSeedPath = join(SEED_DIR, "AMENDMENT-9-PROPOSAL.md");
  const amendmentSandboxPath = join(sandboxDir, "AMENDMENT-9-PROPOSAL.md");
  const amendmentUntouched = existsSync(amendmentSandboxPath) &&
    readFileSync(amendmentSeedPath, "utf8") === readFileSync(amendmentSandboxPath, "utf8");
  checks.push({
    name: "AMENDMENT-9-PROPOSAL.md is byte-identical to the ground truth — its unrelated use of the word 'ask' was correctly left alone",
    pass: amendmentUntouched,
    detail: amendmentUntouched ? "untouched" : "AMENDMENT-9-PROPOSAL.md was modified or deleted — the agent over-renamed",
  });

  let confOut = "";
  let confExit = null;
  try {
    confOut = execFileSync("node", ["--test", "conformance/assay.test.js"], { cwd: sandboxDir, encoding: "utf8", timeout: 20_000 });
    confExit = 0;
  } catch (err) {
    confOut = String(err.stdout ?? "") + String(err.stderr ?? "");
    confExit = typeof err.status === "number" ? err.status : 1;
  }
  checks.push({
    name: "the real conformance suite (unrelated to route.mjs's CLI naming) still passes in full",
    pass: confExit === 0 && /# fail 0/.test(confOut),
    detail: `exit=${confExit}`,
  });

  return { checks };
}
