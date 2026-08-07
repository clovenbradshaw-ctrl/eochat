// Copied verbatim (GAP symbol, GAP_TYPES, gap, isGap) from eoreader6/nul/index.js
// for this task's self-containment. Uses the SAME global symbol registry key
// (Symbol.for) as the real module, so a candidate solution built against this
// file is interoperable with the real one.
const GAP = Symbol.for("eoreader6.gap");

export const GAP_TYPES = Object.freeze([
  "no_ground", "kept_ground", "unreceived_origin", "degenerate_ground", "undeclared",
  "unknown_spec", "empty_material", "exceeds_witness", "made_no_difference", "unstable",
  "incommensurate_extent", "missing_kind_prior", "slack_ground", "anchor_ground",
  "no_candidate", "self_referential", "paradigm_unraveled", "empty_paradigm",
  "no_rezero_trigger", "not_earned", "empty_field", "byte_mismatch", "overlapping_parts",
  "gap_between_parts", "undeclared_organ", "undeclared_cell", "payoff_not_confirmed",
  "model_unreachable", "trending_material",
]);

export const gap = (type, detail = {}) => {
  if (!GAP_TYPES.includes(type)) throw new TypeError(`unknown gap type: ${type}`);
  return Object.freeze({ [GAP]: true, gap: type, ...detail });
};

export const isGap = (x) => Boolean(x && x[GAP] === true);
