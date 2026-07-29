// Every path EOChat needs to reach outside its own repo, resolved in one place.
//
// The old proxy hardcoded seven `/Users/mlacy/Documents/Default Project/...`
// absolute paths and reached for `../eoPriors` by walking up out of its own
// directory. Both assumed one developer's checkout: the first breaks on any
// other machine, and the second breaks the moment the file moves. This repo
// vendors its dependencies as pinned submodules under `vendor/`, so the
// defaults below are repo-relative and correct for any clone.
//
// Every value is overridable by environment variable, because the submodule is
// the DEFAULT source of engine/priors, not the only legal one — a developer
// working on eoreader5 itself will want to point EOChat at their live checkout
// without editing code.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The eochat repo root — one level up from server/. */
export const REPO_ROOT = path.resolve(__dirname, "..");

/** Pinned engine checkout. Override with EOCHAT_ENGINE_PATH. */
export const ENGINE_ROOT = path.resolve(
  process.env.EOCHAT_ENGINE_PATH || path.join(REPO_ROOT, "vendor", "eoreader5")
);

/** Pinned priors checkout. Override with EOCHAT_PRIORS_PATH. */
export const PRIORS_ROOT = path.resolve(
  process.env.EOCHAT_PRIORS_PATH || path.join(REPO_ROOT, "vendor", "eoPriors")
);

/** Per-text coref alias/narrator priors — witness-tier, injected never derived. */
export const COREF_DIR = path.join(PRIORS_ROOT, "priors", "coref");

/** Where the model-router ledger and other durable state live. */
export const MEMORY_DIR = path.resolve(
  process.env.EOCHAT_MEMORY_PATH || path.join(REPO_ROOT, "memory")
);

/** The static UI this server serves. */
export const UI_DIR = path.join(REPO_ROOT, "ui");

/**
 * Repos the codebase-navigation tools may index. Defaults to the vendored
 * dependencies plus this repo — never a hardcoded home directory.
 * Override with EOCHAT_INDEX_REPOS (colon-separated).
 */
export const INDEX_REPOS = (process.env.EOCHAT_INDEX_REPOS
  ? process.env.EOCHAT_INDEX_REPOS.split(":").filter(Boolean)
  : [REPO_ROOT, ENGINE_ROOT, PRIORS_ROOT]
).filter((p) => fs.existsSync(p));

/**
 * Fail loudly at boot rather than degrading into "no source material found".
 * A missing submodule previously surfaced as an empty corpus and an answer
 * that said the sources did not contain the answer — a data-absence message
 * for what is really a setup error, which is the single most misleading thing
 * this server can say.
 */
export function assertDependencies() {
  const missing = [];
  if (!fs.existsSync(path.join(ENGINE_ROOT, "packages", "engine"))) {
    missing.push(`engine not found at ${ENGINE_ROOT}`);
  }
  if (!fs.existsSync(path.join(PRIORS_ROOT, "priors"))) {
    missing.push(`priors not found at ${PRIORS_ROOT}`);
  }
  if (missing.length) {
    throw new Error(
      `EOChat dependencies missing:\n  - ${missing.join("\n  - ")}\n\n` +
        `If you just cloned, run:  git submodule update --init --recursive\n` +
        `Or point at a live checkout with EOCHAT_ENGINE_PATH / EOCHAT_PRIORS_PATH.`
    );
  }
}
