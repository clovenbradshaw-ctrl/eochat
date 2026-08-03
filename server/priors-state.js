// priors-state.js — persisted enable/disable state for individual priors,
// keyed by the same `id` priors-source.js's catalog uses
// ("coref/pg84-frankenstein", "morphology-eng", …).
//
// This is its own module, not a field on priors-source.js's cache, for one
// reason: priors-bridge.js (per-text coref steering, consumed by
// engine-ground.js) needs to check "is this prior disabled" too, and
// priors-source.js already imports engine-ground.js (for engineIngestFile /
// engineDeleteSource). If priors-bridge.js imported priors-source.js for this
// flag, the import graph would cycle back through engine-ground.js. A tiny
// dependency-free module both can import avoids that.
//
// Disabling a prior means "stop letting it steer or be searched" — it does
// NOT delete the artifact. The file on disk is untouched; this only records
// a user preference, and priors-source.js/priors-bridge.js are what act on it.

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

const STATE_PATH = path.join(MEMORY_DIR, "priors-disabled.json");

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return new Set(Array.isArray(raw.disabled) ? raw.disabled : []);
  } catch {
    // Missing or unparseable file means "nothing disabled yet" — not an
    // error worth surfacing, since a fresh checkout has no state file at all.
    return new Set();
  }
}

let disabled = load();

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ disabled: [...disabled].sort() }, null, 2));
  } catch {
    // Best-effort: an unwritable memory dir shouldn't crash a toggle click.
    // The in-memory Set still reflects the user's choice for this process
    // lifetime even if it can't survive a restart.
  }
}

export function isPriorDisabled(id) {
  return disabled.has(id);
}

export function disabledPriorIds() {
  return new Set(disabled);
}

// Returns whether this call actually changed anything — callers use that to
// skip redundant engine ingest/delete work on a no-op toggle.
export function setPriorDisabled(id, value) {
  const was = disabled.has(id);
  if (value === was) return false;
  if (value) disabled.add(id);
  else disabled.delete(id);
  persist();
  return true;
}
