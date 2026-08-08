// repo-fetch.mjs — mechanizes "clone a repo and copy specific files into
// my own workspace" as ONE reliable action, instead of requiring a small
// model to correctly chain multiple free-form run_shell calls (git clone,
// mkdir -p, cp) with exactly right paths and quoting.
//
// Directly answers a real, measured failure, not a hypothetical one: a
// live run asked the model to clone to /tmp/source (outside its sandbox)
// then splice files in with edit_file/write_file (correctly sandboxed to
// the workspace). The model never recovered from that boundary mismatch —
// it tried calling "mkdir" and "cp" as if they were tools in their own
// right (they aren't; everything must go through run_shell), then tried
// edit_file on the unreachable path, then guessed a wrong run_shell path —
// and repeated that exact 4-call cycle for the rest of its step budget
// (see CRISPR.md's coherence-gate section and react-loop.mjs's detectCycle,
// added specifically because this run exposed a periodic-loop blind spot).
//
// This tool removes the boundary mismatch structurally: the clone happens
// in a scratch directory INSIDE the sandbox, and every requested path is
// copied to that SAME relative path under the sandbox root — so whatever
// the model asked for is immediately reachable by read_file/edit_file/
// write_file, with no shell quoting, no absolute-path reasoning, and no
// possible escape error, because there is no boundary left to cross.

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";

const CLONE_TIMEOUT_MS = 30_000;
const FETCH_SUBDIR = ".crispr-fetch"; // lives inside the sandbox, not hidden from it

function resolveInSandbox(sandboxDir, relPath) {
  const abs = resolve(sandboxDir, String(relPath ?? "."));
  const rel = relative(sandboxDir, abs);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`path "${relPath}" escapes the sandbox directory`);
  }
  return abs;
}

function safeRepoDirName(url) {
  return String(url).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "repo";
}

/**
 * Clone `url` into a scratch directory INSIDE sandboxDir (reused across
 * calls for the same url — cloning is the slow part, not the copy), then
 * copy each of `paths` (repo-relative) to the identical relative path
 * under sandboxDir. Every step is a real fs/exec call this function makes
 * directly — never a shell command string the caller has to construct.
 *
 * @param {object} opts
 * @param {string} opts.url        a git URL, e.g. https://github.com/owner/repo
 * @param {string[]} opts.paths    repo-relative file paths to copy in
 * @param {string} opts.sandboxDir the calling tool's own sandbox root
 */
export function fetchRepoFiles({ url, paths, sandboxDir }) {
  if (!url || typeof url !== "string") return { error: "url is required" };
  if (!Array.isArray(paths) || paths.length === 0) {
    return { error: "paths must be a non-empty array of repo-relative file paths" };
  }

  const cloneDir = join(sandboxDir, FETCH_SUBDIR, safeRepoDirName(url));
  let cloneError = null;

  if (!existsSync(cloneDir)) {
    mkdirSync(dirname(cloneDir), { recursive: true });
    try {
      execSync(`git clone --depth 1 -- "${url}" "${cloneDir}"`, {
        timeout: CLONE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      cloneError = String(err.stderr || err.message || "clone failed").slice(0, 300);
    }
  }

  const copied = [];
  const missing = [];
  const skipped = [];

  if (!cloneError) {
    for (const p of paths) {
      const rel = String(p);
      const src = join(cloneDir, rel);
      if (!existsSync(src)) {
        missing.push(rel);
        continue;
      }
      try {
        const dest = resolveInSandbox(sandboxDir, rel);
        // NEVER overwrite a file already at the destination. Real, measured
        // reason: a live run called fetch_repo_files a second time after
        // editing the first copy, to "fix" an unrelated coherence check —
        // this silently reverted every edit back to the pristine clone,
        // with no error, no warning, forcing the model into a genuine
        // self-inflicted redo loop it never escaped. This tool seeds a
        // file once; it is not a sync, and pretending otherwise cost a
        // real run its entire remaining budget.
        if (existsSync(dest)) {
          skipped.push(rel);
          continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        copied.push(rel);
      } catch (err) {
        missing.push(`${rel} (${err.message})`);
      }
    }
  }

  return {
    copied,
    skipped,
    missing,
    cloneError,
    note: cloneError
      ? "clone failed — check the URL"
      : skipped.length > 0
        ? `${skipped.length} file(s) already existed in your workspace and were NOT overwritten (your earlier edits are safe) — edit them directly, don't re-fetch them`
        : missing.length === 0
          ? "every requested file is now at that same path in your workspace — read_file/edit_file it directly"
          : `${copied.length}/${paths.length} copied; missing ones may be at a different path in this repo`,
  };
}

/** Wires fetch_repo_files onto an existing toolset IN PLACE, scoped to sandboxDir like every file-touching tool. */
export function addFetchRepoFilesTool(toolset, sandboxDir) {
  toolset.tools.fetch_repo_files = {
    description:
      'fetch_repo_files({"url": "https://github.com/owner/repo", "paths": ["server/models/post.js"]}) — clones the repo and copies EXACTLY the files you list into the SAME relative path inside your own workspace, ready to read_file/edit_file right away. ONE-TIME SEED, not a sync: it never overwrites a file already in your workspace, even if you call it again with the same paths — edit files directly instead of re-fetching them.',
    run(args) {
      let result;
      try {
        result = fetchRepoFiles({ url: args?.url, paths: args?.paths, sandboxDir });
      } catch (err) {
        result = { error: err.message };
      }
      toolset.toolCalls.push({ name: "fetch_repo_files", args, result, ts: toolset.toolCalls.length });
      return result;
    },
  };
  return toolset;
}
