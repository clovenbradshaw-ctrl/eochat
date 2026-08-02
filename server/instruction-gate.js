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
function scoreFold(fold, cueWords, cueLower) {
  let score = 0;
  const matched = [];
  for (const signal of fold.signals || []) {
    const s = String(signal).toLowerCase();
    if (!s) continue;
    const hit = s.includes(" ") ? cueLower.includes(s) : cueWords.has(s);
    if (hit) { score += s.includes(" ") ? 3 : 2; matched.push(s); }
  }
  for (const w of String(fold.title).toLowerCase().split(/\s+/)) {
    if (w.length > 3 && cueWords.has(w)) { score += 1; matched.push(`title:${w}`); }
  }
  return { score, matched };
}

// The static framing that surrounds the fold list, plus per-fold renderers, so
// the budget can be an honest ceiling on the WHOLE instruction block the model
// receives — not just the fold bodies.
const GATE_HEADER = `===== EO INSTRUCTION GATE =====
The full instruction set is folded. Only the ACTIVE folds below are in force this turn — they are the complete set of rules you follow now. The FOLDED folds listed at the end exist but are NOT active: do not follow them, do not apply them, and do not mention them.`;
const GATE_FOOTER = `===== END INSTRUCTION GATE =====`;

// R2 — a missing fold is a named gap, never a silence. When no conditional
// fold matched this turn, the block says so in its own section: the model must
// not answer from general knowledge as if it were this manual's policy.
const GAP_MARKER = `=== NO FOLD SURFACED THIS TURN ===
No conditional fold matched this turn. The ACTIVE folds above are the complete and only rules in force — nothing else in this manual applies. If the reader's subject is one the active folds do not cover, do not supply the answer from general knowledge or habit: say honestly that you do not have that specific rule in front of you and will confirm it. Never present an improvised answer as policy.`;

function activeLine(fold) { return `\n### ${fold.id} — ${fold.title}\n${fold.body}`; }
function foldedLine(fold) { return `- ${fold.id}: ${fold.fingerprint || fold.title}`; }

function framingTokens(nActive, nFolded, gap) {
  const text = `${GATE_HEADER}\n--- ACTIVE FOLDS (${nActive}) ---\n--- FOLDED FOLDS (${nFolded}) — fingerprints only, NOT active ---\n${gap ? GAP_MARKER + "\n" : ""}${GATE_FOOTER}`;
  return countTokens(text);
}

// Compose the gate block for the model. Active folds are given verbatim under
// the gate header; folded folds are listed by id + fingerprint with an
// explicit NOT-ACTIVE marker. A gap turn (no conditional fold matched) carries
// the R2 marker naming the absence. The core-gate fold (always-on) explains
// this frame to the model itself.
function buildSystemBlock(surfaced, folded, gap) {
  const parts = [GATE_HEADER];
  parts.push(`--- ACTIVE FOLDS (${surfaced.length}) ---`);
  for (const fold of surfaced) parts.push(activeLine(fold));
  parts.push("");
  parts.push(`--- FOLDED FOLDS (${folded.length}) — fingerprints only, NOT active ---`);
  for (const fold of folded) parts.push(foldedLine(fold));
  if (gap) parts.push(GAP_MARKER);
  parts.push(GATE_FOOTER);
  return parts.join("\n");
}

export function createInstructionGate({ dir = INSTRUCTION_DIR, budgetTokens: budgetOverride } = {}) {
  const envBudget = Number(process.env.EO_INSTRUCTION_BUDGET);
  const budgetTokens = Number.isFinite(budgetOverride)
    ? budgetOverride
    : Number.isFinite(envBudget) ? envBudget : DEFAULT_INSTRUCTION_BUDGET;
  const folds = loadInstructionFolds(dir);
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
     * @param {number} [opts.budgetTokens] instruction-block token budget for this turn
     * @returns {{
     *   activeIds: string[], foldedIds: string[], surfaced: object[], folded: object[],
     *   systemMessage: string, stats: object
     * }}
     */
    gate({ question = "", history = [], budgetTokens: perTurnBudget, debug = false } = {}) {
      const budget = Number.isFinite(perTurnBudget) ? perTurnBudget : this.budgetTokens;
      const cue = [...history, question].join(" ");
      const cueWords = new Set(splitTerms(cue));
      const cueLower = cue.toLowerCase();

      const scored = conditional
        .map((fold) => ({ fold, ...scoreFold(fold, cueWords, cueLower) }))
        .sort((a, b) =>
          (b.score - a.score) || (b.fold.weight - a.fold.weight) || a.fold.id.localeCompare(b.fold.id)
        );

      // R2 — the gap is named only for a real corpus. An empty gate (no
      // instruction set at all) is a no-op that changes nothing.
      const gap = folds.length > 0 && !scored.some((s) => s.score > 0);

      // Budget accounting is honest: the budget is a ceiling on the WHOLE
      // instruction block (framing + active bodies + folded index), not just
      // the surfaced bodies. Surfacing a fold moves it from the index (cheap)
      // to an active body (expensive), so its net cost is body − index line.
      const surfaced = [...alwaysOn];
      let used = countTokens(surfaced.map(activeLine).join(""));
      let folded = folds.filter((f) => !surfaced.some((s) => s.id === f.id));
      let indexTokens = countTokens(folded.map(foldedLine).join(""));
      let blockTokens = framingTokens(surfaced.length, folded.length, gap) + used + indexTokens;

      for (const { fold, score } of scored) {
        if (score <= 0) break; // sorted desc — the rest are all irrelevant this turn
        const delta = countTokens(activeLine(fold)) - countTokens(foldedLine(fold));
        if (blockTokens + delta > budget) continue; // too big now — a smaller fold may still fit
        surfaced.push(fold);
        used += countTokens(activeLine(fold));
        indexTokens -= countTokens(foldedLine(fold));
        folded = folds.filter((f) => !surfaced.some((s) => s.id === f.id));
        blockTokens += delta;
      }

      const activeIds = new Set(surfaced.map((f) => f.id));
      folded = folds.filter((f) => !activeIds.has(f.id));
      indexTokens = countTokens(folded.map(foldedLine).join(""));
      const blockTokensFinal = framingTokens(surfaced.length, folded.length, gap) + used + indexTokens;
      const rejectedByBudget = scored.filter((s) => s.score > 0 && !activeIds.has(s.fold.id)).length;

      return {
        activeIds: surfaced.map((f) => f.id),
        foldedIds: folded.map((f) => f.id),
        surfaced,
        folded,
        systemMessage: buildSystemBlock(surfaced, folded, gap),
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
        },
      };
    },
  };
}
