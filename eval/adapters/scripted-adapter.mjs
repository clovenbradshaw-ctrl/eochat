// A deterministic, offline adapter for validating harness plumbing before
// spending real (slow, CPU-bound) time on the real model — the "easy testing
// against before we do it" step. Each call returns the next item from a
// fixed script; running past the end throws loudly rather than looping
// silently, so a plumbing bug (one call too many) is caught, not masked.

export function createScriptedAdapter(script) {
  let i = 0;
  return {
    id: "scripted",
    async generate(_messages, _opts = {}) {
      if (i >= script.length) throw new Error(`scripted adapter: ran out of script at call ${i} (script has ${script.length} entries)`);
      const next = script[i];
      i += 1;
      const resolved = typeof next === "function" ? next(_messages, _opts) : next;
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    },
    callsMade: () => i,
  };
}
