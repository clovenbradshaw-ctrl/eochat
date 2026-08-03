// instruction-gate.js — surf-and-fold control for custom instruction folds.
//
// Folds are provided at runtime (from the custom instruction store). Each turn,
// the gate decides which folds are SURFACED (full body) and which are FOLDED
// (one-line fingerprint in an index), based on signal matching against the
// reader's question and a token budget.
//
// When no folds exist, the gate is a no-op — it returns null system message.

export const DEFAULT_INSTRUCTION_BUDGET = 2800;

export function countTokens(text) {
  return Math.ceil(String(text ?? "").length / 3.5);
}

function splitTerms(text) {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9'’]/i).filter((w) => w.length > 0);
}

function scoreFold(fold, cueWords, cueLower, memoryAdjustment = 0) {
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
  // Memory adjustment: fold's score is modified by its feedback history.
  // Positive history boosts score; negative history suppresses it.
  // The adjustment is scaled so it influences but doesn't dominate signal matching.
  const adjustedScore = score + Math.round(memoryAdjustment * 0.3);
  return { score: adjustedScore, rawScore: score, memoryAdjustment, matched };
}

const GATE_HEADER = `===== INSTRUCTION GATE =====
The full instruction set is folded. Only the ACTIVE folds below are in force this turn. The FOLDED folds listed at the end exist but are NOT active this turn.`;
const GATE_FOOTER = `===== END INSTRUCTION GATE =====`;

const GAP_MARKER = `=== NO FOLD SURFACED THIS TURN ===
No conditional fold matched this turn. The ACTIVE folds above are the complete and only rules in force.`;

function activeLine(fold) { return `\n### ${fold.id} — ${fold.title}\n${fold.body}`; }
function foldedLine(fold) { return `- ${fold.id}: ${fold.fingerprint || fold.title}`; }

function framingTokens(nActive, nFolded, gap) {
  const text = `${GATE_HEADER}\n--- ACTIVE FOLDS (${nActive}) ---\n--- FOLDED FOLDS (${nFolded}) — fingerprints only, NOT active ---\n${gap ? GAP_MARKER + "\n" : ""}${GATE_FOOTER}`;
  return countTokens(text);
}

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

export function createInstructionGate({ budgetTokens: budgetOverride } = {}) {
  const envBudget = Number(process.env.EO_INSTRUCTION_BUDGET);
  const budgetTokens = Number.isFinite(budgetOverride)
    ? budgetOverride
    : Number.isFinite(envBudget) ? envBudget : DEFAULT_INSTRUCTION_BUDGET;

  let folds = [];

  return {
    get folds() { return folds; },

    /** Replace the fold set (called when custom instructions change). */
    setFolds(newFolds) {
      folds = newFolds || [];
    },

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
     * @param {Map<string, number>} [opts.memoryAdjustments] foldId -> weight delta from workspace memory
     * @returns {{
     *   activeIds: string[], foldedIds: string[], surfaced: object[], folded: object[],
     *   systemMessage: string | null, stats: object
     * }}
     */
    gate({ question = "", history = [], budgetTokens: perTurnBudget, memoryAdjustments, debug = false } = {}) {
      if (!folds.length) {
        return {
          activeIds: [],
          foldedIds: [],
          surfaced: [],
          folded: [],
          systemMessage: null,
          stats: { totalFolds: 0, active: 0, folded: 0, usedTokens: 0, indexTokens: 0, blockTokens: 0, budget: budgetTokens || budgetTokens, overflow: 0, gap: false, rejectedByBudget: 0 },
        };
      }

      const budget = Number.isFinite(perTurnBudget) ? perTurnBudget : this.budgetTokens;
      const cue = [...history, question].join(" ");
      const cueWords = new Set(splitTerms(cue));
      const cueLower = cue.toLowerCase();

      const alwaysOn = folds.filter((f) => f.always).sort((a, b) => {
        const aAdj = memoryAdjustments?.get(a.id) || 0;
        const bAdj = memoryAdjustments?.get(b.id) || 0;
        return (b.weight + bAdj) - (a.weight + aAdj);
      });
      const conditional = folds.filter((f) => !f.always);

      const scored = conditional
        .map((fold) => {
          const adj = memoryAdjustments?.get(fold.id) || 0;
          return { fold, ...scoreFold(fold, cueWords, cueLower, adj) };
        })
        .sort((a, b) =>
          (b.score - a.score) || ((b.fold.weight + (memoryAdjustments?.get(b.fold.id) || 0)) - (a.fold.weight + (memoryAdjustments?.get(a.fold.id) || 0))) || a.fold.id.localeCompare(b.fold.id)
        );

      const gap = !scored.some((s) => s.score > 0);

      const surfaced = [...alwaysOn];
      let used = countTokens(surfaced.map(activeLine).join(""));
      let folded = folds.filter((f) => !surfaced.some((s) => s.id === f.id));
      let indexTokens = countTokens(folded.map(foldedLine).join(""));
      let blockTokens = framingTokens(surfaced.length, folded.length, gap) + used + indexTokens;

      for (const { fold, score } of scored) {
        if (score <= 0) break;
        const delta = countTokens(activeLine(fold)) - countTokens(foldedLine(fold));
        if (blockTokens + delta > budget) continue;
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
        scores: debug ? scored.map(({ fold, score, rawScore, memoryAdjustment, matched }) => ({ id: fold.id, score, rawScore, memoryAdjustment, matched })) : undefined,
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
