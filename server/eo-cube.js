// eo-cube.js — the EO cube as an application-layer instrument.
//
// eoreader6/CUBE.md is explicit that the cube "describes no data structure in
// this repository and must not become one" — a scaffold for holding a
// proposed organ up against, not a runtime. That constraint binds the engine
// domain (constitution Article I.1). eochat is a thin host (Article I.4): it
// owns the interface, and a lookup table over an already-published, fixed
// 27-cell algebra is exactly the kind of interface-layer bookkeeping a host
// is allowed to own. It is used here only to CHECK an address callers already
// have real evidence for (task-log.js's operator+grain), never to infer one
// from a task's text. That inference path — a classifier deriving a cell from
// content — was tried against this lineage's own engine and refuted:
// shuffling words inside 2,527 paragraphs left 95.7% of cell assignments
// unchanged, and random words hit the modal cell at 34.7% against real prose
// at 33.5% (eoreader6/CUBE.md). Nothing here repeats that mechanism.
//
// Three axes, one coordinate, three pairwise projections (eoreader6/CUBE.md):
//
//   operator = (mode, domain)   what act
//   terrain  = (domain, grain)  on what, at what grain
//   stance   = (mode, grain)    in what posture, at what grain
//
// Operator already fixes (mode, domain) as one pair, so crossing the nine
// operators with the three grains is legal by construction: 9 x 3 = 27, out
// of 729 (mode, domain, grain) triples where domain and mode are left free to
// disagree with each other. The other 702 are type errors, not omissions.

export const MODES = Object.freeze(["Differentiate", "Relate", "Generate"]);
export const DOMAINS = Object.freeze(["Existence", "Structure", "Interpretation"]);
export const GRAINS = Object.freeze(["Ground", "Figure", "Pattern"]);

// operator = (mode, domain). Nine operators, three per domain, three per mode.
export const OPERATORS = Object.freeze({
  NUL: Object.freeze({ mode: "Differentiate", domain: "Existence" }),
  SIG: Object.freeze({ mode: "Relate", domain: "Existence" }),
  INS: Object.freeze({ mode: "Generate", domain: "Existence" }),
  SEG: Object.freeze({ mode: "Differentiate", domain: "Structure" }),
  CON: Object.freeze({ mode: "Relate", domain: "Structure" }),
  SYN: Object.freeze({ mode: "Generate", domain: "Structure" }),
  DEF: Object.freeze({ mode: "Differentiate", domain: "Interpretation" }),
  EVA: Object.freeze({ mode: "Relate", domain: "Interpretation" }),
  REC: Object.freeze({ mode: "Generate", domain: "Interpretation" }),
});

// terrain = (domain, grain)
export const TERRAIN = Object.freeze({
  Existence: Object.freeze({ Ground: "Void", Figure: "Entity", Pattern: "Kind" }),
  Structure: Object.freeze({ Ground: "Field", Figure: "Link", Pattern: "Network" }),
  Interpretation: Object.freeze({ Ground: "Atmosphere", Figure: "Lens", Pattern: "Paradigm" }),
});

// stance = (mode, grain)
export const STANCE = Object.freeze({
  Differentiate: Object.freeze({ Ground: "Clearing", Figure: "Dissecting", Pattern: "Unraveling" }),
  Relate: Object.freeze({ Ground: "Tending", Figure: "Binding", Pattern: "Tracing" }),
  Generate: Object.freeze({ Ground: "Cultivating", Figure: "Making", Pattern: "Composing" }),
});

export function isOperator(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(OPERATORS, code);
}

export function isGrain(grain) {
  return typeof grain === "string" && GRAINS.includes(grain);
}

/**
 * The cell one (operator, grain) pair addresses. Terrain and stance are
 * DERIVED here, never accepted as separate arguments — that is what keeps
 * this function from being able to construct a contradiction the way an
 * independently-assembled address can (see `coherence` below).
 */
export function cellFor(operatorCode, grain) {
  if (!isOperator(operatorCode)) {
    throw new TypeError(`cellFor: ${JSON.stringify(operatorCode)} is not one of the nine operators`);
  }
  if (!isGrain(grain)) {
    throw new TypeError(`cellFor: ${JSON.stringify(grain)} is not one of the three grains (${GRAINS.join(", ")})`);
  }
  const { mode, domain } = OPERATORS[operatorCode];
  return Object.freeze({
    operator: operatorCode,
    mode,
    domain,
    grain,
    terrain: TERRAIN[domain][grain],
    stance: STANCE[mode][grain],
  });
}

/**
 * The full 27-cell registry, keyed "OPERATOR.Grain" — computed from
 * `cellFor` rather than hand-listed, so it cannot drift from it. eoreader4.2
 * carried two ports of this cube whose hand-listed and derived forms
 * disagreed on five cells (eoreader6/CUBE.md, "A known contradiction in the
 * prior engine"); deriving instead of listing is how that specific defect
 * stays unrepeatable here.
 */
export const CELLS = Object.freeze(
  Object.fromEntries(
    Object.keys(OPERATORS).flatMap((op) => GRAINS.map((grain) => [`${op}.${grain}`, cellFor(op, grain)]))
  )
);

/**
 * Coherence check for an address assembled from independently-sourced faces
 * — e.g. an operator produced by one mechanism, a terrain read off a site, a
 * stance read off a posture. Agreement on the shared mode/domain/grain across
 * whichever faces are supplied is the diagonal CUBE.md names; disagreement
 * names exactly which face is out of step rather than silently preferring
 * one. Returns `{ ok: true, cell }` (cell is null if too little was supplied
 * to derive one) or `{ ok: false, reason }` — never throws, because an
 * incoherent address is exactly the finding this function exists to report.
 */
export function coherence({ operator = null, grain = null, terrain = null, stance = null } = {}) {
  if (operator != null && !isOperator(operator)) {
    return Object.freeze({ ok: false, cell: null, reason: `unknown operator ${JSON.stringify(operator)}` });
  }
  if (grain != null && !isGrain(grain)) {
    return Object.freeze({ ok: false, cell: null, reason: `unknown grain ${JSON.stringify(grain)}` });
  }

  if (operator != null && grain != null) {
    const cell = cellFor(operator, grain);
    if (terrain != null && terrain !== cell.terrain) {
      return Object.freeze({
        ok: false,
        cell: null,
        reason: `terrain ${JSON.stringify(terrain)} disagrees with ${operator}.${grain} (expected ${cell.terrain})`,
      });
    }
    if (stance != null && stance !== cell.stance) {
      return Object.freeze({
        ok: false,
        cell: null,
        reason: `stance ${JSON.stringify(stance)} disagrees with ${operator}.${grain} (expected ${cell.stance})`,
      });
    }
    return Object.freeze({ ok: true, cell, reason: null });
  }

  return Object.freeze({
    ok: true,
    cell: null,
    reason: "not enough faces supplied to derive a cell (need at least operator and grain)",
  });
}
