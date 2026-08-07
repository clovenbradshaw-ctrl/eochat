#!/usr/bin/env node
/**
 * EO Reader Proxy — resilient, tool-calling proxy for Ollama
 *
 * Fixes over the original:
 * - Request body size limits (prevents OOM)
 * - Graceful shutdown (SIGTERM/SIGINT drains connections)
 * - Upstream retry with backoff (resilient to Ollama restarts)
 * - Bounded memory store with TTL eviction
 * - Async I/O in all paths (no fs.writeFileSync in request handlers)
 * - Request timeouts (no hanging connections)
 * - Streaming support (SSE for chat completions)
 * - Health check endpoint
 * - MCP client integration
 * - Tool-calling loop (function calling compatible)
 * - All I/O errors are caught per-operation (no single-point crash)
 *
 * Usage:
 *   node proxy.js [options]
 *
 * Options:
 *   --port=<n>        Proxy port (default: 11435)
 *   --target=<url>    Ollama endpoint (default: http://localhost:11434)
 *   --limit=<n>       Token limit for context assembly (default: 3000)
 *   --max-body=<n>    Max request body in bytes (default: 5242880)
 *   --store-ttl=<n>   Store entry TTL in ms (default: 3600000 = 1hr)
 *   --store-max=<n>   Max store entries (default: 10000)
 *
 * `npm start` sets UV_THREADPOOL_SIZE=16 (Node's default is 4). This process
 * fans out a lot of concurrent fs work under load — per-ingest attachment
 * sidecars, discourse JSONL appends, web-page snapshots — all of which share
 * libuv's threadpool with everything else, admission included (see
 * ingest-worker.js). Four threads queue behind each other exactly the way a
 * blocked main thread does, just less severely; must be set before Node
 * starts (a same-process assignment here would be too late — the pool
 * initializes on first use), hence the launch-time env var rather than a
 * line in this file.
 */

import http from "http";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

// Every path reaching outside this repo resolves here — no hardcoded
// home-directory absolutes, no walking up out of the source tree.
import { REPO_ROOT, MEMORY_DIR, UI_DIR, INDEX_REPOS, assertDependencies, PERCEIVER_DISPATCH, perceiverDispatchUrl } from "./paths.js";
import { createModelRouter } from "./model-router.js";
import { ensureSession, engineIngestFileAsync, engineIngestTextAsync, engineIngestFile, engineIngestText, engineGroundQuery, engineSearch, engineReadSpan, engineReadSegment, engineReadSourceBytes, engineReadContext, engineStats, engineListSources, engineFoldSource, engineDeleteSource, engineListRecycleBin, engineRestoreSource, enginePurgeSource, enginePurgeRecycleBin, engineRecycleBinStats, outlineOfText, engineOutlineOfSource, buildGroundedSystemPrompt, buildUngroundedSystemPrompt, foldConversationTurns } from "./engine-ground.js";
import { foldTurn, updateSummary, emptySummary } from "./conversation-summary.js";
import { terminateIngestWorker } from "./ingest-worker-client.js";
import { formatTerrainReport } from "./terrain-report-format.js";
import { compileInstructionFolds } from "./project-instructions.js";
import { createInstructionGate, countTokens as gateCountTokens, DEFAULT_INSTRUCTION_BUDGET } from "./instruction-gate.js";
import { DELIBERATE_FOLD_IDS, runDeliberateAnswer } from "./longform-orchestrator.js";
import { loadCorefPrior, activatePriors } from "./priors-bridge.js";
// Static, not dynamic: the request handler is synchronous, and the module only
// catalogs on import — ingest stays lazy behind ensurePriorsIngested().
import * as priorsSource from "./priors-source.js";
import { HolonicTask } from "./holonic-task.js";
import { sensesCatalog, SENSE_CATEGORIES } from "./senses-catalog.js";
import * as sensesState from "./senses-state.js";
import { refreshHfCatalog, discoverCacheStatus } from "./senses-hf.js";
import { ConversationStore, ConversationNotFoundError } from "./conversation-store.js";
import { submissionStore } from "./submission-store.js";
import { createTurnController, buildWebSystemMessage } from "./turn-controller.js";
import { cabinetStore } from "./cabinet-store.js";
import { cabinetStats } from "./project-memory.js";
import { buildMemoryMessage, emptyMemory } from "./conversation-memory.js";
import { webSearchAndFetch, flattenDdgTopics } from "./web-search.js";
import { runSessionMessage } from "./code-longform-session.js";
import { runEoCodeTask, listWorkspaces, listWorkspaceFiles, startEoCodeSession, stepEoCodeSession, cancelEoCodeSession } from "./eocode-agent.js";
import { loadMorphologyPrior, discoverNarratorContext } from "./longform-node-context.js";
import { startTelemetry, systemSnapshot, recordTokens, endGeneration } from "./telemetry.js";

// ── CLI args with validation ──

function parseArg(name, def, parse = (v) => v) {
  const idx = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx < 0) return def;
  const arg = process.argv[idx];
  const val = arg.includes("=") ? arg.split("=").slice(1).join("=") : process.argv[idx + 1];
  if (val === undefined || val.startsWith("--")) return def;
  try { return parse(val); } catch { return def; }
}

const REPO_PATH = parseArg("repo", REPO_ROOT);
const PORT = parseArg("port", 11435, Number);
const TARGET = parseArg("target", "http://localhost:11434");
let ANTHROPIC_KEY = parseArg("anthropic-key", process.env.ANTHROPIC_API_KEY || "");
let ANTHROPIC_MODEL = parseArg("anthropic-model", "claude-sonnet-4-20250514");
const TOKEN_LIMIT = parseArg("limit", 3000, Number);
const MAX_BODY = parseArg("max-body", 5_242_880, Number);
const STORE_TTL = parseArg("store-ttl", 3_600_000, Number);
const STORE_MAX = parseArg("store-max", 10_000, Number);

// A second instance of the same cheap, stateless gate turn-controller.js
// builds one of internally (server/turn-controller.js:instructionGate) — for
// deciding, in /api/ground, whether the browser-local WebLLM path should run
// the deliberate long-form pipeline too. Not threaded through as a shared
// dependency because the gate is designed to be cheap and re-creatable
// (module-level constant, loaded once), exactly like gateInstructionBlock's
// own per-project gate already does.
const groundInstructionGate = createInstructionGate();

// See the /shared/ route below for why this exists and why it is an
// explicit list rather than a directory-wide passthrough.
const SHARED_FILE_ALLOWLIST = new Set([
  "server/longform.js",
  "server/longform-orchestrator.js",
  "server/task-log.js",
  "vendor/eoreader5/packages/def/attribution.js",
  "vendor/eoreader5/packages/def/svo.js",
  "vendor/eoreader5/packages/def/morphology.js",
]);

// Tracks a background corpus ingest so "still loading" stays distinguishable
// from "your sources genuinely do not say this" — a query landing mid-ingest
// returned the ordinary `no_evidence_matched` gap, which reads identically to
// real silence. Two different facts; they must not read alike.
//
// Nothing sets these today: the boot-time ingest that did was removed (see
// start()), so the corpus is only ever what the reader attached, and it is
// never half-loaded behind their back. The flags stay because any future
// background ingest needs exactly this distinction — `started` false means
// every empty result is honest silence, which is the correct reading now.
const corpusWarmup = { started: false, ready: false };

// ── Model routing ──
// The talker writes prose over passages a dispatcher already chose. It is not
// a coding assistant and never calls a tool, so both candidates are small
// instruct models. The previous default paired phi4-mini with qwen2.5-coder:7b
// — a CODE model — which answered a Frankenstein question by refusing while
// holding the evidence, and took 256s to do it.
const TINY_MODEL = parseArg("tiny-model", "llama3.2:latest");
const MEDIUM_MODEL = parseArg("medium-model", "phi4-mini:latest");
// A turn that finishes but blows past this reads as a routing FAILURE, not a
// success — "fast every time" is the actual product requirement, and a
// success signal blind to latency cannot route toward it. 8s is a chat
// reply's outer bound before it reads as broken, not a generation-quality
// target.
const LATENCY_BUDGET_MS = parseArg("latency-budget-ms", 8000, Number);

// The model that rewrites a terse follow-up ("read it again") into a
// self-contained cue for retrieval and the instruction gate (prosify-cue.js).
// Defaults to the tiny talker model — the rewrite is a cheap, bounded task,
// never the model that writes the answer. Pass --prosify-model "" to disable
// the rewrite entirely; turn-controller.js treats a falsy value as a no-op.
const PROSIFY_MODEL = parseArg("prosify-model", TINY_MODEL);
const PROSIFY_TIMEOUT_MS = parseArg("prosify-timeout-ms", 4000, Number);

// Context window handed to the talker. Must be large enough for the folded
// passages plus the answer, and small enough that the model stays resident on
// the GPU — see the num_ctx comment at the /api/chat call site.
const NUM_CTX = parseArg("num-ctx", 8192, Number);

let PROVIDERS = [
  { id: "ollama", label: "Ollama", defaultModel: TINY_MODEL },
  ...(ANTHROPIC_KEY ? [{ id: "anthropic", label: "Anthropic", defaultModel: ANTHROPIC_MODEL }] : []),
];
function rebuildProviders() {
  PROVIDERS = [
    { id: "ollama", label: "Ollama", defaultModel: TINY_MODEL },
    ...(ANTHROPIC_KEY ? [{ id: "anthropic", label: "Anthropic", defaultModel: ANTHROPIC_MODEL }] : []),
  ];
}

function selectModel(messages) {
  const text = (messages || []).map(m => m.content || "").join(" ");
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const charCount = text.length;

  // When the system message includes grounding passages ("CITED PASSAGES" or
  // "--- Material"), the talker must bracket its answer with [1], [2], etc.
  // The tiny model routinely ignores this instruction and writes plain prose
  // with no references — every source ends up in the gap list, none in the
  // answer. Force the medium model for any turn with grounding.
  if (/CITED PASSAGES|--- Material\b/.test(text)) {
    return MEDIUM_MODEL;
  }

  // Complex signals → medium model
  const codePatterns = [/```/, /function\s/, /class\s/, /import\s/, /export\s/, /=>/, /\(\)\s*=>/];
  const hasCode = codePatterns.some(p => p.test(text));
  const isLong = wordCount > 50;
  const isTechnical = /\b(refactor|implement|debug|architecture|algorithm|database|api|endpoint|test|deploy)\b/i.test(text);
  const hasManyTurns = messages.length > 4;

  if (hasCode || isTechnical || (isLong && hasManyTurns)) {
    return MEDIUM_MODEL;
  }

  // Simple signals → tiny model
  const isShort = wordCount < 15;
  const isGreeting = /^(hi|hey|hello|yo|sup|howdy|thanks|ok|okay|cool|nice)\b/i.test(text.trim());

  if (isShort && isGreeting) {
    return TINY_MODEL;
  }

  // Default: use message ratio to decide
  return charCount < 200 ? TINY_MODEL : MEDIUM_MODEL;
}

// Learned routing: reuses eoreader5's predictive-competency substrate to
// pick between TINY_MODEL/MEDIUM_MODEL from measured tool-loop outcomes
// instead of the heuristic above. selectModel() remains the cold-start
// fallback (see model-router.js) and the deterministic override path when a
// caller explicitly requests a model.
let modelRouter;
try {
  modelRouter = createModelRouter({
    candidates: [TINY_MODEL, MEDIUM_MODEL],
    ledgerPath: path.join(MEMORY_DIR, "model-router-ledger.jsonl"),
    heuristicFallback: selectModel,
  });
} catch (err) {
  console.error(`[proxy] model-router unavailable, falling back to heuristic only: ${err.message}`);
  modelRouter = null;
}

// ── Conversations — the new conversational surface's durable state + turn coordinator ──

const conversationStore = new ConversationStore();
// A project's own instructions, compiled to folds and cached against the
// file's mtime.
//
// This is deliberately synchronous. It runs on the turn path, where the
// instruction block has to be assembled BEFORE the model call it governs — an
// await here is an opportunity for the rules to arrive late, and a rule that
// arrives after the answer is not a rule. The file is small, the compile is
// pure, and both are skipped entirely unless the text actually changed.
const projectFoldCache = new Map(); // projectId -> { mtimeMs, folds, report }

function projectIdForConversation(conv) {
  // Conversations opened inside a project carry the project as their space and
  // its pool; a conversation outside one uses the shared "corpus" pool.
  const id = conv?.spaceId || (conv?.pool && conv.pool !== "corpus" ? conv.pool : null);
  return id || null;
}

// The project's own instruction budget, read from the project file. Cached
// alongside the folds because it decides how they are compiled.
function projectBudget(projectId) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, "projects", `${projectId}.json`), "utf8"));
    const n = Number(raw.instructionBudget);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INSTRUCTION_BUDGET;
  } catch {
    return DEFAULT_INSTRUCTION_BUDGET;
  }
}

function projectInstructionFolds(conv) {
  const projectId = projectIdForConversation(conv);
  if (!projectId) return null;
  let stat;
  try {
    stat = fs.statSync(projectStore.instructionsPath(projectId));
  } catch {
    projectFoldCache.delete(projectId);
    return null; // no instructions for this project is a no-op, never an error
  }
  const budgetTokens = projectBudget(projectId);
  const hit = projectFoldCache.get(projectId);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.budgetTokens === budgetTokens) {
    return { folds: hit.folds, budgetTokens };
  }
  try {
    const text = fs.readFileSync(projectStore.instructionsPath(projectId), "utf8");
    const compiled = compileInstructionFolds(text, { idPrefix: "proj", budgetTokens });
    projectFoldCache.set(projectId, { mtimeMs: stat.mtimeMs, budgetTokens, ...compiled });
    return { folds: compiled.folds, budgetTokens };
  } catch (err) {
    console.error(`[proxy] project instructions failed to compile for ${projectId}: ${err.message}`);
    return null;
  }
}

const turnController = createTurnController({
  conversationStore,
  projectInstructionFolds,
  groundQuery: engineGroundQuery,
  target: TARGET,
  anthropicKey: ANTHROPIC_KEY,
  anthropicModel: ANTHROPIC_MODEL,
  numCtx: NUM_CTX,
  modelRouter,
  heuristicModel: selectModel,
  latencyBudgetMs: LATENCY_BUDGET_MS,
  isWarming: () => corpusWarmup.started && !corpusWarmup.ready,
  webSearchFn: webSearchAndFetch,
  cabinetStore,
  prosifyModel: PROSIFY_MODEL,
  prosifyTimeoutMs: PROSIFY_TIMEOUT_MS,
});

// ── Retry helper ──

async function withRetry(fn, { label = "operation", maxRetries = 2, baseMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = baseMs * Math.pow(2, attempt) + Math.random() * 200;
        console.error(`[proxy] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay.toFixed(0)}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Safe fetch with timeout ──

async function safeFetch(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ── Content Index (structural codebase index) ──

import { ContentIndex } from "./content-index.js";

let contentIndex = null;

async function buildContentIndex() {
  // Was seven hardcoded `/Users/mlacy/...` absolute paths, several of them
  // repos this product no longer depends on (eoreader4.2, eoreaderapp).
  // INDEX_REPOS defaults to this repo plus the two vendored submodules, and is
  // env-overridable — see server/paths.js.
  const repoRoots = INDEX_REPOS.filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });

  const idx = new ContentIndex();
  console.error(`[proxy] Building content index from ${repoRoots.length} repos...`);
  await idx.scan(repoRoots);
  contentIndex = idx;
  console.error(`[proxy] Content index built: ${idx.totalFiles} files, ${idx.entities.size} entities, ${idx.definitions.size} definitions in ${idx.scanTime}ms`);
}

// ── Bounded memory store with TTL eviction ──

class BoundedStore {
  #entries = [];
  #max;
  #ttl;

  constructor(max = 10000, ttl = 3_600_000) {
    this.#max = max;
    this.#ttl = ttl;
  }

  #evict() {
    const cutoff = Date.now() - this.#ttl;
    this.#entries = this.#entries.filter(e => e.ts > cutoff);
    if (this.#entries.length > this.#max) {
      this.#entries.sort((a, b) => b.ts - a.ts);
      this.#entries = this.#entries.slice(0, this.#max);
    }
  }

  #hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i) | 0;
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // Previously tagged every entry with an "EO cell" (operator/terrain/stance)
  // guessed from a handful of keyword regexes (classifyMessage/classifyCode) and
  // used it to boost search scores — a fabricated classification with no
  // relationship to the engine's actual structural analysis (see terrain_report,
  // which is mechanical and real). Removed rather than replaced: an EO label this
  // store cannot honestly compute stays absent, not approximated by a new
  // keyword classifier.
  ingest(text, type, meta = {}) {
    this.#evict();
    this.#entries.push({
      id: this.#hash(text + Date.now() + Math.random().toString(36).slice(2, 6)),
      text,
      type,
      meta,
      ts: Date.now(),
    });
  }

  search(query, topK = 5) {
    this.#evict();
    const words = (query || "").toLowerCase().split(/\s+/).filter(w => w.length > 1);

    return this.#entries.map(e => {
      const text = e.text.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (text.includes(w)) score += 2;
        for (const t of text.split(/\s+/)) {
          if (t === w) score += 1;
          else if (t.includes(w) || w.includes(t)) score += 0.5;
        }
      }
      return { ...e, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  }

  get size() { return this.#entries.length; }
}

const store = new BoundedStore(STORE_MAX, STORE_TTL);

// ── Discourse store — persisted conversation state ──
//
// Every turn (user message + assistant response) is appended to a JSONL file
// keyed by session id. On startup the file is replayed: each observation is
// re-admitted into the engine session so the discourse survives restart.
//
// When the token budget fills up, older turns are folded into a keyword-based
// summary. Attachments (ingested files) are tracked as first-class objects
// rather than injected as inline text — the LLM sees attachment cards
// (name + size + excerpt) and can FETCH full content on demand.
//
// This mirrors eoreader-mcp/lib/chat-history.js but uses async I/O and
// integrates with the proxy's BoundedStore and engine-ground bridge.

const DISCOURSE_DIR = path.join(MEMORY_DIR, "discourse");
const DISCOURSE_CONTEXT_WINDOW = 32768;
const DISCOURSE_FOLD_THRESHOLD = 0.55;
const DISCOURSE_RECENT_KEEP = 8;
const ATTACHMENT_SNAPSHOT_CHARS = 1400;

class DiscourseStore {
  #sessions = new Map();

  #sessionPath(sessionId) {
    return path.join(DISCOURSE_DIR, `${sessionId}.jsonl`);
  }

  async #ensureDir() {
    await fsp.mkdir(DISCOURSE_DIR, { recursive: true });
  }

  /** Append a single entry (message or attachment) to the JSONL log. */
  async #append(sessionId, entry) {
    await this.#ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await fsp.appendFile(this.#sessionPath(sessionId), line).catch(() => {});
  }

  /** Load a session from disk, replaying turns into BoundedStore. */
  async load(sessionId) {
    if (this.#sessions.has(sessionId)) return this.#sessions.get(sessionId);

    await this.#ensureDir();
    const p = this.#sessionPath(sessionId);
    let lines = [];
    try {
      const text = await fsp.readFile(p, "utf8");
      lines = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch { /* no log yet */ }

    const session = {
      messages: [],
      attachments: new Map(),
      priorSummary: null,
      foldCount: 0,
      totalTokens: 0,
    };

    for (const entry of lines) {
      if (entry.type === "attachment") {
        session.attachments.set(entry.name, entry);
      } else if (entry.role) {
        session.messages.push(entry);
      }
    }

    // Re-ingest prior turns into the BoundedStore so search_memory works
    // across restarts (the engine-ground bridge handles its own replay via
    // the engine session, which survives in-process)
    for (const msg of session.messages) {
      if (msg.content?.length > 5) {
        store.ingest(msg.content, msg.role, { session: sessionId });
      }
    }

    session.totalTokens = this.#sessionTokens(session);
    this.#sessions.set(sessionId, session);
    return session;
  }

  #sessionTokens(session) {
    let total = 0;
    for (const msg of session.messages) total += tok(msg.content);
    total += tok(session.priorSummary || "");
    return total;
  }

  /** Add a message turn. Returns { folded, foldCount, messageCount, tokens }. */
  async addMessage(sessionId, role, content) {
    const session = await this.load(sessionId);
    const msg = { role, content, timestamp: Date.now() };
    session.messages.push(msg);
    session.totalTokens = this.#sessionTokens(session);

    await this.#append(sessionId, msg);

    let folded = false;
    if (
      session.totalTokens > DISCOURSE_CONTEXT_WINDOW * DISCOURSE_FOLD_THRESHOLD &&
      session.messages.length > DISCOURSE_RECENT_KEEP + 4
    ) {
      this.#foldSession(session);
      folded = true;
    }

    return {
      folded,
      foldCount: session.foldCount,
      messageCount: session.messages.length,
      tokens: session.totalTokens,
    };
  }

  /** Fold older messages into a mechanical keyword summary. */
  #foldSession(session) {
    const splitIdx = session.messages.length - DISCOURSE_RECENT_KEEP;
    const toSummarize = session.messages.slice(0, splitIdx);
    const recent = session.messages.slice(splitIdx);

    const priorCtx = session.priorSummary
      ? `[Prior summary]\n${session.priorSummary}\n\n`
      : "";

    const dialogue = toSummarize
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const allText = toSummarize.map(m => m.content).join(" ");
    const topics = this.#extractTopics(allText);

    session.priorSummary = [
      priorCtx,
      `Topics discussed: ${topics.join(", ")}`,
      `Exchange count: ${toSummarize.length}`,
      ``,
      `Key exchanges (compressed):`,
      dialogue.slice(0, 2000),
    ].filter(Boolean).join("\n");

    session.messages = recent;
    session.foldCount++;
    session.totalTokens = this.#sessionTokens(session);
  }

  #extractTopics(text) {
    const stops = new Set([
      "the","a","an","and","or","but","in","on","at","to","for","of","with",
      "by","from","as","is","was","are","were","be","been","has","had","have",
      "do","does","did","will","would","could","should","may","might","can",
      "that","this","it","its","i","you","we","they","he","she","me","my",
      "your","our","their","his","her","him","not","no","so","if","then",
      "just","about","like","what","when","where","how","which","who",
    ]);
    const words = text.toLowerCase().split(/\s+/);
    const freq = {};
    for (const w of words) {
      const clean = w.replace(/[^a-z0-9]/g, "");
      if (clean.length > 3 && !stops.has(clean)) freq[clean] = (freq[clean] || 0) + 1;
    }
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([w]) => w);
  }

  /** Build model-ready context from a session. */
  async buildContext(sessionId, systemPrompt, userMessage) {
    const session = await this.load(sessionId);
    const messages = [];

    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

    if (session.priorSummary) {
      messages.push({
        role: "system",
        content: `[Conversation context — ${session.foldCount} prior folds]\n${session.priorSummary}`,
      });
    }

    // Attachment references (not inline content — the LLM sees cards)
    if (session.attachments.size > 0) {
      const attCards = [...session.attachments.values()].map(a => {
        const excerpt = (a.text || "").slice(0, ATTACHMENT_SNAPSHOT_CHARS);
        return `[${a.name}] ${a.type || "file"} (${Math.round((a.size || 0) / 1024)}KB) — ${a.ingestedAt || ""}\n${excerpt}`;
      }).join("\n\n");
      const attMsg = `Available attachments (use FETCH:<name> to retrieve full content):\n\n${attCards}`;
      if (tok(attMsg) < DISCOURSE_CONTEXT_WINDOW * 0.4) {
        messages.push({ role: "system", content: attMsg });
      } else {
        // Too many attachments — collapse to a name-only index
        const idx = `Available attachments: ${[...session.attachments.keys()].join(", ")}`;
        messages.push({ role: "system", content: idx });
      }
    }

    for (const msg of session.messages) {
      if (msg.role !== "system") messages.push({ role: msg.role, content: msg.content });
    }

    if (userMessage && !messages.some(m => m.role === "user" && m.content === userMessage)) {
      messages.push({ role: "user", content: userMessage });
    }

    return messages;
  }

  /** Store an ingested file as an attachment (not inline text). */
  async addAttachment(sessionId, { name, content, type, size, ingestedAt }) {
    await this.#ensureDir();
    const session = await this.load(sessionId);
    const entry = { type: "attachment", name, content: content?.slice(0, 100000), type, size, text: content?.slice(0, ATTACHMENT_SNAPSHOT_CHARS), ingestedAt: ingestedAt || new Date().toISOString(), contentHash: this.#hash(content?.slice(0, 1000) || "") };
    session.attachments.set(name, entry);

    // Also save the content to a sidecar file so FETCH can retrieve it. Stored
    // whole, matching admission: the sidecar is what `fetch_attachment` reads
    // when the model goes back for more, and a sidecar shorter than the
    // ingested document would make the drill-down path quietly blinder than
    // the search path over the very same source.
    const sidecar = path.join(DISCOURSE_DIR, `${sessionId}_attach_${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    const stored = content || "";
    entry.storedChars = stored.length;
    entry.truncated = false;
    await fsp.writeFile(sidecar, stored, "utf8").catch(() => {});

    await this.#append(sessionId, entry);
    return entry;
  }

  /** Retrieve full attachment content (for FETCH: tool calls). */
  async getAttachmentContent(sessionId, name) {
    await this.load(sessionId);
    const sidecar = path.join(DISCOURSE_DIR, `${sessionId}_attach_${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    try {
      return await fsp.readFile(sidecar, "utf8");
    } catch {
      const session = this.#sessions.get(sessionId);
      return session?.attachments.get(name)?.content || null;
    }
  }

  #hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i) | 0;
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  async getStats(sessionId) {
    const session = await this.load(sessionId);
    return {
      messageCount: session.messages.length,
      attachmentCount: session.attachments.size,
      foldCount: session.foldCount,
      tokens: session.totalTokens,
      contextWindow: DISCOURSE_CONTEXT_WINDOW,
      usagePercent: Math.round((session.totalTokens / DISCOURSE_CONTEXT_WINDOW) * 100),
      attachmentNames: [...session.attachments.keys()],
    };
  }

  async clearSession(sessionId) {
    this.#sessions.delete(sessionId);
    try { await fsp.unlink(this.#sessionPath(sessionId)); } catch {}
    // Also clean sidecar files
    const dir = DISCOURSE_DIR;
    try {
      const files = await fsp.readdir(dir);
      for (const f of files) {
        if (f.startsWith(`${sessionId}_attach_`)) {
          await fsp.unlink(path.join(dir, f)).catch(() => {});
        }
      }
    } catch {}
  }
}

const discourse = new DiscourseStore();

// ── Load code (async, error-isolated per file) ──

async function loadCode(repo) {
  const ignore = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".opencode", "colbert-venv", ".claude", ".venv", "venv", ".mypy_cache", ".pytest_cache"]);
  const skip = new Set([".json", ".lock", ".map", ".png", ".jpg", ".gif", ".ico", ".svg", ".woff", ".woff2", ".mp3", ".mp4", ".wasm"]);

  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    const tasks = entries.map(async e => {
      if (ignore.has(e.name)) return;
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) { await walk(p); return; }
        if (!e.isFile()) return;
        const ext = path.extname(e.name);
        if (skip.has(ext) || e.name.includes(".test.") || e.name.includes(".spec.")) return;

        const content = await fsp.readFile(p, "utf8");
        if (content.length < 20) return;
        const rel = path.relative(repo, p);
        const lines = content.split("\n");
        let chunk = [], size = 0;
        for (const line of lines) {
          chunk.push(line);
          size += line.length;
          if (size > 1200 || /^(module\.exports|export\s)/.test(line)) {
            const text = chunk.join("\n").trim();
            if (text.length > 30) store.ingest(text, "code", { file: rel });
            chunk = []; size = 0;
          }
        }
        if (chunk.length > 0) {
          const text = chunk.join("\n").trim();
          if (text.length > 30) store.ingest(text, "code", { file: rel });
        }
      } catch {}
    });
    await Promise.all(tasks);
  }

  console.error(`[proxy] Loading ${repo}...`);
  const start = Date.now();
  await walk(repo);
  console.error(`[proxy] ${store.size} chunks loaded in ${Date.now() - start}ms`);
}

// ── URL fetch + snapshot ──

const SNAPSHOT_MAX_CHARS = 1400;

function detectUrls(text) {
  return [...new Set((text || "").match(/https?:\/\/[^\s<>"')\]]+/g) || [])];
}

function contentSnapshot(text, url) {
  if (!text || text.length < 20) return `[Empty content from ${url}]`;
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
  const title = lines[0] || '';
  const body = lines.slice(1).join(' ');
  let excerpt = body.slice(0, SNAPSHOT_MAX_CHARS);
  const lastPeriod = excerpt.lastIndexOf('.');
  if (lastPeriod > SNAPSHOT_MAX_CHARS * 0.6) excerpt = excerpt.slice(0, lastPeriod + 1);
  const wordCount = body.split(/\s+/).length;
  return [`[Source: ${url}]`, title ? `[Title: ${title}]` : '', `[${wordCount} words — excerpt below]`, '', excerpt].filter(Boolean).join('\n');
}

// ── Web history ──
//
// Every page a turn pulls in is appended here before it can be cited. The
// engine holds the text; this holds the provenance — which URL, which query
// pulled it, when, and where the raw bytes landed. Append-only and on disk, so
// "why was this in my answer?" stays answerable after the process that fetched
// it is gone. Ingesting from the web without this leaves the reader holding
// citations to sources they never chose and cannot audit.
const WEB_HISTORY_PATH = path.join(import.meta.dirname, "web-history.jsonl");
const webHistory = [];

function loadWebHistory() {
  try {
    for (const line of fs.readFileSync(WEB_HISTORY_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { webHistory.push(JSON.parse(line)); } catch {}
    }
  } catch { /* no history yet — the first web fetch creates it */ }
}
loadWebHistory();

function recordWebHistory(record) {
  webHistory.push(record);
  try {
    fs.appendFileSync(WEB_HISTORY_PATH, JSON.stringify(record) + "\n");
  } catch (err) {
    console.error(`[proxy] web-history append failed: ${err.message}`);
  }
}

async function fetchAndSaveUrl(url) {
  try {
    const resp = await safeFetch(url, {
      headers: { "User-Agent": "EOReader-Proxy/2.0" },
    }, 15000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const contentType = resp.headers.get("content-type") || "";
    let text = await resp.text();

    if (contentType.includes("text/html") || contentType.includes("application/xhtml") || text.trim().startsWith("<")) {
      // Block-level boundaries become blank lines BEFORE tags are stripped —
      // the engine's heading detector (segments.js: headingScore) only
      // recognizes a heading by its FORM, a short line followed by a blank
      // line, so a heading tag stripped straight to " " like everything else
      // collapses "Chapter 1" into the same run-on paragraph as its body and
      // the whole document comes back structureless (sessionOutline finds
      // zero headings, not a wrong one). This is the one place that
      // distinction has to survive the HTML.
      text = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
        .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, "")
        .replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "");
      // Tables (infoboxes, cast/credit grids) are near-never prose — each row
      // is short and isolated exactly like a real heading, so left in they
      // outnumber the article's actual sections in the outline. Stripped
      // innermost-first since infoboxes commonly nest one table inside
      // another and a single non-greedy pass only clears the inner one.
      let prevText;
      do { prevText = text; text = text.replace(/<table(?:(?!<table)[\s\S])*?<\/table>/gi, ""); } while (text !== prevText);
      text = text
        // A list's ITEMS get one plain newline between them, not a blank-line
        // paragraph break — only the list as a whole is set off from
        // surrounding prose. Each <li> blank-line-separated from its
        // neighbors is indistinguishable from a heading by form (short,
        // isolated) to a detector that never sees the <ul> around them, so a
        // five-item cast list was reading as five headings.
        .replace(/<\/(ul|ol)>/gi, "\n\n")
        .replace(/<(ul|ol)[^>]*>/gi, "\n\n")
        .replace(/<\/li>/gi, " ")
        .replace(/<li[^>]*>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|h[1-6]|blockquote)>/gi, "\n\n")
        .replace(/<(p|div|h[1-6])[^>]*>/gi, "\n\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `url_${hostname}_${ts}.txt`;
    const filepath = path.join(MEMORY_DIR, filename);

    try {
      await fsp.mkdir(MEMORY_DIR, { recursive: true });
      await fsp.writeFile(filepath, text, "utf8");
    } catch {}
    console.error(`[proxy] Saved ${filename} (${text.length} chars)`);
    return { text, filename };
  } catch (e) {
    console.error(`[proxy] Fetch failed ${url}: ${e.message}`);
    return { text: null, filename: null, error: e.message };
  }
}

// ── Citation validation ──
//
// The model sometimes cites [N] where N exceeds the number of grounding
// passages — a fabricated reference. Replace those with a visible gap marker
// so the reader never sees a fake citation. Valid citations are left alone.

// Moved to citation-check.js so turn-controller.js (the new conversational
// coordinator) can share these model-blind checks without importing proxy.js.
import {
  validateCitations, verifyQuotedFidelity, checkGrounding, groundingGaps, annotateVoids,
} from "./citation-check.js";

// ── Context assembly ──

const tok = (t) => Math.ceil((t || "").length / 3.5);

async function assemble(messages, sessionId = "default") {
  const latest = [...messages].reverse().find(m => m.role === "user");
  if (!latest) return messages;
  const query = latest.content || "";

  let ctx = [], t = 0;
  const sys = messages.find(m => m.role === "system");
  if (sys) { t += tok(sys.content); ctx.push(sys); }
  else {
    const d = [
      "You are EO, a focused research and engineering assistant with access to web search.",
      "",
      "## Web Search Strategy",
      "Use web_search and web_fetch when you need current information, facts, or data not in local context.",
      "- Formulate keyword-rich queries — be specific",
      "- Start with type='fast', then use type='deep' for comprehensive research",
      "- Read results, then web_fetch promising URLs for full content",
      "- If results are thin, reformulate the query",
      "- Cite sources when presenting facts",
      "",
      "Use the available code and context from memory when relevant.",
    ].join("\n");
    t += tok(d); ctx.push({ role: "system", content: d });
  }

  // Discourse context: fold in past conversation from persisted store.
  // This is how the "discourse channel remembers what we're chatting about."
  try {
    const discourseCtx = await discourse.buildContext(sessionId, null, null);
    // Skip the first message (system prompt) and last message (current query);
    // fold the in-between conversation history into context
    const historyMsgs = discourseCtx.filter(m => m.role !== "system" && m.content !== query);
    if (historyMsgs.length > 0) {
      let histStr = "";
      for (const m of historyMsgs.slice(-10)) {
        const roleTag = m.role === "user" ? "[User]" : "[Assistant]";
        const folded = m.content.length > 400
          ? m.content.slice(0, 400) + "..."
          : m.content;
        histStr += `${roleTag} ${folded}\n`;
      }
      const histCtx = `[Discourse context — recent conversation]\n${histStr}`;
      if (t + tok(histCtx) < TOKEN_LIMIT) {
        t += tok(histCtx);
        ctx.push({ role: "system", content: histCtx });
      }
    }
  } catch (err) {
    console.error(`[proxy] discourse context load error: ${err.message}`);
  }

  // Content index enrichment: if query looks like codebase exploration,
  // add structural context from the content index
  if (contentIndex && (query.includes("modules") || query.includes("packages") || query.includes("entity") || query.includes("organ") || query.includes("engine") || query.includes("index") || query.includes("search") || query.includes("presence") || query.includes("store") || query.includes("fold") || query.includes("discourse") || query.includes("spine") || query.includes("reaction"))) {
    const codeResults = contentIndex.find(query, { limit: 5 });
    if (codeResults.length > 0) {
      const ctxStr = "\n[Codebase context from content index]\n" + codeResults.slice(0, 5).map(r => {
        const parts = [`[${r.type}] ${r.name || r.path}`];
        if (r.repo) parts.push(`(${r.repo})`);
        if (r.line) parts.push(`:${r.line}`);
        if (r.header) parts.push(` — ${r.header.slice(0, 100)}`);
        return parts.join(" ");
      }).join("\n");
      if (t + tok(ctxStr) < TOKEN_LIMIT) { t += tok(ctxStr); ctx.push({ role: "system", content: ctxStr }); }
    }
  }

  // URL fetch (isolated per URL — one failure doesn't block others)
  const urls = detectUrls(query);
  if (urls.length > 0) {
    const results = await Promise.allSettled(urls.map(url => fetchAndSaveUrl(url)));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && r.value.text) {
        const fullText = r.value.text;
        // Fold: if content is near the token budget, snapshot it instead of
        // injecting the full text. The full content is saved to disk and
        // retrievable via FETCH:.
        const remaining = TOKEN_LIMIT - t;
        if (tok(fullText) > remaining * 0.6) {
          // Content is too big for remaining context — fold it down
          const snapshot = contentSnapshot(fullText, urls[i]);
          if (t + tok(snapshot) < TOKEN_LIMIT) {
            t += tok(snapshot);
            ctx.push({ role: "system", content: snapshot });
          }
        } else {
          // Content fits — include as-is
          if (t + tok(fullText) < TOKEN_LIMIT) {
            t += tok(fullText);
            ctx.push({ role: "system", content: `[Source: ${urls[i]}]\n${fullText.slice(0, 3000)}` });
          }
        }
      }
    }
  }

  // Store search — fold results if we're near the limit
  const budgetForSearch = TOKEN_LIMIT - t;
  const results = store.search(query, 5);
  if (results.length) {
    let c = "\n[Context: recalled from memory]\n" +
      results.map(r => r.type === "code"
        ? `--- ${r.meta.file || "?"} ---\n${r.text.slice(0, 500)}`
        : `[${r.type}]: ${r.text.slice(0, 300)}`
      ).join("\n\n");

    // Fold: if search results would hog the budget, truncate each harder
    if (tok(c) > budgetForSearch * 0.7) {
      c = "\n[Context: recalled from memory — truncated for budget]\n" +
        results.map(r => r.type === "code"
          ? `--- ${r.meta.file || "?"} ---\n${r.text.slice(0, 200)}`
          : `[${r.type}]: ${r.text.slice(0, 120)}`
        ).join("\n\n");
    }

    if (t + tok(c) < TOKEN_LIMIT) { t += tok(c); ctx.push({ role: "system", content: c }); }
  }

  ctx.push({ role: "user", content: query });
  console.error(`[proxy] ${t} tokens`);
  return ctx;
}

// ── Tool definitions (OpenAI-compatible function calling) ──

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a shell command. Returns stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
          workdir: { type: "string", description: "Working directory (default cwd)" },
          timeout: { type: "number", description: "Timeout in ms (default 30000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk and return its contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          offset: { type: "number", description: "Line offset (1-indexed)" },
          limit: { type: "number", description: "Max lines to return" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file on disk.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to write to" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit a file by replacing exact string matches.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          old_string: { type: "string", description: "Text to replace" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. **/*.js)" },
          path: { type: "string", description: "Root directory (default cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with regex.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          include: { type: "string", description: "File glob filter (e.g. *.js)" },
          path: { type: "string", description: "Root directory (default cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for information. Performs real-time web searches across multiple sources. Use when you need current information, facts, news, or data not available in local context. Always consider using web_fetch after web_search to get detailed content from specific results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query. Formulate this like you would for a search engine — specific, keyword-rich queries return better results." },
          numResults: { type: "number", description: "Number of search results to return (default: 8, max: 20)" },
          type: { type: "string", enum: ["auto", "fast", "deep"], description: "Search type - 'auto': balanced (default), 'fast': quick snippet results, 'deep': comprehensive search with longer excerpts" },
          livecrawl: { type: "string", enum: ["fallback", "preferred"], description: "Live crawl mode - 'fallback': use cached results if available (default), 'preferred': prioritize live-fetched content" },
          contextMaxCharacters: { type: "number", description: "Maximum characters for the formatted result string (default: 8000). Use lower values for tight token budgets, higher when you need full page excerpts." },
          site: { type: "string", description: "Optional: restrict search to a specific domain (e.g. 'arxiv.org', 'github.com'). Leave empty for all sources." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return its content as readable text. Use this after web_search to get detailed content from specific URLs. Automatically strips HTML tags, scripts, and styles — returns clean text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch (full URL including https://)" },
          maxChars: { type: "number", description: "Maximum characters to return (default: 10000, max: 50000)" },
          format: { type: "string", enum: ["text", "markdown", "html"], description: "Format for the returned content: 'text' for plain text (default), 'markdown' for rendered markdown, 'html' for raw HTML" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ls",
      description: "List contents of a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default .)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ingest",
      description: "Read a file or directory into the engine's memory store.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path to ingest" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Search the engine's memory store for relevant context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verbatim_search",
      description: "Search the engine for EXACT verbatim spans from ingested source texts. Returns byte-offset anchored passages with exact text — no model hallucination. Use this when you need to retrieve EXACT quotes from documents the reader has attached. Naming a specific work here would be a lie about what is loaded: the corpus holds only what this reader attached, and may be empty.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for finding relevant spans" },
          limit: { type: "number", description: "Max results (default 5, max 40)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verbatim_read",
      description: "Read the full verbatim text of a previously-searched span by its span_id. Returns exact byte-offset anchored text from the source document.",
      parameters: {
        type: "object",
        properties: {
          span_id: { type: "string", description: "The span_id returned by verbatim_search" },
          max_bytes: { type: "number", description: "Maximum bytes to return (default 4000)" },
        },
        required: ["span_id"],
      },
    },
  },
  // NOTE: there are deliberately NO priors_* tools here. Priors are witness-
  // tier knowledge that STEERS retrieval; they are never model context. The
  // model absorbs a prior's effect through the evidence it widens (see
  // holonic-task.js's researchSubtask), never through a rule stated to it.
  // Priors are surfaced to the USER instead — /api/priors* for browsing, and
  // per-surf activation provenance for "what shaped this answer".
  {
    type: "function",
    function: {
      name: "memory_stats",
      description: "Get memory store statistics.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_attachment",
      description: "Fetch the full content of an attached file from the discourse store. Use this when you need to read a file that was uploaded as an attachment.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The attachment filename to retrieve" },
          session: { type: "string", description: "Session ID (default: 'default')" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "terrain_report",
      description: "Show terrain analysis for an ingested file: which of the 9 terrains (Void/Entity/Kind/Field/Link/Network/Atmosphere/Lens/Paradigm) are detected, Born-gate signal check, and structural evidence. Fully mechanical — no model call.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the ingested file to analyze" },
        },
      },
    },
  },

  // ── Content Index tools (high-level codebase traversal) ──

  {
    type: "function",
    function: {
      name: "codebase_structure",
      description: "Show the tree structure of the codebase. Optionally filter by path prefix to zoom into a package or directory.",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Path prefix to filter (e.g. 'packages/engine/search' or 'packages/engine/emergence/store'). Omit for root." },
          depth: { type: "number", description: "Max depth to show (default: all)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_find",
      description: "Find definitions, exports, modules, and content matches by name across the entire codebase. Returns ranked results with paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "Name or term to search for (function name, class name, file name fragment)" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
        required: ["term"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_lookup",
      description: "Get detailed information about a specific module file: its imports, exports, definitions, entities implemented, and cross-references.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the module (e.g. 'eoreader5/packages/engine/search/index.js' or 'packages/engine/emergence/store/index.js')" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_search",
      description: "Full-text search across the entire codebase. Searches both source text and structural metadata (exports, definitions, module headers). Returns ranked module-level results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (terms or phrase)" },
          limit: { type: "number", description: "Max results (default 20)" },
          repo: { type: "string", description: "Filter by repo name (e.g. 'eoreader5', 'live_priors')" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_related",
      description: "Show what a module imports, what imports it, and what entities it implements. Good for understanding dependencies and impact analysis.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the module" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_entities",
      description: "List all eoreader5 conceptual entities (cube, presence, fold, store, discourse, spine, reaction, etc.) mapped to their implementation files.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_api",
      description: "Show the API surface (exports + definitions) for a package or directory.",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Package or directory prefix (e.g. 'packages/engine/search')" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codebase_summary",
      description: "Show overall stats: repos, files, entities, definitions.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "holonic_task",
      description: "Decompose and execute a complex writing/research task using holonic task decomposition. Given any task description, the system plans sub-tasks, researches each via the engine, generates content with mechanical inline citations, and assembles the final output with a unified references section. Works best for essays, reports, analyses, or any multi-section document.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The high-level task or topic to decompose. Be specific: 'write a 5-page essay about X covering Y, with citations'." },
          model: { type: "string", description: "Ollama model to use (default: gemma2:2b)" },
          output_path: { type: "string", description: "Optional file path to write the output to" },
        },
        required: ["task"],
      },
    },
  },
];

// ── Tool handlers ──

function _renderTree(node, maxDepth, indent) {
  if (maxDepth <= 0) return indent + "...";
  if (node.type === "file") {
    const tags = [];
    if (node.entities?.length) tags.push(`[${node.entities.join(", ")}]`);
    if (node.exports > 0) tags.push(`${node.exports} exports`);
    if (node.defs > 0) tags.push(`${node.defs} defs`);
    const tagStr = tags.length ? ` ${tags.join(" ")}` : "";
    return `${indent}${node.name}${tagStr}`;
  }
  const parts = [`${indent}${node.name}/`];
  if (node.children) {
    const sorted = [...node.children].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of sorted) {
      parts.push(_renderTree(child, maxDepth - 1, indent + "  "));
    }
  }
  return parts.join("\n");
}

// The engine adapter for the LLM-callable `holonic_task` tool — search and
// prior activation, nothing else. (Previously also shared with a dedicated
// `/api/holonic` endpoint behind a separate "Compose" UI tab; that surface
// was removed — deliberate long-form treatment is now something Chat itself
// does automatically, via server/longform-orchestrator.js, when a turn's
// evidence and request call for it. holonic_task remains, unchanged, for
// open-ended tasks beyond plain grounded long-form writing.)
function buildHolonicEngineAdapter() {
  try {
    return {
      search(query, { limit = 5 } = {}) {
        const result = engineSearch(query, limit);
        return (result.passages || []).slice(0, limit).map(p => ({
          text: (p.text || p.preview || "").slice(0, 800),
          source: p.source || p.source_id || "?",
          score: p.score || 0,
          span_id: p.span_id,
          byte_start: p.byte_start,
          byte_end: p.byte_end,
        })).filter(r => r.text.length > 20);
      },
      // Real per-text coref prior activation (priors-bridge.js), replacing
      // the previously-missing method that left every production run with
      // zero activated priors. Steering only — see holonic-task.js's
      // executeSubtask; nothing here is ever shown to the model as text.
      getPriors(text, sourceId) {
        try {
          const prior = loadCorefPrior(sourceId || "");
          return activatePriors(text, prior);
        } catch (err) {
          return { activated: [], gap: `priors-bridge error: ${err.message}` };
        }
      },
    };
  } catch {
    return null;
  }
}

const toolHandlers = {
  async bash(args) {
    const { execSync } = await import("child_process");
    try {
      const out = execSync(args.command, {
        cwd: args.workdir || process.cwd(),
        timeout: args.timeout || 30000,
        encoding: "utf8",
        maxBuffer: 10_485_760,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return out || "(no output)";
    } catch (err) {
      const std = err.stdout || "";
      const errOut = err.stderr || err.message;
      return std ? `${std}\n\nSTDERR:\n${errOut}` : `Error: ${errOut}`;
    }
  },

  async read_file(args) {
    try {
      const content = await fsp.readFile(args.path, "utf8");
      const lines = content.split("\n");
      const start = args.offset ? Math.max(0, args.offset - 1) : 0;
      const end = args.limit ? start + args.limit : lines.length;
      return lines.slice(start, end).join("\n");
    } catch (err) {
      return `[Error reading ${args.path}: ${err.message}]`;
    }
  },

  async write_file(args) {
    try {
      await fsp.mkdir(path.dirname(args.path), { recursive: true });
      await fsp.writeFile(args.path, args.content, "utf8");
      return `Written ${args.content.length} bytes to ${args.path}`;
    } catch (err) {
      return `[Error writing ${args.path}: ${err.message}]`;
    }
  },

  async edit_file(args) {
    try {
      const content = await fsp.readFile(args.path, "utf8");
      if (!content.includes(args.old_string)) {
        return `[Error: old_string not found in ${args.path}]`;
      }
      const updated = content.replace(args.old_string, args.new_string);
      await fsp.writeFile(args.path, updated, "utf8");
      return `Edited ${args.path}`;
    } catch (err) {
      return `[Error editing ${args.path}: ${err.message}]`;
    }
  },

  async glob(args) {
    const { globSync } = await import("glob");
    try {
      return globSync(args.pattern, { cwd: args.path || process.cwd() }).join("\n") || "(no matches)";
    } catch (err) {
      return `[Error: ${err.message}]`;
    }
  },

  async grep(args) {
    const { execSync } = await import("child_process");
    const cmd = `rg --no-heading -n ${args.include ? `-g '${args.include}'` : ''} '${args.pattern}' ${args.path || '.'}`;
    try {
      return execSync(cmd, { encoding: "utf8", timeout: 15000, maxBuffer: 5_242_880 }) || "(no matches)";
    } catch (err) {
      if (err.status === 1) return "(no matches)";
      return `[Error: ${err.message}]`;
    }
  },

  async web_search(args) {
    // ── Intelligent search with multi-backend support ──
    // Backends tried in order (configurable via env):
    //   1. Brave Search API (BRAVE_API_KEY) — best quality, free tier: 2000/mo
    //   2. Serper.dev (SERPER_API_KEY) — Google results via API, free tier: 2500/mo
    //   3. DuckDuckGo Instant Answer API (no key needed) — fallback JSON
    //
    // Returns structured results optimized for LLM consumption.
    const numResults = Math.min(args.numResults || 8, 20);
    const searchType = args.type || "auto";
    const livecrawl = args.livecrawl || "fallback";
    const maxChars = args.contextMaxCharacters || 8000;
    const siteFilter = args.site || "";

    // Build the query with optional site filter
    const query = siteFilter ? `${args.query} site:${siteFilter}` : args.query;

    // ── Backend 1: Brave Search (best quality, free tier) ──
    const braveKey = process.env.BRAVE_API_KEY;
    if (braveKey) {
      try {
        const count = searchType === "deep" ? Math.min(numResults, 20) : Math.min(numResults, 10);
        const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&safesearch=off${
          livecrawl === "preferred" ? "&freshness=week" : ""
        }${searchType === "deep" ? "&extra_snippets=true" : ""}`;
        const resp = await safeFetch(braveUrl, {
          headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
        }, 10000);
        if (resp.ok) {
          const data = await resp.json();
          const web = data.web || {};
          const results = (web.results || []).slice(0, numResults);
          if (results.length > 0) {
            const lines = [`[Brave Search] "${args.query}" — ${web.total_results || results.length} results (type: ${searchType})`, ""];
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              const snippet = (r.description || r.snippet || "").slice(0, maxChars / numResults);
              lines.push(`[${i + 1}] ${r.title}`);
              lines.push(`    URL: ${r.url}`);
              if (r.page_age) lines.push(`    Age: ${r.page_age}`);
              if (r.profile) lines.push(`    Source: ${r.profile.name}`);
              if (snippet) lines.push(`    ${snippet}`);
              lines.push("");
            }
            const output = lines.join("\n");
            if (output.length > maxChars) return output.slice(0, maxChars) + "\n…[truncated]";
            return output;
          }
        }
      } catch (err) {
        console.error(`[proxy] Brave Search failed, falling back: ${err.message}`);
      }
    }

    // ── Backend 2: Serper.dev (Google results, free tier) ──
    const serperKey = process.env.SERPER_API_KEY;
    if (serperKey) {
      try {
        const count = searchType === "deep" ? Math.min(numResults, 20) : numResults;
        const resp = await safeFetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
          body: JSON.stringify({
            q: query,
            num: count,
            gl: "us",
            hl: "en",
          }),
        }, 10000);
        if (resp.ok) {
          const data = await resp.json();
          const results = (data.organic || []).slice(0, numResults);
          if (results.length > 0) {
            const lines = [`[Serper/Google] "${args.query}" — ${data.searchParameters?.totalResults || results.length} results`, ""];
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              const snippet = (r.snippet || "").slice(0, maxChars / numResults);
              lines.push(`[${i + 1}] ${r.title}`);
              lines.push(`    URL: ${r.link}`);
              if (r.date) lines.push(`    Date: ${r.date}`);
              if (r.source) lines.push(`    Source: ${r.source}`);
              if (snippet) lines.push(`    ${snippet}`);
              lines.push("");
            }
            if (data.knowledgeGraph) {
              const kg = data.knowledgeGraph;
              lines.push(`[Knowledge Graph] ${kg.title || ""}`);
              if (kg.description) lines.push(`    ${kg.description}`);
              if (kg.attributes) {
                for (const [k, v] of Object.entries(kg.attributes)) lines.push(`    ${k}: ${v}`);
              }
              lines.push("");
            }
            if (data.peopleAlsoAsk?.length) {
              lines.push("[People also ask]");
              for (const q of data.peopleAlsoAsk.slice(0, 3)) lines.push(`  ${q.question}`);
              lines.push("");
            }
            const output = lines.join("\n");
            if (output.length > maxChars) return output.slice(0, maxChars) + "\n…[truncated]";
            return output;
          }
        }
      } catch (err) {
        console.error(`[proxy] Serper failed, falling back: ${err.message}`);
      }
    }

    // ── Backend 3: DuckDuckGo Instant Answer API (no key needed) ──
    // A typed JSON response, same as Brave and Serper above — not a scraped
    // results page matched against markup that breaks the moment DuckDuckGo
    // changes its HTML. It answers with a topic abstract plus related
    // topics rather than a ranked general search index, so it is thinner
    // than a page scrape for a broad query — but every field is read off a
    // real JSON value, never guessed from a regex against raw markup.
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
      const resp = await safeFetch(ddgUrl, { headers: { "Accept": "application/json" } }, 10000);

      if (resp.ok) {
        const data = await resp.json();
        const results = [];

        if (data.AbstractText) {
          results.push({ title: data.Heading || args.query, url: data.AbstractURL || "", snippet: data.AbstractText });
        }
        for (const t of flattenDdgTopics(data.RelatedTopics)) {
          if (results.length >= numResults) break;
          // DDG's Text field reads "Name - description"; split on the
          // leading " - " it always inserts so the title is a name, not
          // the whole sentence.
          const dash = t.Text.indexOf(" - ");
          results.push({ title: dash > -1 ? t.Text.slice(0, dash) : t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text });
        }

        if (results.length > 0) {
          const lines = [`[DuckDuckGo] "${args.query}" — ${results.length} results`, ""];
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const snippet = r.snippet.slice(0, Math.floor(maxChars / results.length));
            lines.push(`[${i + 1}] ${r.title}`);
            lines.push(`    URL: ${r.url}`);
            if (snippet) lines.push(`    ${snippet}`);
            lines.push("");
          }
          const output = lines.join("\n");
          if (output.length > maxChars) return output.slice(0, maxChars) + "\n…[truncated]";
          return output;
        }
      }
    } catch (err) {
      console.error(`[proxy] DuckDuckGo search failed: ${err.message}`);
    }

    // ── All backends failed ──
    return `[Search failed: all backends exhausted for "${args.query}". Try a different query or check network connectivity.]`;
  },

  async web_fetch(args) {
    const maxChars = Math.min(args.maxChars || 10000, 50000);
    const format = args.format || "text";
    try {
      const resp = await safeFetch(args.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      }, 15000);
      const text = await resp.text();
      const contentType = resp.headers.get("content-type") || "";
      const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml") || text.trim().startsWith("<");

      if (!isHtml && format === "text") {
        return text.slice(0, maxChars);
      }

      // Strip HTML tags for text format
      const clean = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&[a-z]+;/g, " ")
        .replace(/\s+/g, " ").trim();

      if (!clean || clean.length < 20) {
        return `[${args.url}] fetched but content appears empty or is behind a paywall/login.`;
      }

      const result = clean.slice(0, maxChars);
      return result.length < clean.length
        ? result + "\n\n…[content truncated — use web_fetch with maxChars higher to see more]"
        : result;
    } catch (err) {
      return `[Error fetching ${args.url}: ${err.message}]`;
    }
  },

  async ls(args) {
    try {
      const entries = await fsp.readdir(args.path || ".", { withFileTypes: true });
      return entries.map(e => {
        let size = "";
        if (e.isFile()) try { size = ` ${fs.statSync(path.join(args.path || ".", e.name)).size}`; } catch {}
        return `${e.isDirectory() ? "d" : "-"} ${size.padStart(10)}  ${e.name}`;
      }).join("\n");
    } catch (err) {
      return `[Error: ${err.message}]`;
    }
  },

  async ingest(args) {
    try {
      const stats = fs.statSync(args.path);
      if (stats.isDirectory()) { await loadCode(args.path); return `Ingested directory ${args.path}`; }

      // Read as bytes — works for text, binary, anything
      const bytes = await fsp.readFile(args.path);
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

      // Run terrain analysis via engine dispatch
      let terrainInfo = null;
      try {
        const { buildReadingFromBytes } = await import(perceiverDispatchUrl());
        const reading = await buildReadingFromBytes(bytes);
        terrainInfo = {
          covered: reading.terrain_report?.covered ?? [],
          uncovered: reading.terrain_report?.uncovered ?? [],
          signalDetected: reading.born_gate?.signalDetected ?? false,
          dominantTerrain: reading.born_gate?.dominantTerrain ?? null,
          medium: reading.medium,
          evidence: reading.terrain_report?.evidence ?? {},
        };
      } catch (err) {
        terrainInfo = { error: err.message };
      }

      store.ingest(content.slice(0, 50000), "file", { path: args.path, terrain: terrainInfo });
      // LAWS.md L7a — same conflation server/terrain-report-format.js fixes
      // for terrain_report's own output, fixed here too: "Void (no signal
      // detected)" alone reads as a finding about this file, when it may
      // just as easily mean the classifier's English-only lexicon cannot
      // read it at all (see cube/index.js; measured directly on real Greek
      // in ORGAN-STACK-REAL-DEPLOYMENT.md). Kept short — this is an inline
      // one-line summary, not the full terrain_report — but the ambiguity
      // is still named, not silently resolved to the reading that looks
      // like a real finding.
      const terrainSummary = terrainInfo?.signalDetected
        ? ` Terrain: ${terrainInfo.covered.join(", ")}`
        : " Terrain: Void, or outside this English-only classifier's scope (see terrain_report for detail)";
      return `Ingested ${args.path} (${bytes.length} bytes).${terrainSummary}`;
    } catch (err) {
      return `[Error ingesting ${args.path}: ${err.message}]`;
    }
  },

  async search_memory(args) {
    const results = store.search(args.query, args.limit || 5);
    if (!results.length) return "(no matches in memory)";
    return results.map((r, i) => {
      // LAWS.md L7a — same fix as the ingest summary above: an unqualified
      // "Void" tag here is indistinguishable from "outside this English-
      // only classifier's scope." Named explicitly, even in this terse a
      // hint, rather than left to read as a finding.
      const terrain = r.meta?.terrain;
      const terrainHint = terrain?.signalDetected
        ? ` [terrain: ${terrain.covered?.join(",")}]`
        : (terrain ? " [terrain: Void/out-of-scope]" : "");
      return `--- ${i + 1}. (score: ${r.score.toFixed(2)}) ${r.meta.file || r.meta.path || "?"}${terrainHint} ---\n${r.text.slice(0, 500)}`;
    }).join("\n\n");
  },

  async verbatim_search(args) {
    try {
      const result = engineSearch(args.query, Math.min(args.limit || 5, 40));
      if (!result.passages.length) return "(no verbatim spans found)";
      const lines = result.passages.map((p, i) => {
        return `[${i + 1}] span:${p.span_id} score:${p.score.toFixed(2)} source:${p.source.slice(0, 60)} byte:${p.byte_start}-${p.byte_end}\n${p.text.slice(0, 600)}`;
      });
      return `Found ${result.total} verbatim spans:\n\n` + lines.join("\n\n") +
        (result.gaps?.length ? `\n\n[Gaps: ${result.gaps.join("; ")}]` : "");
    } catch (err) {
      return `[Error: ${err.message}]`;
    }
  },

  async verbatim_read(args) {
    try {
      const result = engineReadSpan(args.span_id, args.max_bytes || 4000);
      if (result.error) return `[Error: ${result.error}]`;
      return `span:${result.span_id} source:${result.source_id} byte:${result.byte_start}-${result.byte_end} verbatim:${result.verbatim} truncated:${result.truncated}\n\n${result.text}`;
    } catch (err) {
      return `[Error: ${err.message}]`;
    }
  },

  async memory_stats() {
    return JSON.stringify({ entries: store.size, max: STORE_MAX, ttl_ms: STORE_TTL });
  },

  // L3a — drill-down is where an unannounced cut does the most damage. This
  // is the tool the model calls when the first answer was not enough; handing
  // back the first 15,000 characters as though they were the document invites
  // exactly one conclusion about everything after them, and it is wrong. The
  // cut is therefore stated in the tool's own return value, where the model
  // reading it will see it, rather than left for the reader to infer.
  async fetch_attachment(args) {
    const sessionId = args.session || "default";
    const content = await discourse.getAttachmentContent(sessionId, args.name);
    if (!content) return `[Attachment "${args.name}" not found in discourse store]`;
    const CAP = 15000;
    if (content.length <= CAP) return content;
    const dropped = content.length - CAP;
    return content.slice(0, CAP) +
      `\n\n[TRUNCATED — this is the first ${CAP} of ${content.length} characters of "${args.name}". ` +
      `${dropped} characters were not returned. Do not conclude that anything is absent from this ` +
      `document on the basis of this excerpt; the remainder was not read. Use verbatim_search to ` +
      `reach the parts not shown here.]`;
  },

  async terrain_report(args) {
    // A missing perceiver is a SETUP failure, and it must not be reported as a
    // terrain finding. Before this, the import pointed at one developer's home
    // directory, so on every other machine the ENOENT was caught below and
    // returned as `[Terrain analysis failed: Cannot find module …]` — which
    // reads, to a model and a reader alike, like something about the document.
    if (!fs.existsSync(PERCEIVER_DISPATCH)) {
      return `[Terrain analysis unavailable: the eoreader5 perceiver is not present at ${PERCEIVER_DISPATCH}. ` +
        `This is a setup gap, not a property of "${args.path}" — run "git submodule update --init --recursive", ` +
        `or set EOCHAT_LEGACY_ENGINE_PATH. No terrain conclusion should be drawn from this message.]`;
    }
    try {
      const { buildReadingFromBytes } = await import(perceiverDispatchUrl());
      const bytes = await fsp.readFile(args.path);
      const reading = await buildReadingFromBytes(bytes);
      // Formatting lives in terrain-report-format.js, not inline here, so
      // scripts/check-laws.mjs's L7 check can import and test the EXACT
      // production text (real ambiguity-disclosure included) without needing
      // a live proxy or a model round-trip — proxy.js starts an HTTP server
      // as a side effect of module load, so it cannot itself be imported
      // just to unit-test one handler's output.
      return formatTerrainReport(reading.terrain_report, reading.born_gate, args.path);
    } catch (err) {
      return `[Error analyzing ${args.path}: ${err.message}]`;
    }
  },

  // ── Content Index handlers ──

  async codebase_structure(args) {
    if (!contentIndex) return "[Content index not built]";
    const tree = contentIndex.structure(args.prefix);
    return _renderTree(tree, args.depth || 99, "");
  },

  async codebase_find(args) {
    if (!contentIndex) return "[Content index not built]";
    const results = contentIndex.find(args.term, { limit: args.limit || 20 });
    if (!results.length) return `No matches for "${args.term}"`;
    return results.map((r, i) => {
      const line = [`${i + 1}. [${r.type}] ${r.name || r.path}`];
      if (r.repo) line.push(`     Repo: ${r.repo}/${r.path}`);
      if (r.line) line.push(`     Line: ${r.line}`);
      if (r.excerpt) line.push(`     ${r.excerpt}`);
      if (r.header) line.push(`     ${r.header.slice(0, 120)}`);
      if (r.entities && r.entities.length) line.push(`     Entities: ${r.entities.join(", ")}`);
      if (r.description) line.push(`     ${r.description.slice(0, 200)}`);
      if (r.files) line.push(`     Files: ${r.files.map(f => f.path).join(", ")}`);
      if (r.context) line.push(`     ...${r.context.slice(0, 200)}...`);
      return line.join("\n");
    }).join("\n\n");
  },

  async codebase_lookup(args) {
    if (!contentIndex) return "[Content index not built]";
    const mod = contentIndex.lookup(args.path);
    if (!mod) return `Module not found: ${args.path}`;
    const lines = [
      `Module: ${mod.repoRel}`,
      `Repo: ${mod.repoName}  Pkg: ${mod.pkgName}`,
      `Size: ${mod.size} bytes, ${mod.lines} lines`,
      `Header: ${mod.header || "(none)"}`,
    ];
    if (mod.entities?.length) lines.push(`Entities: ${mod.entities.join(", ")}`);
    if (mod.definitions?.length) lines.push(`Definitions: ${mod.definitions.map(d => `${d.name} (${d.type}:${d.line})`).join(", ")}`);
    if (mod.exports?.length) lines.push(`Exports: ${mod.exports.map(e => `${e.name} (${e.type}:${e.line})`).join(", ")}`);
    if (mod.imports?.length) lines.push(`Imports: ${mod.imports.map(i => i.spec).join(", ")}`);
    if (mod.importedBy?.length) lines.push(`Imported by: ${mod.importedBy.map(i => i.by).join(", ")}`);
    return lines.join("\n");
  },

  async codebase_search(args) {
    if (!contentIndex) return "[Content index not built]";
    const results = contentIndex.search(args.query, { limit: args.limit || 20, repo: args.repo });
    if (!results.length) return `No matches for "${args.query}"`;
    return results.map((r, i) => {
      const parts = [`${i + 1}. ${r.path} (score: ${r.score})`];
      if (r.header) parts.push(`     ${r.header.slice(0, 120)}`);
      if (r.entities?.length) parts.push(`     Entities: ${r.entities.join(", ")}`);
      parts.push(`     ${r.definitions} defs, ${r.exports} exports, ${r.lines} lines`);
      return parts.join("\n");
    }).join("\n\n");
  },

  async codebase_related(args) {
    if (!contentIndex) return "[Content index not built]";
    const rel = contentIndex.related(args.path);
    if (rel.error) return rel.error;
    const lines = [
      `=== ${rel.module.repoRel} ===`,
      `Header: ${rel.module.header || "(none)"}`,
      `Entities: ${(rel.module.entities || []).join(", ") || "none"}`,
    ];
    if (rel.imports?.length) {
      lines.push(`\nImports:`);
      for (const m of rel.imports.slice(0, 15)) lines.push(`  ${m.repoRel} — ${(m.header || "").slice(0, 80)}`);
    }
    if (rel.importedBy?.length) {
      lines.push(`\nImported by:`);
      for (const m of rel.importedBy.slice(0, 15)) lines.push(`  ${m.repoRel} — ${(m.header || "").slice(0, 80)}`);
    }
    if (rel.entities?.length) {
      lines.push(`\nEntity implementations:`);
      for (const e of rel.entities) {
        lines.push(`  ${e.name}: ${e.description || "(no description)"}`);
        for (const f of e.files) lines.push(`    → ${f.path}`);
      }
    }
    return lines.join("\n");
  },

  async codebase_entities() {
    if (!contentIndex) return "[Content index not built]";
    const ents = contentIndex.entityIndex();
    const names = Object.keys(ents).sort();
    return names.map(name => {
      const e = ents[name];
      const desc = e.description ? `— ${e.description.slice(0, 150)}` : "";
      const files = e.files.map(f => `  ${f.repo}:${f.path}`).join("\n");
      return `${name} ${desc}\n${files}`;
    }).join("\n\n");
  },

  async codebase_api(args) {
    if (!contentIndex) return "[Content index not built]";
    const apis = contentIndex.apiSurface(args.prefix);
    if (!apis.length) return `No API surface found for prefix: ${args.prefix}`;
    return apis.map(a => {
      const parts = [`${a.path}`];
      if (a.entities?.length) parts.push(`  Entities: ${a.entities.join(", ")}`);
      if (a.exports?.length) parts.push(`  Exports: ${a.exports.map(e => `${e.name}(${e.type})`).join(", ")}`);
      if (a.definitions?.length) parts.push(`  Defs: ${a.definitions.map(d => `${d.name}(${d.type})`).join(", ")}`);
      return parts.join("\n");
    }).join("\n\n");
  },

  async codebase_summary() {
    if (!contentIndex) return "[Content index not built]";
    const s = contentIndex.summary();
    const lines = [
      `Content Index Summary`,
      `Scan time: ${s.scanTime}ms`,
      `Total files: ${s.totalFiles}`,
      `Total entities: ${s.totalEntities}`,
      `Total definitions: ${s.totalDefinitions}`,
      ``,
      `Repos:`,
    ];
    for (const r of s.repos) {
      lines.push(`  ${r.name}: ${r.files} files, ${r.lines} lines, ${r.packages} packages`);
      lines.push(`    ${(r.description || "").slice(0, 120)}`);
    }
    return lines.join("\n");
  },

  async holonic_task(args, onEvent) {
    const taskDescription = args.task || args.description || "";
    if (!taskDescription) return "Error: 'task' parameter is required.";

    const model = args.model || "gemma2:2b";
    const outputPath = args.output_path || null;
    const engineAdapter = buildHolonicEngineAdapter();

    const task = new HolonicTask({
      task: taskDescription,
      model,
      engine: engineAdapter,
      outputPath,
    });

    let lastEvent = "planning";
    try {
      const result = await task.run({
        onProgress: (phase, msg, data = {}) => {
          lastEvent = `${phase}: ${msg.slice(0, 80)}`;
          // Forward as its own named SSE event (holonic_plan, holonic_subtask_start,
          // holonic_subtask_priors, holonic_subtask_iteration, holonic_subtask_done,
          // holonic_replan_start, holonic_replan_done, holonic_assemble,
          // holonic_done) — the generic sendSSE(evt.type, evt) in
          // handleToolStream forwards any type verbatim.
          //
          // holonic_subtask_priors is the USER's window onto which priors are
          // steering this surf. It travels the SSE channel only. Note that the
          // `summary` returned below becomes a tool result and therefore enters
          // the model's context — which is exactly why no prior information is
          // put in it. Priors steer retrieval; they are never model context.
          if (onEvent) onEvent({ type: `holonic_${phase}`, msg, ...data });
        },
      });

      const totalMc = result.results.reduce((a, r) => a + (r.citations ? r.citations.length : 0), 0);
      const totalSurf = result.results.reduce((a, r) => a + (r.surf ? r.surf.length : 0), 0);
      const summary = {
        sections: result.results.length,
        chars: result.output.length,
        pages: Math.round(result.output.length / 3000),
        mechanicalCitations: totalMc,
        surfPassages: totalSurf,
        gaps: result.gaps.length,
        metrics: result.metrics,
        output_path: result.path,
        output_preview: result.output.slice(0, 2000),
      };

      store.ingest(`holonic_task: ${taskDescription.slice(0, 100)} (${summary.sections} sections, ${summary.chars} chars)`, "tool", { type: "holonic_task" });
      return JSON.stringify(summary, null, 2);
    } catch (err) {
      return `[holonic_task failed at ${lastEvent}]: ${err.message}`;
    }
  },
};

// ── MCP Client ──

const mcpClients = new Map(); // serverName -> { tools, callTool }

async function connectMcpServer(name, command, args = []) {
  if (mcpClients.has(name)) return mcpClients.get(name).tools;
  try {
    const { spawn } = await import("child_process");
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let buf = "";
    let pending = new Map();
    let msgId = 0;

    proc.stdout.on("data", chunk => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch {}
      }
    });

    proc.stderr.on("data", chunk => {
      const text = chunk.toString().trim();
      if (text) console.error(`[mcp:${name}] ${text}`);
    });

    proc.on("exit", (code) => {
      console.error(`[mcp:${name}] exited with code ${code}`);
      mcpClients.delete(name);
      for (const [, { reject }] of pending) reject(new Error("MCP server exited"));
    });

    async function send(method, params = {}) {
      const id = ++msgId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        proc.stdin.write(msg + "\n");
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`MCP request ${method} timed out`));
          }
        }, 30000);
      });
    }

    // Initialize
    const init = await send("initialize", {
      protocolVersion: "0.1.0",
      capabilities: {},
      clientInfo: { name: "eo-proxy", version: "2.0" },
    });

    // Get tools
    const toolResult = await send("tools/list");
    const tools = (toolResult?.tools || []).map(t => ({
      type: "function",
      function: {
        name: `mcp_${name}_${t.name}`,
        description: `[MCP:${name}] ${t.description || t.name}`,
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    }));

    const client = {
      tools,
      async callTool(toolName, args) {
        const mcpName = toolName.replace(/^mcp_/, "");
        const result = await send("tools/call", { name: mcpName, arguments: args });
        const text = result?.content?.[0]?.text || result?.content?.[0] || JSON.stringify(result || {});
        return text;
      },
      async close() {
        proc.stdin.end();
        proc.kill();
      },
    };

    mcpClients.set(name, client);
    console.error(`[mcp] Connected: ${name} (${tools.length} tools)`);
    return tools;
  } catch (err) {
    console.error(`[mcp] Failed to connect ${name}: ${err.message}`);
    return [];
  }
}

async function getAllTools() {
  const tools = [...TOOL_DEFINITIONS];
  for (const [, client] of mcpClients) {
    tools.push(...client.tools);
  }
  return tools;
}

// ── Tool calling loop ──

// web_search returns formatted text ("[i] Title\n    URL: ...\n    snippet"),
// not structured objects — parse the URLs back out so the pages behind them
// can be ingested into the engine rather than staying as untraceable text.
function parseWebSearchResults(resultStr) {
  const out = [];
  for (const block of resultStr.split(/\n\n+/)) {
    const urlMatch = block.match(/URL:\s*(\S+)/);
    if (!urlMatch) continue;
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    const titleLine = lines.find(l => /^\[\d+\]/.test(l));
    const title = titleLine ? titleLine.replace(/^\[\d+\]\s*/, "") : urlMatch[1];
    out.push({ title, url: urlMatch[1] });
  }
  return out;
}

const WEB_RESULT_FAILURE_RE = /^\[(Error|Search failed)/;

// Scan assistant prose for JSON objects shaped like a tool call and convert
// them into real calls. Only names the model was actually offered are
// accepted — an unknown name is prose that happens to look like JSON, and
// mistaking it for a call would invent a tool the turn never had.
// Returns { calls, remainder } where remainder is the content minus the
// consumed JSON, so any genuine prose around it survives.
function salvageTextToolCalls(content, tools) {
  const known = new Set(tools.map(t => t.function?.name || t.name).filter(Boolean));
  const calls = [];
  let remainder = content;

  // Walk brace-balanced candidates rather than regex-matching nested JSON.
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;

    const raw = content.slice(i, end + 1);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const name = parsed?.name;
    if (typeof name === "string" && known.has(name) && ("arguments" in parsed || "parameters" in parsed)) {
      const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
      calls.push({
        id: `salvaged_${calls.length}_${Math.random().toString(36).slice(2, 8)}`,
        type: "function",
        function: {
          name,
          arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs),
        },
      });
      remainder = remainder.replace(raw, "");
      i = end;
    }
  }

  // Strip the code fences that wrapped the consumed JSON, if any.
  if (calls.length) {
    remainder = remainder.replace(/```(?:json|tool_code)?\s*```/g, "").replace(/\s+/g, " ").trim();
  }
  return { calls, remainder };
}

// onWebContent(urls) — invoked after a web tool returns so the caller can
// ingest those pages into the engine and re-ground. There is no separate
// "web citation" record: a fetched page becomes a source with span_ids and
// byte offsets exactly like an uploaded file, or it is not citable at all.
async function runToolLoop(messages, tools, onEvent = null, maxRounds = 8, forceModel = null, webSearch = true, onWebContent = null) {
  // `tools` is authoritative, including when it is EMPTY. This previously read
  // `tools.length > 0 ? tools : await getAllTools()`, so the caller's decision
  // to send no tools was overridden right here and all 25 went out anyway —
  // the caller-side filter in handleToolStream looked correct while this line
  // silently undid it. Only `undefined`/`null` means "caller has no opinion".
  const effectiveTools = tools ?? await getAllTools();

  // Inject intelligent search guidance as a system message.
  // This tells the model HOW to use web_search effectively — when to search,
  // how to formulate queries, and how to iterate on results.
  // Only injected when web search is enabled.
  if (webSearch && !messages.some(m => m.role === "system" && m.content?.includes("Web Search Strategy"))) {
    messages.unshift({
      role: "system",
      content: [
        "You are EO, a focused research and engineering assistant with access to web search.",
        "",
        "## Web Search Strategy",
        "You have web_search and web_fetch tools. Use them when you need current information, facts, or data not in your training or the local context.",
        "",
        "**When to search:**",
        "- The user asks about current events, recent developments, or time-sensitive information",
        "- You need specific data (prices, stats, specifications, APIs, documentation)",
        "- The question requires domain knowledge you're uncertain about",
        "- The local codebase or memory doesn't contain the answer",
        "",
        "**How to search effectively:**",
        "- Formulate keyword-rich queries — be specific, not vague",
        "- Start broad, then narrow: use type='fast' for quick orientation, type='deep' for comprehensive research",
        "- Read search results first, then use web_fetch to get full content from promising URLs",
        "- If results are thin, try different query formulations or use site: to target known domains",
        "- Use livecrawl='preferred' for breaking news or frequently updated content",
        "",
        "**How to use results:**",
        "- Synthesize information from multiple sources — don't rely on a single result",
        "- Before stating something as fact, look for confirmation the way a careful person would: does a second, independent source agree? If a claim rests on only one source, or sources conflict, say so plainly instead of presenting it as settled",
        "- Cite sources when presenting facts",
        "- If search returns nothing useful, try reformulating the query before giving up",
      ].join("\n"),
    });
  }

  // An explicit forceModel is a deliberate human/client override — it wins
  // outright and never enters the learned-routing ledger (there'd be no
  // honest "the router chose this" claim to score).
  let model, routerCtx;
  if (forceModel) {
    model = forceModel;
    routerCtx = null;
  } else if (modelRouter) {
    ({ model, ctx: routerCtx } = modelRouter.pick(messages));
    console.error(`[proxy] router picked ${model} (msgs=${messages.length}, chars=${messages.reduce((n, m) => n + (m.content || "").length, 0)})`);
  } else {
    model = selectModel(messages);
    routerCtx = null;
  }

  const turnStartedAt = Date.now();

  // "Success" for the router meant only "the tool loop finished cleanly" —
  // measured directly: a 256-second reply and a 2-second reply from the same
  // model both recorded as unqualified successes, so nothing in the learned
  // routing signal could ever prefer the fast candidate over the slow one.
  // Latency IS the thing being optimized for here, so it has to be part of
  // the outcome the router scores, not a side effect nobody reveals to it.
  const revealOutcome = async (outcome) => {
    if (!routerCtx) return;
    const elapsedMs = Date.now() - turnStartedAt;
    const gated = outcome === "success" && elapsedMs > LATENCY_BUDGET_MS ? "failure" : outcome;
    try { await modelRouter.reveal(routerCtx, gated); }
    catch (err) { console.error(`[proxy] model-router reveal failed: ${err.message}`); }
  };

  try {
    for (let round = 0; round < maxRounds; round++) {
      const body = {
        model,
        messages,
        stream: effectiveTools.length === 0,
        options: {
          temperature: 0.7,
          num_predict: 4096,
          // THE single biggest latency fix in this server. Left unset, ollama
          // sizes the context from the model's trained maximum: phi4-mini's is
          // 131072, which allocated 20GB and pushed 24% of the model onto the
          // CPU — so the "tiny" model was the SLOWEST thing here, taking 67s
          // to say hello with no context at all. Pinning it keeps small models
          // wholly on the GPU (phi4-mini 20GB -> 3.7GB, 100% GPU).
          num_ctx: NUM_CTX,
        },
      };
      // Tools are opt-in. A grounded answer needs none: the dispatcher has
      // already retrieved and folded the passages before the model is called,
      // so the talker's only job is prose. Shipping 25 tool definitions on
      // every turn inflated the prompt for exactly the small models that can
      // least afford it, and invited a multi-round tool loop where one call
      // would do.
      if (effectiveTools.length) body.tools = effectiveTools;

      console.error(`[proxy] llm_call round=${round} model=${model} tools=${effectiveTools.length} msgs=[${messages.map(m => `${m.role}:${(m.content || "").length}`).join(" ")}]`);
      if (onEvent) onEvent({ type: "llm_call", round, tools: effectiveTools.length, model });

      const callOllama = () => safeFetch(`${TARGET}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 120000);

      let msg;
      if (effectiveTools.length === 0) {
        // Token-stream the answer so the reader watches it arrive word by
        // word instead of a silent multi-second gap ending in one `response`
        // burst. The UI's `content` handler appends deltas incrementally; a
        // single trailing `response` with the full text still fires, so any
        // consumer keyed on `response` is unchanged. (The tool loop cannot
        // stream: tool calls only appear at the end of an ollama stream, so
        // the loop's salvage-and-recall machinery needs the whole message.)
        const streamResp = await withRetry(callOllama, { label: "Ollama chat (stream)", maxRetries: 2 });
        if (!streamResp.ok) {
          const errText = await streamResp.text().catch(() => streamResp.statusText);
          throw new Error(`Ollama ${streamResp.status}: ${errText}`);
        }
        const reader = streamResp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "", content = "", ollamaErr = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            // Ollama's /api/chat streams bare newline-delimited JSON — no
            // "data:" prefix (that is the OpenAI /v1 shape). Tolerate either.
            const t = line.trim().replace(/^data:\s*/, "");
            if (!t) continue;
            let j;
            try { j = JSON.parse(t); } catch { continue; }
            if (j.error) { ollamaErr = j.error; break; }
            const delta = j.message?.content || "";
            if (delta) {
              content += delta;
              if (onEvent) onEvent({ type: "content", content: delta, model });
              // Token telemetry: count what the reader is watching arrive.
              // ~4 chars/token (Ollama doesn't report eval counts per chunk).
              recordTokens(delta.length / 4, model);
            }
          }
          if (ollamaErr) break;
        }
        if (ollamaErr) throw new Error(`Ollama: ${ollamaErr}`);
        msg = { content };
      } else {
        const resp = await withRetry(callOllama, { label: "Ollama chat", maxRetries: 2 });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => resp.statusText);
          throw new Error(`Ollama ${resp.status}: ${errText}`);
        }
        const data = await resp.json();
        msg = data.message || {};
        if (msg.content) recordTokens(msg.content.length / 4, model); // non-streamed (tool rounds): count whole content
      }

      // Smaller local models routinely emit a tool call as prose — a bare or
      // fenced {"name":…,"arguments":…} in `content` with `tool_calls` empty.
      // Left alone, that JSON streams to the reader AS the answer and the turn
      // silently loses its grounding. Recover it into a real call instead.
      if ((!msg.tool_calls || msg.tool_calls.length === 0) && msg.content) {
        const salvaged = salvageTextToolCalls(msg.content, effectiveTools);
        if (salvaged.calls.length) {
          msg.tool_calls = salvaged.calls;
          msg.content = salvaged.remainder;
          if (onEvent) onEvent({ type: "tool_call_salvaged", count: salvaged.calls.length, names: salvaged.calls.map(c => c.function.name) });
        }
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        messages.push({ role: "assistant", content: msg.content || "" });
        if (onEvent) onEvent({ type: "response", content: msg.content || "", model, elapsedMs: Date.now() - turnStartedAt });
        await revealOutcome("success");
        return msg.content || "";
      }

      // Ollama expects `arguments` as an object on the way back in — handing
      // it a JSON *string* makes its parser fail with "Value looks like
      // object, but can't find closing '}'" and kills the whole turn.
      const toolCalls = msg.tool_calls.map(tc => {
        const rawArgs = tc.function?.arguments ?? tc.arguments ?? {};
        let argsObj = rawArgs;
        if (typeof rawArgs === "string") {
          try { argsObj = JSON.parse(rawArgs); } catch { argsObj = {}; }
        }
        return {
          id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function",
          function: { name: tc.function?.name || tc.name, arguments: argsObj },
        };
      });

      if (onEvent) onEvent({ type: "tool_calls", calls: toolCalls.map(tc => ({ name: tc.function.name, args: JSON.stringify(tc.function.arguments) })) });

      messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });

      for (const tc of msg.tool_calls) {
        const name = tc.function?.name || tc.name;
        let args = {};
        try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); } catch {}

        console.error(`[proxy] Tool call: ${name}(${JSON.stringify(args).slice(0, 200)})`);

        let result;
        const isMcp = name.startsWith("mcp_");

        if (isMcp) {
          const serverName = name.split("_")[1];
          const toolName = name.split("_").slice(2).join("_");
          const client = mcpClients.get(serverName);
          if (client) {
            try { result = await client.callTool(name, args); }
            catch (err) { result = `[MCP error: ${err.message}]`; }
          } else {
            result = `[MCP server "${serverName}" not connected]`;
          }
        } else {
          const handler = toolHandlers[name];
          if (handler) {
            // Handlers receive onEvent as a second (optional) argument so a
            // long-running tool (e.g. holonic_task) can push its own named
            // SSE events mid-flight instead of only returning a final
            // result. Handlers that ignore the second argument (the vast
            // majority) are unaffected.
            try { result = await handler(args, onEvent); }
            catch (err) { result = `[Error calling ${name}: ${err.message}]`; }
          } else {
            result = `[Unknown tool: ${name}]`;
          }
        }

        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        store.ingest(`Tool ${name}: ${resultStr.slice(0, 300)}`, "tool", { name });

        if (onEvent) onEvent({ type: "tool_result", name, result: resultStr.slice(0, 500) });

        // A web hit is only worth anything once it is in the engine — hand the
        // URLs to the caller to ingest and re-ground, then tell the model to
        // cite the renumbered engine passages rather than the raw tool text.
        let citeHint = "";
        if (onWebContent && (name === "web_search" || name === "web_fetch") && !WEB_RESULT_FAILURE_RE.test(resultStr)) {
          const urls = name === "web_search"
            ? parseWebSearchResults(resultStr).map(r => r.url)
            : (args.url ? [args.url] : []);
          if (urls.length) citeHint = (await onWebContent(urls)) || "";
        }

        messages.push({
          role: "tool",
          content: resultStr.slice(0, 10000) + citeHint,
          tool_call_id: tc.id || `call_${Date.now()}`,
        });
      }
    }

    const last = messages[messages.length - 1];
    if (last?.role === "tool") {
      messages.push({ role: "assistant", content: "[Max tool rounds reached. Please continue based on the results above.]" });
    }
    const finalContent = messages[messages.length - 1]?.content || "";
    if (onEvent) onEvent({ type: "response", content: finalContent, model, elapsedMs: Date.now() - turnStartedAt });
    await revealOutcome("failure");
    return finalContent;
  } catch (err) {
    await revealOutcome("failure");
    throw err;
  } finally {
    // Generation is over (answer complete, tool loop done, or error) — let
    // the monitor's live "generating" flag drop instead of waiting out the
    // 3s idle timeout.
    endGeneration();
  }
}

// ── Streaming tool-calling endpoint (SSE) ──

async function handleToolStream(res, messages, tools, forceModel = null, opts = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // The talker does no tool calling. A dispatcher retrieves and folds the
  // passages BEFORE this point, so an ordinary grounded turn is one call with
  // no tool definitions at all — previously every turn shipped all 25, which
  // is prompt weight the small models can least afford and an invitation to
  // spend several rounds in a tool loop to produce one paragraph.
  //
  // Tools return only when something actually needs them: the caller names the
  // ones it wants, or the reader turns web search on.
  let effectiveTools = [];
  if (tools && tools.length > 0) {
    effectiveTools = tools;
  } else if (opts.webSearch) {
    const all = await getAllTools();
    const webTools = new Set(["web_search", "web_fetch"]);
    effectiveTools = all.filter(t => webTools.has(t.function?.name || t.name || ""));
  }

  // verbatim_search / verbatim_read are mechanical — byte-offset-anchored
  // reads with no model step (specs/mechanical-citation-surface.md). The
  // grounding system prompt injected below unconditionally tells the model
  // "you have access to tools... use verbatim_search" on EVERY grounded turn,
  // not just when a caller opts into the full tool list. Without this, that
  // promise was false whenever `tools` wasn't passed: the model had no way to
  // fulfil the instruction it was just given, so a "give me verbatim text"
  // request fell back to freehand-quoting the folded context — observed
  // producing a passage with an invented plot detail under a real citation
  // number that pointed at unrelated source text. These two cost nothing to
  // always include; unlike the other 23, they carry no prompt weight beyond
  // their own schema.
  const haveToolNames = new Set(effectiveTools.map(t => t.function?.name || t.name));
  const missingVerbatim = ["verbatim_search", "verbatim_read"].filter((n) => !haveToolNames.has(n));
  if (missingVerbatim.length) {
    const all = await getAllTools();
    effectiveTools = effectiveTools.concat(
      all.filter((t) => missingVerbatim.includes(t.function?.name || t.name || "")),
    );
  }

  sendSSE("tools_available", { count: effectiveTools.length });

  // Engine-grounded context: search + fold before the LLM sees anything.
  // Inject as a system message so the model answers from source material
  // with inline citations, not from training-data recollection. Mandatory —
  // there is no code path that skips this to answer from the model alone.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const query = lastUser ? (lastUser.content || "") : null;

  // One grounding pass. Re-runnable: after web pages are ingested, the same
  // call re-searches the (now larger) engine and replaces the injected system
  // message, so a web-sourced passage is numbered and cited by the identical
  // mechanism as a file-sourced one.
  let groundedSystemMsg = null;
  // The [1], [2]... citation records from the most recent grounding pass, in
  // display order — what verifyQuotedFidelity checks the model's quotes
  // against once the answer is complete. Kept separate from
  // groundedSystemMsg (which only tracks a count) because the fidelity check
  // needs the actual verbatim text, not just how many citations exist.
  let lastCitations = [];
  const groundNow = () => {
    if (query === null) return null;
    const groundResult = engineGroundQuery(query, {
      budget: opts.groundBudget ?? 2400,
      maxUnits: opts.groundMaxUnits ?? 5,
      limit: opts.groundLimit ?? 30,
      source: opts.groundSource,
    });

    if (!groundResult.context) {
      // Two different facts, reported differently: the corpus is still loading,
      // or the sources really are silent on this. Only the second licenses an
      // ungrounded answer.
      const warming = corpusWarmup.started && !corpusWarmup.ready;

      // No evidence means no citation is possible, so the model must not emit
      // one. It may still answer from its own knowledge — that is useful — but
      // the answer is MODEL-tier, and saying so is the whole contract. A
      // bracketed number here would be indistinguishable from a real citation.
      // The reader is told outside the answer (a UI banner driven by the
      // `grounding` SSE event below, not by anything the model writes) when a
      // turn is ungrounded. The model itself must not narrate this — no
      // preamble about lacking sources, no mention of an index, retrieval, or
      // "source material". It just answers, as itself. Telling the model to
      // self-disclose here produced exactly that meta-commentary in the
      // answer text (observed: "According to the source material, I don't
      // currently possess direct knowledge about..." — echoing this prompt's
      // own wording back to the reader).
      const ungroundedSystem = buildUngroundedSystemPrompt({ warming });

      if (groundedSystemMsg) {
        groundedSystemMsg.content = ungroundedSystem;
      } else {
        groundedSystemMsg = { role: "system", content: ungroundedSystem };
        const userIdx = messages.findIndex((m) => m.role === "user" && m.content === query);
        if (userIdx >= 0) messages.splice(userIdx, 0, groundedSystemMsg);
        else messages.unshift(groundedSystemMsg);
      }
      groundedSystemMsg._citationCount = 0;
      lastCitations = [];

      sendSSE("grounding", {
        sourceCount: 0,
        empty: true,
        warming,
        systemContext: ungroundedSystem,
        retrieved: [],
        queryTerms: String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean),
        // L2e on the surface the reader actually uses. An ungrounded turn used
        // to report `gaps: []` and one fixed sentence about "your sources",
        // which says the wrong thing outright when the reader has no sources:
        // it blames the library for a silence that is really an empty shelf.
        // The same typed gap the verbatim search now returns is emitted here,
        // so the chat banner can tell "ingest something first" apart from
        // "your documents were read and do not cover this".
        gaps: (groundResult.gaps?.length ? groundResult.gaps : null)
          || (warming ? [] : describeAbsence({ query, poolName: groundResult.pool || "corpus", sourceFilter: opts.groundSource || null })),
        note: warming
          ? "Document index still loading — this answer is not grounded in your sources yet."
          : absenceNote(groundResult, opts.groundSource || null),
      });
      return groundResult;
    }

    const systemContext = buildGroundedSystemPrompt(groundResult);

    if (groundedSystemMsg) {
      // Re-ground in place — the model must not see two competing tables.
      groundedSystemMsg.content = systemContext;
    } else {
      groundedSystemMsg = { role: "system", content: systemContext };
      const userIdx = messages.findIndex((m) => m.role === "user" && m.content === query);
      if (userIdx >= 0) messages.splice(userIdx, 0, groundedSystemMsg);
      else messages.unshift(groundedSystemMsg);
    }
    groundedSystemMsg._citationCount = groundResult.citations.length;
    lastCitations = groundResult.citations.map((c, i) => ({ index: i + 1, source_id: c.source_id, text: c.text }));

    sendSSE("grounding", {
      sourceCount: groundResult.total,
      foldedCount: groundResult.folded,
      tokens: groundResult.tokens,
      budget: groundResult.budget,
      dropped: groundResult.dropped,
      // The query as the engine tokenized it, so the reader can see which of
      // their words actually drove retrieval.
      queryTerms: String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean),
      // Every retrieved span, kept or dropped, with its ranking evidence. This
      // is the whole retrieval step, emitted before the model is called at all.
      retrieved: groundResult.retrieved || [],
      // The verbatim system context injected above — clients surface this
      // as the prompt actually sent, rather than reconstructing it.
      systemContext,
      citations: groundResult.citations.map((c, i) => ({
        index: i + 1,
        span_id: c.span_id,
        source_id: c.source_id,
        byte_start: c.byte_start,
        byte_end: c.byte_end,
        score: Math.round(c.score * 100) / 100,
        text: c.text,
      })),
      gaps: groundResult.gaps || [],
      // Which witness-tier coref priors widened this search and with which
      // surface forms — the reader sees what shaped retrieval, never a rule
      // the model was told (priors steer the engine, not the prompt).
      priorWidening: groundResult.priorWidening || null,
    });
    return groundResult;
  };

  groundNow();

  // Web pages are ingested as ordinary sources, then re-grounded. A page the
  // engine cannot admit yields no citation at all rather than a bare URL the
  // reader cannot check.
  const ingestedUrls = new Set();
  const onWebContent = async (urls) => {
    const fresh = urls.filter(u => !ingestedUrls.has(u)).slice(0, 3);
    if (!fresh.length) return "";
    const admitted = [];
    for (const url of fresh) {
      ingestedUrls.add(url);
      try {
        const fetched = await fetchAndSaveUrl(url);
        if (!fetched.text || fetched.text.length < 200) continue;
        let label;
        try {
          const u = new URL(url);
          label = (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/+$/, "").replace(/\//g, "_");
        } catch { label = url.replace(/\//g, "_"); }
        // Async/worker-backed (see ingest-worker.js): a fetched page can run
        // to 500,000 chars, and admitting that synchronously is exactly the
        // L1d failure mode LAWS.md documents — one chat turn's web ingest
        // could block every other concurrent request's SSE handshake.
        await engineIngestTextAsync(fetched.text, `source:${label}`, label);
        admitted.push({ url, label });
        const record = {
          name: label, url, size: fetched.text.length,
          session: opts.session || "default",
          query: query || "",
          ingestedAt: new Date().toISOString(),
          savedPath: fetched.path || null,
          truncated: false,
        };
        recordWebHistory(record);
        sendSSE("source_added", record);
      } catch (err) {
        sendSSE("gap", { type: "web_ingest_failed", url, reason: err.message });
      }
    }
    if (!admitted.length) return "\n\n(None of these pages could be ingested — do not cite them.)";
    groundNow();
    return `\n\n(Ingested: ${admitted.map(a => a.label).join(", ")}. The SOURCE MATERIAL above has been refreshed — cite those numbered passages, not this tool output.)`;
  };

  try {
    const rawContent = await runToolLoop(messages, effectiveTools, (evt) => {
      sendSSE(evt.type, evt);
    }, 8, forceModel, opts.webSearch, onWebContent);

    // Validate citations: replace fabricated [N] with a visible gap marker
    // so the reader never sees a fake citation number.
    const maxCitation = groundedSystemMsg
      ? (groundedSystemMsg._citationCount || 0)
      : 0;
    const content = maxCitation > 0
      ? validateCitations(rawContent, maxCitation)
      : rawContent;

    // Model-blind fidelity check: does every claimed quotation in the answer
    // actually occur in the cited source's real bytes? Sent as its own event,
    // ahead of "done", so a client can never conflate "the model produced
    // text" with "the text was verified" — the two are structurally separate
    // events, one generated, one computed from ground truth.
    const fidelity = verifyQuotedFidelity(content, lastCitations);
    if (fidelity.quotesChecked > 0) sendSSE("fidelity", fidelity);

    // The same mechanical fact-check the conversational surface runs, on the
    // same terms: computed from the finished answer and the engine's citation
    // table, sent as its own event ahead of "done" so a client can never
    // conflate "the model produced text" with "the text was checked". Emitted
    // unconditionally — a report saying it found nothing is a different fact
    // from no report at all.
    // Against rawContent, not content: validateCitations above has already
    // rewritten an invented [9] into "[⊘ no source 9]", which no longer parses
    // as a bracket, so checking the rewritten text would report zero
    // unresolved citations and erase its own finding.
    const groundingCheck = checkGrounding(rawContent, lastCitations, { question: query || "" });
    const annotatedText = maxCitation > 0
      ? validateCitations(annotateVoids(rawContent, groundingCheck), maxCitation)
      : annotateVoids(rawContent, groundingCheck);
    sendSSE("grounding_checked", { ...groundingCheck, annotatedText });
    for (const g of groundingGaps(groundingCheck)) sendSSE("gap", g);

    sendSSE("done", { content });

    // Persist assistant response in discourse store
    if (content?.length > 5 && opts.session) {
      try {
        await discourse.addMessage(opts.session, "assistant", content);
      } catch (err) {
        console.error(`[proxy] discourse persist error (tools): ${err.message}`);
      }
    }
  } catch (err) {
    sendSSE("error", { message: err.message });
  }
  res.end();
}

// ── Ingest ──

// LAWS.md L3 — no silent truncation, satisfied by not truncating.
//
// Admission used to stop at 500,000 characters. Reporting the cut was a real
// improvement over hiding it, but reporting is a consolation prize: the
// dropped six sevenths of a book are still not searchable and still not
// citable, and the reader who is told so is still left without the thing they
// asked for. A document handed to this application is now admitted whole.
//
// `admitWhole` exists so the shape of an ingest result does not depend on how
// big the document was: `truncated: false` is a positive assertion of
// completeness that every ingest surface makes, not a field that only appears
// when something went wrong. If a cap is ever reintroduced, it has to come
// back through here, and the field is already wired to the UI that would
// show it.
function admitWhole(result) {
  return { ...result, truncated: false };
}

// Transport ceiling for a single ingest request body. This is NOT a
// truncation: nothing is cut, and nothing is admitted. A body past this size
// is refused outright, with the limit named, because the alternative is not
// "ingest more" — it is a heap allocation failure that takes the process down
// and loses the document anyway. The ceiling is far above any realistic text
// (War and Peace is ~3MB), and V8's own maximum string length sits not far
// above it, so this is the honest edge of what a single request can carry
// rather than a policy choice about how much of a book is worth reading.
const INGEST_MAX_BODY = parseArg("ingest-max-body", 268_435_456, Number);

// Shared by both /api/ingest response modes (plain JSON and SSE, below):
// admission itself runs off the main thread (engineIngestTextAsync/
// engineIngestFileAsync — see ingest-worker.js for why), so this only
// decides which of url/content/path was sent and shapes the result.
async function performIngest({ ingestPath, ingestUrl, content, name, sessionId }) {
  // URL ingestion — fetch, strip markup, then fall through the same
  // content path so a page becomes a first-class citable source, not a
  // one-turn context injection.
  if (ingestUrl && !content) {
    const fetched = await fetchAndSaveUrl(ingestUrl);
    if (!fetched.text) {
      const err = new Error(`Fetch failed for ${ingestUrl} — ${fetched.error || "no text"}`);
      err.status = 502;
      throw err;
    }
    // The engine derives a display name by stripping everything up to the
    // last slash, so a raw URL would come back "(unnamed)". Flatten
    // host+path into one slash-free label; the URL rides alongside it.
    let label;
    try {
      const u = new URL(ingestUrl);
      label = (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/+$/, "").replace(/\//g, "_");
    } catch { label = ingestUrl.replace(/\//g, "_"); }
    const srcName = name || label || ingestUrl;
    const sourceId = `source:${srcName}`;
    const result = await engineIngestTextAsync(fetched.text, sourceId, srcName);
    const att = await discourse.addAttachment(sessionId, {
      name: srcName,
      content: fetched.text,
      type: "url",
      size: fetched.text.length,
      ingestedAt: new Date().toISOString(),
    });
    return admitWhole({
      ...result, sourceId, name: srcName, url: ingestUrl,
      attachment: { name: att.name, type: att.type, size: att.size },
    });
  }

  // Content-based ingestion (from browser file picker)
  if (content) {
    const sourceId = `source:${name || "upload"}:${Date.now()}`;
    const result = await engineIngestTextAsync(content, sourceId, name || "upload");

    // Register as attachment in discourse
    const att = await discourse.addAttachment(sessionId, {
      name: name || `upload_${Date.now()}.txt`,
      content,
      type: name ? (name.endsWith(".txt") ? "text" : name.endsWith(".json") ? "json" : name.endsWith(".js") ? "javascript" : name.endsWith(".py") ? "python" : "file") : "text",
      size: content.length,
      ingestedAt: new Date().toISOString(),
    });

    return admitWhole(
      { ...result, sourceId, name: name || "upload", attachment: { name: att.name, type: att.type, size: att.size } },
    );
  }

  // Path-based ingestion (from server filesystem)
  if (!ingestPath) {
    const err = new Error("Missing 'url', 'path' or 'content' field");
    err.status = 400;
    throw err;
  }
  try {
    return await engineIngestFileAsync(ingestPath);
  } catch (err) {
    // Idempotent: if already ingested, return success with existing source info
    if (err.message?.includes("duplicate")) {
      const existing = engineListSources().find(s => s.path === ingestPath);
      return {
        path: ingestPath,
        sourceId: ingestPath,
        alreadyIngested: true,
        truncated: false,
        chunks: existing?.chunks || 0,
        pool: existing?.pool || "corpus",
        note: "Source already ingested",
      };
    }
    throw err;
  }
}

// LAWS.md candidate law — "errors do not wear success."
//
// The engine's read helpers report a failed read by RETURNING `{error}`
// rather than throwing, so the routes that wrapped them in an unconditional
// `writeHead(200)` answered "unknown span_id — search first" with a success
// status. Every client that branches on `res.ok` — including the check
// harness, which passed these routes for exactly that reason — then treats a
// missing passage as a delivered one. On an audit hop that is the worst
// possible place for it: the reader following a citation home is told the
// journey succeeded.
//
// A read that produced no evidence is 404: the span named does not exist.
function sendVerbatim(res, result) {
  const failed = result && typeof result === "object" && result.error;
  res.writeHead(failed ? 404 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

// ── Absence ──
//
// LAWS.md L2e — a gap is a finding and must be inspectable. A no-match search
// used to return `gaps: null`, which meant an empty corpus, a corpus still
// warming up, a source filter that excluded everything, and a corpus that
// genuinely does not discuss the query all produced byte-identical responses.
// The reader cannot act on any of them, because they cannot tell which one
// happened — and "an empty space where evidence should be is the single
// easiest thing to mistake for evidence of nothing."
//
// This names which silence it was, and says what was searched, so the reader
// can tell "you have not given me this book" from "this book does not say
// that." Every branch reports the same shape the UI already renders for
// engine gaps (`{ type, reason }`), so no new surface is needed to show it.
// The one-line form of the same finding, for the ungrounded-turn banner. It
// must not say "no matching passage in your sources" when there are no
// sources: that sentence quietly asserts a library was consulted.
function absenceNote(groundResult, sourceFilter) {
  const gap = describeAbsence({
    query: "",
    poolName: groundResult?.pool || "corpus",
    sourceFilter,
  })[0];
  if (gap.type === "no_sources_ingested") {
    return "No documents are ingested yet, so nothing was searched. Answering from general knowledge, uncited — add a source to get cited answers.";
  }
  if (gap.type === "source_filter_matched_nothing") {
    return `No ingested source matches "${sourceFilter}", so nothing was searched. Answering from general knowledge, uncited.`;
  }
  return `No matching passage in your ${gap.sourcesSearched} ingested source(s). Answering from general knowledge, uncited.`;
}

function describeAbsence({ query, poolName, sourceFilter, searchedQuery }) {
  const gap = (type, reason, extra = {}) => [{
    type, reason, query,
    ...(searchedQuery && searchedQuery !== query ? { searchedQuery } : {}),
    pool: poolName,
    ...(sourceFilter ? { sourceFilter } : {}),
    ...extra,
  }];

  // Still loading is not the same fact as not present, and the two must never
  // render alike (LAWS.md, candidate law: "two facts that differ must not read
  // alike"). corpusWarmup exists for exactly this distinction.
  if (corpusWarmup.started && !corpusWarmup.ready) {
    return gap("corpus_warming",
      "The corpus is still being loaded, so this search did not see every source yet. Ask again once loading finishes — this is not a statement that the text is silent.");
  }

  let sources = [];
  try {
    sources = engineListSources({ pool: poolName }).filter((s) => (s.kind ?? "corpus") === "corpus");
  } catch { /* listing is best-effort; the gap below is still worth naming */ }

  if (!sources.length) {
    return gap("no_sources_ingested",
      `Nothing is ingested in the "${poolName}" pool, so there was nothing to search. This is an empty library, not a silent one — ingest a document first.`,
      { sourcesSearched: 0 });
  }

  if (sourceFilter) {
    const matching = sources.filter((s) => (s.name || s.path || "").includes(sourceFilter));
    if (!matching.length) {
      return gap("source_filter_matched_nothing",
        `No ingested source matches the filter "${sourceFilter}", so the search ran against nothing. ${sources.length} source(s) are loaded but none were eligible.`,
        { sourcesSearched: 0, sourcesAvailable: sources.length });
    }
    return gap("no_evidence_matched",
      `Searched ${matching.length} source(s) matching "${sourceFilter}" and found no passage for this query. The sources are loaded and were read; they do not appear to contain it.`,
      { sourcesSearched: matching.length, sources: matching.map((s) => s.name) });
  }

  // The honest, and most common, case: the library is there, it was read, and
  // it does not contain this. That is a finding, and it is now stated as one.
  return gap("no_evidence_matched",
    `Searched ${sources.length} ingested source(s) and found no passage matching this query. The corpus was read and does not appear to contain it.`,
    { sourcesSearched: sources.length, sources: sources.map((s) => s.name).slice(0, 20) });
}

// ── Project store ──

import { ProjectStore, projectStore } from "./project-store.js";
import { insightStore } from "./insight-store.js";

// ── Server ──

let connections = new Set();
let shuttingDown = false;

const server = http.createServer((req, res) => {
  // Track connection for graceful shutdown
  connections.add(res);
  res.on("close", () => connections.delete(res));

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // Private Network Access: this proxy is only ever reached from a browser
  // as "public page (GitHub Pages) fetches a local/private target" — the
  // exact shape PNA's preflight permission check exists to gate. Without
  // this header, Chromium-family browsers (Chrome, Brave, Edge...) silently
  // block any *preflighted* cross-origin request here — POSTs with a JSON
  // body, like eoCode's /api/eocode/run, but not plain GETs like /health,
  // which never preflight and so never hit this check. That asymmetry (GETs
  // fine, JSON POSTs blocked) is what makes this easy to miss: the server
  // already trusts any Origin (see Allow-Origin: * above), so granting the
  // private-network preflight too is consistent with the trust this proxy
  // already extends, not a new boundary.
  res.setHeader("Access-Control-Allow-Private-Network", "true");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", store_size: store.size, uptime: process.uptime().toFixed(1) }));
    return;
  }

  // System telemetry for the Monitor surface. Always answers — the sampler
  // degrades to whatever the host can report and flags what it can't (GPU on
  // non-Apple, ollama CPU on Windows), and the UI hides what's unavailable.
  if (req.method === "GET" && req.url === "/api/system/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(systemSnapshot()));
    return;
  }

  // Serves a small, explicit allowlist of files byte-identical to the
  // browser, so the exact same deliberate-long-form verification code
  // (longform.js, longform-orchestrator.js, task-log.js, and the vendored
  // attribution/svo/morphology trio it depends on) runs in Node
  // (turn-controller.js, against Ollama) and in the browser
  // (ui/webllm-longform.js, against WebLLM) with zero forked logic. URLs
  // mirror real repo-relative paths on purpose: longform.js's existing
  // relative import of ../vendor/eoreader5/packages/def/attribution.js
  // (which itself imports ./svo.js and ./morphology.js) then resolves
  // correctly with NO modification — same bytes, same import specifiers,
  // both runtimes.
  //
  // An explicit allowlist, not a wildcard — server/ also holds
  // conversations/memory that must never become network-reachable this way.
  if (req.method === "GET" && req.url.startsWith("/shared/")) {
    const rel = decodeURIComponent(req.url.slice("/shared/".length).split("?")[0]);
    if (!SHARED_FILE_ALLOWLIST.has(rel)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `not on the shared-file allowlist: ${rel}` }));
      return;
    }
    const abs = path.resolve(REPO_ROOT, rel);
    // Belt-and-suspenders traversal guard — the allowlist above already
    // makes this unreachable, but a resolved-path check is cheap insurance
    // against it ever becoming reachable by accident.
    if (!abs.startsWith(REPO_ROOT + path.sep)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path escapes repo root" }));
      return;
    }
    fs.readFile(abs, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": rel.endsWith(".json") ? "application/json" : "text/javascript",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
    return;
  }

  // Stats
  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ store_size: store.size, max_store: STORE_MAX, ttl_seconds: STORE_TTL / 1000, uptime: process.uptime().toFixed(1) }));
    return;
  }

  // List available models (tiny/medium routing tiers)
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tiny: TINY_MODEL, medium: MEDIUM_MODEL }));
    return;
  }

  // Available providers and models for the frontend model picker
  if (req.method === "GET" && req.url === "/api/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      providers: PROVIDERS,
      defaultProvider: "local",
      defaultModel: MEDIUM_MODEL,
      anthropicAvailable: !!ANTHROPIC_KEY,
    }));
    return;
  }

  // List models installed in the local Ollama instance. The frontend uses this
  // to populate the model picker when the reader wires up Ollama.
  if (req.method === "GET" && req.url === "/api/ollama/models") {
    (async () => {
      try {
        const resp = await safeFetch(`${TARGET}/api/tags`, {}, 10000);
        if (!resp.ok) throw new Error("upstream returned " + resp.status);
        const data = await resp.json();
        const models = (data.models || []).map(m => ({
          name: m.name,
          size: m.size,
          modified: m.modified_at || null,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models }));
      } catch (err) {
        // A bare err.message ("fetch failed") tells the reader nothing they
        // can act on. Node's fetch nests the real reason in err.cause — an
        // ECONNREFUSED/ENOTFOUND there means nothing is listening at TARGET
        // at all (Ollama not installed, not running, or on a different
        // port), which is a distinct fix from a slow-but-present upstream.
        // The setup guide in ui/index.html (requestOllamaConnect /
        // runOllamaDiagnosis) branches on `reason` to show the right one.
        const causeCode = err.cause?.code || err.cause?.errors?.[0]?.code;
        const reason = causeCode === "ECONNREFUSED" || causeCode === "ENOTFOUND" || causeCode === "EHOSTUNREACH"
          ? "not-running"
          : err.name === "AbortError" ? "timeout" : "unknown";
        const message = reason === "not-running" ? `No Ollama instance found at ${TARGET}.`
          : reason === "timeout" ? `Timed out waiting for Ollama at ${TARGET}.`
          : "Could not reach Ollama: " + err.message;
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message, reason, target: TARGET }));
      }
    })();
    return;
  }

  // Accept API key updates from the frontend settings panel at runtime.
  // Keys are held in memory only — they do not persist across a proxy restart.
  if (req.method === "POST" && req.url === "/api/settings") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > MAX_BODY) req.destroy(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        let changed = false;
        if (data.anthropicKey !== undefined) {
          ANTHROPIC_KEY = data.anthropicKey;
          changed = true;
        }
        if (data.anthropicModel !== undefined) {
          ANTHROPIC_MODEL = data.anthropicModel;
          changed = true;
        }
        if (changed) rebuildProviders();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, anthropicAvailable: !!ANTHROPIC_KEY }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Learned model-router state (competency ledger snapshot, read-only)
  if (req.method === "GET" && req.url === "/v1/router") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(modelRouter ? modelRouter.describe() : { error: "model-router unavailable" }));
    return;
  }

  // List MCP servers
  if (req.method === "GET" && req.url === "/mcp/servers") {
    const servers = [];
    for (const [name, client] of mcpClients) {
      servers.push({ name, tools: client.tools.length });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ servers }));
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // Discourse endpoints — persisted conversation + attachments
  // ══════════════════════════════════════════════════════════════

  // Load discourse context for a session
  if (req.method === "GET" && req.url.startsWith("/api/discourse")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("session") || "default";
    const pathPart = url.pathname;

    (async () => {
      try {
        if (pathPart === "/api/discourse/stats") {
          const stats = await discourse.getStats(sessionId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(stats));
          return;
        }

        if (pathPart === "/api/discourse/context") {
          const sysPrompt = url.searchParams.get("system") || "You are a helpful assistant with access to a memory store.";
          const messages = await discourse.buildContext(sessionId, sysPrompt);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ messages, sessionId }));
          return;
        }

        // Default: load full session
        const session = await discourse.load(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          sessionId,
          messages: session.messages,
          attachments: [...session.attachments.entries()].map(([name, a]) => ({
            name, type: a.type, size: a.size, ingestedAt: a.ingestedAt,
          })),
          foldCount: session.foldCount,
          tokens: session.totalTokens,
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // Add a message to discourse (used by browser chat for persistence)
  if (req.method === "POST" && req.url === "/api/discourse/message") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", async () => {
      try {
        // `session` is the spelling every other surface uses — the ?session=
        // query param on the reads, args.session on the tools, data.session on
        // /api/chat. This endpoint alone read `sessionId`, so a client that
        // posted {session: "x"} silently wrote into "default": the message
        // landed in a conversation the caller never named, and the read side
        // reported the named session as empty. `sessionId` stays accepted so
        // existing callers keep working.
        const parsed = JSON.parse(body);
        const sessionId = parsed.session || parsed.sessionId || "default";
        const { role, content } = parsed;
        const result = await discourse.addMessage(sessionId, role, content);
        store.ingest(content, role, { session: sessionId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Clear a session
  if (req.method === "POST" && req.url === "/api/discourse/clear") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", async () => {
      try {
        // Same `session`/`sessionId` mismatch as /api/discourse/message, and
        // more costly here: a client asking to clear session "x" wiped
        // "default" instead — someone else's conversation, irreversibly.
        const parsed = JSON.parse(body);
        const sessionId = parsed.session || parsed.sessionId || "default";
        await discourse.clearSession(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cleared: true, session: sessionId }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Attachment endpoints
  if (req.method === "GET" && req.url.startsWith("/api/attachments")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("session") || "default";

    (async () => {
      if (url.pathname === "/api/attachments/content") {
        const name = url.searchParams.get("name");
        if (!name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'name' parameter" }));
          return;
        }
        const content = await discourse.getAttachmentContent(sessionId, name);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(content || "[Attachment not found]");
        return;
      }

      const session = await discourse.load(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        attachments: [...session.attachments.entries()].map(([name, a]) => ({
          name, type: a.type, size: a.size, ingestedAt: a.ingestedAt,
          excerpt: (a.text || "").slice(0, 200),
        })),
      }));
    })();
    return;
  }

  if (req.method === "POST" && req.url === "/api/ingest") {
    let body = "";
    let overBody = false;
    // The UI no longer pre-cuts uploads, and admission no longer caps, so this
    // route is the first and only thing to see a whole document — it must
    // bound what it buffers or a large enough upload takes the process down
    // and loses the document anyway. Refusing is reserved for exactly that,
    // and it refuses out loud: an oversized body used to be answered by
    // destroying the socket, which is L1d's "dies quietly" in its purest form.
    // Nothing between "fits in memory" and this ceiling is ever cut.
    req.on("data", (c) => {
      if (overBody) return;
      body += c;
      if (body.length > INGEST_MAX_BODY) {
        overBody = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: `Upload exceeds the ${INGEST_MAX_BODY}-byte request ceiling and was not ingested.`,
          maxBodyBytes: INGEST_MAX_BODY,
          ingested: false,
          note: "Nothing was admitted — this is a refusal, not a truncation. Split the document and ingest the parts.",
        }));
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (overBody) return;
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const { path: ingestPath, url: ingestUrl, content, name, session } = data;
      const sessionId = session || "default";
      const wantsStream = data.stream === true || (req.headers.accept || "").includes("text/event-stream");

      if (!wantsStream) {
        try {
          const result = await performIngest({ ingestPath, ingestUrl, content, name, sessionId });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(err.status || 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Streaming path (LAWS.md L1c/L1a) — same SSE transport handleToolStream
      // uses. The acknowledgement is written HERE, before performIngest does
      // anything: L1a requires the first signal on receipt of the trigger, not
      // on completion. What describes it (name/bytes) comes only from what the
      // caller sent, never from the ingest result, so it is honest to emit
      // before any engine work has run.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sendSSE = (event, payload) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      const label = name || ingestUrl || (ingestPath ? ingestPath.replace(/^.*[/\\]/, "") : null) || "upload";
      const startedAt = Date.now();
      sendSSE("started", {
        name: label,
        bytes: content != null ? Buffer.byteLength(content, "utf8") : null,
        path: ingestPath || null,
        url: ingestUrl || null,
      });

      // L1c: admission itself is one atomic call in the worker (see
      // ingest-worker.js) with no midpoint to report chunk-by-chunk progress
      // from — but it no longer blocks this thread either, so a heartbeat
      // tied to THIS request's outstanding promise is a real signal ("still
      // working, Nms so far"), not decoration: it stops the instant the
      // ingest settles, and never fires for one that already returned.
      const heartbeat = setInterval(() => {
        sendSSE("progress", { name: label, elapsedMs: Date.now() - startedAt });
      }, 300);

      try {
        const result = await performIngest({ ingestPath, ingestUrl, content, name, sessionId });
        clearInterval(heartbeat);
        sendSSE("done", result);
      } catch (err) {
        clearInterval(heartbeat);
        sendSSE("error", { message: err.message });
      }
      res.end();
    });
    return;
  }

  // Grounding with no generation step — retrieval + the same citation-
  // instruction prompt the tool-calling talker gets (buildGroundedSystemPrompt,
  // shared with the /api/conversations turn handler so the wording can never
  // drift between the two), minus any call to Ollama. Exists for a client
  // that runs its own model over this evidence instead of the server's — the
  // eochat UI's browser-local WebLLM path (webllm-client.js) is the first
  // caller: it has no tool loop of its own, so it asks for toolsAvailable:false.
  if (req.method === "POST" && req.url === "/api/ground") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const query = String(data.query || "").trim();
      if (!query) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "query is required" }));
        return;
      }
      try {
        let groundResult = engineGroundQuery(query, {
          budget: data.groundBudget ?? 2400,
          maxUnits: data.groundMaxUnits ?? 5,
          limit: data.groundLimit ?? 30,
          source: data.groundSource,
          pool: data.pool,
        });

        // Same deterministic trigger turn-controller.js's server path checks
        // (see runAnswer there) — this is what lets the browser-local WebLLM
        // path run the SAME deliberate long-form pipeline, since it has no
        // way to run instruction-gate.js itself (Node-only, reads
        // instruction-set/*.md from disk). Computed BEFORE the grounded/
        // ungrounded branch below and against the question regardless of
        // whether local retrieval found anything: an essay-shaped request
        // with zero local evidence is exactly the case web search exists to
        // rescue (see the client's thin/zero-evidence supplement), not a
        // reason to silently fall back to answering from pretrained memory.
        const gateInfo = groundInstructionGate.folds.length
          ? groundInstructionGate.gate({
              question: query,
              history: Array.isArray(data.history) ? data.history : [],
              evidence: groundResult.citations.map((c) => c.text),
            })
          : null;
        const deliberate = !!gateInfo?.activeIds?.some((id) => DELIBERATE_FOLD_IDS.has(id));

        if (!groundResult.context) {
          const warming = corpusWarmup.started && !corpusWarmup.ready;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            grounded: false,
            // Still reported true here — no local passages does not mean no
            // evidence is reachable; the client will attempt web search
            // before ever falling back to ungrounded generation. See
            // localAskConversation's thin/zero-evidence supplement.
            deliberate,
            warming,
            systemPrompt: buildUngroundedSystemPrompt({ warming }),
            // Same L2e treatment as the server-model path above — a client
            // running its own model must be able to tell an empty library from
            // a silent one just as well as the one using ours.
            gaps: (groundResult.gaps?.length ? groundResult.gaps : null)
              || (warming ? [] : describeAbsence({ query, poolName: groundResult.pool || data.pool || "corpus", sourceFilter: data.groundSource || null })),
            note: warming
              ? "Document index still loading — this answer is not grounded in your sources yet."
              : absenceNote(groundResult.pool ? groundResult : { pool: data.pool }, data.groundSource || null),
          }));
          return;
        }

        // Widen retrieval once, using write-longform.mjs's own already-tuned
        // values — the default width above leaves almost nothing for the
        // client's outline step to partition. Only for turns that actually
        // need it; ordinary questions keep the caller's original width.
        if (deliberate) {
          groundResult = engineGroundQuery(query, {
            budget: 4000, maxUnits: 12, limit: 24,
            source: data.groundSource, pool: data.pool,
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          grounded: true,
          deliberate,
          systemPrompt: buildGroundedSystemPrompt(groundResult, { toolsAvailable: false }),
          total: groundResult.total,
          folded: groundResult.folded,
          tokens: groundResult.tokens,
          budget: groundResult.budget,
          dropped: groundResult.dropped,
          citations: groundResult.citations.map((c, i) => ({
            index: i + 1,
            span_id: c.span_id,
            source_id: c.source_id,
            byte_start: c.byte_start,
            byte_end: c.byte_end,
            score: Math.round(c.score * 100) / 100,
            text: c.text,
          })),
          gaps: groundResult.gaps || [],
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Web-search counterpart of /api/ground — same purpose (retrieval + the
  // matching citation-instruction prompt, no generation step) but sourced
  // from a live web search instead of the local corpus. Exists for the same
  // caller /api/ground exists for: a client running its own model with no
  // tool loop of its own (the eochat UI's browser-local WebLLM path) still
  // needs the reader's "Web" toggle to actually reach the web, not just the
  // engine's own index — this is what makes that true.
  if (req.method === "POST" && req.url === "/api/web-ground") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const query = String(data.query || "").trim();
      if (!query) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "query is required" }));
        return;
      }
      try {
        const webResults = await webSearchAndFetch(query, {
          numResults: data.numResults ?? 5,
          maxFetchChars: data.maxFetchChars ?? 5000,
        });

        // Same deterministic trigger /api/ground computes above — the browser-
        // local WebLLM path decides whether a turn runs the deliberate long-form
        // pipeline from this flag, whichever retrieval source fed the evidence.
        const gateInfo = groundInstructionGate.folds.length
          ? groundInstructionGate.gate({
              question: query,
              history: Array.isArray(data.history) ? data.history : [],
              evidence: webResults.map((r) => r.text || r.snippet || ""),
            })
          : null;
        const deliberate = !!gateInfo?.activeIds?.some((id) => DELIBERATE_FOLD_IDS.has(id));

        const { message } = buildWebSystemMessage(webResults);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          grounded: webResults.length > 0,
          deliberate,
          systemPrompt: message.content,
          total: webResults.length,
          citations: webResults.map((r, i) => ({
            index: i + 1,
            source_id: r.url,
            title: r.title,
            url: r.url,
            text: r.text || r.snippet || "",
          })),
          gaps: webResults.length === 0
            ? [{ type: "no_web_results", reason: "No web search results matched this question." }]
            : [],
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Fold a conversation's older turns down to a small, budgeted recap, using
  // foldConversationTurns (engine-ground.js) — the same foldSpans mechanism
  // measured against a real ~3MB corpus for the document-grounding side, not
  // the heading-based instruction-gate fold: that one selects by relevance
  // SIGNAL matching over a rules document, this needs recency-scored,
  // cost-aware selection over plain turns (a long recent turn should lose to
  // several cheap older ones, which signal-matching has no notion of at all).
  //
  // Exists for the eochat UI's browser-local WebLLM path (localAskConversation):
  // that path has no server-held conversation to fold server-side (local-mode
  // turns are never persisted — "answers stay in this tab"), so the client
  // sends the turns it already has, once, per call, rather than this route
  // ever owning conversation state itself.
  //
  // The caller keeps a small window of recent turns verbatim on its own
  // side and only sends turns OLDER than that window here — this route
  // folds, it does not decide what counts as "recent".
  if (req.method === "POST" && req.url === "/api/conversations/fold-history") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const turns = Array.isArray(data.turns) ? data.turns : [];
      if (!turns.length) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ turns: [], dropped: 0 }));
        return;
      }
      try {
        const budgetTokens = Number.isFinite(data.budgetTokens) ? data.budgetTokens : 900;
        const foldResult = foldConversationTurns(turns, { budget: budgetTokens });
        // The turns themselves, q/a pairs, nothing said ABOUT them — the
        // caller places these as ordinary user/assistant messages, same as
        // the verbatim window. No prose recap, no mechanism explained: a
        // model reads real turns better than a description of turns.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          turns: foldResult.selected.map((u) => ({ q: u.q, a: u.a })),
          dropped: foldResult.dropped,
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Fold the newest turn to its discourse contribution and roll it into the
  // conversation summary. Used by the local/browser generation path (ui/index.html
  // localAskConversation) where turns are never persisted server-side, so the
  // summary must be computed here and handed back — the browser stores it in the
  // space. The proxy path (turn-controller.js) uses the same two functions
  // internally via persistTurnSummary. Cheap model, bounded context, best-effort.
  if (req.method === "POST" && req.url === "/api/conversations/summary") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const question = String(data.question || "");
      const answer = String(data.answer || "");
      if (!question && !answer) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing question/answer" }));
        return;
      }
      try {
        const makeCall = (opts = {}) => async (prompt) => {
          const body = {
            model: "llama3.2:latest",
            messages: [{ role: "user", content: prompt }],
            stream: false,
            options: { temperature: 0.4, num_predict: 150, num_ctx: NUM_CTX },
          };
          if (opts.format) body.format = opts.format;
          const resp = await safeFetch(`${TARGET}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }, 20000);
          if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
          const j = await resp.json();
          return (j.message?.content || "").trim();
        };
        const plainCall = makeCall();
        const jsonCall = makeCall({ format: "json" });
        const fold = await foldTurn({ question, answer, callLLM: plainCall });
        const nextSummary = await updateSummary({
          previousSummary: data.previousSummary || emptySummary(),
          turnFold: fold,
          callLLM: jsonCall,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ summary: nextSummary }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Engine session stats
  if (req.method === "GET" && req.url === "/api/grounded/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(engineStats()));
    return;
  }

  // List ingested sources. Entries carry `kind` ("corpus" | "prior-raw" |
  // "prior-card") and `pool`, so the UI can pill priors distinctly from texts
  // instead of presenting witness-tier artifacts as if they were source material.
  if (req.method === "GET" && req.url.startsWith("/api/sources")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const poolFilter = url.searchParams.get("pool");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(engineListSources(poolFilter ? { pool: poolFilter } : {})));
    return;
  }

  // Delete (soft-delete) a source — moves it to the recycle bin.
  // Sources can be restored or permanently purged through /api/recycle-bin endpoints.
  if (req.method === "DELETE" && req.url.startsWith("/api/sources")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sourceKey = url.searchParams.get("source");
    if (!sourceKey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'source' query parameter" }));
      return;
    }
    const result = engineDeleteSource(sourceKey, { pool: url.searchParams.get("pool") || undefined });
    const status = result.error ? 404 : 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // Admin summary endpoint
  if (req.method === "GET" && req.url === "/api/admin/summary") {
    (async () => {
      try {
        const submissionStats = await submissionStore.stats();
        let recycleList = [];
        try { recycleList = engineListRecycleBin(); } catch { /* empty */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          submissionStats,
          recycleBinCount: recycleList.length,
          uptime: process.uptime().toFixed(1),
          memoryUsage: process.memoryUsage().rss ? `${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB` : '—',
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // ── Admin submission review endpoints ──

  // Submit new content for admin review
  if (req.method === "POST" && req.url === "/api/admin/submissions") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const submission = await submissionStore.submit({
          originalText: params.text || "",
          mediaType: params.mediaType || "text",
          audioModel: params.audioModel || null,
          heardText: params.heardText || null,
          metadata: params.metadata || {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(submission));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // List pending submissions (review queue)
  if (req.method === "GET" && req.url === "/api/admin/submissions/pending") {
    (async () => {
      try {
        const pending = await submissionStore.listPending();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pending));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // List resolved submissions
  if (req.method === "GET" && req.url === "/api/admin/submissions/resolved") {
    (async () => {
      try {
        const resolved = await submissionStore.listResolved();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resolved));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // Submission stats
  if (req.method === "GET" && req.url === "/api/admin/submissions/stats") {
    (async () => {
      try {
        const stats = await submissionStore.stats();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // Get full submission by id
  if (req.method === "GET" && req.url.startsWith("/api/admin/submissions/") && !req.url.includes("/pending") && !req.url.includes("/resolved") && !req.url.includes("/stats") && !req.url.includes("/edit") && !req.url.includes("/approve") && !req.url.includes("/reject") && !req.url.includes("/reopen") && !req.url.includes("/archive")) {
    const id = req.url.split("/api/admin/submissions/")[1].split("?")[0];
    (async () => {
      try {
        const rec = await submissionStore.get(decodeURIComponent(id));
        if (!rec) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rec));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // Edit a submission (admin correction)
  if (req.method === "POST" && req.url === "/api/admin/submissions/edit") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const updated = await submissionStore.edit(params.id, {
          editedText: params.text || "",
          editor: params.editor || "admin",
          reason: params.reason || "",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(updated));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Approve a submission
  if (req.method === "POST" && req.url === "/api/admin/submissions/approve") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const approved = await submissionStore.approve(params.id, {
          templateSpec: params.templateSpec || null,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(approved));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Reject a submission
  if (req.method === "POST" && req.url === "/api/admin/submissions/reject") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const rejected = await submissionStore.reject(params.id, {
          reason: params.reason || "",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rejected));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Reopen a submission
  if (req.method === "POST" && req.url === "/api/admin/submissions/reopen") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const reopened = await submissionStore.reopen(params.id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reopened));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Archive a submission
  if (req.method === "POST" && req.url === "/api/admin/submissions/archive") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const archived = await submissionStore.archive(params.id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(archived));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Recycle bin endpoints ──

  // List deleted sources
  if (req.method === "GET" && req.url === "/api/recycle-bin") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(engineListRecycleBin()));
    return;
  }

  // Recycle bin stats
  if (req.method === "GET" && req.url === "/api/recycle-bin/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(engineRecycleBinStats()));
    return;
  }

  // Restore a source from the recycle bin
  if (req.method === "POST" && req.url === "/api/recycle-bin/restore") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const sourceKey = parsed.source;
      if (!sourceKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'source' field" }));
        return;
      }
      const result = engineRestoreSource(sourceKey, { pool: parsed.pool || undefined });
      const status = result.error ? 404 : 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Permanently delete one source or empty the entire recycle bin
  if (req.method === "DELETE" && req.url === "/api/recycle-bin") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sourceKey = url.searchParams.get("source");
    if (sourceKey) {
      const result = enginePurgeSource(sourceKey);
      const status = result.error ? 404 : 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else {
      const result = enginePurgeRecycleBin();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
    return;
  }

  // The append-only provenance ledger for everything a web search pulled in.
  // Independent of any chat turn, so the reader can audit what the engine was
  // fed long after the turn that fed it.
  if (req.method === "GET" && req.url.startsWith("/api/web-history")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: webHistory.length, entries: webHistory }));
    return;
  }

  // The reading fold for one ingested source: its cast (referents typed
  // holon/emanon/protogon/field/apparatus), its divisions, and how much of the
  // file was folded at all. This is what eochat's buildEntityMatcher — a regex
  // over capitalized words, top-20 by frequency — is meant to be replaced by.
  //
  // Anything the engine cannot supply arrives as a typed gap in `gaps`, and a
  // referent no per-text prior has individuated arrives in `withheld` with
  // `aliasesResolved: false` rather than in `referents` under a guessed label.
  // A client that renders `referents` therefore cannot show a fabricated cast;
  // one that wants the withheld candidates must ask for them by name.
  if (req.method === "GET" && req.url.startsWith("/api/fold")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const source = url.searchParams.get("source");
    if (!source) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'source' parameter" }));
      return;
    }
    try {
      // `z` tunes how readily the novelty curve calls a boundary. It is handed
      // straight to detectBoundaries rather than post-filtered here, so a finer
      // read is the engine's reading at another sensitivity — not this endpoint
      // second-guessing the one it got.
      const z = url.searchParams.has("z") ? Number(url.searchParams.get("z")) : undefined;
      const result = engineFoldSource(source, {
        pool: url.searchParams.get("pool") || undefined,
        limit: parseInt(url.searchParams.get("limit") || "40", 10),
        anchors: parseInt(url.searchParams.get("anchors") || "3", 10),
        zThreshold: Number.isFinite(z) ? z : undefined,
      });
      // An unresolvable source is a 404, not a 200 carrying an error body — a
      // client polling this must be able to tell "no such source" from "a fold
      // with nothing in it", and those mean very different things here.
      res.writeHead(result.error ? 404 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Read a byte range of an ingested source. The reader's body text for corpus
  // sources: /api/attachments/content only knows session uploads, and the books
  // ingested at startup are not uploads. Byte ranges are the same coordinates
  // /api/fold's divisions carry, so paging by division needs no translation.
  if (req.method === "GET" && req.url.startsWith("/api/source/text")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const source = url.searchParams.get("source");
    if (!source) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'source' parameter" }));
      return;
    }
    try {
      const num = (name) => {
        const raw = url.searchParams.get(name);
        if (raw == null || raw === "") return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      };
      const result = engineReadSourceBytes(source, {
        pool: url.searchParams.get("pool") || undefined,
        start: num("start") ?? 0,
        end: num("end"),
        maxBytes: num("max") ?? undefined,
      });
      // Same 404-vs-200 split as /api/fold: "no such source" and "a source with
      // nothing at that offset" are different answers and the client acts on
      // them differently.
      res.writeHead(result.error ? 404 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // Priors — live_priors as a browsable, searchable source.
  // Separate pool: these are never returned by corpus grounding.
  // ══════════════════════════════════════════════════════════════
  if (req.method === "GET" && req.url.startsWith("/api/priors")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const priors = priorsSource;

      if (url.pathname === "/api/priors/read") {
        const id = url.searchParams.get("id");
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'id' parameter" }));
          return;
        }
        const result = priors.readPrior(id, {
          layer: url.searchParams.get("layer") === "raw" ? "raw" : "card",
          byteStart: parseInt(url.searchParams.get("start") || "0", 10),
          maxBytes: parseInt(url.searchParams.get("max") || "40000", 10),
          chrome: url.searchParams.get("chrome") === "true",
        });
        res.writeHead(result.error ? 404 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/priors/search") {
        const q = url.searchParams.get("q");
        if (!q) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'q' parameter" }));
          return;
        }
        const result = priors.searchPriors(q, parseInt(url.searchParams.get("limit") || "8", 10), {
          maxChars: parseInt(url.searchParams.get("max_chars") || "900", 10),
          prior: url.searchParams.get("prior") || undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // Catalog. Entries carry metadata only (size, family, scope, key names);
      // the parsed artifacts are never retained, so this stays small.
      const state = priors.ensurePriorsIngested();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        pool: state.pool,
        count: state.priors,
        gaps: state.gaps,
        priors: priors.priorsCatalog(),
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Switch one or more priors on/off — the Priors tab's per-item and
  // per-bucket toggles. Accepts either { id, enabled } or { ids: [...], enabled }
  // so a bucket toggle is one request instead of N. Never 500s for a partial
  // failure: each id gets its own result so the caller can tell which of a
  // batch actually changed.
  if (req.method === "POST" && req.url === "/api/priors/toggle") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const ids = Array.isArray(parsed.ids) ? parsed.ids : (parsed.id ? [parsed.id] : []);
      if (!ids.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id' or 'ids'" }));
        return;
      }
      const enabled = !!parsed.enabled;
      try {
        const results = ids.map((id) => priorsSource.setPriorEnabled(id, enabled));
        const allErrored = results.length > 0 && results.every((r) => r.error);
        res.writeHead(allErrored ? 404 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled, results }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // Senses — the vision-model library the Senses tab subscribes and
  // activates from. This route only serves the catalog and the reader's
  // subscribe/active/endpoint choices; it never calls a model. Invoking a
  // connected sense happens client-side, straight from the browser to the
  // endpoint the reader configured (same trust model as the proxy URL
  // itself) — the same shape as the existing PDF-OCR-via-Tesseract path,
  // just pointed at a URL instead of a bundled library.
  // ══════════════════════════════════════════════════════════════
  if (req.method === "GET" && req.url === "/api/senses") {
    const endpoints = sensesState.senseEndpoints();
    const subscribed = sensesState.subscribedSenseIds();
    const active = sensesState.activeSenseIds();
    // Curated catalog first, then whatever's been promoted from Hub
    // discovery — same shape, same id space, so a reader can't tell which
    // list an entry came from once it's in their library.
    const all = [...sensesCatalog(), ...sensesState.customSensesList()];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      categories: SENSE_CATEGORIES,
      senses: all.map((s) => ({
        ...s,
        subscribed: subscribed.has(s.id),
        active: active.has(s.id),
        endpoint: endpoints[s.id] || "",
        connected: !s.needsEndpoint || !!endpoints[s.id],
      })),
    }));
    return;
  }

  // Discover more senses from the Hugging Face Hub — see senses-hf.js for
  // why this can't just be one clean tag query. Refreshes at most weekly
  // (senses-hf.js's own cache) unless ?refresh=1 forces it. A Hub outage or
  // an offline dev box surfaces as `errors`, never as a silent empty list —
  // the caller can tell "checked, found nothing new" from "couldn't check".
  if (req.method === "GET" && req.url.startsWith("/api/senses/discover")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    (async () => {
      try {
        const force = url.searchParams.get("refresh") === "1";
        const result = await refreshHfCatalog({ force });
        const subscribed = sensesState.subscribedSenseIds();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ...result,
          discovered: result.discovered.map((d) => ({ ...d, alreadyInLibrary: subscribed.has(d.id) || !!sensesState.customSense(d.id) })),
        }));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, status: discoverCacheStatus() }));
      }
    })();
    return;
  }

  // Promotes one discovered Hub entry into the library and subscribes it in
  // the same call — discovery's "add" IS the subscribe step; a reader who
  // clicked "add to library" on a search result did not mean "show it to me
  // twice more before it counts."
  if (req.method === "POST" && req.url === "/api/senses/discover/add") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      if (!parsed.id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id'" }));
        return;
      }
      try {
        const { discovered } = await refreshHfCatalog({});
        const entry = discovered.find((d) => d.id === parsed.id);
        if (!entry) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `"${parsed.id}" is not in the last-discovered list — refresh discovery first` }));
          return;
        }
        sensesState.addCustomSense(entry);
        const subscribeResult = sensesState.setSenseSubscribed(entry.id, true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ added: entry, subscribed: subscribeResult }));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Subscribe/unsubscribe one or more senses at once — the Senses tab's
  // per-item and category-bucket switches. Unsubscribing also deactivates
  // (senses-state.js) so a sense can never be active without being visibly
  // in the library.
  if (req.method === "POST" && req.url === "/api/senses/subscribe") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const ids = Array.isArray(parsed.ids) ? parsed.ids : (parsed.id ? [parsed.id] : []);
      if (!ids.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id' or 'ids'" }));
        return;
      }
      const subscribed = !!parsed.subscribed;
      const results = ids.map((id) => sensesState.setSenseSubscribed(id, subscribed));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ subscribed, results }));
    });
    return;
  }

  // Select which subscribed senses run on ingestion — multiple at once, one
  // request per bucket click same as /api/priors/toggle. Activating a sense
  // that isn't subscribed is reported as a per-id error, not silently
  // dropped or auto-subscribed.
  if (req.method === "POST" && req.url === "/api/senses/activate") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const ids = Array.isArray(parsed.ids) ? parsed.ids : (parsed.id ? [parsed.id] : []);
      if (!ids.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id' or 'ids'" }));
        return;
      }
      const active = !!parsed.active;
      const results = ids.map((id) => sensesState.setSenseActive(id, active));
      const allErrored = results.length > 0 && results.every((r) => r.error);
      res.writeHead(allErrored ? 409 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active, results }));
    });
    return;
  }

  // Set or clear a sense's endpoint — where the browser sends work for it.
  // An empty/whitespace url clears it, which demotes the sense back to
  // "library entry with nowhere to send work" without needing a separate
  // delete route.
  if (req.method === "POST" && req.url === "/api/senses/endpoint") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      if (!parsed.id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id'" }));
        return;
      }
      const result = sensesState.setSenseEndpoint(parsed.id, parsed.url || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Structural outline of a document, for the reader's section navigation.
  //
  // POST rather than GET, and it takes the text itself, because the reader's
  // content arrives from three different places — session attachments, prior
  // artifacts, client-side blobs from an upload the engine never saw — and an
  // outline that only worked for one of them would quietly leave the other two
  // rendering as a single unnavigable blob. The caller already holds the exact
  // string it is about to slice, so sending it back is what makes the returned
  // offsets provably in the same coordinate system as the reader's own text.
  //
  // `{ name, session }` is the fallback when the caller has a name but no text.
  if (req.method === "POST" && req.url === "/api/verbatim/outline") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const { text, name, session, source: sourceRef, pool } = JSON.parse(body || "{}");
        // An ingested corpus source resolves through the engine and comes back
        // byte-addressed, which is what the reader pages with. Attachments and
        // raw text keep the code-unit-only path — they have no file behind them.
        if (sourceRef) {
          const result = engineOutlineOfSource(sourceRef, { pool: pool || undefined });
          res.writeHead(result.error ? 404 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }
        let content = typeof text === "string" ? text : null;
        if (content == null && name) {
          content = await discourse.getAttachmentContent(session || "default", name);
        }
        if (content == null) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provide 'source' (ingested), 'text', or a 'name' that resolves to an attachment" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(outlineOfText(content)));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // Verbatim endpoints — direct engine search, NO model call.
  // Returns exact byte-offset anchored spans from ingested text.
  // ══════════════════════════════════════════════════════════════

  // Search the engine for verbatim spans matching a query.
  if (req.method === "GET" && req.url.startsWith("/api/verbatim")) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Read a specific span by ID
    if (url.pathname === "/api/verbatim/read") {
      // UX-DESIGN.md documents this as `span_id`; the implementation only ever
      // read `id`, so every caller written against the doc got a 400. Accept
      // both — the documented name is not the wrong name.
      const spanId = url.searchParams.get("id") || url.searchParams.get("span_id");
      const maxBytes = parseInt(url.searchParams.get("max") || "4000", 10);
      if (!spanId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id' (or 'span_id') parameter" }));
        return;
      }
      try {
        const result = engineReadSpan(spanId, maxBytes);
        sendVerbatim(res, result);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Read a segment by query — omnimodal, discovers dynamic boundaries
    if (url.pathname === "/api/verbatim/segment") {
      const q = url.searchParams.get("q");
      const maxBytes = parseInt(url.searchParams.get("max") || "50000", 10);
      const source = url.searchParams.get("source") || null;
      if (!q) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'q' parameter" }));
        return;
      }
      try {
        const result = engineReadSegment(q, maxBytes, source);
        sendVerbatim(res, result);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Read context around a span: expand before/after
    if (url.pathname === "/api/verbatim/context") {
      // Same documented-vs-implemented split that /api/verbatim/read carried:
      // UX-DESIGN.md publishes `span_id`, this route only ever read `id`, so
      // following a citation to its surrounding text — the second hop of the
      // audit round trip — returned 400 for every caller written against the
      // documentation. Accept both names here too. Found by check-laws.mjs as
      // an L2b violation: an audit path that breaks at a hop is not a path.
      const id = url.searchParams.get("id") || url.searchParams.get("span_id");
      const before = parseInt(url.searchParams.get("before") || "0", 10);
      const after = parseInt(url.searchParams.get("after") || "0", 10);
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id' (or 'span_id') parameter" }));
        return;
      }
      try {
        const result = engineReadContext(id, { beforeBytes: before, afterBytes: after });
        sendVerbatim(res, result);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Search verbatim spans
    let query = url.searchParams.get("q");
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);
    const maxChars = parseInt(url.searchParams.get("max_chars") || "800", 10);
    let source = url.searchParams.get("source") || null;
    if (!query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'q' parameter" }));
      return;
    }
    // `source=priors` selects the priors POOL rather than filtering the corpus
    // pool by filename — asking for priors is a different question, not a
    // narrower one. `source=priors:lens-fold` narrows within that pool.
    let searchPool = undefined;
    if (source === "priors" || source?.startsWith("priors:")) {
      priorsSource.ensurePriorsIngested();
      searchPool = priorsSource.PRIORS_POOL;
      source = source.startsWith("priors:") ? source.slice("priors:".length) : null;
    }
    try {
      // Try the query as-is first (the engine's dense retrieval may find
      // semantically related passages even with diacritic differences)
      let result = engineSearch(query, Math.min(limit, 40), { maxChars, source, pool: searchPool });
      let searchedQuery = query;

      // If the query returned gaps (no_evidence_matched) and the query has
      // diacritics or the query might differ from stored text's diacritics,
      // retry with a broadened query: strip diacritics so "Natasha" matches
      // "Natásha", then re-search. This is the only model-free fix for the
      // Natásha↔Natasha problem — the engine's dense embedder treats them
      // as different tokens.
      if (result.passages.length === 0) {
        const stripped = query.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        if (stripped !== query) {
          result = engineSearch(stripped, Math.min(limit, 40), { maxChars, source, pool: searchPool });
          searchedQuery = stripped;
          if (result.passages.length > 0) {
            result.diacritic_fallback = true;
            result.diacritic_query = stripped;
          }
        }
      }

      // L2e — if the engine did not supply its own typed gap and the search
      // came back empty, name the absence here rather than passing `null` up.
      // The engine's gap wins when it has one: it knows more about why its own
      // retrieval was silent than this layer does.
      const engineGaps = Array.isArray(result.gaps) ? result.gaps : result.gaps ? [result.gaps] : [];
      const gaps = result.passages.length === 0 && engineGaps.length === 0
        ? describeAbsence({ query, poolName: result.pool, sourceFilter: source, searchedQuery })
        : engineGaps;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        query,
        pool: result.pool,
        total: result.total,
        passages: result.passages,
        gaps,
        verbatim: true,
        note: "These are exact verbatim spans from the engine — byte-accurate, no model involved.",
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Connect an MCP server
  if (req.method === "POST" && req.url === "/mcp/connect") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", async () => {
      try {
        const { name, command, args } = JSON.parse(body);
        const tools = await connectMcpServer(name, command, args || []);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: true, name, tools }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // Projects — named collections with their own knowledge base (pool) and
  // associated conversations. Each project maps to a distinct engine pool
  // so retrieval is scoped to that project's sources only.
  // ══════════════════════════════════════════════════════════════
  if (req.url === "/api/projects" || req.url.startsWith("/api/projects/")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const segments = url.pathname.split("/").filter(Boolean);

    const readJsonBody = () => new Promise((resolve, reject) => {
      let body = "", size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(new Error("Request body too large")); reject(new Error("body too large")); return; }
        body += c.toString("utf8");
      });
      req.on("end", () => {
        if (!body.trim()) return resolve({});
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
      req.on("error", reject);
    });
    const sendJson = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    (async () => {
      try {
        // GET /api/projects — list all projects
        if (req.method === "GET" && segments.length === 2) {
          const projects = await projectStore.list();
          // A conversation belongs to a project by the spaceId stamped at
          // creation (see the conversations POST route); project.conversationIds
          // is only ever populated by addConversation, which nothing calls, so
          // counting it alone would report every project as empty. Count the
          // real members so the projects view and sidebar match what a reader
          // would find under each project's Chats list.
          const allConvs = await conversationStore.list();
          for (const p of projects) {
            p.conversationCount = allConvs.filter(c => (c.spaceId === p.id) || (c.pool === p.pool)).length;
          }
          return sendJson(200, { projects });
        }

        // POST /api/projects — create a new project
        if (req.method === "POST" && segments.length === 2) {
          const data = await readJsonBody();
          const project = await projectStore.create({
            name: data.name,
            description: data.description,
          });
          return sendJson(201, project);
        }

        // GET /api/projects/:id — get project details
        if (req.method === "GET" && segments.length === 3) {
          const project = await projectStore.get(segments[2]);
          if (!project) return sendJson(404, { error: `project not found: ${segments[2]}` });
          return sendJson(200, project);
        }

        // PATCH /api/projects/:id — update project metadata
        if (req.method === "PATCH" && segments.length === 3) {
          const data = await readJsonBody();
          const project = await projectStore.update(segments[2], data);
          return sendJson(200, project);
        }

        // DELETE /api/projects/:id — delete a project
        if (req.method === "DELETE" && segments.length === 3) {
          const result = await projectStore.remove(segments[2]);
          return sendJson(200, result);
        }

        // ── Project instructions ──
        //
        // The rules the model must obey inside this project. Any length: they
        // are stored verbatim and compiled to folds that the instruction gate
        // surfs and folds per turn, so a long manual costs a bounded block
        // rather than the whole window (INSTRUCTION-LAW R5).

        // GET /api/projects/:id/instructions — the text, plus how it will be
        // gated. The compile report ships with the text on purpose: a reader
        // who cannot see that their manual was folded into 40 pieces, or that
        // one section can never surface, cannot act on it.
        if (req.method === "GET" && segments.length === 4 && segments[3] === "instructions") {
          const record = await projectStore.getInstructions(segments[2]);
          const budgetTokens = projectBudget(segments[2]);
          const { folds, report } = compileInstructionFolds(record.text, { idPrefix: "proj", budgetTokens });
          return sendJson(200, {
            ...record,
            report,
            folds: folds.map((f) => ({
              id: f.id, title: f.title, always: f.always,
              signals: f.signals, fingerprint: f.fingerprint,
              tokens: gateCountTokens(f.body),
            })),
          });
        }

        // PUT /api/projects/:id/instructions — replace them. Returns the same
        // shape as GET so the caller sees the consequence of what it wrote
        // without a second round trip.
        if (req.method === "PUT" && segments.length === 4 && segments[3] === "instructions") {
          const data = await readJsonBody();
          if (typeof data.text !== "string") {
            return sendJson(400, { error: "'text' (string) is required" });
          }
          if (data.instructionBudget !== undefined) {
            await projectStore.update(segments[2], { instructionBudget: data.instructionBudget });
          }
          const record = await projectStore.setInstructions(segments[2], data.text);
          projectFoldCache.delete(segments[2]);
          const budgetTokens = projectBudget(segments[2]);
          const { folds, report } = compileInstructionFolds(record.text, { idPrefix: "proj", budgetTokens });
          return sendJson(200, {
            ...record,
            report,
            folds: folds.map((f) => ({
              id: f.id, title: f.title, always: f.always,
              signals: f.signals, fingerprint: f.fingerprint,
              tokens: gateCountTokens(f.body),
            })),
          });
        }

        // POST /api/projects/:id/instructions/preview — given a question, show
        // exactly which rules WOULD be in force and which would be folded away.
        //
        // LAWS.md L2b: the path to evidence begins at the thing in question.
        // "Why did it not follow my rule?" is asked about a specific question,
        // so it must be answerable by asking about that specific question —
        // not by reading the gate's source or guessing at its keywords.
        if (req.method === "POST" && segments.length === 5 && segments[3] === "instructions" && segments[4] === "preview") {
          const data = await readJsonBody();
          const record = await projectStore.getInstructions(segments[2]);
          const budgetTokens = projectBudget(segments[2]);
          const { folds, report } = compileInstructionFolds(record.text, { idPrefix: "proj", budgetTokens });
          if (!folds.length) {
            return sendJson(200, {
              question: data.question || "", report, active: [], folded: [],
              gap: true,
              note: "This project has no instructions, so nothing is in force. That is an empty manual, not a silent one.",
            });
          }
          const gate = createInstructionGate({ folds, budgetTokens, label: "PROJECT INSTRUCTION GATE" });
          const r = gate.gate({ question: String(data.question || ""), history: data.history || [], debug: true });
          // A rule that matched but did not fit is the failure most easily
          // mistaken for the gate working. It is called out by name here, with
          // the remedy, rather than left as a count in a stats object.
          const crowdedOut = (r.stats.crowdedOutIds || []).map((id) => {
            const f = folds.find((x) => x.id === id);
            return { id, title: f?.title || id, tokens: f ? gateCountTokens(f.body) : null };
          });
          return sendJson(200, {
            question: data.question || "",
            report,
            active: r.surfaced.map((f) => ({ id: f.id, title: f.title, always: f.always, tokens: gateCountTokens(f.body) })),
            folded: r.folded.map((f) => ({ id: f.id, title: f.title, fingerprint: f.fingerprint })),
            crowdedOut,
            ...(crowdedOut.length ? {
              warning: `${crowdedOut.length} instruction(s) matched this question but did not fit the ${budgetTokens}-token budget, so the model would not see them. This is not "no rule applies" — raise the project's instructionBudget or split these sections with more headings.`,
            } : {}),
            scores: r.scores,
            stats: r.stats,
            systemMessage: r.systemMessage,
          });
        }

        // ── Project knowledge sources ──

        // GET /api/projects/:id/sources — list sources in the project's pool
        if (req.method === "GET" && segments.length === 4 && segments[3] === "sources") {
          const project = await projectStore.get(segments[2]);
          if (!project) return sendJson(404, { error: `project not found: ${segments[2]}` });
          const sources = engineListSources({ pool: project.pool });
          return sendJson(200, { sources, pool: project.pool });
        }

        // POST /api/projects/:id/ingest — ingest a source into the project's pool
        if (req.method === "POST" && segments.length === 4 && segments[3] === "ingest") {
          const project = await projectStore.get(segments[2]);
          if (!project) return sendJson(404, { error: `project not found: ${segments[2]}` });
          const data = await readJsonBody();
          const { path: ingestPath, url: ingestUrl, content, name } = data;

          if (content) {
            const sourceId = `source:${name || "upload"}:${Date.now()}`;
            const result = await engineIngestText(content, sourceId, name || "upload", { pool: project.pool });
            await projectStore.addSource(segments[2], sourceId);
            return sendJson(200, admitWhole({ ...result, sourceId, pool: project.pool }));
          }

          if (ingestUrl) {
            const fetched = await fetchAndSaveUrl(ingestUrl);
            if (!fetched.text) {
              return sendJson(502, { error: `Fetch failed for ${ingestUrl} — ${fetched.error || "no text"}` });
            }
            let label;
            try {
              const u = new URL(ingestUrl);
              label = (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/+$/, "").replace(/\//g, "_");
            } catch { label = ingestUrl.replace(/\//g, "_"); }
            const srcName = name || label || ingestUrl;
            const sourceId = `source:${srcName}`;
            const result = await engineIngestText(fetched.text, sourceId, srcName, { pool: project.pool });
            await projectStore.addSource(segments[2], sourceId);
            return sendJson(200, admitWhole({ ...result, sourceId, name: srcName, url: ingestUrl, pool: project.pool }));
          }

          if (ingestPath) {
            try {
              const result = await engineIngestFile(ingestPath, { pool: project.pool });
              const sourceId = `source:${path.basename(ingestPath)}`;
              await projectStore.addSource(segments[2], sourceId);
              return sendJson(200, { ...result, pool: project.pool });
            } catch (err) {
              if (err.message?.includes("duplicate")) {
                const existing = engineListSources({ pool: project.pool }).find(s => s.path === ingestPath);
                return sendJson(200, { path: ingestPath, alreadyIngested: true, pool: project.pool });
              }
              throw err;
            }
          }

          return sendJson(400, { error: "Missing 'content', 'url', or 'path' field" });
        }

        // DELETE /api/projects/:id/sources — remove a source from the project
        if (req.method === "DELETE" && segments.length === 5 && segments[3] === "sources") {
          const project = await projectStore.get(segments[2]);
          if (!project) return sendJson(404, { error: `project not found: ${segments[2]}` });
          const sourceId = decodeURIComponent(segments[4]);
          const result = engineDeleteSource(sourceId, { pool: project.pool });
          await projectStore.removeSource(segments[2], sourceId);
          return sendJson(200, result || { deleted: true, sourceId });
        }

        // ── Project conversations ──

        // GET /api/projects/:id/conversations — list conversations in a project
        if (req.method === "GET" && segments.length === 4 && segments[3] === "conversations") {
          const project = await projectStore.get(segments[2]);
          if (!project) return sendJson(404, { error: `project not found: ${segments[2]}` });
          const allConvs = await conversationStore.list();
          const projectConvs = allConvs.filter(c => (c.spaceId === project.id) || (project.conversationIds || []).includes(c.id));
          projectConvs.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
          return sendJson(200, { conversations: projectConvs });
        }

        // ── Project cabinet (durable memory) ──

        // GET /api/projects/:id/cabinet — the project's file cabinet: durable
        // notes that were confirmed across its conversations, with usage stats
        // and the terms each memo is retrieved by. The audit counterpart to
        // /api/conversations/:id/memory: the desk shows what this conversation
        // knows; the cabinet shows what the whole project remembers.
        if (req.method === "GET" && segments.length === 4 && segments[3] === "cabinet") {
          const project = await projectStore.get(segments[2]);
          if (!project) return sendJson(404, { error: `project not found: ${segments[2]}` });
          const cabinet = await cabinetStore.get(project.pool);
          return sendJson(200, {
            pool: project.pool,
            stats: cabinetStats(cabinet),
            memos: (cabinet?.memos || []).map((m) => ({
              id: m.id, keys: m.keys, text: m.text, confirmed: m.confirmed,
              weight: m.weight, accessCount: m.accessCount,
              lastTurn: m.lastTurn, lastAccessed: m.lastAccessed,
              conversationId: m.conversationId,
              createdAt: m.createdAt, updatedAt: m.updatedAt,
            })),
          });
        }

        // ── Project community insights ──
        //
        // A merged, standardized-key ledger that sits beside this project's
        // document corpus rather than inside it: ingest a plan's goals, its
        // current-state reporting, its intervention metrics and its
        // definitions, and read back a standardized key table with goal vs.
        // current deltas, keys still awaiting a human merge decision, and
        // any conflicting signals for the same key. See insight-store.js for
        // the merge/conflict/delta rules this surface exposes.
        if (segments.length >= 4 && segments[3] === "insights") {
          const project = await projectStore.get(segments[2]);
          if (!project) return sendJson(404, { error: `project not found: ${segments[2]}` });
          const sub = segments[4];

          // GET /api/projects/:id/insights/keys — the canonical key table
          if (req.method === "GET" && segments.length === 5 && sub === "keys") {
            return sendJson(200, { keys: await insightStore.listKeys(project.id) });
          }

          // POST /api/projects/:id/insights/keys — define a canonical key by hand
          if (req.method === "POST" && segments.length === 5 && sub === "keys") {
            const data = await readJsonBody();
            if (!data.label) return sendJson(400, { error: "'label' is required" });
            const entry = await insightStore.createKey(project.id, {
              key: data.key, label: data.label, category: data.category ?? null,
              unit: data.unit ?? null, directionality: data.directionality || "unknown",
            });
            return sendJson(201, entry);
          }

          // PATCH /api/projects/:id/insights/keys/:key — edit a canonical
          // key's label/category/unit/directionality (never its aliases or
          // observations — see updateKey()).
          if (req.method === "PATCH" && segments.length === 6 && sub === "keys") {
            const data = await readJsonBody();
            const entry = await insightStore.updateKey(project.id, decodeURIComponent(segments[5]), {
              label: data.label, category: data.category, unit: data.unit, directionality: data.directionality,
            });
            return sendJson(200, entry);
          }

          // POST /api/projects/:id/insights/ingest — extract standardized facts
          // from already-decoded document text (the same text the UI's
          // file-formats.js extraction or a project source upload produces).
          // Never re-parses raw file bytes itself — see insight-store.js.
          if (req.method === "POST" && segments.length === 5 && sub === "ingest") {
            const data = await readJsonBody();
            const text = data.content ?? data.text;
            if (!text) return sendJson(400, { error: "'content' (document text) is required" });
            const result = await insightStore.ingestDocument(project.id, {
              text,
              kind: data.kind || null,
              asOf: data.asOf || null,
              sourceId: data.sourceId || (data.name ? `source:${data.name}` : null),
              sourceName: data.name || null,
            });
            return sendJson(200, result);
          }

          // GET /api/projects/:id/insights/observations?key=&kind=&keyStatus=
          if (req.method === "GET" && segments.length === 5 && sub === "observations") {
            const observations = await insightStore.listObservations(project.id, {
              key: url.searchParams.get("key") || undefined,
              kind: url.searchParams.get("kind") || undefined,
              keyStatus: url.searchParams.get("keyStatus") || undefined,
            });
            return sendJson(200, { observations });
          }

          // POST /api/projects/:id/insights/observations — manual fact entry;
          // the correction path for whatever automatic extraction misses or
          // gets wrong.
          if (req.method === "POST" && segments.length === 5 && sub === "observations") {
            const data = await readJsonBody();
            if (!data.kind || data.value === undefined) return sendJson(400, { error: "'kind' and 'value' are required" });
            if (!data.key && !data.rawKey) return sendJson(400, { error: "'key' or 'rawKey' is required" });
            const observation = await insightStore.addObservation(project.id, {
              key: data.key || null, rawKey: data.rawKey || data.key, kind: data.kind, value: data.value,
              asOf: data.asOf || null, sourceId: data.sourceId || null, sourceName: data.sourceName || null,
              quote: data.quote || null,
            });
            return sendJson(201, observation);
          }

          // DELETE /api/projects/:id/insights/observations/:obsId
          if (req.method === "DELETE" && segments.length === 6 && sub === "observations") {
            const result = await insightStore.removeObservation(project.id, decodeURIComponent(segments[5]));
            return sendJson(200, result);
          }

          // GET /api/projects/:id/insights/unclear — raw keys awaiting a human
          // merge decision, grouped so one resolve-key call clears every
          // observation that used that exact wording.
          if (req.method === "GET" && segments.length === 5 && sub === "unclear") {
            return sendJson(200, { unclear: await insightStore.unclearKeys(project.id) });
          }

          // POST /api/projects/:id/insights/resolve-key — merge a raw key into
          // an existing canonical key, or mint a new one from it.
          if (req.method === "POST" && segments.length === 5 && sub === "resolve-key") {
            const data = await readJsonBody();
            const rawKeys = Array.isArray(data.rawKeys) && data.rawKeys.length ? data.rawKeys : null;
            if (!rawKeys && !data.rawKey) return sendJson(400, { error: "'rawKey' or 'rawKeys' is required" });
            if (!data.canonicalKey && !data.createLabel) {
              return sendJson(400, { error: "'canonicalKey' (map to an existing key) or 'createLabel' (mint a new one) is required" });
            }
            const result = await insightStore.resolveKey(project.id, {
              rawKey: data.rawKey || null, rawKeys, canonicalKey: data.canonicalKey || null, createLabel: data.createLabel || null,
              category: data.category ?? null, unit: data.unit ?? null, directionality: data.directionality || "unknown",
            });
            return sendJson(200, result);
          }

          // GET /api/projects/:id/insights/state — merged goal/current/delta
          // per standardized key: the "are we where the plan said we'd be" view.
          if (req.method === "GET" && segments.length === 5 && sub === "state") {
            return sendJson(200, { rows: await insightStore.state(project.id) });
          }

          // GET /api/projects/:id/insights/delta-report — state(), filtered to
          // keys that actually have a goal and/or a current value to compare.
          if (req.method === "GET" && segments.length === 5 && sub === "delta-report") {
            return sendJson(200, { rows: await insightStore.deltaReport(project.id) });
          }

          // GET /api/projects/:id/insights/conflicts — disagreeing signals for
          // the same resolved key/kind/point-in-time, each with its source.
          if (req.method === "GET" && segments.length === 5 && sub === "conflicts") {
            return sendJson(200, { conflicts: await insightStore.conflicts(project.id) });
          }

          // GET /api/projects/:id/insights/history?key=&kind= — every resolved
          // observation for a key over time, oldest first.
          if (req.method === "GET" && segments.length === 5 && sub === "history") {
            const key = url.searchParams.get("key");
            if (!key) return sendJson(400, { error: "'key' query param is required" });
            const observations = await insightStore.history(project.id, key, { kind: url.searchParams.get("kind") || "current_state" });
            return sendJson(200, { key, observations });
          }

          // GET /api/projects/:id/insights/delta?key=&from=&to=&kind= — the
          // delta between the state nearest `from` and the state nearest `to`.
          if (req.method === "GET" && segments.length === 5 && sub === "delta") {
            const key = url.searchParams.get("key");
            const from = url.searchParams.get("from");
            const to = url.searchParams.get("to");
            if (!key || !from || !to) return sendJson(400, { error: "'key', 'from' and 'to' query params are required" });
            const result = await insightStore.deltaBetween(project.id, key, {
              from, to, kind: url.searchParams.get("kind") || "current_state",
            });
            return sendJson(200, result);
          }

          return sendJson(404, { error: "no such insights route" });
        }

        sendJson(404, { error: "no such projects route" });
      } catch (err) {
        if (res.headersSent) { try { res.end(); } catch { /* already closing */ } return; }
        sendJson(500, { error: err.message });
      }
    })();
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // Conversations — the new conversational surface. Each conversation is a
  // durable record (server/conversation-store.js); server/turn-controller.js
  // is the single coordinator for every turn asked against it.
  // ══════════════════════════════════════════════════════════════
  if (req.url === "/api/conversations" || req.url.startsWith("/api/conversations/") || req.url.startsWith("/api/conversations?")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // ["api","conversations", id?, "turns"|"restore"?, turnId?, "stop"|"regenerate"?]
    const segments = url.pathname.split("/").filter(Boolean);

    const readJsonBody = () => new Promise((resolve, reject) => {
      let body = "", size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(new Error("Request body too large")); reject(new Error("body too large")); return; }
        body += c.toString("utf8");
      });
      req.on("end", () => {
        if (!body.trim()) return resolve({});
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
      req.on("error", reject);
    });
    const sendJson = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const notFound = (id) => sendJson(404, { error: `conversation not found: ${id}` });

    (async () => {
      try {
        // ── Path-based navigation: GET /api/conversations/nav?path=<path> ──
        if (req.method === "GET" && segments.length === 2 && url.searchParams.has("nav")) {
          const navPath = url.searchParams.get("nav");
          const resolved = await conversationStore.resolvePath(navPath);
          if (!resolved) return sendJson(404, { error: `no conversation found at path: ${navPath}` });
          return sendJson(200, resolved);
        }
        // ── Create child: POST /api/conversations/nav?parent=<parentId>&path=<segment>&mode=surf|think ──
        if (req.method === "POST" && segments.length === 2 && url.searchParams.has("parent")) {
          const parentId = url.searchParams.get("parent");
          const childPath = url.searchParams.get("path");
          const mode = url.searchParams.get("mode") || "surf";
          if (!childPath) return sendJson(400, { error: "'path' query param is required" });
          const child = await conversationStore.createChild(parentId, { path: childPath, mode });
          return sendJson(201, child);
        }

        if (req.method === "GET" && segments.length === 2) {
          return sendJson(200, { conversations: await conversationStore.list() });
        }
        if (req.method === "GET" && segments.length === 3 && segments[2] === "deleted") {
          return sendJson(200, { conversations: await conversationStore.listDeleted() });
        }
        if (req.method === "POST" && segments.length === 2) {
          const data = await readJsonBody();
          const conv = await conversationStore.create({
            title: data.title, pool: data.pool, sourceScope: data.sourceScope, spaceId: data.spaceId,
            parentId: data.parentId, path: data.path, mode: data.mode,
          });
          return sendJson(201, conv);
        }
        if (req.method === "GET" && segments.length === 3) {
          const conv = await conversationStore.get(segments[2]);
          if (!conv) return notFound(segments[2]);
          return sendJson(200, conv);
        }
        if (req.method === "PATCH" && segments.length === 3) {
          const data = await readJsonBody();
          const conv = await conversationStore.update(segments[2], data);
          return sendJson(200, conv);
        }
        if (req.method === "DELETE" && segments.length === 3) {
          const summary = await conversationStore.remove(segments[2]);
          return sendJson(200, summary);
        }
        if (req.method === "POST" && segments.length === 4 && segments[3] === "restore") {
          const conv = await conversationStore.restore(segments[2]);
          return sendJson(200, conv);
        }

        // GET /api/conversations/:id/children — list child conversations
        if (req.method === "GET" && segments.length === 4 && segments[3] === "children") {
          const parent = await conversationStore.get(segments[2]);
          if (!parent) return notFound(segments[2]);
          const children = await conversationStore.findChildren(segments[2]);
          return sendJson(200, { children, parentId: segments[2] });
        }

        // POST /api/conversations/:id/children — create a child conversation
        if (req.method === "POST" && segments.length === 4 && segments[3] === "children") {
          const parent = await conversationStore.get(segments[2]);
          if (!parent) return notFound(segments[2]);
          const data = await readJsonBody();
          if (!data.path) return sendJson(400, { error: "'path' is required" });
          const child = await conversationStore.createChild(segments[2], {
            path: data.path, mode: data.mode || "surf",
            title: data.title, pool: data.pool, sourceScope: data.sourceScope,
          });
          return sendJson(201, child);
        }

        // GET /api/conversations/:id/breadcrumbs — breadcrumb trail to root
        if (req.method === "GET" && segments.length === 4 && segments[3] === "breadcrumbs") {
          const conv = await conversationStore.get(segments[2]);
          if (!conv) return notFound(segments[2]);
          const crumbs = await conversationStore.breadcrumbs(segments[2]);
          return sendJson(200, { breadcrumbs: crumbs });
        }

        // GET /api/conversations/:id/memory — the conversation's working memory
        // (the desk): the recorded facts and hot trace, plus the exact block
        // that is injected into every turn's model context. LAWS.md L2b — the
        // path to evidence begins at the thing in question: "why did it deny
        // my code?" is answerable by reading what the model was told it was
        // told, without knowing where the memory lives.
        if (req.method === "GET" && segments.length === 4 && segments[3] === "memory") {
          const conv = await conversationStore.get(segments[2]);
          if (!conv) return notFound(segments[2]);
          const state = conv.memory && (conv.memory.hot?.length || conv.memory.facts?.length)
            ? conv.memory
            : emptyMemory();
          const injected = buildMemoryMessage(state);
          return sendJson(200, {
            conversationId: conv.id,
            facts: state.facts,
            hot: state.hot,
            injected,
            tokens: gateCountTokens(injected || ""),
          });
        }

        // POST /api/conversations/:id/turns — a new user turn, streamed as SSE.
        if (req.method === "POST" && segments.length === 4 && segments[3] === "turns") {
          const conversationId = segments[2];
          const data = await readJsonBody();
          const exists = await conversationStore.get(conversationId);
          if (!exists) return notFound(conversationId);
          if (!data.question || !String(data.question).trim()) {
            return sendJson(400, { error: "question is required" });
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
            "Connection": "keep-alive", "X-Accel-Buffering": "no",
          });
          const sendEvent = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
          try {
            const { done } = await turnController.startTurn({
              conversationId, question: data.question,
              sourceScope: data.sourceScope, pool: data.pool, attachments: data.attachments || [],
              provider: data.provider, model: data.model, draftModel: data.draftModel, mode: data.mode, webSearch: data.webSearch,
            }, sendEvent);
            await done;
          } catch (err) {
            sendEvent("failed", { message: err.message });
          } finally {
            res.end();
          }
          return;
        }

        // POST /api/conversations/:id/turns/:turnId/stop|regenerate
        if (req.method === "POST" && segments.length === 6 && segments[3] === "turns") {
          const conversationId = segments[2];
          const turnId = segments[4];
          const action = segments[5];

          if (action === "stop") {
            const stopped = turnController.stopTurn(conversationId, turnId);
            return sendJson(200, { stopped });
          }

          if (action === "regenerate") {
            const conv = await conversationStore.get(conversationId);
            if (!conv) return notFound(conversationId);
            if (!conv.turns.some((t) => t.id === turnId)) {
              return sendJson(404, { error: `turn not found: ${turnId}` });
            }
            res.writeHead(200, {
              "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
              "Connection": "keep-alive", "X-Accel-Buffering": "no",
            });
            const sendEvent = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
            try {
              const { done } = await turnController.regenerateTurn({ conversationId, turnId }, sendEvent);
              await done;
            } catch (err) {
              sendEvent("failed", { message: err.message });
            } finally {
              res.end();
            }
            return;
          }
        }

        sendJson(404, { error: "no such conversations route" });
      } catch (err) {
        if (res.headersSent) { try { res.end(); } catch { /* already closing */ } return; }
        const status = err instanceof ConversationNotFoundError ? 404 : 400;
        sendJson(status, { error: err.message });
      }
    })();
    return;
  }

  // Streaming tool-calling endpoint (always engine-grounded — not a client toggle)
  if (req.method === "POST" && req.url === "/api/chat/tools") {
    let body = "";
    let bodySize = 0;
    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(new Error("Request body too large")); return; }
      body += chunk.toString("utf8");
    });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        let messages = data.messages || [];
        const tools = data.tools;
        const sessionId = data.session || "default";

        // Ingest user input into discourse store
        for (const m of messages) {
          if (m.content?.length > 5 && m.role === "user") {
            store.ingest(m.content, m.role, { session: sessionId });
            await discourse.addMessage(sessionId, m.role, m.content);
          }
        }

        // Fold discourse context into messages so the LLM remembers
        // the conversation across turns
        try {
          const discourseCtx = await discourse.buildContext(sessionId, null, null);
          const historyMsgs = discourseCtx.filter(m =>
            m.role !== "system" && !messages.some(existing =>
              existing.role === m.role && existing.content === m.content
            )
          );
          if (historyMsgs.length > 0) {
            // Insert history before the current batch of messages
            messages = [...discourseCtx.filter(m => m.role === "system"), ...historyMsgs.slice(-10), ...messages];
          }
        } catch (err) {
          console.error(`[proxy] discourse context injection error: ${err.message}`);
        }

        await handleToolStream(res, messages, tools, data.model || null, {
          webSearch: data.webSearch !== false,
          session: sessionId,
          groundBudget: data.groundBudget ?? 2400,
          groundMaxUnits: data.groundMaxUnits ?? 5,
          groundLimit: data.groundLimit ?? 30,
          groundSource: data.groundSource || null,
        });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // Long-form code generation ACROSS messages — the sessionful build. The
  // first POST to a directory builds the project from scratch; every later
  // POST to the SAME directory is a revision of what earlier messages built.
  // Progress events stream per-file, and a final "done" carries the measured
  // residual so the UI can show what the next message must still fix.
  if (req.method === "POST" && req.url === "/api/code-longform/session") {
    let body = "";
    let bodySize = 0;
    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(new Error("Request body too large")); return; }
      body += chunk.toString("utf8");
    });
    req.on("end", async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
        return;
      }

      const message = data.message || "";
      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "'message' is required" }));
        return;
      }
      const dir = data.dir || null;
      if (!dir) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "'dir' is required" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sendSSE = (event, payload) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        const result = await runSessionMessage({
          dir,
          request: message,
          model: data.model || "llama3.2:latest",
          onProgress: (msg) => sendSSE("progress", { msg }),
        });
        const session = result.session;
        sendSSE("done", {
          kind: result.kind,
          files: session.files.map((f) => f.path),
          messages: session.messages.length,
          verifications: session.verifications,
          continuityFlags: session.continuityFlags,
          assetGaps: session.assetGaps,
          dir,
        });
      } catch (err) {
        sendSSE("error", { message: err.message });
      }
      res.end();
    });
    return;
  }

  // eoCode — the agentic-coding tab. GET lists workspaces / a workspace's
  // files (used to populate the picker and the "files touched" panel); POST
  // runs one task and discloses every step live over SSE as react-loop.mjs's
  // onStep fires it, the same real-time transparency Claude Code / opencode
  // show for their own tool calls.
  if (req.method === "GET" && req.url === "/api/eocode/workspaces") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ workspaces: listWorkspaces() }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/eocode/workspaces/")) {
    try {
      const name = decodeURIComponent(req.url.slice("/api/eocode/workspaces/".length).split("?")[0]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ workspace: name, files: listWorkspaceFiles(name) }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/eocode/run") {
    let body = "";
    let bodySize = 0;
    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(new Error("Request body too large")); return; }
      body += chunk.toString("utf8");
    });
    req.on("end", async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
        return;
      }
      if (!data.prompt || !String(data.prompt).trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "'prompt' is required" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Small, sparse writes (one per whole tool call, seconds apart, unlike
      // chat's dense token deltas) get more benefit from skipping Nagle's
      // send-side coalescing delay than they lose from it -- cheap and safe
      // to disable here since every SSE frame is already a complete, whole
      // write.
      res.socket.setNoDelay(true);
      const sendSSE = (event, payload) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      // A client that navigates away mid-run should not leave a local model
      // grinding on a step nobody is watching disclose. MUST be res.on
      // ("close"), not req.on("close"): the request's own readable side
      // closes as soon as its (tiny, already-consumed) body finishes
      // reading -- which happens almost immediately, well before the
      // response is done -- so req.on("close") set `aborted` true right at
      // the start of every run, silently swallowing every SSE event after
      // the first couple. res.on("close") fires when the actual underlying
      // connection to the client ends, which is the real signal wanted here.
      let aborted = false;
      res.on("close", () => { aborted = true; });

      try {
        await runEoCodeTask({
          workspace: data.workspace || "default",
          prompt: data.prompt,
          model: data.model || "qwen2.5-coder:1.5b",
          maxSteps: Number.isFinite(data.maxSteps) ? data.maxSteps : 20,
          // Kept in sync with eocode-agent.js's own runEoCodeTask default —
          // see its comment for why 400 silently truncated content-heavy
          // write_file calls into invalid JSON.
          maxTokensPerStep: Number.isFinite(data.maxTokensPerStep) ? data.maxTokensPerStep : 1600,
          seed: Number.isFinite(data.seed) ? data.seed : Date.now() % 100000,
          onEvent: (type, payload) => { if (!aborted) sendSSE(type, payload); },
        });
      } catch (err) {
        if (!aborted) sendSSE("error", { message: err.message });
      } finally {
        if (!aborted) res.end();
      }
    });
    return;
  }

  // eoCode stepping API — the SAME agent as /api/eocode/run, driven one turn
  // at a time by a caller supplying its own model text instead of a server-
  // owned Ollama adapter. Exists for WebLLM: a model running in the reader's
  // own browser can plan and write code as well as a server-side one, but it
  // cannot touch this machine's filesystem or run a shell, so tool execution
  // stays here unconditionally — only "what should I do next" text
  // generation moves to wherever the caller's model runs. Plain JSON
  // request/response, not SSE: the client already controls pacing (it waits
  // on its own model between steps), so there is nothing for the server to
  // push proactively.
  if (req.method === "POST" && req.url === "/api/eocode/session/start") {
    let body = "";
    let bodySize = 0;
    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(new Error("Request body too large")); return; }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
        return;
      }
      try {
        const started = startEoCodeSession({
          workspace: data.workspace || "default",
          prompt: data.prompt,
          maxSteps: Number.isFinite(data.maxSteps) ? data.maxSteps : 20,
          foldK: Number.isFinite(data.foldK) ? data.foldK : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(started));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/eocode/session/") && req.url.endsWith("/step")) {
    let body = "";
    let bodySize = 0;
    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(new Error("Request body too large")); return; }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
        return;
      }
      const sessionId = req.url.slice("/api/eocode/session/".length, -"/step".length);
      if (typeof data.raw !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "'raw' (the model's raw response text) is required" }));
        return;
      }
      try {
        const stepped = stepEoCodeSession({ sessionId, raw: data.raw });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stepped));
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/eocode/session/") && req.url.endsWith("/cancel")) {
    const sessionId = req.url.slice("/api/eocode/session/".length, -"/cancel".length);
    const cancelled = cancelEoCodeSession(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled }));
    return;
  }

  // Chat completions (with tool calling)
  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/api/chat")) {
    let body = "";
    let bodySize = 0;

    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        req.destroy(new Error("Request body too large"));
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", async () => {
      let data;
      try { data = JSON.parse(body); } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid JSON: ${e.message}` }));
        return;
      }

      // Tools: use provided tools or default to our internal tools
      const tools = data.tools && data.tools.length > 0 ? data.tools : undefined;
      const useToolLoop = tools || data.use_tools;
      const sessionId = data.session || "default";

      try {
        if (useToolLoop) {
          // Non-streaming tool loop
          const result = await runToolLoop(
            data.messages || [],
            tools || TOOL_DEFINITIONS
          );

          // Persist to discourse store
          for (const m of data.messages || []) {
            if (m.content?.length > 5 && m.role === "user") {
              await discourse.addMessage(sessionId, m.role, m.content);
              store.ingest(m.content, m.role, { session: sessionId });
            }
          }
          if (result?.length > 5) {
            await discourse.addMessage(sessionId, "assistant", result);
            store.ingest(result, "assistant", { session: sessionId });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: `chat-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: data.model || "llama3.2",
            choices: [{
              index: 0,
              message: { role: "assistant", content: result },
              finish_reason: "stop",
            }],
          }));
        } else if (data.stream) {
          const targetUrl = req.url === "/api/chat" ? `${TARGET}/api/chat` : `${TARGET}/v1/chat/completions`;
          const { use_tools, session: _sess, ...forwardData } = data;
          forwardData.model = selectModel(forwardData.messages || []);

          // Persist user messages to discourse before forwarding
          for (const m of forwardData.messages || []) {
            if (m.content?.length > 5 && m.role === "user") {
              await discourse.addMessage(sessionId, m.role, m.content);
            }
          }

          // Check if this question warrants deliberate long-form treatment.
          const question = (forwardData.messages || []).filter(m => m.role === "user").pop()?.content || "";
          let deliberate = false;
          let groundResult = null;
          if (question && groundInstructionGate.folds.length) {
            groundResult = engineGroundQuery(question, { budget: 4000, maxUnits: 12, limit: 24 });
            if (groundResult.context && (groundResult.citations || []).length > 0) {
              const gateInfo = groundInstructionGate.gate({
                question, history: [],
                evidence: groundResult.citations.map(c => c.text),
              });
              deliberate = !!gateInfo?.activeIds?.some(id => DELIBERATE_FOLD_IDS.has(id));
            }
          }

          if (deliberate && groundResult) {
            const model = forwardData.model;
            const citations = (groundResult.citations || []).map((c, i) => ({
              index: i + 1, span_id: c.span_id, source_id: c.source_id,
              byte_start: c.byte_start, byte_end: c.byte_end,
              score: Math.round((c.score || 0) * 100) / 100, text: c.text,
            }));

            const generate = async (system, user, maxTokens) => {
              const resp = await safeFetch(`${TARGET}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
                  stream: false, options: { temperature: 0.7, num_predict: maxTokens },
                }),
              });
              if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
              const j = await resp.json();
              return j.message?.content || "";
            };

            const { narratorSpans, cast } = discoverNarratorContext(
              groundResult.citations.map(c => ({ source_id: c.source_id }))
            );
            const morphology = loadMorphologyPrior();

            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
            });
            let fullResponse = "";
            try {
              const result = await runDeliberateAnswer({
                question, citations, generate, narratorSpans, cast, morphology,
                onProgress: (e) => {
                  if (e.phase === "section_closed") {
                    const chunk = (fullResponse ? "\n\n" : "") + `## ${e.title}\n\n${e.text}`;
                    fullResponse += chunk;
                    res.write(`data: ${JSON.stringify({
                      object: "chat.completion.chunk", model,
                      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
                    })}\n\n`);
                  }
                },
              });
              res.write(`data: ${JSON.stringify({
                object: "chat.completion.chunk", model,
                choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
              })}\n\n`);
              if (fullResponse.length > 5) {
                await discourse.addMessage(sessionId, "assistant", fullResponse);
                store.ingest(fullResponse, "assistant", { session: sessionId });
              }
            } catch (err) {
              console.error(`[proxy] Deliberate answer error: ${err.message}`);
              res.write(`data: ${JSON.stringify({
                object: "chat.completion.chunk", model,
                choices: [{ index: 0, delta: { content: "\n\n[An error occurred while writing this answer.]" }, finish_reason: "stop" }],
              })}\n\n`);
            }
            res.end();
            return;
          }

          const upstreamResp = await withRetry(() => safeFetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(forwardData),
          }, 120000), { label: "Ollama stream", maxRetries: 1 });

          res.writeHead(upstreamResp.status, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          const reader = upstreamResp.body.getReader();
          const decoder = new TextDecoder();
          let fullResponse = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              fullResponse += chunk;
              res.write(chunk);
            }
          } catch (err) {
            console.error(`[proxy] Stream error: ${err.message}`);
          }
          res.end();

          // Persist assistant response after stream completes
          try {
            const lines = fullResponse.split("\n");
            let content = "";
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const parsed = JSON.parse(line.slice(6));
                  if (parsed.message?.content) content += parsed.message.content;
                  else if (parsed.choices?.[0]?.delta?.content) content += parsed.choices[0].delta.content;
                } catch {}
              }
            }
            if (content.length > 5) {
              await discourse.addMessage(sessionId, "assistant", content);
              store.ingest(content, "assistant", { session: sessionId });
            }
          } catch (err) {
            console.error(`[proxy] Discourse persist error (stream): ${err.message}`);
          }
        } else {
          // Non-streaming passthrough with model routing
          const { use_tools, session: _sess, ...forwardData } = data;
          if (!forwardData.messages) forwardData.messages = [];

          // Persist user messages
          for (const m of forwardData.messages) {
            if (m.content?.length > 5 && m.role === "user") {
              await discourse.addMessage(sessionId, m.role, m.content);
            }
          }

          // Route model intelligently
          forwardData.model = selectModel(forwardData.messages);

          // Assemble context (ingest, search memory, discourse history)
          forwardData.messages = await assemble(forwardData.messages, sessionId);

          const upstreamResp = await withRetry(() => safeFetch(`${TARGET}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...forwardData, stream: false }),
          }, 120000), { label: "Ollama chat", maxRetries: 2 });

          const upstreamText = await upstreamResp.text();
          let responseContent = "";
          try {
            const parsed = JSON.parse(upstreamText);
            responseContent = parsed.message?.content || parsed.choices?.[0]?.message?.content || "";
            if (responseContent.length > 5) {
              await discourse.addMessage(sessionId, "assistant", responseContent);
              store.ingest(responseContent, "assistant", { session: sessionId });
            }
          } catch {}

          res.writeHead(upstreamResp.status, { "Content-Type": "application/json" });
          res.end(upstreamText);
        }
      } catch (err) {
        console.error(`[proxy] Request error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });

    req.on("error", (err) => {
      console.error(`[proxy] Request stream error: ${err.message}`);
    });
    return;
  }

  // Fallback: proxy to Ollama
  const targetUrl = `${TARGET}${req.url}`;
  safeFetch(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: new URL(TARGET).host },
  }, 30000)
    .then(async (upstreamResp) => {
      const text = await upstreamResp.text();
      res.writeHead(upstreamResp.status, { "Content-Type": upstreamResp.headers.get("content-type") || "application/json" });
      res.end(text);
    })
    .catch((err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream error: ${err.message}`, detail: `Could not reach ${TARGET}` }));
    });
});

// ── Graceful shutdown ──

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`\n[proxy] ${signal}: draining connections (${connections.size} active)...`);

  server.close(async () => {
    await terminateIngestWorker();
    console.error("[proxy] Server closed");
    process.exit(0);
  });

  // Force-close remaining connections after timeout
  setTimeout(() => {
    console.error(`[proxy] Force closing ${connections.size} connections`);
    for (const res of connections) {
      try { res.destroy(); } catch {}
    }
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error(`[proxy] Uncaught exception: ${err.message}`);
  console.error(err.stack);
});
process.on("unhandledRejection", (err) => {
  console.error(`[proxy] Unhandled rejection: ${err.message}`);
});

// ── Startup ──

server.keepAliveTimeout = 30000;
server.headersTimeout = 31000;

async function start() {
  // Ensure memory dir
  try { await fsp.mkdir(MEMORY_DIR, { recursive: true }); } catch {}

  // Start server FIRST so it accepts connections immediately
  server.listen(PORT, () => {
    console.error(`[proxy] Ready on port ${PORT} (target: ${TARGET}, store: ${store.size}/${STORE_MAX})`);
    console.error(`[proxy] Tool calling: ${Object.keys(toolHandlers).length} tools loaded`);
    // Print ready message on stdout for consumers
    process.stdout.write(`EO_PROXY_READY:${PORT}\n`);
  });

  // System telemetry for the Monitor surface — CPU/memory/GPU/token sampler.
  // Degrades to what the host can report (no GPU on non-Apple, no ollama CPU
  // on Windows); the UI hides whatever the snapshot flags as unavailable.
  startTelemetry({ target: TARGET });

  // Load code (async, error-isolated) — happens AFTER server starts
  try {
    await loadCode(REPO_PATH);
  } catch (err) {
    console.error(`[proxy] Warning: code loading incomplete: ${err.message}`);
  }

  // Build content index (server starts first, index builds in background
  // — deferred via setImmediate so synchronous file I/O inside the scan
  // doesn't block the event loop before server.listen)
  setImmediate(() => {
    buildContentIndex().catch(err => {
      console.error(`[proxy] Warning: content index build failed: ${err.message}`);
    });
  });

  // No boot-time corpus ingest. Three Gutenberg texts — War and Peace
  // (pg2600.txt), Frankenstein (pg84.txt), the King James Bible (pg10.txt) —
  // used to be scanned for and ingested here, off whichever of four hardcoded
  // paths happened to exist. They arrived in the sources rail on every boot
  // without the reader having attached anything, so the rail described a
  // corpus nobody chose and every ungrounded answer had three books to be
  // wrong about. The corpus now holds exactly what this reader attached.
  //
  // Priors are unaffected: live_priors lives in its own pool (see
  // priors-source.js) and is deliberately excluded from the sources rail, so
  // wiping the corpus does not thin what steers retrieval.
  //
  // To read one of these texts again, attach it like any other source. To
  // restore an automatic ingest, do it behind an explicit opt-in env var
  // rather than a filesystem scan, and set corpusWarmup.started/ready around
  // it so the "still loading" gap stays distinguishable from "sources are
  // silent" (see corpusWarmup at the top of this file).

  // Verify upstream is reachable — retry with backoff because a large
  // concurrent ingest may temporarily make Ollama unresponsive during
  // embedding. Boot no longer ingests anything, so this is now about a
  // reader attaching a big text right as the server comes up; the backoff
  // costs nothing when idle and still covers that.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ok = await safeFetch(`${TARGET}/api/tags`, {}, attempt < 4 ? 5000 : 10000).then(r => true).catch(() => false);
    if (ok) {
      console.error(`[proxy] Ollama reachable at ${TARGET}`);
      break;
    }
    if (attempt < 4) {
      console.error(`[proxy] Waiting for Ollama (attempt ${attempt}/4)...`);
      await new Promise(r => setTimeout(r, 3000 * attempt));
    } else {
      console.error(`[proxy] Warning: Ollama not reachable at ${TARGET} after 4 attempts`);
      console.error(`[proxy] The proxy will start but upstream calls will fail until Ollama is available.`);
    }
  }
}

start().catch(err => {
  console.error(`[proxy] Fatal startup error: ${err.message}`);
  process.exit(1);
});
