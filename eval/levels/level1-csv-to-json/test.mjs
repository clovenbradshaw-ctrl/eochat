// Independently-authored, held-out test cases — never shown to the agent.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function evaluate(sandboxDir) {
  const checks = [];
  const check = (name, fn) => {
    try { checks.push({ name, pass: !!fn(), message: "" }); }
    catch (err) { checks.push({ name, pass: false, message: err.message }); }
  };

  const run = (csv) => {
    const p = join(sandboxDir, `._held_out_${Math.random().toString(36).slice(2)}.csv`);
    writeFileSync(p, csv);
    const out = execFileSync("node", ["convert.js", p], { cwd: sandboxDir, encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out.trim());
  };

  check("held-out case 1: two rows, two columns", () => {
    const got = run("name,age\nAlice,30\nBob,25\n");
    return JSON.stringify(got) === JSON.stringify([{ name: "Alice", age: "30" }, { name: "Bob", age: "25" }]);
  });

  check("held-out case 2: three columns, three rows, different data", () => {
    const got = run("city,country,pop\nOslo,Norway,700000\nLima,Peru,9000000\nDakar,Senegal,1100000\n");
    return JSON.stringify(got) === JSON.stringify([
      { city: "Oslo", country: "Norway", pop: "700000" },
      { city: "Lima", country: "Peru", pop: "9000000" },
      { city: "Dakar", country: "Senegal", pop: "1100000" },
    ]);
  });

  check("held-out case 3: single data row", () => {
    const got = run("a,b\n1,2\n");
    return JSON.stringify(got) === JSON.stringify([{ a: "1", b: "2" }]);
  });

  return { checks };
}
