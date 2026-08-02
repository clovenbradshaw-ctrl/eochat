// token-tally.js — pure token accounting. No I/O, no clock, no network.
//
// The question this answers is the one a reader asks after their fourth
// question of the morning: "how much have I actually spent on this?" Before
// this file, the honest answer was that nobody knew — the local model reported
// prompt_eval_count and eval_count on every final chunk and the server threw
// them away, and a hosted model would have reported usage nobody was reading.
//
// Three shapes, kept deliberately separate:
//
//   normalizeOllamaUsage / normalizeAnthropicUsage  — provider wire shape -> our shape
//   addUsage                                        — fold one tally into another
//   estimateCostUsd                                 — our shape -> dollars, or null
//
// `estimateCostUsd` returns null rather than 0 for a model it has no published
// price for. Zero is a claim ("this was free"); null is the truth ("this host
// does not know"). A local model is the one case where zero IS the claim, and
// it is stated explicitly rather than inferred from a missing table entry.

/** The zero tally. Freshly allocated per call — callers may mutate their copy. */
export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    calls: 0,
  };
}

function n(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Every token that crossed the wire, cached or not. Cache reads and cache
 * writes ARE input tokens the model processed — they are priced differently,
 * not counted differently — so a tally that omitted them would under-report
 * the context the reader actually paid to send.
 */
export function totalOf(usage) {
  return n(usage.inputTokens) + n(usage.outputTokens)
    + n(usage.cacheReadInputTokens) + n(usage.cacheCreationInputTokens);
}

/** Fold `b` into a new tally with `a`. Neither argument is mutated. */
export function addUsage(a, b) {
  const base = a || emptyUsage();
  const add = b || emptyUsage();
  const merged = {
    inputTokens: n(base.inputTokens) + n(add.inputTokens),
    outputTokens: n(base.outputTokens) + n(add.outputTokens),
    cacheReadInputTokens: n(base.cacheReadInputTokens) + n(add.cacheReadInputTokens),
    cacheCreationInputTokens: n(base.cacheCreationInputTokens) + n(add.cacheCreationInputTokens),
    totalTokens: 0,
    calls: n(base.calls) + n(add.calls),
  };
  merged.totalTokens = totalOf(merged);
  return merged;
}

/** True when nothing was recorded — used to avoid claiming a turn cost zero. */
export function isEmptyUsage(usage) {
  return !usage || (totalOf(usage) === 0 && n(usage.calls) === 0);
}

/**
 * Ollama reports counts on its final stream chunk: prompt_eval_count (the
 * prompt) and eval_count (what it generated). A chunk that carries neither —
 * every chunk before the last, and every chunk of a stream cut short by a
 * stop — yields null, so a partial turn tallies what is known rather than
 * inventing a zero.
 */
export function normalizeOllamaUsage(chunk) {
  if (!chunk) return null;
  const input = n(chunk.prompt_eval_count);
  const output = n(chunk.eval_count);
  if (input === 0 && output === 0) return null;
  const usage = { ...emptyUsage(), inputTokens: input, outputTokens: output, calls: 1 };
  usage.totalTokens = totalOf(usage);
  return usage;
}

/**
 * Anthropic reports usage on message_start (input, cache) and cumulatively on
 * message_delta (output). Both arrive as the same `usage` shape, so one
 * normalizer covers the streaming case and the final message alike.
 *
 * `calls` is 1 here and the caller REPLACES rather than accumulates the
 * per-call tally while a stream is running — output_tokens on message_delta
 * is a running total, not a delta, and adding each one would count the whole
 * answer once per event.
 */
export function normalizeAnthropicUsage(usage) {
  if (!usage) return null;
  const out = {
    ...emptyUsage(),
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadInputTokens: n(usage.cache_read_input_tokens),
    cacheCreationInputTokens: n(usage.cache_creation_input_tokens),
    calls: 1,
  };
  out.totalTokens = totalOf(out);
  return out;
}

// Published Anthropic list prices, US dollars per million tokens. Cached from
// the Claude API pricing table (2026-06-24) — a local copy, so a tally never
// depends on a network call, and therefore a stale copy is possible. That is
// why every number this produces is labelled an estimate at the boundary and
// carries `pricedAt`.
export const PRICING_AS_OF = "2026-06-24";

const PRICE_PER_MTOK = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
};

// Cache reads bill at ~0.1x the input rate; a 5-minute cache write at ~1.25x.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Dollars, or null when this host cannot honestly say.
 *
 * A local model is priced at exactly 0 — that is a real claim about a model
 * running on the reader's own machine, not a missing entry. An unknown hosted
 * model returns null and the UI shows tokens without a price rather than
 * showing "$0.00" for something that was billed.
 */
export function estimateCostUsd(model, usage) {
  if (!usage) return null;
  if (!model || !/^claude-/.test(model)) return 0; // local model: genuinely free
  const price = PRICE_PER_MTOK[model];
  if (!price) return null;
  const dollars =
    (n(usage.inputTokens) * price.input
      + n(usage.cacheReadInputTokens) * price.input * CACHE_READ_MULTIPLIER
      + n(usage.cacheCreationInputTokens) * price.input * CACHE_WRITE_MULTIPLIER
      + n(usage.outputTokens) * price.output) / 1_000_000;
  return Math.round(dollars * 1e6) / 1e6;
}

/**
 * The tally as the wire and the UI want it: counts, an estimated cost, and
 * the provenance of that estimate. Kept here so the server and any client
 * agree on one shape rather than each deriving its own.
 */
export function summarizeUsage(usage, model) {
  const base = usage ? { ...emptyUsage(), ...usage } : emptyUsage();
  base.totalTokens = totalOf(base);
  const costUsd = estimateCostUsd(model, base);
  return {
    ...base,
    model: model || null,
    costUsd,
    costIsEstimate: costUsd !== null && costUsd > 0,
    pricedAt: costUsd !== null && costUsd > 0 ? PRICING_AS_OF : null,
  };
}

/**
 * Roll a `{ model: usage }` map up into one tally.
 *
 * A conversation can be answered by more than one model — a local model this
 * morning, a hosted one after a key was added, and the router picking between
 * two local models before that. Tokens add across models; DOLLARS DO NOT, so
 * cost is summed per model at that model's own rate, and `costComplete` goes
 * false the moment any model in the mix has no published price. A partial sum
 * presented as a total would understate the bill.
 */
export function rollUpUsage(byModel) {
  let total = emptyUsage();
  let cost = 0;
  let costComplete = true;
  const models = [];
  for (const [model, usage] of Object.entries(byModel || {})) {
    total = addUsage(total, usage);
    const summary = summarizeUsage(usage, model);
    if (summary.costUsd === null) costComplete = false;
    else cost += summary.costUsd;
    models.push(summary);
  }
  models.sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    ...total,
    costUsd: costComplete ? Math.round(cost * 1e6) / 1e6 : null,
    costComplete,
    pricedAt: cost > 0 ? PRICING_AS_OF : null,
    byModel: models,
  };
}

/** "12.4k" / "812" — for a chip that has to fit in a header. */
export function formatTokens(count) {
  const value = n(count);
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
