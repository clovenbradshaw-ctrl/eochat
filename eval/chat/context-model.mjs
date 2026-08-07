// A deterministic stand-in "model" for the scripted/offline run — the same
// role eval/adapters/scripted-adapter.mjs plays for the coding eval. It makes
// no claim about how a real LLM reasons; it only answers from what is
// LITERALLY present in the context it was given, case-insensitively. That is
// the one property this eval actually needs to isolate: whether the fact
// reached the prompt at all, not whether a model is smart enough to use it.
// A real run (see run.mjs --model) can layer a real local model on top of the
// exact same two context-assembly pipelines to check whether that floor
// generalizes to real generation — this adapter is the honest, falsifiable
// baseline for "was the information even there."

export function contextBoundAnswer(messages, fact) {
  const haystack = messages.map((m) => m.content || "").join("\n").toLowerCase();
  if (haystack.includes(String(fact).toLowerCase())) {
    return `Yes — you told me it's ${fact}.`;
  }
  return "That information was never provided in this conversation.";
}
