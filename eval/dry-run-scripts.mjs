// Fixed, hand-written action sequences for --dry-run: a fast, offline,
// zero-cost way to validate the harness plumbing (sandboxing, seeding,
// holon-coder, oracle scoring, result recording) BEFORE spending real
// CPU-minutes on the actual local model. This is NOT a model and its
// "pass rate" says nothing about agentic capability — it says the harness
// itself works. Labeled as such everywhere it's reported. Plain objects
// here, not hand-escaped JSON strings — scripted-adapter.mjs stringifies
// them, so file content can just be a real multi-line template literal.

const csvConvert = `const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8").trim();
const lines = text.split("\\n");
const headers = lines[0].split(",");
const rows = lines.slice(1).map((line) => {
  const vals = line.split(",");
  const obj = {};
  headers.forEach((h, i) => (obj[h] = vals[i]));
  return obj;
});
console.log(JSON.stringify(rows));
`;

const csvConvertQuoteAware = `const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8").trim();
const lines = text.split("\\n");
const headers = lines[0].split(",");
function parseLine(line) {
  const vals = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { vals.push(cur); cur = ""; continue; }
    cur += c;
  }
  vals.push(cur);
  return vals;
}
const rows = lines.slice(1).map((line) => {
  const vals = parseLine(line);
  const obj = {};
  headers.forEach((h, i) => (obj[h] = vals[i]));
  return obj;
});
console.log(JSON.stringify(rows));
`;

const fizzbuzz = `const n = Number(process.argv[2]);
const out = [];
for (let i = 1; i <= n; i++) {
  if (i % 15 === 0) out.push("FizzBuzz");
  else if (i % 3 === 0) out.push("Fizz");
  else if (i % 5 === 0) out.push("Buzz");
  else out.push(String(i));
}
console.log(JSON.stringify(out));
`;

const jsonlSummarize = `const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const lines = text.split("\\n").filter((l) => l.trim());
let sum = 0;
for (const line of lines) sum += JSON.parse(line).amount;
console.log(sum);
`;

export const DRY_RUN_SCRIPTS = {
  "level1-csv-to-json": [
    { decompose: false },
    { tool: "write_file", args: { path: "convert.js", content: csvConvert } },
    { tool: "write_file", args: { path: "sample.csv", content: "a,b\n1,2\n" } },
    { tool: "run_shell", args: { command: "node convert.js sample.csv" } },
    { tool: "finish", args: { summary: "wrote convert.js, ran it against sample.csv, output matched the expected JSON array" } },
  ],
  "level1-fizzbuzz": [
    { decompose: false },
    { tool: "write_file", args: { path: "fizzbuzz.js", content: fizzbuzz } },
    { tool: "run_shell", args: { command: "node fizzbuzz.js 15" } },
    { tool: "finish", args: { summary: "wrote fizzbuzz.js, ran it for N=15, output looked correct" } },
  ],
  "level2-csv-quoted-comma": [
    { decompose: false },
    { tool: "write_file", args: { path: "convert.js", content: csvConvertQuoteAware } },
    { tool: "run_shell", args: { command: "node check.mjs" } },
    { tool: "finish", args: { summary: "wrote convert.js with quote-aware parsing, node check.mjs printed CHECK: PASS" } },
  ],
  "level2-jsonl-quirk": [
    { decompose: false },
    { tool: "write_file", args: { path: "summarize.js", content: jsonlSummarize } },
    { tool: "run_shell", args: { command: "node check.mjs" } },
    { tool: "finish", args: { summary: "wrote summarize.js handling line-delimited JSON, node check.mjs printed CHECK: PASS" } },
  ],
};
