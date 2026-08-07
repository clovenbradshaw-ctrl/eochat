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
import { sniffBinary, looksLikeWav } from "./media.mjs";
import { perceive as dispatchPerceive } from "./senses.mjs";

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
      description: `read_file({"path": "relative/path.js"}) — read a TEXT file's content (truncated to ${MAX_READ_CHARS} chars, with a stated truncation count, never silent). Refuses honestly on binary content (e.g. a WAV or PNG file) instead of silently corrupting it as garbled text — use perceive to inspect a non-text file's real content instead.`,
      run({ path }) {
        let result;
        try {
          const abs = resolveInSandbox(sandboxDir, path);
          const raw = readFileSync(abs);
          if (sniffBinary(raw)) {
            const hint = looksLikeWav(raw)
              ? "this looks like a WAV audio file — use perceive to inspect its real structure"
              : "read_file only reads text; use perceive to inspect non-text content without corrupting it";
            result = { error: `"${path}" is binary content (${raw.length} bytes), not text — ${hint}` };
          } else {
            const full = raw.toString("utf8");
            const truncated = full.length > MAX_READ_CHARS;
            result = {
              content: full.slice(0, MAX_READ_CHARS),
              truncated,
              withheldChars: truncated ? full.length - MAX_READ_CHARS : 0,
            };
          }
        } catch (err) {
          result = { error: err.message };
        }
        record("read_file", { path }, result);
        return result;
      },
    },
    perceive: {
      description: 'perceive({"path": "relative/anything", "buckets": 16}) — sniff a file\'s REAL format and route it to the narrowest sense this app has for it, bounded so the result never grows with file size: text says so and points you to read_file; WAV gets its real chunk layout, sample rate/channels, duration, and a fixed-size loudness envelope ("buckets" numbers, default 16 — a 10-minute clip costs the same context as a 1-second one); PNG gets its real width/height/color-type from its header (pixel content itself is a stated gap, not decoded). Anything else reports a specific, honest gap AND names which of this app\'s own cataloged vision/OCR systems (server/senses-catalog.js) would apply — none has a live endpoint in this sandbox, so that gap is real, not a bug.',
      run({ path, buckets }) {
        let result;
        try {
          const abs = resolveInSandbox(sandboxDir, path);
          const raw = readFileSync(abs);
          result = dispatchPerceive(raw, path, buckets === undefined ? {} : { buckets });
        } catch (err) {
          result = { error: err.message };
        }
        record("perceive", { path, buckets }, result);
        return result;
      },
    },
    write_file: {
      description: 'write_file({"path": "relative/path.js", "content": "..."}) — write the COMPLETE file content (overwrites; creates parent directories). For a small NEW file. For an existing real file bigger than a few lines, use edit_file instead — you do not have the token budget to retype a whole real file.',
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
    edit_file: {
      description: 'edit_file({"path": "relative/path.js", "old_string": "exact text to find", "new_string": "replacement"}) — surgical edit: old_string must match EXACTLY ONE place in the file (copy it CHARACTER-FOR-CHARACTER from a prior read_file\'s content, including whitespace and indentation — do NOT wrap it in your own extra quote marks, those are not part of the file) or this fails and tells you why (not found, or found N times — add more surrounding context to make it unique). Use this for any real, existing file — it costs only the changed lines, not the whole file.',
      run({ path, old_string, new_string }) {
        let result;
        try {
          const abs = resolveInSandbox(sandboxDir, path);
          const full = readFileSync(abs, "utf8");
          const needle = String(old_string ?? "");
          if (needle === "") {
            result = { error: "old_string must not be empty" };
          } else {
            const occurrences = full.split(needle).length - 1;
            if (occurrences === 0) {
              const stripped = needle.replace(/^(['"`])([\s\S]*)\1$/, "$2");
              const strippedHint = stripped !== needle && full.includes(stripped)
                ? " — old_string appears to be wrapped in extra quote marks that are not actually part of the file; the unquoted text WAS found, try again without wrapping it in quotes"
                : "";
              result = { error: `old_string was not found in the file — it must match the file's actual current content exactly (re-read the file if unsure)${strippedHint}` };
            } else if (occurrences > 1) {
              result = { error: `old_string matches ${occurrences} places in the file — it must be unique; include more surrounding context` };
            } else {
              const next = full.replace(needle, String(new_string ?? ""));
              writeFileSync(abs, next);
              result = { ok: true, bytesWritten: Buffer.byteLength(next) };
            }
          }
        } catch (err) {
          result = { error: err.message };
        }
        record("edit_file", { path, oldLength: (old_string ?? "").length, newLength: (new_string ?? "").length }, result);
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
