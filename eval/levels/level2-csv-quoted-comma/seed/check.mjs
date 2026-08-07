// Provided verification script — the agent is told to make this pass by
// actually running it, not to guess. Do not modify this file.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const csvPath = "._check_fixture.csv";
writeFileSync(csvPath, 'name,note\nAlice,"hello, world"\nBob,plain\n');

let out;
try {
  out = execFileSync("node", ["convert.js", csvPath], { encoding: "utf8", timeout: 10_000 });
} catch (err) {
  console.error("CHECK: FAIL — convert.js crashed: " + err.message);
  process.exit(1);
}

let rows;
try {
  rows = JSON.parse(out.trim());
} catch {
  console.error("CHECK: FAIL — convert.js did not print valid JSON. Got:\n" + out);
  process.exit(1);
}

if (rows.length !== 2 || rows[0].note !== "hello, world" || rows[1].note !== "plain") {
  console.error("CHECK: FAIL — expected row 0 note to be exactly \"hello, world\" (comma preserved, quotes stripped). Got: " + JSON.stringify(rows));
  process.exit(1);
}

console.log("CHECK: PASS");
