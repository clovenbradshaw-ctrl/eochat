// Deterministic coverage for agent/tools.mjs's edit_file organ — the
// surgical old_string/new_string tool grown so the agent can work on real,
// larger files without needing to retype the whole file per write_file's
// token budget. Its safety property (unique match or an honest refusal) is
// the whole point, so it gets pinned down directly, not just exercised
// incidentally through a task run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "./tools.mjs";

function freshSandbox() {
  return mkdtempSync(join(tmpdir(), "tools-test-"));
}

test("edit_file replaces a unique match and writes only the delta", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "const x = 1;\nconst y = 2;\n");
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "a.js", old_string: "const x = 1;", new_string: "const x = 100;" });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "const x = 100;\nconst y = 2;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file refuses an old_string that is not found, with a specific reason", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "const x = 1;\n");
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "a.js", old_string: "const z = 9;", new_string: "const z = 10;" });
    assert.match(result.error, /not found/);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "const x = 1;\n", "the file must be untouched on refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file refuses an old_string that matches more than once, rather than guessing which", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "foo();\nfoo();\n");
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "a.js", old_string: "foo();", new_string: "bar();" });
    assert.match(result.error, /2 places/);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "foo();\nfoo();\n", "the file must be untouched on refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file cannot escape the sandbox", () => {
  const dir = freshSandbox();
  try {
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "../../etc/passwd", old_string: "root", new_string: "x" });
    assert.match(result.error, /escapes the sandbox/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
