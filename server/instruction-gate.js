// instruction-gate.js — surf-and-fold control for the instruction set.
//
// The full instruction set (instruction-set/*.md) is too large to sit in the
// context window alongside history, grounding passages, and the answer. This
// module is the gate that decides, per turn, which instruction folds are
// SURFACED (given verbatim) and which are FOLDED (reduced to a one-line
// fingerprint in an index).
//
// The design follows the project's own discipline (DEVELOPMENT-STATE.md):
// never hand the model more context than the turn needs — hand it a small,
// bounded current state, chosen mechanically, and auditably. Surfacing is
// keyword-signal matching (cheap, deterministic, no learned system); folding
// is lossy by design but the index keeps every folded fold NAMED, so absence
// stays auditable (LAWS.md L2e — an empty space where evidence should be must
// not read like evidence of nothing).
//
// The cue is evidence-extended: retrieval runs before the gate, so the
// passages the answer will be built from are scored as a second, capped signal
// channel. A fold the retrieved evidence is about surfaces even when the
// question does not name it — prediction of what the response needs, done
// mechanically from what the response will actually engage.
//
// A fold declares its own relevance in front matter: `signals` (words/phrases
// that point at this fold), `weight` (tie-break priority), `always` (core
// folds surfaced on every turn regardless of budget), and `fingerprint` (the
// one-line form it is folded to).

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.js";

export const INSTRUCTION_DIR = path.join(REPO_ROOT, "instruction-set");

export const DEFAULT_INSTRUCTION_BUDGET = 2800;

// Same character-per-token estimate the rest of the server uses (proxy.js
// `tok`): a rough ceiling, good enough to budget against. Consistent by
// construction — the gate's numbers and the server's numbers never diverge.
export function countTokens(text) {
  return Math.ceil(String(text ?? "").length / 3.5);
}

// Parse one fold file's front matter (`--- key: value` lines between the top
// `---` markers). `always`/`weight` parse as JSON; `signals` is a bracket list
// of comma-separated terms whose bare words need no quotes ("like this");
// `fingerprint` is the raw remainder of its line. Anything unparseable in the
// front matter is a load failure, not a silent default — a fold whose
// relevance was mis-declared would surface for the wrong questions, which is
// the exact silent corruption this module exists to avoid.
function parseSignalList(raw) {
  const inner = String(raw).trim();
  const content = inner.startsWith("[") && inner.endsWith("]") ? inner.slice(1, -1) : inner;
  if (!content.trim()) return [];
  const terms = [];
  let current = "", inQuote = null;
  for (const ch of content) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ",") {
      terms.push(current.trim()); current = "";
    } else {
      current += ch;
    }
  }
  terms.push(current.trim());
  return terms.filter(Boolean);
}

function parseFrontMatter(raw) {
  const headerEnd = raw.indexOf("\n---");
  if (raw.startsWith("---") && headerEnd > 0) {
    const header = raw.slice(3, headerEnd).trim();
    const fields = {};
    for (const line of header.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (key === "signals") {
        value = parseSignalList(value);
      } else if (key === "always" || key === "weight") {
        try { value = JSON.parse(value); }
        catch (err) { throw new Error(`instruction-set: ${key} not valid JSON in ${key}: ${err.message}`); }
      }
      fields[key] = value;
    }
    return { fields, body: raw.slice(headerEnd + 4).trim() };
  }
  return { fields: {}, body: raw.trim() };
}

export function loadInstructionFolds(dir = INSTRUCTION_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    // No instruction set at all — an empty gate is a valid gate: it surfaces
    // nothing and changes nothing. A missing corpus must not crash the server.
    return [];
  }
  const folds = [];
  for (const name of names) {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    const { fields, body } = parseFrontMatter(raw);
    if (!fields.id) throw new Error(`instruction-set: ${name} has no front-matter id`);
    const always = fields.always === true;
    const signals = Array.isArray(fields.signals) ? fields.signals : [];
    // R3 — relevance must be declared. A conditional fold that declares no
    // signals can never surface: it is a wall, not a gap-in-waiting, and a
    // fold that can never be consulted silently widens the gap the manual
    // exists to close. Fail loudly, like a missing id.
    if (!always && signals.length === 0) {
      throw new Error(`instruction-set: ${name} (${fields.id}) is conditional but declares no signals — it can never be surfaced`);
    }
    folds.push({
      id: fields.id,
      title: fields.title || fields.id,
      always,
      weight: Number.isFinite(fields.weight) ? fields.weight : 0,
      signals,
      fingerprint: fields.fingerprint || "",
      body,
    });
  }
  return folds;
}

function splitTerms(text) {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9'’]/i).filter((w) => w.length > 0);
}

// Mechanical relevance: signal hit count (weighted, phrases count more than
// bare words) plus title-word overlap. No learned system, no classifier — a
// fold is relevant because its declared signals appear in the turn's cue. The
// matched list makes the decision auditable: a fold is surfaced because these
// exact terms hit, and nothing else.
//
// Three signal channels, in decreasing strength, because they predict what
// THIS response needs with decreasing accuracy:
//
//   1. the QUESTION — the reader's message right now, at full weight
//   2. HISTORY (last few turns) — keeps the thread for referential follow-ups
//      ("and what about the other one?"), but an old topic must not crowd out
//      the current question's own folds, so it scores at half weight, capped.
//   3. EVIDENCE — the retrieved passages the answer will be built from. These
//      run before the gate on every server path, so a fold whose subject the
//      evidence is about must surface even when the question does not name it
//      (prediction of what the response needs, done mechanically from what the
//      response will actually engage). Scored at the same sub-weight as
//      history but capped lower, so a fold the question names directly always
//      outranks a fold that only matches incidental passage text.
//
// Every non-question hit is tagged in the audit (`hist:`/`ev:` prefixes), so
// the report can show WHICH channel surfaced each fold. The question channel
// keeps its untagged form, and the R7 probes that gate without history or
// evidence are unchanged.
const HISTORY_CAP_PER_FOLD = 3;
const EVIDENCE_CAP_PER_FOLD = 2;
const SUB_WORD = 1; // history / evidence bare-word hit
const SUB_PHRASE = 1.5; // history / evidence phrase hit
const SUB_TITLE_WORD = 0.5; // history / evidence title-word hit

// One channel of the mechanical score. `tag` is null for the question channel
// (full weight, untagged audit) and a prefix for history/evidence (half
// weight, capped, auditable as `hist:`/`ev:`).
function scoreChannel(fold, words, lower, tag, cap) {
  if (!words || !lower) return { score: 0, matched: [] };
  let score = 0;
  const matched = [];
  const pre = tag ? `${tag}:` : "";
  for (const signal of fold.signals || []) {
    const s = String(signal).toLowerCase();
    if (!s) continue;
    const phrase = s.includes(" ");
    const hit = phrase ? lower.includes(s) : words.has(s);
    if (hit) {
      score += phrase ? (tag ? SUB_PHRASE : 3) : (tag ? SUB_WORD : 2);
      matched.push(pre + s);
    }
  }
  for (const w of String(fold.title).toLowerCase().split(/\s+/)) {
    if (w.length > 3 && words.has(w)) {
      score += tag ? SUB_TITLE_WORD : 1;
      matched.push(pre + `title:${w}`);
    }
  }
  return { score: Math.min(score, cap), matched };
}

function scoreFold(fold, cueWords, cueLower, historyWords, historyLower, evidenceWords, evidenceLower) {
  const cue = scoreChannel(fold, cueWords, cueLower, null, Infinity);
  const hist = scoreChannel(fold, historyWords, historyLower, "hist", HISTORY_CAP_PER_FOLD);
  const ev = scoreChannel(fold, evidenceWords, evidenceLower, "ev", EVIDENCE_CAP_PER_FOLD);
  return {
    score: cue.score + hist.score + ev.score,
    matched: [...cue.matched, ...hist.matched, ...ev.matched],
  };
}

// The static framing that surrounds the fold list, plus per-fold renderers, so
// the budget can be an honest ceiling on the WHOLE instruction block the model
// receives — not just the fold bodies.
//
// The model-facing block carries only what the model must follow: the rules in
// force this turn, verbatim, with no account of how they were chosen. The gate
// machinery (folded folds, fingerprints, budgets) is an audit concern and stays
// server-side — the talking model never sees it and never hears the word.
const DEFAULT_LABEL = "RULES IN FORCE THIS TURN";
const gateHeader = (label) => `${"=".repeat(label.length + 8)}
===== ${label} =====
The rules below are the complete set of additional rules in force for this turn. Follow them, and no others.`;
const gateFooter = (label) => `===== END ${label} =====`;
const GATE_HEADER = gateHeader(DEFAULT_LABEL);
const GATE_FOOTER = gateFooter(DEFAULT_LABEL);

// R2 — a missing rule is a named gap, never a silence. When no conditional
// rule matched this turn, the block says so in its own section: the model must
// not answer from general knowledge as if it were this manual's policy.
const GAP_MARKER = `=== NO ADDITIONAL RULES FOR THIS TURN ===
No additional rules apply this turn beyond the ones above. If the reader's subject is not one they cover, do not supply the answer from general knowledge or habit: say honestly that you do not have that specific rule in front of you and will confirm it. Never present an improvised answer as policy.`;

function activeLine(fold) { return `\n### ${fold.title}\n${fold.body}`; }
function foldedLine(fold) { return `- ${fold.id}: ${fold.fingerprint || fold.title}`; }

function framingTokens(nActive, nFolded, gap, label = DEFAULT_LABEL) {
  const text = `${gateHeader(label)}\n--- RULES (${nActive}) ---\n${gap ? GAP_MARKER + "\n" : ""}${gateFooter(label)}`;
  return countTokens(text);
}

// Compose the gate block for the model. Active folds are given verbatim under
// a plain rules header; the folded index is NOT included — the model only ever
// sees the rules in force. A gap turn (no conditional fold matched) carries
// the R2 marker naming the absence.
function buildSystemBlock(surfaced, folded, gap, label = DEFAULT_LABEL) {
  const parts = [gateHeader(label)];
  parts.push(`--- RULES (${surfaced.length}) ---`);
  for (const fold of surfaced) parts.push(activeLine(fold));
  if (gap) parts.push(GAP_MARKER);
  parts.push(gateFooter(label));
  return parts.join("\n");
}

// `folds` may be supplied directly instead of read from a directory, so a
// corpus that does not live on disk as .md files — a project's own
// instructions, compiled from free text by project-instructions.js — is gated
// by this exact function rather than a second one written to resemble it. R3
// requires one scoreFold shared by every fold; that is only true if there is
// one gate. Directory loading stays the default so every existing caller is
// unchanged.
export function createInstructionGate({ dir = INSTRUCTION_DIR, folds: providedFolds, budgetTokens: budgetOverride, label = DEFAULT_LABEL } = {}) {
  const envBudget = Number(process.env.EO_INSTRUCTION_BUDGET);
  const budgetTokens = Number.isFinite(budgetOverride)
    ? budgetOverride
    : Number.isFinite(envBudget) ? envBudget : DEFAULT_INSTRUCTION_BUDGET;
  const folds = providedFolds ? [...providedFolds] : loadInstructionFolds(dir);
  const alwaysOn = folds.filter((f) => f.always).sort((a, b) => b.weight - a.weight);
  const conditional = folds.filter((f) => !f.always);

  return {
    folds,
    budgetTokens,

    totalTokens() {
      return countTokens(folds.map((f) => f.body).join("\n"));
    },

    /**
     * Gate one turn's instruction context.
     *
     * @param {object} opts
     * @param {string} opts.question   the reader's message
     * @param {string[]} [opts.history] recent user messages from this conversation
     *   (scored at half weight, so the current question's folds are never
     *   crowded out by topics the conversation has already left)
     * @param {string|string[]} [opts.evidence] text the answer will be built from
     *   (retrieved passages / web results). Scored as a second, capped channel —
     *   a fold the evidence is about surfaces even when the question itself does
     *   not name it.
     * @param {number} [opts.budgetTokens] instruction-block token budget for this turn
     * @returns {{
     *   activeIds: string[], foldedIds: string[], surfaced: object[], folded: object[],
     *   systemMessage: string, stats: object
     * }}
     */
    gate({ question = "", history = [], evidence = [], budgetTokens: perTurnBudget, debug = false } = {}) {
      const budget = Number.isFinite(perTurnBudget) ? perTurnBudget : this.budgetTokens;

      // The question is the strongest predictor of what this response needs;
      // history only keeps the thread, so it is scored as a capped secondary
      // channel rather than blended into the question at full weight.
      const questionCue = String(question ?? "");
      const cueWords = new Set(splitTerms(questionCue));
      const cueLower = questionCue.toLowerCase();

      const historyCue = (history || []).join(" ");
      const historyWords = historyCue ? new Set(splitTerms(historyCue)) : null;
      const historyLower = historyCue ? historyCue.toLowerCase() : null;

      const evidenceText = Array.isArray(evidence) ? evidence.join(" ") : String(evidence ?? "");
      const evidenceWords = evidenceText ? new Set(splitTerms(evidenceText)) : null;
      const evidenceLower = evidenceText ? evidenceText.toLowerCase() : null;

      const scored = conditional
        .map((fold) => ({ fold, ...scoreFold(fold, cueWords, cueLower, historyWords, historyLower, evidenceWords, evidenceLower) }))
        .sort((a, b) =>
          (b.score - a.score) || (b.fold.weight - a.fold.weight) || a.fold.id.localeCompare(b.fold.id)
        );

      // R2 — the gap is named only for a real corpus. An empty gate (no
      // instruction set at all) is a no-op that changes nothing.
      const gap = folds.length > 0 && !scored.some((s) => s.score > 0);

      // Budget accounting is honest: the budget is a ceiling on the WHOLE
      // instruction block (framing + active bodies). The folded index is no
      // longer part of the model-facing message (the talking model never sees
      // the fold machinery), so surfacing a fold costs exactly its active
      // body; the folded index is still counted below as an audit figure.
      const surfaced = [...alwaysOn];
      let used = countTokens(surfaced.map(activeLine).join(""));
      let blockTokens = framingTokens(surfaced.length, 0, gap, label) + used;

      for (const { fold, score } of scored) {
        if (score <= 0) break; // sorted desc — the rest are all irrelevant this turn
        const delta = countTokens(activeLine(fold));
        if (blockTokens + delta > budget) continue; // too big now — a smaller fold may still fit
        surfaced.push(fold);
        used += delta;
        blockTokens += delta;
      }

      const activeIds = new Set(surfaced.map((f) => f.id));
      const folded = folds.filter((f) => !activeIds.has(f.id));
      const indexTokens = countTokens(folded.map(foldedLine).join(""));
      const blockTokensFinal = framingTokens(surfaced.length, 0, gap, label) + used;
      // Folds that WERE relevant this turn and were crowded out by the budget.
      // This is a different fact from "nothing matched", and the two must not
      // read alike: a rule the reader wrote, which the gate agreed applied,
      // and which the model never saw, is the one failure most likely to be
      // mistaken for the gate working correctly. Named, with ids, so the
      // remedy (raise the budget, or split the section) is actionable.
      const crowdedOut = scored.filter((s) => s.score > 0 && !activeIds.has(s.fold.id));
      const rejectedByBudget = crowdedOut.length;

      return {
        activeIds: surfaced.map((f) => f.id),
        foldedIds: folded.map((f) => f.id),
        surfaced,
        folded,
        systemMessage: buildSystemBlock(surfaced, folded, gap, label),
        scores: debug ? scored.map(({ fold, score, matched }) => ({ id: fold.id, score, matched })) : undefined,
        stats: {
          totalFolds: folds.length,
          active: surfaced.length,
          folded: folded.length,
          usedTokens: used,
          indexTokens,
          blockTokens: blockTokensFinal,
          budget,
          overflow: blockTokensFinal > budget ? blockTokensFinal - budget : 0,
          gap,
          rejectedByBudget,
          crowdedOutIds: crowdedOut.map((s) => s.fold.id),
        },
      };
    },
  };
}
