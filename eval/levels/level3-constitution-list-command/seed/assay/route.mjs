#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { classify, check, VERDICTS } from "./classify.js";

const usage = `eo-constitution routing assay

usage:
  node assay/route.mjs check <claim.json>   verify a placement claim against the constitution
  node assay/route.mjs ask <evidence.json>  classify evidence and return the routed placement
  node assay/route.mjs help

exit codes:
  0  placement sustained (or classification resolved)
  1  placement refuted / gap / awaiting level — the gate did not pass

claim schema (check):
  {
    "claim_id": "slug",
    "what": "human description",
    "proposed_placement": "engine | priors | app",
    "evidence": {
      "needs_name_or_surface": bool,    // II.1 omnimodal veto
      "is_material_knowledge": bool,    // II.2 witness knowledge
      "giver": "who gives it | ''",     // II.2 must name its giver
      "is_host_knowledge": bool,        // II.3 reader/host/moment/interface
      "medium_agnostic": bool,          // II.4 invariance
      "asserted_agnosticism": bool,     // II.11 omnimodal earning veto (engine claims)
      "is_one_off_fix": bool,           // II.7 convergence veto (engine claims)
      "weights_present": bool,          // II.8 difference veto: weights what is present (engine claims)
      "scores_arrival_alone": bool,     // II.9 revision veto: scores the arrival, not the revision (engine claims)
      "needs_datacenter_compute": bool, // II.12 local veto: presumes the AI datacenter (engine claims)
      "consumes_source": "direct|surrogate|none", // II.6 book test (surrogate refuted everywhere)
      "host_dependencies": [...],       // III.2 engine owns none
      "level_test": "above|peer|unstable" // IV.3 growth rule (engine organs)
    }
  }
`;

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function render(c) {
  const lines = [];
  if (c.claim_id) lines.push(`claim:   ${c.claim_id}`);
  lines.push(`what:    ${c.what ?? "(none)"}`);
  if (c.placement) lines.push(`where:   ${c.placement}`);
  if (c.classified_placement) lines.push(`routes:  ${c.classified_placement}`);
  lines.push("reasons:");
  for (const r of c.reasons) lines.push(`  - ${r}`);
  return lines.join("\n");
}

const [mode, path] = process.argv.slice(2);

if (mode === "help" || !mode) {
  console.log(usage);
  process.exit(mode ? 0 : 1);
}

if (mode === "check") {
  const claim = load(path);
  const verdict = check(claim);
  const report = {
    ...verdict,
    claim_id: claim.claim_id,
    what: claim.what,
  };
  console.log(report.verdict === VERDICTS.PASS ? "PLACEMENT SUSTAINED" : "PLACEMENT REFUTED");
  console.log(render(report));
  process.exit(report.verdict === VERDICTS.PASS ? 0 : 1);
}

if (mode === "ask") {
  const loaded = load(path);
  const evidence = loaded.evidence ?? loaded;
  const verdict = classify(evidence);
  const report = {
    ...verdict,
    what: loaded.what ?? "(bare evidence)",
  };
  if (verdict.verdict === VERDICTS.PASS) {
    console.log(`ROUTED: ${verdict.placement}`);
  } else {
    console.log(`UNROUTED (${verdict.verdict})`);
  }
  console.log(render(report));
  process.exit(verdict.verdict === VERDICTS.PASS ? 0 : 1);
}

console.error(`unknown mode "${mode}"`);
console.error(usage);
process.exit(1);
