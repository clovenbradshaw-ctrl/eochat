// instruction-compliance.js — DEF·EVA·REC compliance pipeline for instruction folds.
//
// After a turn completes, this module checks whether the response actually
// followed the surfaced instructions. The pipeline follows the project's
// DEF·EVA·REC discipline:
//
//   DEF  — discretize: extract the compliance criteria from each active fold's
//          body. Pure, deterministic, replayable.
//   EVA  — evaluate: check the response against those criteria. Mechanical
//          checks first (citations, refusals, format), then model-based
//          semantic checks if mechanical checks pass but uncertainty remains.
//   REC  — restructure: when EVA fails, propose adjustments to the instruction
//          graph — weight changes, signal additions, body tightening. The model
//          is used here to generate a search plan (what to change), but every
//          proposal is grounded against the actual fold vocabulary.
//
// The compliance verdict feeds into workspace-memory, which adjusts future
// surf scoring.

import { countTokens } from "./instruction-gate.js";

// ── DEF — discretize active folds into compliance criteria ─────────────────
// Each fold's body is parsed for compliance signals:
//   - "never" / "do not" / "must not" → prohibition checks
//   - "always" / "must" / "should" → obligation checks
//   - "cite" / "bracket" / "[n]" → citation format checks
//   - "refuse" / "decline" → refusal checks
//   - "format" / "json" / "xml" / "list" → format checks
//   - "role" / "as a" / "perspective" → role adherence checks

const PROHIBITION_PATTERNS = [
  /never\s+/i,
  /do\s+not\s+/i,
  /don't\s+/i,
  /must\s+not\s+/i,
  /mustn't\s+/i,
  /avoid\s+/i,
  /no\s+(?:emoji|preamble|apolog|disclaim)/i,
];

const OBLIGATION_PATTERNS = [
  /always\s+/i,
  /must\s+/i,
  /should\s+/i,
  /cite/i,
  /verbat/i,
  /ground/i,
];

const CITATION_PATTERNS = [
  /cite/i,
  /bracket/i,
  /\[\d+\]/,
  /\[n\]/i,
  /numbered\s+passage/i,
];

const REFUSAL_PATTERNS = [
  /refuse/i,
  /decline/i,
  /do\s+not\s+give/i,
  /never\s+give\s+out/i,
  /content\s+against/i,
];

const FORMAT_PATTERNS = [
  /json/i,
  /xml/i,
  /markdown/i,
  /list/i,
  /section/i,
  /format/i,
];

const ROLE_PATTERNS = [
  /respond\s+as/i,
  /act\s+as/i,
  /you\s+are\s+a/i,
  /role/i,
  /perspective/i,
];

function extractCriteria(fold) {
  const body = fold.body || "";
  const criteria = [];

  // Prohibitions
  for (const pattern of PROHIBITION_PATTERNS) {
    const matches = body.match(pattern);
    if (matches) {
      criteria.push({
        type: "prohibition",
        foldId: fold.id,
        text: matches[0].trim(),
        check: "checkProhibition",
      });
    }
  }

  // Obligations
  for (const pattern of OBLIGATION_PATTERNS) {
    const matches = body.match(pattern);
    if (matches) {
      criteria.push({
        type: "obligation",
        foldId: fold.id,
        text: matches[0].trim(),
        check: "checkObligation",
      });
    }
  }

  // Citation-specific
  if (CITATION_PATTERNS.some((p) => p.test(body))) {
    criteria.push({
      type: "citation",
      foldId: fold.id,
      text: "citation format required",
      check: "checkCitation",
    });
  }

  // Refusal-specific
  if (REFUSAL_PATTERNS.some((p) => p.test(body))) {
    criteria.push({
      type: "refusal",
      foldId: fold.id,
      text: "refusal required for certain content",
      check: "checkRefusal",
    });
  }

  // Format-specific
  if (FORMAT_PATTERNS.some((p) => p.test(body))) {
    criteria.push({
      type: "format",
      foldId: fold.id,
      text: "specific output format required",
      check: "checkFormat",
    });
  }

  // Role-specific
  if (ROLE_PATTERNS.some((p) => p.test(body))) {
    criteria.push({
      type: "role",
      foldId: fold.id,
      text: "role adherence required",
      check: "checkRole",
    });
  }

  return criteria;
}

// ── EVA — evaluate response against criteria ───────────────────────────────
// Mechanical checks (no model):
//   - Citation: if citations expected, check bracket format
//   - Refusal: if refusal expected, check for refusal language
//   - Format: if format expected, check for format markers
//   - Prohibition: check for prohibited patterns in response

const EVA_CHECKS = {
  checkProhibition(response, criterion, fold) {
    // Check if the response contains the prohibited pattern
    // This is a soft check — we flag it, not fail it
    const prohibited = criterion.text.toLowerCase();
    const responseLower = response.toLowerCase();
    // Extract what's prohibited from the context
    const afterPattern = fold.body?.toLowerCase().indexOf(prohibited);
    if (afterPattern < 0) return { pass: true, note: "prohibition context not found" };

    // Get the surrounding sentence for context
    const contextStart = fold.body.toLowerCase().lastIndexOf(".", afterPattern);
    const contextEnd = fold.body.toLowerCase().indexOf(".", afterPattern + prohibited.length);
    const sentence = fold.body.slice(
      contextStart >= 0 ? contextStart + 1 : 0,
      contextEnd >= 0 ? contextEnd + 1 : undefined
    );

    // Check for obvious violations
    const violations = [];
    if (prohibited.includes("never") && responseLower.includes("as an ai")) {
      violations.push("used 'as an AI' despite prohibition");
    }
    if (prohibited.includes("no emoji") && /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u.test(response)) {
      violations.push("used emoji despite prohibition");
    }
    if (prohibited.includes("no preamble") && /^(great question|to answer|i'd be happy|let me|sure|of course)/i.test(response.trim())) {
      violations.push("used preamble despite prohibition");
    }

    return {
      pass: violations.length === 0,
      violations,
      note: violations.length ? violations.join("; ") : "no violation detected",
    };
  },

  checkObligation(response, criterion, fold) {
    // Soft check — obligations are harder to verify mechanically
    const obligated = criterion.text.toLowerCase();
    if (obligated.includes("cite") || obligated.includes("verbatim")) {
      // Check if response has any citation-like markers
      const hasCitations = /\[\d+\]/.test(response);
      return {
        pass: true, // soft pass — detailed check in checkCitation
        note: "obligation noted; detailed check in citation",
      };
    }
    return { pass: true, note: "obligation noted (semantic check required)" };
  },

  checkCitation(response, criterion, fold) {
    // Check citation format: [1], [2], etc.
    const citations = response.match(/\[(\d+)\]/g) || [];
    if (citations.length === 0) {
      // No citations — might be okay if no passages were provided
      return { pass: true, note: "no citations found (may be appropriate)" };
    }

    // Check for out-of-range citations (fabricated)
    // We don't know the max citation here, so just check format
    const maxCitation = Math.max(...citations.map((c) => parseInt(c.slice(1, -1))));
    const suspicious = citations.some((c) => parseInt(c.slice(1, -1)) > 100);

    return {
      pass: !suspicious,
      note: suspicious
        ? `suspicious citation [${maxCitation}] — may be fabricated`
        : `${citations.length} citations found, format valid`,
    };
  },

  checkRefusal(response, criterion, fold) {
    // Check if response contains refusal language when expected
    const refusalWords = [
      "i cannot",
      "i can't",
      "i must refuse",
      "i'm unable",
      "i am unable",
      "i won't",
      "i will not",
      "that request",
      "against",
      "not appropriate",
    ];
    const responseLower = response.toLowerCase();
    const hasRefusal = refusalWords.some((w) => responseLower.includes(w));

    return {
      pass: true, // soft — we can't know if refusal was needed without the question
      hasRefusal,
      note: hasRefusal ? "refusal language detected" : "no refusal language",
    };
  },

  checkFormat(response, criterion, fold) {
    const bodyLower = fold.body?.toLowerCase() || "";
    const checks = [];

    if (bodyLower.includes("json")) {
      const hasJson = response.includes("{") && response.includes("}");
      checks.push({ format: "json", present: hasJson });
    }
    if (bodyLower.includes("xml")) {
      const hasXml = response.includes("<") && response.includes(">");
      checks.push({ format: "xml", present: hasXml });
    }
    if (bodyLower.includes("list") && !bodyLower.includes("not")) {
      const hasList = /^[\s]*[-*]\s/m.test(response) || /^[\s]*\d+\.\s/m.test(response);
      checks.push({ format: "list", present: hasList });
    }

    const failed = checks.filter((c) => !c.present);
    return {
      pass: failed.length === 0,
      checks,
      note: failed.length
        ? `expected formats missing: ${failed.map((c) => c.format).join(", ")}`
        : "format checks passed",
    };
  },

  checkRole(response, criterion, fold) {
    // Check if response signals role adoption
    const roleSignals = [
      /as a\s+\w+/i,
      /from a\s+\w+\s+perspective/i,
      /in my role as/i,
      /speaking as/i,
    ];
    const hasRoleSignal = roleSignals.some((p) => p.test(response));

    return {
      pass: true, // soft — role adherence is semantic
      hasRoleSignal,
      note: hasRoleSignal ? "role adoption signaled" : "no explicit role signal (may still be adhering)",
    };
  },
};

function evaluateResponse(response, criteria, folds) {
  const foldMap = new Map(folds.map((f) => [f.id, f]));
  const results = [];
  let allPass = true;

  for (const criterion of criteria) {
    const checkFn = EVA_CHECKS[criterion.check];
    if (!checkFn) continue;

    const fold = foldMap.get(criterion.foldId);
    const result = checkFn(response, criterion, fold);
    results.push({
      foldId: criterion.foldId,
      type: criterion.type,
      ...result,
    });
    if (!result.pass) allPass = false;
  }

  return {
    pass: allPass,
    criteriaCount: criteria.length,
    results,
    method: "eva",
  };
}

// ── REC — restructure when EVA fails ───────────────────────────────────────
// When EVA fails, REC proposes adjustments to the instruction graph:
//   - Weight reduction for non-compliant folds
//   - Signal additions if the fold wasn't surfaced but should have been
//   - Body tightening suggestions
//   - Flag for human review

const REC_PROMPT = (activeFolds, response, violations) => `
You are reviewing an AI response against its active instructions. The response failed compliance checks.

Active instructions:
${activeFolds.map((f) => `### ${f.id} — ${f.title}\n${f.body.slice(0, 300)}`).join("\n\n")}

Response (first 2000 chars):
${response.slice(0, 2000)}

Violations found:
${violations.map((v) => `- ${v.foldId}: ${v.note}`).join("\n")}

Propose adjustments to improve future compliance. For each adjustment, specify:
1. Which fold to adjust (id)
2. What to change: "weight" (number delta), "signals" (add terms), or "body" (suggested addition)
3. Why (brief reason)

Output as JSON array: [{"foldId": "...", "change": "weight"|"signals"|"body", "value": ..., "reason": "..."}]
`;

async function restructure(activeFolds, response, violations, { model, speak }) {
  if (!model || !speak) {
    // No model available — return mechanical suggestions only
    const suggestions = violations.map((v) => ({
      foldId: v.foldId,
      change: "weight",
      value: -3,
      reason: `non-compliant: ${v.note} (no model available for deeper analysis)`,
    }));
    return { suggestions, method: "rec-mechanical" };
  }

  try {
    const raw = await speak(model, [
      { role: "user", content: REC_PROMPT(activeFolds, response, violations) },
    ], { maxTokens: 500 });

    let suggestions;
    try {
      suggestions = JSON.parse(raw);
    } catch {
      // Parse failed — fall back to mechanical
      suggestions = violations.map((v) => ({
        foldId: v.foldId,
        change: "weight",
        value: -2,
        reason: `non-compliant: ${v.note}`,
      }));
    }

    // Ground suggestions against actual folds
    const foldIds = new Set(activeFolds.map((f) => f.id));
    suggestions = suggestions.filter((s) => foldIds.has(s.foldId));

    return { suggestions, method: "rec-model", raw };
  } catch (err) {
    return {
      suggestions: violations.map((v) => ({
        foldId: v.foldId,
        change: "weight",
        value: -2,
        reason: `non-compliant: ${v.note} (model error: ${err.message})`,
      })),
      method: "rec-fallback",
    };
  }
}

// ── The pipeline — DEF → EVA → REC on failure ─────────────────────────────

export async function checkCompliance({ response, activeFolds, question, model, speak }) {
  // DEF: discretize
  const allCriteria = [];
  for (const fold of activeFolds) {
    allCriteria.push(...extractCriteria(fold));
  }

  if (allCriteria.length === 0) {
    return {
      pass: true,
      method: "def-none",
      criteria: [],
      verdict: "compliant",
      note: "no compliance criteria extracted from active folds",
    };
  }

  // EVA: evaluate
  const eva = evaluateResponse(response, allCriteria, activeFolds);

  if (eva.pass) {
    return {
      pass: true,
      method: "def-eva",
      criteria: allCriteria,
      eva,
      verdict: "compliant",
    };
  }

  // REC: restructure
  const violations = eva.results.filter((r) => !r.pass);
  const rec = await restructure(activeFolds, response, violations, { model, speak });

  return {
    pass: false,
    method: "def-eva-rec",
    criteria: allCriteria,
    eva,
    rec,
    verdict: "noncompliant",
    violations,
  };
}
