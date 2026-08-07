// Real local-CPU-model adapter — same /api/chat shape eochat's own
// server/code-longform.js already uses against Ollama, reused rather than
// reinvented.

export function createOllamaAdapter({ model, url = process.env.OLLAMA_URL || "http://localhost:11434", temperature = 0.2 } = {}) {
  if (!model) throw new TypeError("createOllamaAdapter: model is required");
  return {
    id: model,
    async generate(messages, { maxTokens = 300, seed = 0 } = {}) {
      const resp = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false, options: { temperature, num_predict: maxTokens, seed } }),
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      return (data.message?.content || "").trim();
    },
  };
}
