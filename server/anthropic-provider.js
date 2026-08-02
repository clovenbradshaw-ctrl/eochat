// anthropic-provider.js — the hosted-model half of the talker.
//
// The talker's job is unchanged by which model does it: it receives a grounded
// system message plus history and writes prose over passages a dispatcher
// already chose (see turn-controller.js). So this file is deliberately shaped
// like the Ollama call it sits beside — same messages in, same
// `{ text, model }` out, same AbortSignal, same per-delta callback — and
// differs only where the two providers genuinely differ:
//
//   - Anthropic takes the system prompt as a top-level `system` field, not as
//     a message with role "system". The grounded prompt is built once, in the
//     turn controller, and split here rather than built twice.
//   - Thinking is streamed as its own block type. It is forwarded to
//     `onThinking` so the engine-activity log can show the model working
//     instead of the reader watching a still screen (LAWS.md L1c).
//   - Usage is reported by the API. It is forwarded to `onUsage` as it
//     arrives, not just at the end, so a turn the reader STOPS still tallies
//     the tokens it actually spent.
//   - A truncated or refused answer is a fact about the answer, so it comes
//     back as a structured `stopReason` for the caller to report as a gap
//     (LAWS.md L3 — no silent truncation).

import Anthropic from "@anthropic-ai/sdk";
import { normalizeAnthropicUsage } from "./token-tally.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/**
 * The models this host offers. A short list, not the whole catalogue: every
 * entry here has a price in token-tally.js, so the tally can never show a
 * token count next to a cost this host had to guess at.
 */
export const ANTHROPIC_MODELS = Object.freeze([
  { id: "claude-opus-5", label: "Claude Opus 5", note: "Most capable — deep reasoning over your sources" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Balanced — near-Opus quality, lower cost" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fastest and cheapest" },
]);

export function isKnownAnthropicModel(id) {
  return ANTHROPIC_MODELS.some((m) => m.id === id);
}

// Generous, because `max_tokens` caps thinking AND the answer together on
// Claude Opus 5 — thinking is on by default there, and a ceiling sized for
// the prose alone would truncate the answer behind it. This is a cap, not a
// target: a grounded answer over a handful of passages is far shorter.
const MAX_OUTPUT_TOKENS = 32000;

/**
 * Split the Ollama-shaped message list this codebase speaks into Anthropic's
 * (system, messages) pair.
 *
 * Two rules the API enforces that the local model tolerated: the first
 * message must be `user`, and content must be non-empty. Both are handled
 * here rather than at the call site so a history with an empty assistant turn
 * (a stopped answer that produced no text) cannot 400 someone's next
 * question.
 */
export function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  for (const m of messages || []) {
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "system") {
      if (content.trim()) systemParts.push(content);
      continue;
    }
    if (!content.trim()) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    // Consecutive same-role turns are legal but pointless; merging keeps the
    // transcript readable in the API console and costs nothing.
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role === "assistant") out.shift();
  return { system: systemParts.join("\n\n"), messages: out };
}

/** A stop reason the reader needs told about, or null when the answer is whole. */
export function describeStopReason(stopReason, stopDetails) {
  if (stopReason === "max_tokens") {
    return {
      type: "answer_truncated",
      reason: `The answer hit this host's ${MAX_OUTPUT_TOKENS.toLocaleString()}-token output ceiling and stops mid-thought — it is not a complete answer.`,
    };
  }
  if (stopReason === "refusal") {
    const category = stopDetails?.category ? ` (${stopDetails.category})` : "";
    return {
      type: "model_refused",
      reason: `The model declined to answer this question${category}. Nothing was written — this is a refusal, not an empty result from your sources.`,
    };
  }
  return null;
}

/**
 * Stream one grounded turn from Anthropic.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {object[]} opts.messages           Ollama-shaped [{role, content}]
 * @param {AbortSignal} [opts.signal]
 * @param {(delta: string, text: string) => void} opts.onDelta
 * @param {(text: string) => void} [opts.onThinking]  summarized reasoning, as it arrives
 * @param {(usage: object) => void} [opts.onUsage]    latest known tally for THIS call
 * @param {object} [opts.client]             injected for tests
 * @returns {Promise<{text: string, model: string, usage: object|null, stopReason: string|null, stopDetails: object|null}>}
 */
export async function streamAnthropicChat({
  apiKey, model, messages, signal, onDelta, onThinking, onUsage, client,
}) {
  const anthropic = client || new Anthropic({ apiKey });
  const { system, messages: converted } = toAnthropicMessages(messages);
  if (!converted.length) throw new Error("Nothing to ask — the message list is empty.");

  const stream = anthropic.messages.stream({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(system ? { system } : {}),
    messages: converted,
    // Adaptive thinking, displayed. Omitted thinking would give the reader a
    // long silent pause before the first word of the answer — dead air with
    // an invoice attached. Summarized reasoning is a real, specific signal
    // about this turn (L1b/L1e), and it costs nothing extra: thinking is
    // billed identically under every display setting.
    thinking: { type: "adaptive", display: "summarized" },
  }, signal ? { signal } : undefined);

  let text = "";
  let usage = null;
  let stopReason = null;
  let stopDetails = null;

  // The wire fields seen so far, merged field-by-field. message_start carries
  // the input and cache counts; message_delta carries a RUNNING TOTAL of
  // output tokens. So later events overwrite earlier ones per field — folding
  // them together instead would count the answer once per event and report
  // several times what was actually spent.
  let rawUsage = null;
  const reportUsage = (raw) => {
    if (!raw) return;
    rawUsage = { ...(rawUsage || {}), ...raw };
    const next = normalizeAnthropicUsage(rawUsage);
    if (!next) return;
    usage = next;
    if (onUsage) onUsage(usage);
  };

  for await (const event of stream) {
    if (event.type === "message_start") {
      reportUsage(event.message?.usage);
      continue;
    }
    if (event.type === "message_delta") {
      if (event.usage) reportUsage(event.usage);
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      if (event.delta?.stop_details) stopDetails = event.delta.stop_details;
      continue;
    }
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && event.delta.text) {
        text += event.delta.text;
        onDelta(event.delta.text, text);
      } else if (event.delta?.type === "thinking_delta" && event.delta.thinking && onThinking) {
        onThinking(event.delta.thinking);
      }
    }
  }

  // finalMessage() carries the authoritative usage and stop reason; the
  // streamed values above exist so an interrupted turn still has both.
  const final = await stream.finalMessage();
  reportUsage(final.usage);
  stopReason = final.stop_reason ?? stopReason;
  stopDetails = final.stop_details ?? stopDetails;

  return { text, model: final.model || model, usage, stopReason, stopDetails };
}

/**
 * A one-call reachability check, used when a key is added: it either works or
 * the reader is told why immediately, rather than finding out on their next
 * question. Deliberately tiny — one token of output.
 */
export async function verifyAnthropicKey({ apiKey, model = DEFAULT_ANTHROPIC_MODEL, client } = {}) {
  const anthropic = client || new Anthropic({ apiKey });
  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 1,
      // Thinking off keeps the probe to a single billed token; at effort
      // "low" that combination is accepted on every model listed above.
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true, model: resp.model, usage: normalizeAnthropicUsage(resp.usage) };
  } catch (err) {
    return { ok: false, error: describeApiError(err) };
  }
}

/** Anthropic SDK errors, rendered as something a reader can act on. */
export function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "That API key was rejected (401). Check it and try again.";
  if (err instanceof Anthropic.PermissionDeniedError) return "That API key is not permitted to use this model (403).";
  if (err instanceof Anthropic.NotFoundError) return "That model does not exist for this key (404).";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API (429) — wait a moment and retry.";
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`.trim();
  return err?.message || String(err);
}
