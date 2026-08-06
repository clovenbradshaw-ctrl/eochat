// Node-only inputs to the deliberate long-form orchestrator (longform-orchestrator.js).
//
// Kept separate from longform.js and the orchestrator on purpose: both of
// those are served byte-identical to the browser (see the /shared/ route in
// proxy.js), so anything that touches the filesystem has to live here
// instead, never in a file the browser also imports.

import fs from "node:fs";
import path from "node:path";
import { PRIORS_ROOT } from "./paths.js";
import { discoverCast, castSurfaces } from "../vendor/eoreader5/packages/engine/referents/discover-cast.js";

// The morphology prior, loaded once. Absent => attributionResidual's
// checkAttribution call reports a gap and degrades to suffix stemming, which
// provably misses every irregular — degraded, not broken.
let _morph;
export function loadMorphologyPrior() {
  if (_morph !== undefined) return _morph;
  const p = path.join(PRIORS_ROOT, "priors", "morphology-eng.json");
  _morph = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  return _morph;
}

// Cast discovery for whichever sources this turn's citations actually came
// from — generic, corpus-agnostic (discoverCast reads whatever file the
// citation points to; nothing here names a specific book).
//
// Deliberately NOT included: write-longform.mjs's original narratorSpans
// path additionally unioned in a hand-curated coref prior and re-derived
// narrator spans via earnNesting() — but that prior is witness-tier ("injected,
// never derived", borrowed-form.js) and exactly one exists on disk
// (pg84-frankenstein, for the Frankenstein test corpus specifically). There is
// no way to discover the right prior id for an arbitrary reader-ingested
// document, so a general-purpose orchestrator that runs on ANY corpus cannot
// assume one exists. attributionResidual already degrades gracefully with
// narratorSpans: [] (first-person "I" simply isn't scope-resolved), so this
// is a real, honest capability gap for first-person narrative sources — not
// a bug — rather than a fabricated prior for corpora that never had one.
export function discoverNarratorContext(citations) {
  const cast = [];
  const seen = new Set();
  for (const c of citations || []) {
    const src = String(c.source_id ?? c.source ?? "").replace(/^source:/, "").replace(/:chunk-\d+$/, "");
    if (!src || seen.has(src)) continue;
    seen.add(src);
    try {
      const body = fs.readFileSync(src, "utf8");
      const found = discoverCast(body);
      cast.push(...castSurfaces(found.cast));
    } catch { /* unreadable or non-file source — its referents simply are not nameable */ }
  }
  return { narratorSpans: [], cast: [...new Set(cast)] };
}
