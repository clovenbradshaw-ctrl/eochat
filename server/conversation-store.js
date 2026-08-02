// ConversationStore — the durable record of "conversation" as EOChat's first-class
// object. Before this, a "space" (question/answer turns, source scope) lived only in
// the browser's localStorage: closing one browser lost it, and no server-side code
// could reason about "which sources may this conversation ground against" — the
// question the turn-controller has to answer honestly before every retrieval.
//
// One JSON file per conversation under memory/conversations/. memory/ is gitignored
// (see .gitignore) — this is runtime state, never repo content, exactly like
// memory/discourse/ and memory/model-router-ledger.jsonl already are.
//
// Writes are atomic (write to a sibling temp file, then rename into place) so a
// process kill mid-write can never leave a half-written record. Reads that hit a
// record which fails to parse are quarantined into .corrupt/ and treated as absent
// rather than throwing — one bad file must not take the whole conversation list down.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";
import { addUsage, rollUpUsage } from "./token-tally.js";

/**
 * The conversation's running token tally, as callers want to read it.
 *
 * Kept as a `{ model: usage }` map on the record and rolled up on read rather
 * than stored pre-summed, because the roll-up is where per-model pricing is
 * applied — a stored total would freeze today's prices into last week's
 * conversation and quietly go wrong when the table is updated.
 */
export function usageView(conv) {
  return rollUpUsage(conv?.usage?.byModel);
}

export const CONVERSATIONS_DIR = path.join(MEMORY_DIR, "conversations");
const TRASH_DIR = path.join(CONVERSATIONS_DIR, ".trash");
const CORRUPT_DIR = path.join(CONVERSATIONS_DIR, ".corrupt");

function newId(prefix = "c") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** Write `data` to `file` atomically: temp file in the same directory, then rename. */
async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, file);
}

export class ConversationNotFoundError extends Error {
  constructor(id) {
    super(`conversation not found: ${id}`);
    this.name = "ConversationNotFoundError";
    this.code = "conversation_not_found";
  }
}

export class ConversationStore {
  constructor({ dir = CONVERSATIONS_DIR } = {}) {
    this.dir = dir;
    this.trashDir = path.join(dir, ".trash");
    this.corruptDir = path.join(dir, ".corrupt");
    // One promise chain per conversation id — serializes read-modify-write so
    // concurrent patches (a turn starting while another finishes) cannot clobber
    // each other. Not a distributed lock — this process is the only writer, which
    // is the same assumption memory/discourse/*.jsonl already makes.
    this._locks = new Map();
  }

  #file(id) { return path.join(this.dir, `${id}.json`); }
  #trashFile(id) { return path.join(this.trashDir, `${id}.json`); }

  async #withLock(id, fn) {
    const prior = this._locks.get(id) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this._locks.set(id, prior.then(() => gate));
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(id) === undefined) { /* no-op */ }
    }
  }

  /** Parse a conversation record off disk. Quarantines and returns null on corruption. */
  async #readFile(file, { quarantineOnError = true } = {}) {
    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      if (quarantineOnError) {
        await ensureDir(this.corruptDir);
        const dest = path.join(this.corruptDir, `${path.basename(file)}.${Date.now()}.bad`);
        try { await fsp.rename(file, dest); } catch { /* best-effort */ }
        console.error(`[conversation-store] quarantined malformed record ${file} -> ${dest}: ${err.message}`);
      }
      return null;
    }
  }

  async #save(conv) {
    conv.updatedAt = new Date().toISOString();
    await writeAtomic(this.#file(conv.id), JSON.stringify(conv, null, 2));
    return conv;
  }

  /** List conversation summaries, newest first. Excludes trashed conversations. */
  async list() {
    await ensureDir(this.dir);
    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const conv = await this.#readFile(path.join(this.dir, name));
      if (!conv || !conv.id) continue;
      out.push(this.#summarize(conv));
    }
    out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return out;
  }

  /** Deleted (soft-removed) conversations, for a recycle-bin-style UI. */
  async listDeleted() {
    await ensureDir(this.trashDir);
    let names;
    try {
      names = await fsp.readdir(this.trashDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const conv = await this.#readFile(path.join(this.trashDir, name), { quarantineOnError: false });
      if (!conv || !conv.id) continue;
      out.push(this.#summarize(conv));
    }
    out.sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
    return out;
  }

  #summarize(conv) {
    return {
      id: conv.id,
      title: conv.title,
      spaceId: conv.spaceId ?? null,
      pool: conv.pool || "corpus",
      sourceScope: conv.sourceScope ?? null,
      parentId: conv.parentId || null,
      path: conv.path || null,
      mode: conv.mode || "chat",
      childIds: conv.childIds || [],
      turnCount: (conv.turns || []).length,
      // The running tally travels with the summary, so the conversation list
      // can show what each one has cost without loading every full record.
      usage: usageView(conv),
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      deletedAt: conv.deletedAt || null,
    };
  }

  async get(id) {
    const conv = await this.#readFile(this.#file(id));
    return conv;
  }

  /** Throws ConversationNotFoundError if absent — for route handlers that need a 404. */
  async require(id) {
    const conv = await this.get(id);
    if (!conv) throw new ConversationNotFoundError(id);
    return conv;
  }

  async create({ title, spaceId = null, pool = "corpus", sourceScope = null, parentId = null, path = null, mode = "chat" } = {}) {
    const now = new Date().toISOString();
    const conv = {
      id: newId(),
      title: title || "New conversation",
      spaceId,
      pool,
      // null = no filter (every enabled source). [] = every source switched off,
      // which must retrieve nothing — see server/engine-ground.js sourceMatcher.
      sourceScope,
      parentId: parentId || null,
      path: path || null,
      mode: mode || "chat",
      turns: [],
      // Running token tally, one bucket per model that has answered here.
      // Records written before this field existed simply have no bucket and
      // read as zero — an honest "nothing was measured", not a wrong number.
      usage: { byModel: {} },
      createdAt: now,
      updatedAt: now,
    };
    await writeAtomic(this.#file(conv.id), JSON.stringify(conv, null, 2));
    // If this is a child conversation, register it in the parent's childIds
    if (parentId) {
      await this.#withLock(parentId, async () => {
        const parent = await this.require(parentId);
        if (!parent.childIds) parent.childIds = [];
        if (!parent.childIds.includes(conv.id)) {
          parent.childIds.push(conv.id);
        }
        return this.#save(parent);
      });
    }
    return conv;
  }

  async update(id, patch) {
    return this.#withLock(id, async () => {
      const conv = await this.require(id);
      if (patch.title !== undefined) conv.title = patch.title;
      if (patch.sourceScope !== undefined) conv.sourceScope = patch.sourceScope;
      if (patch.pool !== undefined) conv.pool = patch.pool;
      if (patch.spaceId !== undefined) conv.spaceId = patch.spaceId;
      if (patch.mode !== undefined) conv.mode = patch.mode;
      if (patch.path !== undefined) conv.path = patch.path;
      return this.#save(conv);
    });
  }

  /** Soft delete — moves the record into .trash/ so restore() can bring it back. */
  async remove(id) {
    return this.#withLock(id, async () => {
      const conv = await this.require(id);
      conv.deletedAt = new Date().toISOString();
      await ensureDir(this.trashDir);
      await writeAtomic(this.#trashFile(id), JSON.stringify(conv, null, 2));
      await fsp.unlink(this.#file(id)).catch(() => {});
      return this.#summarize(conv);
    });
  }

  async restore(id) {
    const trashed = await this.#readFile(this.#trashFile(id), { quarantineOnError: false });
    if (!trashed) throw new ConversationNotFoundError(id);
    delete trashed.deletedAt;
    await writeAtomic(this.#file(id), JSON.stringify(trashed, null, 2));
    await fsp.unlink(this.#trashFile(id)).catch(() => {});
    return trashed;
  }

  async purge(id) {
    await fsp.unlink(this.#trashFile(id)).catch(() => {});
  }

  /** Appends a new user turn (question + the source scope it was asked against). */
  async appendTurn(id, { question, sourceScope, attachments = [] }) {
    return this.#withLock(id, async () => {
      const conv = await this.require(id);
      const turn = {
        id: newId("t"),
        question,
        sourceScope: sourceScope !== undefined ? sourceScope : conv.sourceScope,
        attachments,
        createdAt: new Date().toISOString(),
        answers: [],
        activeAnswerId: null,
      };
      conv.turns.push(turn);
      await this.#save(conv);
      return { conv, turn };
    });
  }

  #findTurn(conv, turnId) {
    const turn = (conv.turns || []).find((t) => t.id === turnId);
    if (!turn) throw new Error(`turn not found: ${turnId}`);
    return turn;
  }

  /** Adds a new assistant answer (a "variant") to a turn and makes it active. */
  async addAnswer(id, turnId, answer) {
    return this.#withLock(id, async () => {
      const conv = await this.require(id);
      const turn = this.#findTurn(conv, turnId);
      const full = {
        id: newId("a"),
        status: "streaming", // streaming | completed | interrupted | failed
        text: "",
        citations: [],
        gaps: [],
        snippets: [],
        grounding: null,
        trace: [],
        model: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        ...answer,
      };
      turn.answers.push(full);
      turn.activeAnswerId = full.id;
      await this.#save(conv);
      return full;
    });
  }

  async patchAnswer(id, turnId, answerId, patch) {
    return this.#withLock(id, async () => {
      const conv = await this.require(id);
      const turn = this.#findTurn(conv, turnId);
      const answer = turn.answers.find((a) => a.id === answerId);
      if (!answer) throw new Error(`answer not found: ${answerId}`);
      Object.assign(answer, patch);
      await this.#save(conv);
      return answer;
    });
  }

  /**
   * Record what one model call cost, against both the answer that spent it
   * and the conversation's running total.
   *
   * `usage` REPLACES the answer's own tally and the conversation total is
   * recomputed from every answer, rather than being incremented. A streaming
   * call reports its usage repeatedly as it grows (see anthropic-provider.js),
   * and a regenerated turn adds a second answer to the same turn — under
   * increment-on-report either would inflate the tally. Recomputing from the
   * answers means the total is always exactly the sum of what is on record.
   */
  async recordUsage(id, turnId, answerId, usage, model) {
    return this.#withLock(id, async () => {
      const conv = await this.require(id);
      const turn = this.#findTurn(conv, turnId);
      const answer = turn.answers.find((a) => a.id === answerId);
      if (!answer) throw new Error(`answer not found: ${answerId}`);
      answer.usage = usage ? { ...usage } : null;
      if (model) answer.usageModel = model;

      const byModel = {};
      for (const t of conv.turns || []) {
        for (const a of t.answers || []) {
          if (!a.usage) continue;
          const key = a.usageModel || a.model || "unknown";
          byModel[key] = addUsage(byModel[key], a.usage);
        }
      }
      conv.usage = { byModel };
      await this.#save(conv);
      return usageView(conv);
    });
  }

  async setActiveAnswer(id, turnId, answerId) {
    return this.#withLock(id, async () => {
      const conv = await this.require(id);
      const turn = this.#findTurn(conv, turnId);
      if (!turn.answers.some((a) => a.id === answerId)) throw new Error(`answer not found: ${answerId}`);
      turn.activeAnswerId = answerId;
      await this.#save(conv);
      return turn;
    });
  }

  // ── Hierarchical conversation navigation ──
  //
  // Conversations can have parent/child relationships forming a tree. A child
  // conversation inherits its parent's pool and sourceScope by default, and
  // carries a `mode` flag: "chat" (default), "surf" (evidence retrieval only),
  // or "think" (holonic task decomposition).
  //
  // The `path` field follows the folder notation `parent_title/child_title`,
  // e.g. "frankenstein_discussion/surf:creature_motivation" or
  // "frankenstein_discussion/think:write_analysis".

  /** Create a child conversation under a parent. */
  async createChild(parentId, { path, mode = "surf", title = null, pool = null, sourceScope = null } = {}) {
    const parent = await this.require(parentId);
    return this.create({
      title: title || `${parent.title || "conv"}/${path}`,
      parentId,
      path,
      mode,
      pool: pool || parent.pool,
      sourceScope: sourceScope !== undefined ? sourceScope : parent.sourceScope,
    });
  }

  /** List direct children of a conversation. */
  async findChildren(parentId) {
    const all = await this.list();
    return all.filter((c) => c.parentId === parentId);
  }

  /** Find a child conversation by its path segment within a parent. */
  async findChildByPath(parentId, pathSegment) {
    const children = await this.findChildren(parentId);
    return children.find((c) => c.path === pathSegment) || null;
  }

  /** Resolve a path string like "parent_id/path_segment" to a conversation summary, or null.
   *  The path can be a conversation id directly, or a parentId/path format. */
  async resolvePath(pathStr) {
    if (!pathStr || typeof pathStr !== "string") return null;
    // Try as a direct conversation ID first
    const direct = await this.get(pathStr);
    if (direct) return this.#summarize(direct);
    // Try parentId/path format
    const slashIdx = pathStr.indexOf("/");
    if (slashIdx > 0) {
      const parentId = pathStr.slice(0, slashIdx);
      const pathSegment = pathStr.slice(slashIdx + 1);
      const parent = await this.require(parentId).catch(() => null);
      if (parent) {
        const child = await this.findChildByPath(parentId, pathSegment);
        if (child) return child;
        // Child doesn't exist yet — return parent info so the caller can create it
        return { ...this.#summarize(parent), _wouldCreate: { parentId, path: pathSegment } };
      }
    }
    return null;
  }

  /** Build the full breadcrumb path from a conversation to the root. */
  async breadcrumbs(id) {
    const crumbs = [];
    let current = await this.get(id);
    while (current) {
      crumbs.unshift(this.#summarize(current));
      current = current.parentId ? await this.get(current.parentId) : null;
    }
    return crumbs;
  }
}

export const conversationStore = new ConversationStore();
