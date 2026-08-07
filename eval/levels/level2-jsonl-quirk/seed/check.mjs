// Provided verification script — the agent is told to make this pass by
// actually running it, not to guess. Do not modify this file.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const dataPath = "._check_fixture.jsonl";
writeFileSync(dataPath, '{"amount":10}\n{"amount":5}\n{"amount":7.5}\n');

let out;
try {
  out = execFileSync("node", ["summarize.js", dataPath], { encoding: "utf8", timeout: 10_000 });
} catch (err) {
  console.error("CHECK: FAIL — summarize.js crashed: " + err.message);
  process.exit(1);
}

const printed = out.trim();
const value = Number(printed);
if (!Number.isFinite(value) || Math.abs(value - 22.5) > 1e-9) {
  console.error(`CHECK: FAIL — expected the sum 22.5, got: ${JSON.stringify(printed)}`);
  process.exit(1);
}

console.log("CHECK: PASS");
