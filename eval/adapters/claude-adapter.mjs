// Real Claude adapter for the live pipeline comparisons — the same request
// shape server/turn-controller.js's callModelNonStreaming already uses against
// the Anthropic API (system messages joined and hoisted to the top-level
// `system` field, everything else sent as alternating user/assistant turns),
// reused rather than reimplemented so the eval measures the same wire format
// eochat itself sends in production.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Web search as a real server-side tool — EOchat's own grounded-answer path
// uses server tools the same way (this is the Anthropic API's tool, run on
// Anthropic's infrastructure, not anything this eval fetches itself). Passing
// { webSearch: true } to generate() is how build-transcript.mjs gets real,
// live-researched answers instead of anything hand-authored in this repo.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search" };

export function createClaudeAdapter({ model, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!model) throw new TypeError("createClaudeAdapter: model is required");
  if (!apiKey) throw new TypeError("createClaudeAdapter: apiKey is required (set ANTHROPIC_API_KEY)");
  return {
    id: model,
    async generate(messages, { maxTokens = 300, retries = 4, webSearch = false } = {}) {
      const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const body = {
        model,
        max_tokens: maxTokens,
        messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
      };
      if (systemMessages) body.system = systemMessages;
      if (webSearch) body.tools = [WEB_SEARCH_TOOL];

      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const t0 = Date.now();
        let resp;
        try {
          resp = await fetch(ANTHROPIC_API_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(2 * 60 * 1000),
          });
        } catch (err) {
          lastErr = err;
          await backoff(attempt);
          continue;
        }
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`Anthropic ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
          await backoff(attempt);
          continue;
        }
        if (!resp.ok) {
          throw new Error(`Anthropic ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
        }
        const j = await resp.json();
        // Only text blocks become the "answer" — web_search_tool_result and
        // server_tool_use blocks are the model's real, live research, but
        // pipelines.mjs's conversation shape (server/turn-controller.js's
        // own buildHistoryMessages) only ever persists plain assistant text,
        // so this matches what a real EOchat turn actually keeps as history.
        const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        const searched = (j.content || []).some((c) => c.type === "server_tool_use" && c.name === "web_search");
        return {
          text,
          model: j.model || model,
          wallMs: Date.now() - t0,
          usage: j.usage || null,
          searched,
        };
      }
      throw lastErr || new Error("Anthropic request failed after retries");
    },
  };
}

function backoff(attempt) {
  const ms = Math.min(16000, 500 * 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
