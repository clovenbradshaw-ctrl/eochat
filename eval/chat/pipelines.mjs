// Three ways of assembling the context for one chat turn. `baseline` and
// `holonic` are built from the SAME real production functions
// turn-controller.js itself calls — never a reimplementation of either.
// `growingContext` is the adversary: a deliberately naive pipeline that does
// NOT call the production windowing function at all, because that omission
// IS the thing under test.
//
//   baseline — buildHistoryMessages() only (server/turn-controller.js). This
//     is "normal chatting": a fixed sliding window of the last HISTORY_TURNS
//     raw exchanges and nothing else, which is what any ordinary chat
//     completion endpoint (a raw /v1/chat/completions passthrough) gives you
//     once conversations run long. Whatever fell out of the window is gone —
//     not summarized, not remembered, not disclosed as withheld.
//
//   holonic — the same buildHistoryMessages() window, PLUS the desk
//     (server/conversation-memory.js's applyTurn/buildMemoryMessage), the
//     bounded, verbatim, always-injected fact ledger that is this
//     codebase's task-log-style "mouth": small, declared, and honest about
//     what it evicts (see conversation-memory.js's own FACTS_MAX/
//     FACT_CHAR_BUDGET headers).
//
//   growingContext — the adversary this eval was built to test against:
//     every turn ever exchanged, verbatim, resent in full on every request,
//     with no windowing and no fold at all. This is "just run a Claude model
//     with a growing context window instead of surf and fold" — the prompt
//     this pipeline sends grows without bound as the conversation lengthens,
//     which is exactly the property `baseline`/`holonic` refuse by design.
//
// All three conditions replay the identical scripted conversation — the
// comparison is the point, not any one pipeline in isolation.

import { buildHistoryMessages } from "../../server/turn-controller.js";
import { applyTurn, buildMemoryMessage, emptyMemory, isAcknowledgment } from "../../server/conversation-memory.js";

let turnCounter = 0;
function nextTurnId() {
  turnCounter += 1;
  return `t${turnCounter}`;
}

/** A fresh conversation record shaped exactly like conversation-store.js's, holding only what buildHistoryMessages reads. */
export function createConversation() {
  return { turns: [] };
}

/** Append one completed (question, answer) exchange — the same shape turn-controller.js persists. */
export function pushTurn(conv, { question, answer }) {
  const id = nextTurnId();
  const answerId = `${id}-a`;
  conv.turns.push({
    id,
    question,
    activeAnswerId: answerId,
    answers: [{ id: answerId, status: "completed", text: answer }],
  });
  return id;
}

/** Advance the desk by one turn, mirroring turn-controller.js's persistTurnMemory. Pure — returns a new memory state. */
export function advanceDesk(memory, turnNumber, { question, answer }) {
  return applyTurn(memory, turnNumber, {
    userText: question,
    assistantText: answer,
    confirmed: isAcknowledgment(answer),
  });
}

/** Replay a scripted conversation through both conditions in lockstep, returning the final conv + desk state for each. */
export function replay(scriptedTurns) {
  const baselineConv = createConversation();
  const holonicConv = createConversation();
  let memory = emptyMemory();

  scriptedTurns.forEach(({ question, answer }, i) => {
    pushTurn(baselineConv, { question, answer });
    pushTurn(holonicConv, { question, answer });
    memory = advanceDesk(memory, i, { question, answer });
  });

  return { baselineConv, holonicConv, memory };
}

/** The context a plain, non-holonic chat endpoint would send for the next turn: windowed history only. */
export function baselineContext(conv) {
  return buildHistoryMessages(conv, null);
}

/** The context the holonic pipeline sends: the same window, plus the desk — never replacing it, never reimplemented. */
export function holonicContext(conv, memory) {
  const messages = buildHistoryMessages(conv, null);
  const memoryMsg = buildMemoryMessage(memory);
  return memoryMsg ? [{ role: "system", content: memoryMsg }, ...messages] : messages;
}

/**
 * The adversary pipeline: the ENTIRE raw conversation, every turn, unbounded,
 * with no windowing and no desk. Deliberately does not call
 * buildHistoryMessages() — bypassing the production windowing function is
 * the whole point, since this pipeline models what a harness gets by simply
 * growing the context window every turn instead of surfing/folding it.
 */
export function growingContext(conv) {
  const out = [];
  for (const t of conv.turns || []) {
    out.push({ role: "user", content: t.question });
    const active = (t.answers || []).find((a) => a.id === t.activeAnswerId);
    if (active && active.status === "completed" && active.text) {
      out.push({ role: "assistant", content: active.text });
    }
  }
  return out;
}

export function contextText(messages) {
  return messages.map((m) => m.content).join("\n");
}
