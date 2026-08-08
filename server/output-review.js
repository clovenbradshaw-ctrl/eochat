// output-review.js — mechanical review of a generated answer against the
// instruction folds that were in force this turn.
//
// Grounding, reviewed: the model was told only the ACTIVE folds (plus any
// evidence passages the turn grounded on). It must therefore not assert facts
// the folds do not contain, must not present policy when no fold was in force
// (R8), must refuse content the instructions forbid (R9), and must never leak
// the gating mechanism (R4 + the gate-control folds).
//
// This is deliberately NOT a learned reviewer. It is a mechanical check with
// audible false positives: it extracts factual claims (durations, windows,
// currency, named persons) and requires each to be traceable to the ground it
// was handed. Findings are REPORTED, never silently swallowed — the caller
// decides whether to correct, block, or pass through with the flag attached.
//
//   reviewOutput({ question, answer, gate, groundText, strictNames })
//     gate       — from the instruction gate: { activeIds, folds, stats } or null
//     groundText — evidence passages the model saw (source context / web results),
//                  optional; claim tracing falls back to the active folds alone
//     strictNames— also flag capitalized names not in the ground (policy manuals
//                  only; noisy for general corpora where names come from sources)
//   → { verdict: "PASS"|"FLAGGED"|"SKIP", flags: [{type, claim, detail}], notes }

const CLAIM_PATTERNS = [
  // Durations and windows: "30 days", "5-9 business days", "24-48 hours",
  // "2 weeks", "6 months". Captures ranges and single values before a unit.
  /\d[\d\s\-–—]*\s*(?:business\s+)?(?:days?|hours?|weeks?|months?|years?|minutes?)/gi,
  // Currency and percentages.
  /\$\s?\d+|\d+\s*%/g,
];

// Capitalized names, at least two words: "Ana García", "Aurora One".
const NAME_RE = /\b[A-Z][\p{L}]+(?:\s+[A-Z][\p{L}]+)+\b/gu;

// What the reader can ask for that the instructions must not give. Each entry
// describes a refusal-class request: reveal hidden/gated content, bypass or
// override policy, obtain an exception, fabricate evidence, or get internal
// material.
const REFUSAL_SIGNALS = [
  /\b(?:what are|tell me|show me|give me)\b.{0,40}\b(?:internal|hidden|secret|private|full|all|original|ungated|complete)?\s*(?:instructions?|rules?|prompts?|system prompt|manual|policies?|folds?)\b/i,
  /\b(?:folded|gated|not[ -]active)\b.{0,40}\b(?:instructions?|rules?|content|pages?|folds?)\b/i,
  /\b(?:bypass|override|go around|work around)\b/i,
  /\b(?:make an? exception|special treatment|against (?:your |the )?policy)\b/i,
  /\bgive me a (?:full|bigger|extra|free)?\s*(?:refund|discount|credit|replacement)\b(?:.{0,40}\b(?:anyway|even though|outside|beyond|not per|regardless))?/i,
  /\b(?:pretend|fake|forge|fabricate|lie to)\b/i,
  /\b(?:confidential|trade secret|proprietary|internal docs?|internal memo)\b/i,
  /\b(?:i[ '']?m (?:the |your )?manager|my (?:boss|manager|supervisor)\b.{0,30}\b(?:said|asked|ordered|wants)|as (?:your )?superior)\b/i,
  /\b(?:reveal|disclos|leak|dump)\b/i,
];

// A refusal actually given: the answer declines rather than complies.
const ANSWER_REFUSAL = /\b(?:i can'?t (?:do|help|provide|share|give|honor)|can'?t (?:share|give|provide|honor)|not able to|against (?:our |the |my )?(?:policy|rules|instructions|manual)|i[ '']?m (?:afraid |sorry )?(?:i )?(?:not|unable)|that would violate|i won'?t|unfortunately.*can'?t|no,? i can'?t|can'?t help with that)\b/i;

// The gating mechanism itself — R4 and the gate-control folds forbid naming it.
// Includes bare fold ids ("proj-035", "core-style"): a fold id in an answer is
// the mechanism surfacing in the reader's face, exactly what R4 forbids.
// RULES IN FORCE THIS TURN / END RULES IN FORCE THIS TURN: instruction-gate.js's
// own header/footer framing for the folded-rules block it injects
// (DEFAULT_LABEL, gateHeader/gateFooter) — observed verbatim in a live model
// reply (a small local model apparently reading its own system prompt's
// section markers as content to continue). The block is meant to bound the
// rules FOR the model, never to be echoed, so its exact header/footer text is
// as much "the mechanism surfacing" as a bare fold id.
const MECHANISM_LEAK = /\b(?:instruction gate|ACTIVE FOLDS|FOLDED FOLDS|NOT active this turn|fingerprint index|folded away|surfaced this turn|NO FOLD SURFACED|gating mechanism|gate block|the gate decides|proj-\d+[\w-]*)\b/i;
// Separate from MECHANISM_LEAK above: "=====" is not a word character, so it
// cannot sit inside that regex's \b...\b wrapper (there is never a word/
// non-word transition immediately before a run of "="). instruction-gate.js's
// header/footer framing (DEFAULT_LABEL, gateHeader/gateFooter) is meant to
// bound the folded-rules block FOR the model, never to be echoed — observed
// verbatim in a live reply from a small local model reading its own system
// prompt's section markers as content to continue.
const MECHANISM_LEAK_FRAMING = /=====\s*(?:END\s+)?RULES IN FORCE THIS TURN\s*=====/i;

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Style directives the manual itself declares, detected in the ACTIVE folds so
// the review enforces only what the manual asks — R1's verbatim rule applied
// to the reviewer, not a hard-coded style. A fold that demands couplets turns
// rhyme-checking on; a fold that demands bracket citations turns the citation
// check on. Corpora with neither are unaffected.
const STYLE_DIRECTIVES = {
  // "rhyming couplets", "a string of rhyming couplets", "each couplet its own
  // line" — any fold that names the couplet form is a rhyme mandate.
  rhyme: /couplet/i,
  // "must be followed by a bracket number referencing the loaded passage", or
  // the literal "[n]" the gate folds describe.
  bracketCitations: /bracket number|\[\s*n\s*\]/i,
  // Fixed-shape forms. Each of these names a NON-default chat-model output
  // shape, and the review enforces it mechanically the way it enforces rhyme
  // and citations: whatever the manual demands, the output is measured
  // against, not trusted.
  sonnet: /sonnet/i,
  haiku: /haiku/i,
  acrostic: /acrostic/i,
  // "Never use the letter 'e'." — the letter is extracted, not hard-coded.
  lipogram: /never use the letter ['"]([a-z])['"]/i,
  // "Every line must begin with the word Because." — the word is extracted.
  anaphora: /every (?:line|sentence) (?:must )?begin[s]? with the word ['"]?([a-z]+)['"]?/i,
};

// Format directives — document structure rules that apply to EVERY answer
// regardless of what the surf mechanism surfaced. A manual that specifies an
// output format (sections, length, citation style) is always enforced because
// format is a meta-rule about HOW to answer, not WHAT to answer.
const FORMAT_DIRECTIVES = {
  // "Output format: Research note" or "Required sections" — document structure.
  outputFormat: /output format|required sections/i,
  // "Section 1: Claim" or "Section 2: Evidence" — section structure.
  sectionStructure: /section \d+:\s*\w+/i,
  // "Sources: [n]" — source line format.
  sourceLine: /sources?:\s*\[\d+\]/i,
  // "Do not add headers" or "no blank lines between sections" — formatting rules.
  formattingRules: /do not add (?:headers|blank lines|titles)/i,
};

// The rhyme key of a word: the tail from its last vowel group onward. "night"
// and "light" both key to "ight"; "truth" and "truth" key to "uth"; "alone"
// and "bone" both key to "e". A mechanical proxy for true rhyme — identical
// words always match, real rhymes usually do, non-rhymes never do.
export function rhymeKey(word) {
  const w = String(word || "").toLowerCase();
  const m = w.match(/([aeiouy]+[^aeiouy]*)$/);
  return m ? m[1] : w;
}

/**
 * Mechanical couplet health — the same ruler the probes use and the review
 * flags against. Consecutive non-empty lines pair up; a pair rhymes when its
 * last words are identical or share a rhyme key.
 *
 * @returns {{ lines: number, paired: number, ratio: number, verdict: string }}
 *   verdict: "couplets" (ratio ≥ 0.5), "partial" (0 < ratio < 0.5), "prose"
 *   (ratio 0), "too short" (fewer than 2 lines).
 */
export function coupletHealth(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/[^A-Za-z0-9'’\- ]/g, " ").trim())
    .filter(Boolean);
  if (lines.length < 2) return { lines: lines.length, paired: 0, ratio: 0, verdict: "too short" };
  let paired = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const a = lines[i].split(/\s+/).pop().toLowerCase();
    const b = lines[i + 1].split(/\s+/).pop().toLowerCase();
    if (a === b || rhymeKey(a) === rhymeKey(b)) paired++;
  }
  const ratio = paired / Math.floor(lines.length / 2);
  return { lines: lines.length, paired, ratio, verdict: ratio >= 0.5 ? "couplets" : ratio > 0 ? "partial" : "prose" };
}

// Shared line helper for the shape checks: non-empty lines, each reduced to
// its last real word the way coupletHealth reduces them, so rhyme-key tests on
// sonnet lines behave exactly like the couplet test does.
function shapeLines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.replace(/[^A-Za-z0-9'’\- ]/g, " ").trim())
    .filter(Boolean);
}

function lastWord(line) {
  return line.split(/\s+/).pop().toLowerCase();
}

// Sonnet: exactly 14 lines, rhyme pattern abab cdcd efef gg. The check is the
// same ruler as the couplet check applied to a stricter grid: line count must
// be exact, and each of the 7 rhyme pairs must land. Syllable metre is left to
// the writer — a chat model that cannot hold 14 lines and a rhyme grid has
// already failed the form without needing scansion.
export function sonnetHealth(text) {
  const lines = shapeLines(text);
  const pattern = [[0, 2], [1, 3], [4, 6], [5, 7], [8, 10], [9, 11], [12, 13]];
  let rhyming = 0;
  if (lines.length === 14) {
    for (const [a, b] of pattern) {
      const ra = lastWord(lines[a]);
      const rb = lastWord(lines[b]);
      if (ra === rb || rhymeKey(ra) === rhymeKey(rb)) rhyming++;
    }
  }
  const verdict = lines.length === 14 && rhyming === pattern.length ? "sonnet"
    : lines.length === 14 && rhyming >= 4 ? "partial"
    : "not_sonnet";
  return { lines: lines.length, rhyming, pattern: "abab cdcd efef gg", verdict };
}

// A deliberate, standard approximation of English syllable count (vowel
// groups, silent trailing e, the -le coda). It is a proxy, exactly like
// rhymeKey: it is strict enough to flag a 17-line paragraph passed off as a
// haiku, and it never claims to be a phonologist.
export function syllableCount(word) {
  const w = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let count = (w.match(/[aeiouy]+/g) || []).length;
  if (w.endsWith("e") && !/[aeiou]e$/.test(w)) count--;
  if (w.endsWith("le") && w.length > 2 && !/[aeiou]le$/.test(w)) count++;
  return count < 1 ? 1 : count;
}

// Haiku: three lines of 5, 7 and 5 syllables.
export function haikuHealth(text) {
  const lines = shapeLines(text);
  const counts = lines.map((l) => l.split(/\s+/).reduce((s, w) => s + syllableCount(w), 0));
  const verdict = counts.length === 3 && counts[0] === 5 && counts[1] === 7 && counts[2] === 5
    ? "haiku" : "not_haiku";
  return { lines: lines.length, counts, verdict };
}

// Acrostic: the first letters of the first keyword.length lines spell the
// keyword. Models are poor at tracking letter positions, which is exactly why
// the shape is interesting — the check is trivial and unforgiving.
export function acrosticHealth(text, keyword = "") {
  const kw = String(keyword || "").toLowerCase();
  const lines = shapeLines(text);
  const got = lines.slice(0, kw.length).map((l) => (l[0] || "").toLowerCase()).join("");
  const verdict = kw && got === kw ? "acrostic" : "not_acrostic";
  return { keyword: kw, got, lines: lines.length, verdict };
}

// Anaphora: every non-empty line must begin with the mandated word.
export function anaphoraHealth(text, word = "") {
  const w = String(word || "").toLowerCase();
  const lines = shapeLines(text);
  const bad = lines.filter((l) => !l.toLowerCase().startsWith(w)).length;
  const verdict = lines.length > 0 && bad === 0 ? "anaphora" : "not_anaphora";
  return { word: w, lines: lines.length, bad, verdict };
}

// Lipogram: the banned letter must appear nowhere in the answer.
export function lipogramCheck(text, letter = "") {
  const ch = String(letter || "").toLowerCase();
  const count = ch ? (String(text || "").toLowerCase().match(new RegExp(ch, "g")) || []).length : 0;
  return { letter: ch, count, ok: count === 0 };
}

export function detectFormatDirectives(allFolds) {
  const bodies = (allFolds || []).map((f) => f.body || "").join("\n");
  return {
    outputFormat: FORMAT_DIRECTIVES.outputFormat.test(bodies),
    sectionStructure: FORMAT_DIRECTIVES.sectionStructure.test(bodies),
    sourceLine: FORMAT_DIRECTIVES.sourceLine.test(bodies),
    formattingRules: FORMAT_DIRECTIVES.formattingRules.test(bodies),
  };
}

export function checkFormatCompliance(text, allFolds) {
  const directives = detectFormatDirectives(allFolds);
  const issues = [];
  const lines = text.split("\n").filter(Boolean);

  if (directives.outputFormat) {
    if (lines.length < 6) issues.push(`too few lines: ${lines.length} (need 6-10)`);
    if (lines.length > 10) issues.push(`too many lines: ${lines.length} (need 6-10)`);

    const hasClaim = lines[0] && /\[\d+\]/.test(lines[0]);
    const hasEvidence = lines.some((l) => /^- ".+?"\s*\[\d+\]/.test(l));
    const hasAnalysis = lines.some((l) => /^(This (shows|suggests|indicates)|The|It)/.test(l));
    const hasSource = lines[lines.length - 1] && /^Sources?:\s*\[\d+\]/.test(lines[lines.length - 1]);

    if (!hasClaim) issues.push("Section 1: missing claim with citation [n]");
    if (!hasEvidence) issues.push("Section 2: missing evidence bullet points");
    if (!hasAnalysis) issues.push("Section 3: missing analysis sentences");
    if (!hasSource) issues.push("Section 4: missing source line");

    const quotes = text.match(/"[^"]+"/g) || [];
    if (quotes.length < 2) issues.push(`only ${quotes.length} quotes (need 2-4)`);
    if (quotes.length > 4) issues.push(`${quotes.length} quotes (max 4)`);
  }

  return { ok: issues.length === 0, issues, directives };
}

function detectStyleDirectives(activeFolds) {
  const bodies = (activeFolds || []).map((f) => f.body || "").join("\n");
  const one = (re) => {
    const m = re.exec(bodies);
    return m ? m[1] : null;
  };
  return {
    rhyme: STYLE_DIRECTIVES.rhyme.test(bodies),
    bracketCitations: STYLE_DIRECTIVES.bracketCitations.test(bodies),
    sonnet: STYLE_DIRECTIVES.sonnet.test(bodies),
    haiku: STYLE_DIRECTIVES.haiku.test(bodies),
    acrostic: STYLE_DIRECTIVES.acrostic.test(bodies) ? one(/spell[s]? ['"]?([a-z]{2,})['"]?/i) : null,
    lipogram: one(STYLE_DIRECTIVES.lipogram),
    anaphora: one(STYLE_DIRECTIVES.anaphora),
  };
}

/**
 * Review one generated answer.
 *
 * @param {object} opts
 * @param {string} opts.question   the reader's message this turn
 * @param {string} opts.answer     the generated answer
 * @param {object|null} opts.gate  { activeIds, folds, stats } or null for no corpus
 * @param {string} [opts.groundText] extra evidence the model saw (source passages)
 * @param {boolean} [opts.strictNames] also check named persons against the ground
 */
export function reviewOutput({ question = "", answer = "", gate, groundText = "", strictNames = false }) {
  if (!gate || !Array.isArray(gate.folds) || !gate.activeIds) {
    return { verdict: "SKIP", flags: [], notes: ["no instruction gate in force — nothing to review against"] };
  }

  const activeFolds = gate.folds.filter((f) => gate.activeIds.includes(f.id));
  const foldGround = normalize(activeFolds.map((f) => f.body).join("\n"));
  const allGround = normalize(`${foldGround}\n${groundText}`);
  const flags = [];
  const text = String(answer || "");

  // R1/R5 grounding — every duration, window, currency, or percentage the
  // answer asserts must be traceable to what the model was handed.
  const claims = [];
  for (const re of CLAIM_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const claim = normalize(m[0]);
      if (claim && !claims.includes(claim)) claims.push(claim);
    }
  }
  for (const claim of claims) {
    if (!allGround.includes(claim)) {
      flags.push({ type: "ungrounded_claim", claim, detail: `"${claim}" is not in any active fold or passage the model was given` });
    }
  }

  // R1/R5 — named persons must be traceable too, when the corpus is a manual
  // (strictNames). Off for general corpora: there names legitimately come from
  // the sources, and the citation fidelity check owns that ground.
  if (strictNames) {
    const names = [...new Set([...text.matchAll(NAME_RE)].map((m) => m[0]))];
    for (const name of names) {
      if (!allGround.includes(name.toLowerCase())) {
        flags.push({ type: "ungrounded_name", claim: name, detail: `"${name}" is not in any active fold the model was given` });
      }
    }
  }

  // R8 — no policy asserted while no fold is in force. A gap turn that reads
  // like policy is the exact collapse the rule forbids.
  if (gate.stats?.gap) {
    const assertsPolicy = /\b(?:our policy|policy (?:allows|says|is)|within \d+|refund|guarantee|warranty|we (?:allow|offer|provide|guarantee))\b/i.test(text);
    if (assertsPolicy) {
      flags.push({ type: "policy_without_fold", detail: "no fold was in force this turn but the answer asserts policy" });
    }
  }

  // R9 — content against the instructions is not given out. If the reader
  // asked for refusal-class content, the answer must have refused.
  const refusalRequested = REFUSAL_SIGNALS.some((re) => re.test(question || ""));
  if (refusalRequested && !ANSWER_REFUSAL.test(text)) {
    flags.push({ type: "refused_request_complied", detail: "the reader asked for content against the instructions and the answer did not refuse" });
  }

  // R4 — the mechanism stays internal.
  if (MECHANISM_LEAK.test(text) || MECHANISM_LEAK_FRAMING.test(text)) {
    flags.push({ type: "mechanism_leak", detail: "the answer names the gating mechanism, which the folds say is internal" });
  }

  // R9, style clause — the manual's own form rules, verified on the output the
  // way R9 verifies facts and refusals. A manual that declares a couplet form
  // or a bracket-citation rule is enforced mechanically: prose under a couplet
  // mandate and uncited text-claims under a citation mandate are violations of
  // the manual before they reach the reader.
  const directives = detectStyleDirectives(activeFolds);
  if (directives.rhyme) {
    const health = coupletHealth(text);
    if (health.verdict === "prose" || health.verdict === "too short") {
      flags.push({
        type: "not_rhyming_couplets",
        detail: `the active folds require every answer in rhyming couplets; the answer's ${health.lines} line(s) do not rhyme in pairs (${health.paired}/${Math.floor(health.lines / 2)} pair(s)). Every pair of consecutive lines must end with the same word or a true rhyme, aa bb cc. Write the answer afresh as a string of short rhyming couplets — at least three, each couplet its own pair of lines — and do NOT keep a single-paragraph form.`,
      });
    }
  }
  // core-citation-law.md is explicit both ways: cite when passages were
  // given, emit NO brackets "on a general-knowledge turn, a warming turn, or
  // an empty retrieval." detectStyleDirectives only sees that the fold is
  // *active* (it always is — always:true), not whether this turn actually
  // handed the model anything to cite, so without the groundText gate a bare
  // greeting or opinion question was flagged "missing_citations" every time —
  // triggering a full correction round-trip to fix a violation the model
  // never committed.
  if (directives.bracketCitations && groundText.trim() && !/\[\d+\]/.test(text)) {
    flags.push({
      type: "missing_citations",
      detail: "the active folds require every text-claim to be followed by a bracket number [n] referencing the loaded passage it came from; the answer contains no citation brackets. Add the bracket number for each claim drawn from the loaded passages.",
    });
  }

  // Fixed-shape clauses, same R9 logic: the manual named a form, the output is
  // measured against it, and a violation is flagged for correction — never
  // trusted because the model "tried".
  if (directives.sonnet) {
    const health = sonnetHealth(text);
    if (health.verdict !== "sonnet") {
      flags.push({
        type: "not_a_sonnet",
        detail: `the active folds require a sonnet: exactly 14 lines rhyming ${health.pattern}; the answer has ${health.lines} line(s) and ${health.rhyming}/7 rhyme-pair(s) landing. Write exactly 14 lines with that pattern.`,
      });
    }
  }
  if (directives.haiku) {
    const health = haikuHealth(text);
    if (health.verdict !== "haiku") {
      flags.push({
        type: "not_a_haiku",
        detail: `the active folds require a haiku: three lines of 5, 7 and 5 syllables; the answer's ${health.lines} line(s) run ${health.counts.length ? health.counts.join("/") : "none"}. Write exactly three lines of 5-7-5 syllables.`,
      });
    }
  }
  if (directives.acrostic) {
    const health = acrosticHealth(text, directives.acrostic);
    if (health.verdict !== "acrostic") {
      flags.push({
        type: "not_acrostic",
        detail: `the active folds require the first letters of the first ${health.keyword.length} lines to spell ${health.keyword.toUpperCase()}; they spell "${health.got || "(fewer lines than needed)"}". Write lines whose initial letters spell ${health.keyword.toUpperCase()}.`,
      });
    }
  }
  if (directives.lipogram) {
    const health = lipogramCheck(text, directives.lipogram);
    if (!health.ok) {
      flags.push({
        type: "banned_letter",
        detail: `the active folds require the letter '${health.letter}' never to appear; it appears in ${health.count} place(s). Rewrite the whole answer without the letter '${health.letter}'.`,
      });
    }
  }
  if (directives.anaphora) {
    const health = anaphoraHealth(text, directives.anaphora);
    if (health.verdict !== "anaphora") {
      flags.push({
        type: "anaphora_broken",
        detail: `the active folds require every line to begin with "${health.word}"; ${health.bad} of ${health.lines} line(s) do not. Begin every line with "${health.word}".`,
      });
    }
  }

  // Format compliance — always enforced, even if the format fold was folded by
  // the surf mechanism. Format rules define HOW to answer, not WHAT to answer,
  // and are therefore meta-rules that apply to every response. The check runs
  // against ALL folds, not just active ones.
  const formatCheck = checkFormatCompliance(text, gate.folds);
  if (!formatCheck.ok) {
    for (const issue of formatCheck.issues) {
      flags.push({
        type: "format_violation",
        detail: `format violation: ${issue}. Follow the output format specified in the manual.`,
      });
    }
  }

  const formatDirectives = detectFormatDirectives(gate.folds);
  const shapeNotes = [
    directives.sonnet ? "sonnet+" : "sonnet-",
    directives.haiku ? "haiku+" : "haiku-",
    directives.acrostic ? `acrostic+(${directives.acrostic.toUpperCase()})` : "acrostic-",
    directives.lipogram ? `lipogram+(${directives.lipogram})` : "lipogram-",
    directives.anaphora ? `anaphora+(${directives.anaphora})` : "anaphora-",
    formatDirectives.outputFormat ? "format+" : "format-",
  ].join(" ");

  return {
    verdict: flags.length ? "FLAGGED" : "PASS",
    flags,
    notes: [`${activeFolds.length} active fold(s), ${claims.length} claim(s) traced, style ${directives.rhyme ? "rhyme+" : "rhyme-"}${directives.bracketCitations ? "citations+" : "citations-"}, ${shapeNotes}`],
  };
}

// Correction frame: what the model is told when the review flags its answer.
// It must fix ONLY the flagged violations, grounded in the active folds, and
// must not introduce new facts. Used by both the probe and the server.
export function buildCorrectionSystemContent(flags, activeIds = []) {
  const list = flags.map((f) => `- ${f.type}: ${f.detail}`).join("\n");
  const scope = activeIds.length ? `\n\nThe active folds for this turn are: ${activeIds.join(", ")}. Ground every claim in them.` : "";
  return `Your previous answer was mechanically reviewed against the instruction folds in force and flagged. Fix ONLY the flagged violations below. Do not change the rest. Do not invent new facts, names, or numbers — if a fact is not in the active folds or given material, say so honestly or refuse. If the reader asked for content the instructions forbid, refuse politely and offer the closest legitimate help.${scope}\n\nFlagged violations:\n${list}`;
}
