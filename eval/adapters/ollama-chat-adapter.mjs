// Local-CPU-model adapter for ordinary free-text chat replies — the
// conversational counterpart to ollama-adapter.mjs, which is dedicated to
// the agentic coding eval and grammar-constrains output to JSON
// (format: "json") because every prompt there demands a JSON tool call.
// A recall probe ("what was the X I gave you earlier?") wants prose, not
// JSON, so this is a separate, smaller adapter rather than an option bolted
// onto the JSON-shaped one — the two have genuinely different contracts
// (this one returns {text, wallMs, usage}, matching claude-adapter.mjs's
// shape so eval/chat/live/run-live.mjs can treat both adapters identically).

export function createOllamaChatAdapter({ model, url = process.env.OLLAMA_URL || "http://localhost:11434", temperature = 0.2 } = {}) {
  if (!model) throw new TypeError("createOllamaChatAdapter: model is required");
  return {
    id: model,
    async generate(messages, { maxTokens = 300, numCtx = 8192 } = {}) {
      const t0 = Date.now();
      const resp = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: { temperature, num_predict: maxTokens, num_ctx: numCtx },
        }),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      // Ollama reports nanosecond durations split by phase — load_duration is
      // a one-time model-load cost (not part of steady-state throughput once
      // the model is warm), prompt_eval_duration is prefill, eval_duration is
      // token generation. Surfacing all of them (not just wall time) is what
      // lets a caller compute a real tokens/sec figure instead of guessing
      // from wall-clock, which is dominated by whichever call happened to pay
      // the (one-time) load cost.
      return {
        text: (data.message?.content || "").trim(),
        model,
        wallMs: Date.now() - t0,
        usage: { input_tokens: data.prompt_eval_count ?? null, output_tokens: data.eval_count ?? null },
        timingNs: {
          total: data.total_duration ?? null,
          load: data.load_duration ?? null,
          promptEval: data.prompt_eval_duration ?? null,
          eval: data.eval_duration ?? null,
        },
      };
    },
  };
}
