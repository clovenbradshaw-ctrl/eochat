import { execFileSync } from "node:child_process";

export async function evaluate(sandboxDir) {
  const checks = [];
  const check = (name, fn) => {
    try { checks.push({ name, pass: !!fn(), message: "" }); }
    catch (err) { checks.push({ name, pass: false, message: err.message }); }
  };
  const run = (n) => JSON.parse(execFileSync("node", ["fizzbuzz.js", String(n)], { cwd: sandboxDir, encoding: "utf8", timeout: 10_000 }).trim());

  const expected15 = ["1","2","Fizz","4","Buzz","Fizz","7","8","Fizz","Buzz","11","Fizz","13","14","FizzBuzz"];
  check("N=15 matches the canonical sequence exactly", () => JSON.stringify(run(15)) === JSON.stringify(expected15));
  check("N=1 returns exactly [\"1\"]", () => JSON.stringify(run(1)) === JSON.stringify(["1"]));
  check("N=30 has FizzBuzz at position 30 (index 29)", () => run(30)[29] === "FizzBuzz");
  check("N=30 has Buzz at position 25 (index 24), not FizzBuzz", () => run(30)[24] === "Buzz");

  return { checks };
}
