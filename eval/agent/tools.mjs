// Real tool access for the coding agent, bound to one sandbox directory.
// Every tool is a plain (name, description, run(args)) triple — no framework,
// no schema DSL, because the model only ever sees the description as prose
// in the system prompt (see react-loop.mjs's PROTOCOL block).
//
// Safety: every path argument is resolved under `sandboxDir` and rejected if
// it escapes it (no "../../etc/passwd"); run_shell executes with cwd
// pinned to `sandboxDir` and a hard timeout — this is a local eval harness
// running a small local model against throwaway scratch directories, not a
// production sandbox, and that scope is deliberate, not an oversight.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, relative, dirname } from "node:path";

const MAX_READ_CHARS = 4000;
const MAX_SHELL_OUTPUT_CHARS = 3000;
const SHELL_TIMEOUT_MS = 30_000;

function resolveInSandbox(sandboxDir, relPath) {
  const abs = resolve(sandboxDir, String(relPath ?? ""));
  const rel = relative(sandboxDir, abs);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`path "${relPath}" escapes the sandbox directory`);
  }
  return abs;
}

function listAllFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) listAllFiles(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

export function createTools(sandboxDir) {
  const toolCalls = [];
  const record = (name, args, result) => toolCalls.push({ name, args, result, ts: toolCalls.length });

  const tools = {
    list_files: {
      description: 'list_files({}) — list every file in the sandbox directory (relative paths).',
      run() {
        const files = existsSync(sandboxDir) ? listAllFiles(sandboxDir) : [];
        const result = { files };
        record("list_files", {}, result);
        return result;
      },
    },
    read_file: {
      description: `read_file({"path": "relative/path.js"}) — read a file's content (truncated to ${MAX_READ_CHARS} chars, with a stated truncation count, never silent).`,
      run({ path }) {
        let result;
        try {
          const abs = resolveInSandbox(sandboxDir, path);
          const full = readFileSync(abs, "utf8");
          const truncated = full.length > MAX_READ_CHARS;
          result = {
            content: full.slice(0, MAX_READ_CHARS),
            truncated,
            withheldChars: truncated ? full.length - MAX_READ_CHARS : 0,
          };
        } catch (err) {
          result = { error: err.message };
        }
        record("read_file", { path }, result);
        return result;
      },
    },
    write_file: {
      description: 'write_file({"path": "relative/path.js", "content": "..."}) — write the COMPLETE file content (overwrites; creates parent directories).',
      run({ path, content }) {
        let result;
        try {
          const abs = resolveInSandbox(sandboxDir, path);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, String(content ?? ""));
          result = { ok: true, bytesWritten: Buffer.byteLength(String(content ?? "")) };
        } catch (err) {
          result = { error: err.message };
        }
        record("write_file", { path, contentLength: (content ?? "").length }, result);
        return result;
      },
    },
    run_shell: {
      description: `run_shell({"command": "npm test"}) — run a shell command in the sandbox directory. Output truncated to ${MAX_SHELL_OUTPUT_CHARS} chars, ${SHELL_TIMEOUT_MS / 1000}s timeout.`,
      run({ command }) {
        let result;
        try {
          mkdirSync(sandboxDir, { recursive: true });
          const out = execSync(String(command ?? ""), {
            cwd: sandboxDir, timeout: SHELL_TIMEOUT_MS, encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024,
          });
          const truncated = out.length > MAX_SHELL_OUTPUT_CHARS;
          result = { exitCode: 0, output: out.slice(0, MAX_SHELL_OUTPUT_CHARS), truncated };
        } catch (err) {
          const out = String(err.stdout ?? "") + String(err.stderr ?? "");
          result = {
            exitCode: typeof err.status === "number" ? err.status : 1,
            output: out.slice(0, MAX_SHELL_OUTPUT_CHARS),
            truncated: out.length > MAX_SHELL_OUTPUT_CHARS,
            timedOut: err.signal === "SIGTERM" && err.killed === true,
          };
        }
        record("run_shell", { command }, result);
        return result;
      },
    },
    finish: {
      description: 'finish({"summary": "what you did and verified"}) — declare the task complete. Only call this once you have actually run something (a test, the program itself) and observed it working.',
      run(args) {
        record("finish", args, { ok: true });
        return { ok: true };
      },
    },
  };

  return { tools, toolCalls };
}
