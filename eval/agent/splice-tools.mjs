// splice-tools.mjs — mechanized adaptation actions for eoCode, so a small
// model doesn't have to construct a uniquely-disambiguated edit_file call
// for a task that is actually "rename every occurrence of X in this file,"
// a fundamentally different, safer operation than edit_file's one-precise-
// edit contract (which correctly REQUIRES uniqueness, and correctly
// refuses when the caller actually wants a global rename instead).
//
// Real, measured need, not a hypothetical one: a live eoCode run (real
// Ollama model, real cloned code) was asked to rename a field across a
// real file it had just fetched. edit_file correctly refused three times
// in a row ("matches 8 places, must be unique"); the model never
// constructed a more specific match, gave up, and finished without ever
// completing the rename. This tool removes the need for that
// disambiguation entirely for the "rename everywhere" case, which is what
// stage 9 (Splice/adapt) actually needs most of the time.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

function resolveInSandbox(sandboxDir, relPath) {
  const abs = resolve(sandboxDir, String(relPath ?? ""));
  const rel = relative(sandboxDir, abs);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`path "${relPath}" escapes the sandbox directory`);
  }
  return abs;
}

/** Wires replace_in_file onto an existing toolset IN PLACE, sandboxed like every other file-touching tool. */
export function addReplaceInFileTool(toolset, sandboxDir) {
  toolset.tools.replace_in_file = {
    description:
      'replace_in_file({"path": "relative/path.js", "find": "category", "replace": "species"}) — replaces EVERY occurrence of find with replace in the file (a global rename). Use this instead of edit_file when you want to rename something everywhere, not make one surgical edit — edit_file will correctly refuse if find matches more than once.',
    run(args) {
      let result;
      try {
        const abs = resolveInSandbox(sandboxDir, args?.path);
        const find = String(args?.find ?? "");
        if (find === "") {
          result = { error: "find must not be empty" };
        } else {
          const full = readFileSync(abs, "utf8");
          const count = full.split(find).length - 1;
          if (count === 0) {
            result = { error: `"${find}" was not found in the file — re-read it if unsure of the exact text` };
          } else {
            const next = full.split(find).join(String(args?.replace ?? ""));
            writeFileSync(abs, next);
            result = { ok: true, replacedCount: count, bytesWritten: Buffer.byteLength(next) };
          }
        }
      } catch (err) {
        result = { error: err.message };
      }
      toolset.toolCalls.push({ name: "replace_in_file", args, result, ts: toolset.toolCalls.length });
      return result;
    },
  };
  return toolset;
}
