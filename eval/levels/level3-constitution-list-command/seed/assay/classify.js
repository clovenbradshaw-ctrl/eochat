export const VERDICTS = Object.freeze({
  PASS: "pass",
  REFUTE: "refute",
  GAP: "gap",
  WAIT: "wait",
});

export const FORBIDDEN_HOST_DEPENDENCIES = Object.freeze([
  "clock",
  "io",
  "randomness",
  "network",
  "filesystem",
]);

export const CONSUMPTION_MODES = Object.freeze(["direct", "surrogate", "none"]);

const EVIDENCE_BOOLEANS = Object.freeze([
  "needs_name_or_surface",
  "is_material_knowledge",
  "is_host_knowledge",
  "medium_agnostic",
  "asserted_agnosticism",
  "is_one_off_fix",
  "weights_present",
  "scores_arrival_alone",
  "unconditional_null",
  "needs_datacenter_compute",
  "undisclosed_script_scope",
  "fold_overclaims_completeness",
  "drilldown_uses_keyword_trigger",
  "surprise_claim_undisambiguated",
]);

export function classify(evidence) {
  const reasons = [];

  if (!evidence || typeof evidence !== "object") {
    return {
      verdict: VERDICTS.GAP,
      placement: null,
      reasons: [...reasons, "II.5 — evidence is not an object; type error before null"],
    };
  }

  for (const key of EVIDENCE_BOOLEANS) {
    if (typeof evidence[key] !== "boolean") {
      return {
        verdict: VERDICTS.GAP,
        placement: null,
        reasons: [`II.5 — evidence.${key} must be a boolean; type error before null`],
      };
    }
  }

  if (!Array.isArray(evidence.host_dependencies || [])) {
    return {
      verdict: VERDICTS.GAP,
      placement: null,
      reasons: ["II.5 — evidence.host_dependencies must be an array; type error before null"],
    };
  }

  if (!CONSUMPTION_MODES.includes(evidence.consumes_source)) {
    return {
      verdict: VERDICTS.GAP,
      placement: null,
      reasons: ["II.5 — evidence.consumes_source must be one of direct|surrogate|none; type error before null"],
    };
  }

  let placement;

  if (evidence.is_host_knowledge) {
    placement = "app";
    reasons.push("II.3 — knowledge of reader/host/moment/interface belongs in the application");
  } else if (evidence.is_material_knowledge) {
    if (evidence.giver) {
      placement = "priors";
      reasons.push("II.2 — witness knowledge about the material belongs in priors and names its giver");
    } else {
      return {
        verdict: VERDICTS.GAP,
        placement: null,
        reasons: ["II.2 — material knowledge without a giver is a wall; report a typed gap, never derive (r ≈ 0.974)"],
      };
    }
  } else if (evidence.needs_name_or_surface) {
    return {
      verdict: VERDICTS.GAP,
      placement: null,
      reasons: ["II.1/II.5 — needs a name string or surface yet is neither witness nor host knowledge; no tier exists"],
    };
  } else {
    placement = "engine";
    reasons.push("II.4 — invariant across every text and every host; the measurement itself");
  }

  if (evidence.consumes_source === "surrogate") {
    return {
      verdict: VERDICTS.REFUTE,
      placement,
      reasons: [
        "II.6 — the book test: this mechanism consumes a stand-in for the source. Read the book, St. John's rule — no summary, paraphrase, or sampler takes its place, in any tier",
      ],
    };
  }

  if (placement === "engine") {
    if (evidence.weights_present) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.8 — the difference test: this mechanism forms its output by weighting what is present, with no perturbation, no null, and no rebuilt ground — it can never differ from itself. Attention is refused as the measurement; the host may attend, the engine never does",
        ],
      };
    }
    if (evidence.scores_arrival_alone) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.9 — the revision test: this mechanism scores the arrival rather than measuring what the arrival revised. Surprise is a witnessed revision of prior structure — apply the candidate to a copy of the prior, decompose the delta across the nine operators, rank it against a null. A sound null does not rescue it — a rebuilt ground is a different question from whether anything moved. A cheap sense organ may nominate; it never decides",
        ],
      };
    }
    if (evidence.surprise_claim_undisambiguated) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.16 — the surprise-disambiguation test: this mechanism reports a surprise/divergence signal without separating narrative novelty from mere genre-distinctiveness, and without disclosing the conflation. 'Surprising relative to a prior' is at least two claims; a consumer cannot tell them apart from one number",
        ],
      };
    }
    if (evidence.unconditional_null) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.10 — the commensurability test: this mechanism's null differs from the observation in an axis other than the one under test. It is a units change, not a ground. The null undergoes what the observation underwent; selection is an axis; commensurability is checked by type, not by hope",
        ],
      };
    }
    if (evidence.fold_overclaims_completeness) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.14 — the fold fidelity test: this mechanism claims completeness for output that compresses its source. 'Lossless' means zero fabrication verified against real source offsets, never completeness — compression that keeps everything is not compression",
        ],
      };
    }
    if (evidence.drilldown_uses_keyword_trigger) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.14 — the fold fidelity test: this mechanism's drill-down trigger is a keyword or substring match against compressed content rather than the organ-computed significance signal that governs the fold. Flooding-by-occurrence relocated into the trigger is not solved",
        ],
      };
    }
    if (evidence.asserted_agnosticism) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.11 — the omnimodal earning test: this mechanism declares medium-agnosticism without an invariance fixture that runs it across modalities. Assertion is not measurement. If the mechanism's specificity is a property of the material, it is received typography and sits in priors with its giver (II.2); if it is a fixed grammar with no giver, no tier exists (II.1/II.5)",
        ],
      };
    }
    if (evidence.undisclosed_script_scope) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.13 — the script earning test: this mechanism is scoped to one language, script, or lexicon and asserts general applicability without a cross-script invariance fixture or a disclosed giver naming its scope. Silence about the boundary is the defect, not the boundary itself",
        ],
      };
    }
    if (evidence.is_one_off_fix) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.7 — the convergence test: this mechanism fixes only this one thing; it is a debt, not an organ. Zoom out — intelligence converges on the same mechanism everywhere it is rewarded for being right",
        ],
      };
    }
    if (evidence.needs_datacenter_compute) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          "II.12 — the local test: this mechanism's correctness depends on compute this lineage does not own. The AI datacenter with infinite GPU compute does not exist; the boundary conditions of the invention are local compute and mainstream hardware. A measurement that presumes the datacenter is refused wherever it is the measurement; a null that does not run locally does not exist",
        ],
      };
    }
    const forbidden = (evidence.host_dependencies || []).filter((dep) =>
      FORBIDDEN_HOST_DEPENDENCIES.includes(dep),
    );
    if (forbidden.length > 0) {
      return {
        verdict: VERDICTS.REFUTE,
        placement,
        reasons: [
          `III.2 — the engine has no ${forbidden.join(", ")}; the host supplies it, the engine never owns it`,
        ],
      };
    }
    if (evidence.level_test && evidence.level_test !== "above") {
      return {
        verdict: VERDICTS.WAIT,
        placement,
        reasons: [`IV.3 — growth rule: the level test returned ${evidence.level_test}; peer or unstable means it waits`],
      };
    }
  }

  return { verdict: VERDICTS.PASS, placement, reasons };
}

export function check(claim) {
  if (!claim || typeof claim !== "object" || !claim.evidence) {
    return {
      verdict: VERDICTS.GAP,
      placement: null,
      reasons: ["II.5 — a claim must carry evidence"],
    };
  }
  const classified = classify(claim.evidence);

  if (classified.verdict !== VERDICTS.PASS) {
    const tail =
      classified.verdict === VERDICTS.GAP
        ? "I.5 — no domain exists for this; it is a gap, not a category"
        : classified.verdict === VERDICTS.WAIT
          ? "IV.3 — awaiting the level test; a non-above organ does not enter the engine"
          : null;
    return {
      ...classified,
      verdict: VERDICTS.REFUTE,
      reasons: tail ? [...classified.reasons, tail] : classified.reasons,
    };
  }

  if (classified.placement !== claim.proposed_placement) {
    return {
      verdict: VERDICTS.REFUTE,
      placement: claim.proposed_placement,
      classified_placement: classified.placement,
      reasons: [
        ...classified.reasons,
        `placement mismatch — proposed ${claim.proposed_placement}, the constitution routes ${classified.placement}`,
      ],
    };
  }

  return { ...classified, verdict: VERDICTS.PASS };
}
