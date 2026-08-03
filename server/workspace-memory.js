// workspace-memory.js — per-project memory of feedback and compliance, used to
// weight instruction surf scoring.
//
// Each project has a memory file that records:
//   - Turn outcomes (which folds were active, compliance verdict)
//   - User feedback (positive, negative, corrections)
//   - Fold-level weight adjustments derived from feedback
//
// The gate reads this memory when scoring folds: a fold with a history of
// non-compliance or negative feedback gets its effective weight reduced,
// making it less likely to surface. A fold that consistently produces good
// results gets a boost.
//
// Storage: memory/workspace-memory/<projectId>.jsonl

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

const MEMORY_DIR_PATH = path.join(MEMORY_DIR, "workspace-memory");

async function ensureDir() {
  await fsp.mkdir(MEMORY_DIR_PATH, { recursive: true });
}

function memoryFile(projectId) {
  return path.join(MEMORY_DIR_PATH, `${projectId}.jsonl`);
}

async function readLines(projectId) {
  const file = memoryFile(projectId);
  try {
    const raw = await fsp.readFile(file, "utf8");
    return raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function appendLine(projectId, entry) {
  await ensureDir();
  const line = JSON.stringify(entry) + "\n";
  await fsp.appendFile(memoryFile(projectId), line);
}

// ── Feedback types ─────────────────────────────────────────────────────────
// positive     — user liked the response (thumbs up, "good", etc.)
// negative     — user disliked the response (thumbs down, "bad", correction)
// correction   — user provided a corrected version or explicit fix
// noncompliant — compliance checker flagged the response
// compliant    — compliance checker passed the response

// ── Weight adjustment ──────────────────────────────────────────────────────
// Each feedback event produces a delta for each active fold. The delta is
// applied to the fold's base weight at surf time (not stored permanently in
// the fold itself — the base weight stays what the user set, and the memory
// layer adds/subtracts on top).

const FEEDBACK_DELTAS = {
  positive: 2,
  negative: -3,
  correction: -5,
  noncompliant: -4,
  compliant: 1,
};

export class WorkspaceMemory {
  /**
   * Record a turn's outcome.
   * @param {string} projectId
   * @param {object} entry
   * @param {string} entry.turnId
   * @param {string} entry.question
   * @param {string[]} entry.activeFoldIds  folds that were surfaced
   * @param {string} entry.verdict          'compliant' | 'noncompliant' | 'unknown'
   * @param {string} [entry.feedback]       'positive' | 'negative' | 'correction' | null
   * @param {string} [entry.correction]     user's corrected text (if feedback === 'correction')
   * @param {object} [entry.compliance]     DEF/EVA/REC result object
   */
  async recordTurn(projectId, entry) {
    const record = {
      ts: new Date().toISOString(),
      turnId: entry.turnId,
      question: entry.question,
      activeFoldIds: entry.activeFoldIds || [],
      verdict: entry.verdict || "unknown",
      feedback: entry.feedback || null,
      correction: entry.correction || null,
      compliance: entry.compliance || null,
    };
    await appendLine(projectId, record);
    return record;
  }

  /**
   * Get the weight adjustment for a fold, based on its feedback history.
   * Returns a number to add to the fold's base weight (can be negative).
   */
  async foldAdjustment(projectId, foldId, window = 20) {
    const lines = await readLines(projectId);
    const recent = lines.slice(-window);
    let delta = 0;
    for (const entry of recent) {
      if (!entry.activeFoldIds.includes(foldId)) continue;
      if (entry.feedback && FEEDBACK_DELTAS[entry.feedback] !== undefined) {
        delta += FEEDBACK_DELTAS[entry.feedback];
      }
      if (entry.verdict === "compliant") delta += FEEDBACK_DELTAS.compliant;
      if (entry.verdict === "noncompliant") delta += FEEDBACK_DELTAS.noncompliant;
    }
    return delta;
  }

  /**
   * Get all fold adjustments for a project.
   */
  async allAdjustments(projectId, window = 20) {
    const lines = await readLines(projectId);
    const recent = lines.slice(-window);
    const adjustments = new Map();
    for (const entry of recent) {
      for (const foldId of entry.activeFoldIds) {
        const current = adjustments.get(foldId) || 0;
        let delta = 0;
        if (entry.feedback && FEEDBACK_DELTAS[entry.feedback] !== undefined) {
          delta += FEEDBACK_DELTAS[entry.feedback];
        }
        if (entry.verdict === "compliant") delta += FEEDBACK_DELTAS.compliant;
        if (entry.verdict === "noncompliant") delta += FEEDBACK_DELTAS.noncompliant;
        adjustments.set(foldId, current + delta);
      }
    }
    return adjustments;
  }

  /**
   * Get recent feedback history for a project.
   */
  async recentFeedback(projectId, limit = 50) {
    const lines = await readLines(projectId);
    return lines.slice(-limit).map((e) => ({
      ts: e.ts,
      turnId: e.turnId,
      question: e.question,
      activeFoldIds: e.activeFoldIds,
      verdict: e.verdict,
      feedback: e.feedback,
      correction: e.correction,
    }));
  }

  /**
   * Get compliance history.
   */
  async complianceHistory(projectId, limit = 30) {
    const lines = await readLines(projectId);
    return lines
      .filter((e) => e.compliance)
      .slice(-limit)
      .map((e) => ({
        ts: e.ts,
        turnId: e.turnId,
        method: e.compliance.method,
        verdict: e.verdict,
        activeFoldIds: e.activeFoldIds,
      }));
  }

  /**
   * Clear all memory for a project.
   */
  async clear(projectId) {
    const file = memoryFile(projectId);
    try {
      await fsp.unlink(file);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return { deleted: true, projectId };
  }

  /**
   * Get summary stats for a project.
   */
  async stats(projectId) {
    const lines = await readLines(projectId);
    const total = lines.length;
    const compliant = lines.filter((e) => e.verdict === "compliant").length;
    const noncompliant = lines.filter((e) => e.verdict === "noncompliant").length;
    const positive = lines.filter((e) => e.feedback === "positive").length;
    const negative = lines.filter((e) => e.feedback === "negative").length;
    const corrections = lines.filter((e) => e.feedback === "correction").length;
    return { total, compliant, noncompliant, positive, negative, corrections };
  }
}

export const workspaceMemory = new WorkspaceMemory();
