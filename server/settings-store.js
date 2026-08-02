// SettingsStore — the durable, reader-owned configuration this host holds on
// behalf of the person using it. Today that is exactly one thing: which model
// answers a turn, and the Anthropic API key that makes a hosted model
// reachable at all.
//
// Why a store and not another --flag: a CLI flag is set by whoever launched
// the process, which is not who is sitting in front of the UI. "Let someone
// add an API key" means the person in the browser, mid-session, without
// restarting the server — so the key has to live somewhere the HTTP surface
// can write.
//
// Three rules this file exists to keep:
//
//   1. The key is write-only across the wire. Every read path returns a hint
//      ("sk-ant-…4f2a") and never the secret. A UI that can display a key can
//      leak one, and there is no reason a UI needs it back.
//   2. The key is never repo content. It is written under memory/, which is
//      gitignored exactly like the conversation records and the router
//      ledger, with 0600 so it is not world-readable on a shared machine.
//   3. An environment key still works and is never overwritten. ANTHROPIC_API_KEY
//      is how a server operator supplies a key; the UI path is how a reader
//      does. Both are reported with their `source` so "where did this key come
//      from" is answerable, and clearing the stored key falls back to the
//      environment rather than pretending no key exists.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "./paths.js";
import { DEFAULT_ANTHROPIC_MODEL, ANTHROPIC_MODELS, isKnownAnthropicModel } from "./anthropic-provider.js";

export const SETTINGS_FILE = path.join(MEMORY_DIR, "settings.json");

export const PROVIDERS = ["local", "anthropic"];

const DEFAULTS = Object.freeze({
  version: 1,
  provider: "local",
  anthropic: Object.freeze({ key: null, model: DEFAULT_ANTHROPIC_MODEL }),
});

/** "sk-ant-…4f2a" — enough to tell two keys apart, not enough to use one. */
export function hintFor(key) {
  if (!key) return null;
  const tail = key.slice(-4);
  const head = key.slice(0, 7);
  return `${head}…${tail}`;
}

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-settings-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  // 0600 at creation, not chmod after: a key must never exist on disk, even
  // for a millisecond, at the default umask.
  await fsp.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, file);
}

export class SettingsStore {
  constructor({ file = SETTINGS_FILE, env = process.env } = {}) {
    this.file = file;
    this.env = env;
    this.data = { ...DEFAULTS, anthropic: { ...DEFAULTS.anthropic } };
    this.loaded = false;
  }

  /**
   * Read the record off disk. A malformed file is reported and treated as
   * absent — a bad settings file must not stop the server from booting, but
   * it must not be silently rewritten either, so it is left in place.
   */
  async load() {
    let text;
    try {
      text = await fsp.readFile(this.file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`[settings] could not read ${this.file}: ${err.message} — using defaults`);
      }
      this.loaded = true;
      return this.data;
    }
    try {
      const parsed = JSON.parse(text);
      this.data = {
        version: 1,
        provider: PROVIDERS.includes(parsed.provider) ? parsed.provider : DEFAULTS.provider,
        anthropic: {
          key: typeof parsed.anthropic?.key === "string" && parsed.anthropic.key ? parsed.anthropic.key : null,
          model: typeof parsed.anthropic?.model === "string" && parsed.anthropic.model
            ? parsed.anthropic.model
            : DEFAULT_ANTHROPIC_MODEL,
        },
      };
    } catch (err) {
      console.error(`[settings] ${this.file} is not valid JSON (${err.message}) — using defaults, file left untouched`);
    }
    this.loaded = true;
    return this.data;
  }

  /** Synchronous load, for callers that must have settings before the first request. */
  loadSync() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = {
        version: 1,
        provider: PROVIDERS.includes(parsed.provider) ? parsed.provider : DEFAULTS.provider,
        anthropic: {
          key: typeof parsed.anthropic?.key === "string" && parsed.anthropic.key ? parsed.anthropic.key : null,
          model: typeof parsed.anthropic?.model === "string" && parsed.anthropic.model
            ? parsed.anthropic.model
            : DEFAULT_ANTHROPIC_MODEL,
        },
      };
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`[settings] could not read ${this.file}: ${err.message} — using defaults`);
      }
    }
    this.loaded = true;
    return this.data;
  }

  async #save() {
    await writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    return this.data;
  }

  /** The key actually used for a call: stored key first, environment second. */
  anthropicKey() {
    return this.data.anthropic.key || this.env.ANTHROPIC_API_KEY || null;
  }

  /** Where that key came from — "settings" | "env" | null. Never the key itself. */
  keySource() {
    if (this.data.anthropic.key) return "settings";
    if (this.env.ANTHROPIC_API_KEY) return "env";
    return null;
  }

  anthropicModel() {
    return this.data.anthropic.model || DEFAULT_ANTHROPIC_MODEL;
  }

  /**
   * The provider a turn will actually use, which is not always the one asked
   * for: "anthropic" with no key resolves to local. The reason is returned
   * alongside so the caller can SAY so (L1d — a silent downgrade is a trigger
   * that died quietly) instead of quietly answering from a different model
   * than the reader chose.
   */
  effectiveProvider() {
    if (this.data.provider !== "anthropic") return { provider: "local", fallbackReason: null };
    if (!this.anthropicKey()) {
      return {
        provider: "local",
        fallbackReason: "No Anthropic API key is set — answered with the local model instead.",
      };
    }
    return { provider: "anthropic", fallbackReason: null };
  }

  /** The whole public view. Contains a hint, never a key. Safe to serve. */
  publicView() {
    const { provider, fallbackReason } = this.effectiveProvider();
    return {
      provider: this.data.provider,
      effectiveProvider: provider,
      fallbackReason,
      anthropic: {
        hasKey: !!this.anthropicKey(),
        keyHint: hintFor(this.anthropicKey()),
        keySource: this.keySource(),
        // An environment key belongs to whoever launched the process; the UI
        // must not offer to delete something it did not create.
        keyRemovable: !!this.data.anthropic.key,
        model: this.anthropicModel(),
        models: ANTHROPIC_MODELS,
      },
    };
  }

  /**
   * Adding a key is the whole point of adding a key: it switches this host to
   * the hosted model unless the caller explicitly says otherwise. A key that
   * is stored but never used would look exactly like a key that failed to
   * save.
   */
  async setAnthropicKey(key, { activate = true } = {}) {
    const trimmed = String(key || "").trim();
    if (!trimmed) throw new Error("An API key is required.");
    // Anthropic keys are `sk-ant-…`. Rejecting other shapes here turns a typo
    // (a pasted OpenAI key, a pasted URL) into an immediate, local error
    // instead of a 401 three seconds into someone's next question.
    if (!/^sk-ant-[A-Za-z0-9_\-]{16,}$/.test(trimmed)) {
      throw new Error("That does not look like an Anthropic API key — they start with \"sk-ant-\".");
    }
    this.data.anthropic.key = trimmed;
    if (activate) this.data.provider = "anthropic";
    await this.#save();
    return this.publicView();
  }

  /**
   * Removing the stored key falls back to the environment key if there is
   * one, and only drops to the local model when there is genuinely no key
   * left — so "remove" never silently leaves a key in play, and never claims
   * to have removed one it cannot reach.
   */
  async clearAnthropicKey() {
    this.data.anthropic.key = null;
    if (!this.anthropicKey()) this.data.provider = "local";
    await this.#save();
    return this.publicView();
  }

  async setProvider(provider) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`Unknown provider "${provider}" — expected one of: ${PROVIDERS.join(", ")}`);
    }
    if (provider === "anthropic" && !this.anthropicKey()) {
      throw new Error("Add an Anthropic API key before switching to the hosted model.");
    }
    this.data.provider = provider;
    await this.#save();
    return this.publicView();
  }

  async setAnthropicModel(model) {
    const id = String(model || "").trim();
    if (!id) throw new Error("A model id is required.");
    if (!isKnownAnthropicModel(id)) {
      throw new Error(`Unknown Anthropic model "${id}" — expected one of: ${ANTHROPIC_MODELS.map((m) => m.id).join(", ")}`);
    }
    this.data.anthropic.model = id;
    await this.#save();
    return this.publicView();
  }
}

export const settingsStore = new SettingsStore();
