// Independently-authored oracle for the Level 6 (long-horizon, multi-stage)
// task: a `stats` subcommand whose four stages (read claims -> call the
// real check() -> tally verdicts -> tally article citations) must each be
// right for the next to be right. Ground truth is computed here by
// importing the REAL, unmodified classify.js from this task's own seed and
// running the exact same check() calls independently — not by re-deriving
// numbers from the claim files' own "expect" field, which would let a
// shortcut implementation (skip check(), just read "expect") pass by
// accident.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, "seed");

async function groundTruth() {
  const { check } = await import(pathToFileURL(join(SEED_DIR, "assay", "classify.js")).href);
  const files = readdirSync(join(SEED_DIR, "claims")).filter((f) => f.endsWith(".claim.json"));
  let pass = 0, refute = 0;
  const articleCounts = {};
  for (const f of files) {
    const claim = JSON.parse(readFileSync(join(SEED_DIR, "claims", f), "utf8"));
    const v = check(claim);
    if (v.verdict === "pass") pass++; else refute++;
    const citedInThisClaim = new Set((v.reasons.join(" ").match(/\b[IVX]+\.\d+\b/g)) || []);
    for (const code of citedInThisClaim) articleCounts[code] = (articleCounts[code] ?? 0) + 1;
  }
  const ranked = Object.entries(articleCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { total: files.length, pass, refute, topArticle: ranked[0] };
}

export async function evaluate(sandboxDir) {
  const checks = [];
  const truth = await groundTruth();

  const claimFiles = readdirSync(join(SEED_DIR, "claims"));
  const tampered = claimFiles.filter((f) => {
    const seedPath = join(SEED_DIR, "claims", f);
    const sandboxPath = join(sandboxDir, "claims", f);
    return !existsSync(sandboxPath) || readFileSync(seedPath, "utf8") !== readFileSync(sandboxPath, "utf8");
  });
  checks.push({
    name: "every real claim fixture is untouched",
    pass: tampered.length === 0,
    detail: tampered.length === 0 ? "all untouched" : `modified/missing: ${tampered.join(", ")}`,
  });

  let out = "";
  let exit = null;
  try {
    out = execFileSync("node", ["assay/route.mjs", "stats"], { cwd: sandboxDir, encoding: "utf8", timeout: 15_000 });
    exit = 0;
  } catch (err) {
    out = String(err.stdout ?? "") + String(err.stderr ?? "");
    exit = typeof err.status === "number" ? err.status : 1;
  }
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);

  checks.push({ name: "`node assay/route.mjs stats` exits 0", pass: exit === 0, detail: `exit=${exit}` });

  const expectedHead = [`TOTAL ${truth.total}`, `PASS ${truth.pass}`, `REFUTE ${truth.refute}`];
  const gotHead = lines.slice(0, 3);
  checks.push({
    name: `stage 1-3: TOTAL/PASS/REFUTE match check() run independently over every real claim (expected ${expectedHead.join(", ")})`,
    pass: JSON.stringify(gotHead) === JSON.stringify(expectedHead),
    detail: `got: ${JSON.stringify(gotHead)}`,
  });

  const expectedTop = truth.topArticle ? `${truth.topArticle[0]} ${truth.topArticle[1]}` : null;
  const hasTop = expectedTop ? lines.slice(3).some((l) => l === expectedTop) : true;
  checks.push({
    name: `stage 4: the single most-cited real article code and its real count appear (expected "${expectedTop}")`,
    pass: hasTop,
    detail: `article lines: ${JSON.stringify(lines.slice(3))}`,
  });

  let checkOut = "";
  let checkExit = null;
  try {
    checkOut = execFileSync("node", ["assay/route.mjs", "check", "claims/holonic-task.claim.json"], { cwd: sandboxDir, encoding: "utf8", timeout: 10_000 });
    checkExit = 0;
  } catch (err) {
    checkOut = String(err.stdout ?? "") + String(err.stderr ?? "");
    checkExit = typeof err.status === "number" ? err.status : 1;
  }
  checks.push({
    name: "the pre-existing `check` subcommand still works (no regression)",
    pass: checkExit === 0 && /PLACEMENT SUSTAINED/.test(checkOut),
    detail: `exit=${checkExit}`,
  });

  return { checks };
}
