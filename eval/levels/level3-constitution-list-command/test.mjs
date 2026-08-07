// Independently-authored oracle for the Level 3 "real codebase" task: add a
// `list` subcommand to a real CLI (clovenbradshaw-ctrl/eo-constitution's
// assay/route.mjs) without being told the exact implementation, verified
// against the REAL claim fixtures on disk (not a hand-picked sample), plus a
// regression guard that the pre-existing `check` subcommand still works.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, "seed");

function realClaimList() {
  return readdirSync(join(SEED_DIR, "claims"))
    .filter((f) => f.endsWith(".claim.json"))
    .map((f) => JSON.parse(readFileSync(join(SEED_DIR, "claims", f), "utf8")))
    .map((c) => `${c.claim_id} ${c.expect}`)
    .sort();
}

export async function evaluate(sandboxDir) {
  const checks = [];

  const claimFiles = readdirSync(join(SEED_DIR, "claims"));
  const tampered = claimFiles.filter((f) => {
    const seedPath = join(SEED_DIR, "claims", f);
    const sandboxPath = join(sandboxDir, "claims", f);
    return !existsSync(sandboxPath) || readFileSync(seedPath, "utf8") !== readFileSync(sandboxPath, "utf8");
  });
  checks.push({
    name: "every real claim fixture is untouched (the new command reads them, never edits them)",
    pass: tampered.length === 0,
    detail: tampered.length === 0 ? "all untouched" : `modified/missing: ${tampered.join(", ")}`,
  });

  let listOut = "";
  let listExit = null;
  try {
    listOut = execFileSync("node", ["assay/route.mjs", "list"], { cwd: sandboxDir, encoding: "utf8", timeout: 10_000 });
    listExit = 0;
  } catch (err) {
    listOut = String(err.stdout ?? "") + String(err.stderr ?? "");
    listExit = typeof err.status === "number" ? err.status : 1;
  }
  checks.push({ name: "`node assay/route.mjs list` exits 0", pass: listExit === 0, detail: `exit=${listExit}` });

  const expected = realClaimList();
  const actualLines = listOut.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const matches = JSON.stringify(actualLines) === JSON.stringify(expected);
  checks.push({
    name: `list output has exactly one correctly-formatted "<claim_id> <expect>" line per real claim fixture (${expected.length} expected), sorted`,
    pass: matches,
    detail: matches ? "matched" : `expected ${expected.length} line(s), got ${actualLines.length}; first mismatch context: expected=${JSON.stringify(expected.slice(0, 3))} actual=${JSON.stringify(actualLines.slice(0, 3))}`,
  });

  // Regression guard: a claim already known to pass under the real,
  // unmodified classify.js must still sustain after the edit.
  let checkOut = "";
  let checkExit = null;
  try {
    checkOut = execFileSync("node", ["assay/route.mjs", "check", "claims/holonic-task.claim.json"], {
      cwd: sandboxDir, encoding: "utf8", timeout: 10_000,
    });
    checkExit = 0;
  } catch (err) {
    checkOut = String(err.stdout ?? "") + String(err.stderr ?? "");
    checkExit = typeof err.status === "number" ? err.status : 1;
  }
  checks.push({
    name: "the pre-existing `check` subcommand still sustains a real passing claim (no regression)",
    pass: checkExit === 0 && /PLACEMENT SUSTAINED/.test(checkOut),
    detail: `exit=${checkExit} output_head=${checkOut.slice(0, 120)}`,
  });

  return { checks };
}
