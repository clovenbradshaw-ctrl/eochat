// project-memory.js — the project-global file cabinet.
//
// The desk (conversation-memory.js) is bounded and always on-screen; it cannot
// hold everything a project learns, and it must not — most of what is said in
// one conversation is local to it, and a desk that grew to fit every project
// fact would crowd out the history, the instruction gate, and the passages.
// This module is the cabinet: durable, project-wide memory that persists
// across conversations in the same project and is RETRIEVED BY CUE rather than
// injected always, the way a person reaches for a file rather than keeping
// every file on the desk.
//
// What belongs in the cabinet: facts the desk confirmed. A fact the assistant
// acknowledged ("noted", or restated in an answer) is a fact the project now
// depends on; a fact merely said once and never taken up stays local to the
// conversation it was said in. That single rule keeps the cabinet from
// becoming a dumping ground — entry is earned by acknowledgment, not by having
// been typed.
//
// Retrieval is mechanical and auditable: a memo is retrieved because its terms
// overlap the question's terms (code-like tokens score double, since a code is
// the shape of fact most likely to be searched for and most costly to forget),
// and the same words are returned in the stats so a client can show WHY a memo
// surfaced. Use strengthens the trace: every retrieval bumps accessCount and
// lastAccessed, and those weight the next retrieval's tie-break.
//
// This module is pure and synchronous; the project store owns persistence.

import { contentTerms, normalizeFactText, sameFact } from "./conversation-memory.js";

// ── Budgets ──────────────────────────────────────────────────────────────────

export const CABINET_MAX = 200;            // hard cap on memos kept per project
export const CABINET_MEMO_MAX_CHARS = 300; // a memo longer than this is a file, not a note
export const CABINET_RETRIEVE_BUDGET = 3000; // char budget for one retrieval (≈850 tokens)
export const CABINET_TOP = 6;              // memos returned per retrieval
const MEMO_LINE_OVERHEAD = 24;             // "N. " + per-memo formatting
const CODE_LIKE_BONUS = 2;

// ── Identity ─────────────────────────────────────────────────────────────────

function newId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The stable topic terms a memo is indexed under. Derived from its own text at
 * insert time and stored, so scoring can match against the index even when a
 * later question quotes only a fragment of the memo.
 */
export function memoKeys(text) {
  return [...new Set(contentTerms(text, { cap: 24 }))];
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * How relevant a memo is to a cue. Returns the shared terms as well as the
 * score, because the matched terms ARE the audit trail: a memo surfaces
 * because these exact words hit, and nothing else.
 */
export function scoreMemo(memo, cue) {
  const cueTerms = new Set(contentTerms(cue));
  const pool = new Set([...(memo.keys || []), ...contentTerms(memo.text, { cap: 48 })]);
  const shared = [...cueTerms].filter((t) => pool.has(t));
  if (!shared.length) return { score: 0, shared: [] };
  const codeLike = shared.filter((t) => /\d/.test(t) || t.length >= 8).length;
  return { score: shared.length + codeLike * CODE_LIKE_BONUS, shared };
}

// ── State ────────────────────────────────────────────────────────────────────

export function emptyCabinet() {
  return { memos: [] };
}

function now() {
  return new Date().toISOString();
}

/**
 * Insert or strengthen one memo. Pure: returns a new cabinet. Existing memos
 * are matched by the same normalisation the desk uses, so a restatement of an
 * already-cabineted fact strengthens it instead of duplicating it. The cabinet
 * is capped; when it overflows, the lowest-weight, oldest memos are evicted.
 */
export function upsertMemo(cabinet, { text, source = "reader", conversationId = "", turn = 0 } = {}) {
  const state = cabinet || emptyCabinet();
  if (!text || text.length > CABINET_MEMO_MAX_CHARS) return state;

  const memos = state.memos.map((m) => ({ ...m }));
  const existing = memos.find((m) => sameFact(m.text, text));
  const timestamp = now();

  if (existing) {
    existing.weight = (existing.weight || 1) + 1;
    existing.lastTurn = Math.max(existing.lastTurn ?? turn, turn);
    existing.updatedAt = timestamp;
  } else {
    const keys = memoKeys(text);
    memos.push({
      id: newId(),
      keys,
      text,
      source,
      conversationId,
      turn,
      lastTurn: turn,
      confirmed: true,
      weight: 1,
      accessCount: 0,
      lastAccessed: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  memos.sort((a, b) =>
    (b.weight || 0) - (a.weight || 0) ||
    (b.lastTurn ?? 0) - (a.lastTurn ?? 0) ||
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  );

  return { ...state, memos: memos.slice(0, CABINET_MAX) };
}

/**
 * Move the desk's confirmed facts into the cabinet. Unconfirmed facts stay on
 * the desk; only acknowledgment earns a place in the file. Pure.
 */
export function mergeDeskFacts(cabinet, { facts = [], conversationId = "", turn = 0 } = {}) {
  let state = cabinet || emptyCabinet();
  for (const f of facts) {
    if (!f.confirmed) continue;
    state = upsertMemo(state, { text: f.text, conversationId, turn });
  }
  return state;
}

// ── Retrieval ────────────────────────────────────────────────────────────────

/**
 * Retrieve the memos a cue points at. Mechanical: only memos whose terms
 * overlap the cue are candidates; they are ranked by score, then by how
 * strongly the project has used them (usage strengthens the trace), then by
 * recency, and packed under a char budget. A retrieval that finds nothing
 * says so with counts — a scored-but-empty result and a skipped retrieval
 * must not read the same (LAWS.md: two facts that differ must not read alike).
 */
export function retrieveCabinet(cabinet, { question = "", cue = "", budgetChars = CABINET_RETRIEVE_BUDGET, top = CABINET_TOP } = {}) {
  const memos = cabinet?.memos || [];
  if (!memos.length) {
    return { memos: [], stats: { scored: 0, hits: 0, retrieved: 0, usedChars: 0, budgetChars } };
  }
  const cueText = [cue, question].filter(Boolean).join(" ");
  const scored = memos.map((memo) => ({ memo, ...scoreMemo(memo, cueText) }));
  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      (b.memo.weight || 0) - (a.memo.weight || 0) ||
      (b.memo.lastTurn ?? 0) - (a.memo.lastTurn ?? 0) ||
      (b.memo.lastAccessed || "").localeCompare(a.memo.lastAccessed || "")
    );

  const picked = [];
  let used = 0;
  for (const s of hits) {
    if (picked.length >= top) break;
    const cost = s.memo.text.length + MEMO_LINE_OVERHEAD;
    if (picked.length > 0 && used + cost > budgetChars) break;
    picked.push(s.memo);
    used += cost;
  }

  return {
    memos: picked,
    stats: { scored: memos.length, hits: hits.length, retrieved: picked.length, usedChars: used, budgetChars },
  };
}

/**
 * Record that memos were actually used this turn. Usage strengthens the trace:
 * a memo retrieved and answered FROM is worth more next time than one that was
 * merely a candidate. Pure.
 */
export function markAccessed(cabinet, ids, at = now()) {
  if (!cabinet || !ids?.length) return cabinet;
  const idSet = new Set(ids);
  const memos = cabinet.memos.map((m) =>
    idSet.has(m.id)
      ? { ...m, accessCount: (m.accessCount || 0) + 1, lastAccessed: at }
      : m
  );
  return { ...cabinet, memos };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The cabinet as the model sees it. The header tells the model the same two
 * things the desk header does: these are records of the conversation, not
 * source passages (never bracket-cite them), and a memo that exists here was
 * real in this project — do not deny it.
 */
export function buildCabinetBlock(memos) {
  if (!memos?.length) return null;
  const lines = [];
  lines.push("PROJECT CABINET — durable notes retrieved because they matched this question. They record what was confirmed in this project; they are not source passages, so never cite them with brackets. A note listed here was real — do not deny or say it was never discussed.");
  memos.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.text}`);
  });
  return lines.join("\n");
}

/** One number per shape, so a client can render the cabinet without parsing it. */
export function cabinetStats(cabinet) {
  const memos = cabinet?.memos || [];
  const accessed = memos.filter((m) => (m.accessCount || 0) > 0).length;
  return {
    memos: memos.length,
    max: CABINET_MAX,
    accessed,
    chars: memos.reduce((n, m) => n + m.text.length, 0),
    topKeys: memos
      .slice()
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 8)
      .map((m) => (m.keys || []).slice(0, 3).join(" ")),
  };
}
