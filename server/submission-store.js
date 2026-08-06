// SubmissionStore — the admin review queue for submitted content.
//
// Every submission carries a full provenance chain:
//   raw   – what the user actually typed or the audio they submitted
//   heard – what the model heard/transcribed (for audio; null for text)
//   edits – admin corrections, each timestamped and attributed
//   final – the approved text that gets spun into templateised forms
//
// One JSON file per submission under memory/submissions/. Pending and
// resolved submissions are stored in subdirectories so the review queue
// only ever lists what actually needs attention.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";

export const SUBMISSIONS_DIR = path.join(MEMORY_DIR, "submissions");
const PENDING_DIR = path.join(SUBMISSIONS_DIR, "pending");
const RESOLVED_DIR = path.join(SUBMISSIONS_DIR, "resolved");
const ARCHIVE_DIR = path.join(SUBMISSIONS_DIR, "archive");

function newId(prefix = "sub") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, file);
}

export class SubmissionStore {
  constructor({ dir = SUBMISSIONS_DIR } = {}) {
    this.dir = dir;
    this.pendingDir = path.join(dir, "pending");
    this.resolvedDir = path.join(dir, "resolved");
    this.archiveDir = path.join(dir, "archive");
    this._locks = new Map();
  }

  #pendingFile(id) { return path.join(this.pendingDir, `${id}.json`); }
  #resolvedFile(id) { return path.join(this.resolvedDir, `${id}.json`); }
  #archiveFile(id) { return path.join(this.archiveDir, `${id}.json`); }

  async #withLock(id, fn) {
    const prior = this._locks.get(id) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this._locks.set(id, prior.then(() => gate));
    await prior;
    try { return await fn(); }
    finally { release(); }
  }

  async #readFile(file) {
    let text;
    try { text = await fsp.readFile(file, "utf8"); }
    catch (err) { if (err.code === "ENOENT") return null; throw err; }
    try { return JSON.parse(text); }
    catch { return null; }
  }

  /**
   * Record a new submission with its raw input and optional audio model
   * transcription (what the model heard). The provenance chain starts here.
   */
  async submit({ originalText, mediaType = "text", audioModel = null, heardText = null, metadata = {} }) {
    const id = newId();
    const record = {
      id,
      status: "pending",
      provenance: {
        raw: { text: originalText, mediaType, submittedAt: new Date().toISOString() },
        heard: heardText !== null ? { text: heardText, model: audioModel, transcribedAt: new Date().toISOString() } : null,
        edits: [],
        final: null,
      },
      template: null,
      metadata,
      projectId: metadata.projectId || null,
      conversationId: metadata.conversationId || null,
      sourceId: metadata.sourceId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.#withLock(id, async () => {
      await writeAtomic(this.#pendingFile(id), JSON.stringify(record, null, 2));
    });
    return this.#summarize(record);
  }

  /** List all pending submissions (the review queue). */
  async listPending() {
    await ensureDir(this.pendingDir);
    let names;
    try { names = await fsp.readdir(this.pendingDir); }
    catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const rec = await this.#readFile(path.join(this.pendingDir, name));
      if (!rec || !rec.id) continue;
      out.push(this.#summarize(rec));
    }
    out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return out;
  }

  /** List resolved (approved/rejected) submissions. */
  async listResolved() {
    await ensureDir(this.resolvedDir);
    let names;
    try { names = await fsp.readdir(this.resolvedDir); }
    catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const rec = await this.#readFile(path.join(this.resolvedDir, name));
      if (!rec || !rec.id) continue;
      out.push(this.#summarize(rec));
    }
    out.sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""));
    return out;
  }

  /** Get a full submission record by id (searches pending then resolved). */
  async get(id) {
    let rec = await this.#readFile(this.#pendingFile(id));
    if (!rec) rec = await this.#readFile(this.#resolvedFile(id));
    if (!rec) rec = await this.#readFile(this.#archiveFile(id));
    return rec || null;
  }

  /**
   * Apply an admin edit to the submission. Adds an entry to the provenance
   * chain rather than overwriting, so the full edit history is preserved.
   */
  async edit(id, { editedText, editor = "admin", reason = "" }) {
    return this.#withLock(id, async () => {
      const rec = await this.get(id);
      if (!rec) throw new Error(`submission not found: ${id}`);
      const editEntry = {
        by: editor,
        text: editedText,
        reason,
        editedAt: new Date().toISOString(),
      };
      rec.provenance.edits.push(editEntry);
      rec.updatedAt = new Date().toISOString();
      await writeAtomic(this.#pendingFile(id), JSON.stringify(rec, null, 2));
      return this.#summarize(rec);
    });
  }

  /**
   * Approve the submission — finalises the text (latest edit or original),
   * generates a template, and moves to resolved.
   */
  async approve(id, { templateSpec = null } = {}) {
    return this.#withLock(id, async () => {
      const rec = await this.get(id);
      if (!rec) throw new Error(`submission not found: ${id}`);

      const edits = rec.provenance.edits || [];
      const finalText = edits.length > 0 ? edits[edits.length - 1].text : rec.provenance.raw.text;
      rec.provenance.final = { text: finalText, approvedAt: new Date().toISOString() };
      rec.status = "approved";
      rec.template = templateSpec || this.#buildTemplate(finalText, rec.metadata);
      rec.resolvedAt = new Date().toISOString();
      rec.updatedAt = new Date().toISOString();

      await writeAtomic(this.#resolvedFile(id), JSON.stringify(rec, null, 2));
      try { await fsp.unlink(this.#pendingFile(id)); } catch { /* already moved */ }
      return this.#summarize(rec);
    });
  }

  /** Reject without templating. */
  async reject(id, { reason = "" } = {}) {
    return this.#withLock(id, async () => {
      const rec = await this.get(id);
      if (!rec) throw new Error(`submission not found: ${id}`);
      rec.status = "rejected";
      rec.rejectionReason = reason;
      rec.resolvedAt = new Date().toISOString();
      rec.updatedAt = new Date().toISOString();
      await writeAtomic(this.#resolvedFile(id), JSON.stringify(rec, null, 2));
      try { await fsp.unlink(this.#pendingFile(id)); } catch { /* already moved */ }
      return this.#summarize(rec);
    });
  }

  /** Restore a resolved submission back to pending. */
  async reopen(id) {
    return this.#withLock(id, async () => {
      const rec = await this.#readFile(this.#resolvedFile(id));
      if (!rec) throw new Error(`resolved submission not found: ${id}`);
      rec.status = "pending";
      rec.resolvedAt = null;
      rec.rejectionReason = null;
      rec.template = null;
      rec.provenance.final = null;
      rec.updatedAt = new Date().toISOString();
      await writeAtomic(this.#pendingFile(id), JSON.stringify(rec, null, 2));
      try { await fsp.unlink(this.#resolvedFile(id)); } catch { /* already moved */ }
      return this.#summarize(rec);
    });
  }

  /** Permanently archive a resolved submission. */
  async archive(id) {
    const rec = await this.#readFile(this.#resolvedFile(id));
    if (!rec) throw new Error(`resolved submission not found: ${id}`);
    rec.status = "archived";
    rec.archivedAt = new Date().toISOString();
    rec.updatedAt = new Date().toISOString();
    await writeAtomic(this.#archiveFile(id), JSON.stringify(rec, null, 2));
    try { await fsp.unlink(this.#resolvedFile(id)); } catch { /* already moved */ }
    return this.#summarize(rec);
  }

  /** Queue stats for the admin dashboard. */
  async stats() {
    const pending = await this.listPending();
    const resolved = await this.listResolved();
    const approved = resolved.filter(r => r.status === "approved").length;
    const rejected = resolved.filter(r => r.status === "rejected").length;
    return { pending: pending.length, resolved: resolved.length, approved, rejected };
  }

  #summarize(rec) {
    const edits = rec.provenance?.edits || [];
    return {
      id: rec.id,
      status: rec.status,
      mediaType: rec.provenance?.raw?.mediaType || "text",
      originalText: (rec.provenance?.raw?.text || "").slice(0, 140),
      heardText: rec.provenance?.heard ? (rec.provenance.heard.text || "").slice(0, 140) : null,
      hasHeard: !!rec.provenance?.heard,
      hasEdits: edits.length > 0,
      editCount: edits.length,
      finalText: rec.provenance?.final ? (rec.provenance.final.text || "").slice(0, 140) : null,
      hasTemplate: !!rec.template,
      templateKind: rec.template?.kind || null,
      metadata: rec.metadata || {},
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      resolvedAt: rec.resolvedAt || null,
      rejectionReason: rec.rejectionReason || null,
    };
  }

  #buildTemplate(text, metadata) {
    const kind = metadata.kind || "form";
    return {
      kind,
      title: (text || "").slice(0, 80),
      body: text,
      fields: this.#extractFields(text, kind),
      generatedAt: new Date().toISOString(),
    };
  }

  #extractFields(text, kind) {
    if (kind === "query") {
      return [{ name: "question", value: text }];
    }
    const fields = [];
    const lines = (text || "").split("\n").filter(l => l.trim());
    for (const line of lines) {
      const m = line.match(/^(.+?):\s*(.+)/);
      if (m) {
        fields.push({ name: m[1].trim(), value: m[2].trim() });
      }
    }
    if (!fields.length) {
      fields.push({ name: "content", value: text });
    }
    return fields;
  }
}

export const submissionStore = new SubmissionStore();
