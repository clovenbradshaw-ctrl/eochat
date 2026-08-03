// senses-state.js — persisted subscribe/activate/endpoint state for the
// Senses tab, keyed by the same `id` senses-catalog.js's catalog uses
// ("holo2", "dots-ocr", …) — or, for a sense promoted from Hub discovery
// (senses-hf.js), the Hub's own id ("Hcompany/Holo2-8B").
//
// Mirrors priors-state.js: a tiny dependency-free module, not a field on any
// larger store, so both the /api/senses routes and (later) an ingest path
// can check it without an import cycle.
//
// Three independent facts per sense, not one flag:
//   - subscribed: added to the reader's library. Doesn't run anything yet.
//   - active:     selected to run on ingestion. Only meaningful for a
//                 subscribed sense — activating cascades a subscribe,
//                 unsubscribing cascades an unactivate, so the two can never
//                 drift into "active but not subscribed".
//   - endpoint:   where to reach it (self-hosted or cloud). Absent means the
//                 sense is a library entry with nowhere to send work — a real
//                 gap the ingest paths report rather than silently skip.
//
// A fourth thing lives here too: customSenses, catalog-shaped entries for
// senses promoted from Hub discovery rather than hand-curated in
// senses-catalog.js. Same shape, same state machine — discovery just adds to
// the id space the other three facts are keyed by.

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

const STATE_PATH = path.join(MEMORY_DIR, "senses-state.json");

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      subscribed: new Set(Array.isArray(raw.subscribed) ? raw.subscribed : []),
      active: new Set(Array.isArray(raw.active) ? raw.active : []),
      endpoints: new Map(Object.entries(raw.endpoints && typeof raw.endpoints === "object" ? raw.endpoints : {})),
      customSenses: new Map(Object.entries(raw.customSenses && typeof raw.customSenses === "object" ? raw.customSenses : {})),
    };
  } catch {
    // Missing or unparseable file means "nothing subscribed yet" — not an
    // error worth surfacing, since a fresh checkout has no state file at all.
    return { subscribed: new Set(), active: new Set(), endpoints: new Map(), customSenses: new Map() };
  }
}

let state = load();

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      subscribed: [...state.subscribed].sort(),
      active: [...state.active].sort(),
      endpoints: Object.fromEntries(state.endpoints),
      customSenses: Object.fromEntries(state.customSenses),
    }, null, 2));
  } catch {
    // Best-effort: an unwritable memory dir shouldn't crash a toggle click.
    // The in-memory state still reflects the choice for this process
    // lifetime even if it can't survive a restart.
  }
}

export function isSenseSubscribed(id) {
  return state.subscribed.has(id);
}

export function isSenseActive(id) {
  return state.active.has(id);
}

export function senseEndpoint(id) {
  return state.endpoints.get(id) || "";
}

export function subscribedSenseIds() {
  return new Set(state.subscribed);
}

export function activeSenseIds() {
  return new Set(state.active);
}

export function senseEndpoints() {
  return Object.fromEntries(state.endpoints);
}

// Subscribing/unsubscribing. Unsubscribing also deactivates — an
// unsubscribed sense that stayed "active on ingestion" would be a switch the
// reader can no longer see, still silently steering ingestion.
export function setSenseSubscribed(id, value) {
  const wasSubscribed = state.subscribed.has(id);
  let changed = false;
  if (value !== wasSubscribed) {
    if (value) state.subscribed.add(id);
    else state.subscribed.delete(id);
    changed = true;
  }
  let activeChanged = false;
  if (!value && state.active.has(id)) {
    state.active.delete(id);
    activeChanged = true;
  }
  if (changed || activeChanged) persist();
  return { id, subscribed: state.subscribed.has(id), active: state.active.has(id), changed: changed || activeChanged };
}

// Activating an unsubscribed sense is a caller error, not a silent
// auto-subscribe — the reader asked to activate something they never added
// to their library, and the honest answer is "subscribe it first", named as
// an error rather than acted on as if they'd done both.
export function setSenseActive(id, value) {
  if (value && !state.subscribed.has(id)) {
    return { id, active: state.active.has(id), changed: false, error: "not subscribed" };
  }
  const was = state.active.has(id);
  if (value === was) return { id, active: was, changed: false };
  if (value) state.active.add(id);
  else state.active.delete(id);
  persist();
  return { id, active: state.active.has(id), changed: true };
}

export function setSenseEndpoint(id, url) {
  const trimmed = (url || "").trim();
  const prior = state.endpoints.get(id) || "";
  if (trimmed === prior) return { id, endpoint: prior, changed: false };
  if (trimmed) state.endpoints.set(id, trimmed);
  else state.endpoints.delete(id);
  persist();
  return { id, endpoint: trimmed, changed: true };
}

export function customSensesList() {
  return [...state.customSenses.values()].map((s) => ({ ...s }));
}

export function customSense(id) {
  const s = state.customSenses.get(id);
  return s ? { ...s } : null;
}

// Promotes a discovered Hub entry into the library, catalog-shaped so it
// flows through the same subscribe/active/endpoint machinery as the
// hand-curated 14. Does not itself subscribe it — same "two separate
// actions" contract as everything else here; the /api/senses/discover/add
// route calls setSenseSubscribed right after this.
export function addCustomSense(entry) {
  if (!entry || !entry.id) throw new Error("custom sense needs an id");
  state.customSenses.set(entry.id, { ...entry });
  persist();
  return { ...entry };
}
