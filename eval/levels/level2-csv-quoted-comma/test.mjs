// Independently-authored held-out oracle — deliberately broader than the
// seeded check.mjs the agent was told to satisfy, so passing check.mjs by
// coincidence (or by narrowly special-casing its exact fixture) doesn't
// register as a real fix.
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

  check("plain CSV with no quoting still works", () => {
    const got = run("a,b\n1,2\n3,4\n");
    return JSON.stringify(got) === JSON.stringify([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });

  check("REGRESSION (the seeded quirk): a quoted field with an embedded comma is preserved intact", () => {
    const got = run('name,note\nAlice,"hello, world"\nBob,plain\n');
    return got.length === 2 && got[0].note === "hello, world" && got[1].note === "plain";
  });

  check("held-out generalization: TWO quoted fields with commas in the SAME row", () => {
    const got = run('a,b,c\n"x, y","p, q",z\n');
    return got.length === 1 && got[0].a === "x, y" && got[0].b === "p, q" && got[0].c === "z";
  });

  check("held-out generalization: a quoted field with no comma inside still has quotes stripped", () => {
    const got = run('name,note\nAlice,"just quoted"\n');
    return got[0].note === "just quoted";
  });

  return { checks };
}
