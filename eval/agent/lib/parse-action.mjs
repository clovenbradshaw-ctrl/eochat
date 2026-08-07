// Balanced-brace JSON object extraction — the same discipline
// server/holonic-task.js and server/code-longform.js already use (a
// non-greedy regex truncates on the first "}", which may belong to a NESTED
// object; a small local model's raw output also routinely wraps the JSON in
// a sentence or a markdown fence, which a bare JSON.parse rejects outright).

export function extractJSONObject(text) {
  const src = String(text ?? "");
  const start = src.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = src.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

/** One agent action: {tool: string, args: object}. Validated, not guessed. */
export function parseAction(text, knownTools) {
  const obj = extractJSONObject(text);
  if (!obj || typeof obj !== "object") {
    return { ok: false, reason: "no valid JSON object found in the model's response" };
  }
  if (typeof obj.tool !== "string" || !knownTools.includes(obj.tool)) {
    return { ok: false, reason: `"tool" must be one of ${knownTools.join(", ")}, got ${JSON.stringify(obj.tool)}` };
  }
  const args = obj.args && typeof obj.args === "object" ? obj.args : {};
  return { ok: true, tool: obj.tool, args };
}
