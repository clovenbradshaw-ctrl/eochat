// eochat/server · code-longform-session.test — the sessionful layer on top of
// code-longform's writeFileStable spine, proven the same way the one-shot is:
// end-to-end through runSessionMessage/patchFileStable with a stubbed model,
// so the wiring under test is the CROSS-MESSAGE state — SESSION.json survives,
// a second message REVISES instead of rebuilding, a broken patch is discarded,
// and unresolved references accumulate across messages rather than being
// recomputed from scratch.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { loadSession, saveSession, runSessionMessage, patchFileStable } from "./code-longform-session.js";

const PLAN = JSON.stringify({
  sharedVocabulary: [{ name: "main-title", kind: "id", meaning: "the page header" }],
  files: [
    { path: "index.html", language: "html", description: 'A header element with id="main-title".', requires: [] },
    { path: "styles.css", language: "css", description: "Styles the header.", requires: ["index.html"] },
  ],
});

const INDEX = `<html><head></head><body><h1 id="main-title">Hi</h1></body></html>`;
const INDEX_REVISED = `<html><head></head><body><h1 id="main-title">Hi</h1><p>subtitle</p></body></html>`;
const STYLES = `#main-title { color: blue; }`;

// The revision plan prompt is the ONLY user message that ends with
// "THE USER NOW SAYS:" — patchFileStable's prompt says "THE USER'S MESSAGE:",
// planFiles' says "Decompose the following request", so dispatch is exact.
function stubModel({ patchTo = INDEX_REVISED, addCss = null, brokenPatch = null } = {}) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;

    if (userMsg.startsWith("You are a precise software architect. Decompose")) {
      return { ok: true, json: async () => ({ message: { content: PLAN } }) };
    }
    if (userMsg.includes("THE USER NOW SAYS:")) {
      const actions = [];
      if (brokenPatch) actions.push({ op: "patch", path: "index.html", description: brokenPatch });
      else actions.push({ op: "patch", path: "index.html", description: "Add a subtitle paragraph." });
      if (addCss) actions.push({ op: "add", path: "theme.css", language: "css", description: addCss });
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ actions }) } }) };
    }
    if (userMsg.includes("Here is the current content of index.html")) {
      return { ok: true, json: async () => ({ message: { content: brokenPatch ? `function broken( { console.log('x');` : patchTo } }) };
    }
    if (userMsg.includes("Here is the current content of script.js")) {
      return { ok: true, json: async () => ({ message: { content: `function broken( { console.log('x');` } }) };
    }
    if (userMsg.includes("Here is a file you just rewrote")) {
      // Correction attempt — the stub stays broken, proving the discard path.
      return { ok: true, json: async () => ({ message: { content: brokenPatch ? `function broken( { console.log('x');` : patchTo } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: INDEX } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      return { ok: true, json: async () => ({ message: { content: STYLES } }) };
    }
    if (userMsg.includes("NOW WRITE: theme.css")) {
      return { ok: true, json: async () => ({ message: { content: "body { color: red; }" } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
}

const tmp = (n) => `/tmp/code-longform-session-test-${n}`;

async function withFetch(stub, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a first message builds from scratch, a second message REVISES and the state survives", async () => {
  const dir = tmp("1");
  rmSync(dir, { recursive: true, force: true });
  await withFetch(stubModel(), async () => {
    const first = await runSessionMessage({ dir, request: "a landing page with a header", model: "stub", onProgress: () => {} });
    assert.equal(first.kind, "build");
    assert.equal(first.session.files.length, 2);
    assert.ok(existsSync(`${dir}/SESSION.json`), "SESSION.json must be persisted after the build");
    assert.ok(existsSync(`${dir}/BUILD_REPORT.md`), "BUILD_REPORT.md must exist after the build");
    assert.equal(JSON.parse(readFileSync(`${dir}/SESSION.json`, "utf8")).sharedVocabulary[0].name, "main-title");

    const second = await runSessionMessage({ dir, request: "add a subtitle paragraph", model: "stub", onProgress: () => {} });
    assert.equal(second.kind, "revision");
    assert.equal(second.session.messages.length, 2, "both messages must be recorded in the session");
    assert.ok(readFileSync(`${dir}/index.html`, "utf8").includes("subtitle"), "the revision must have rewritten index.html");
    assert.ok(readFileSync(`${dir}/BUILD_REPORT.md`, "utf8").includes("add a subtitle paragraph"), "the report must include the second message");
  });
});

test("a patch that fails syntax twice is DISCARDED — the verified original is kept, failure recorded", async () => {
  const dir = tmp("2");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/script.js`, `document.getElementById("main").addEventListener("click", function(){});`);

  const session = {
    dir,
    request: "a page",
    sharedVocabulary: [],
    files: [{ path: "script.js", language: "js", description: "x", requires: [] }],
  };
  const verifications = [];
  const continuityFlags = [];
  const discoveryLog = [];
  const assetGaps = [];

  await withFetch(stubModel({ brokenPatch: true }), async () => {
    const r = await patchFileStable({
      session, path: "script.js", description: "add a handler", message: "make it work", model: "stub",
      seed: 42, progress: () => {}, verifications, continuityFlags, discoveryLog, assetGaps,
    });
    assert.equal(r.ok, false, "a doubly-broken patch must report failure");
    assert.ok(r.reason.includes("original kept"), "the reason must say the original was kept");
    assert.equal(readFileSync(`${dir}/script.js`, "utf8"), `document.getElementById("main").addEventListener("click", function(){});`,
      "the previous verified content must be untouched on disk");
    const entry = verifications.find((v) => v.path === "script.js");
    assert.equal(entry.syntaxOk, false);
    assert.ok(entry.syntaxReason, "the discarded patch's failure must be recorded with a reason");
  });
});

test("an add action grows the plan, and the new file persists in SESSION.json", async () => {
  const dir = tmp("3");
  rmSync(dir, { recursive: true, force: true });
  await withFetch(stubModel({ addCss: "styles the body" }), async () => {
    const first = await runSessionMessage({ dir, request: "a landing page", model: "stub", onProgress: () => {} });
    assert.equal(first.session.files.length, 2);

    const second = await runSessionMessage({ dir, request: "add a theme file", model: "stub", onProgress: () => {} });
    assert.equal(second.kind, "revision");
    const added = second.session.files.find((f) => f.path === "theme.css");
    assert.ok(added, "the added file must be part of the persisted file list");
    assert.ok(existsSync(`${dir}/theme.css`), "the added file must exist on disk");
    assert.equal(readFileSync(`${dir}/theme.css`, "utf8"), "body { color: red; }");
    assert.ok(JSON.parse(readFileSync(`${dir}/SESSION.json`, "utf8")).files.some((f) => f.path === "theme.css"),
      "SESSION.json must list the added file");
  });
});

test("unresolved cross-file references ACCUMULATE across messages instead of being recomputed", async () => {
  const dir = tmp("4");
  rmSync(dir, { recursive: true, force: true });
  const stub = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect. Decompose")) {
      return { ok: true, json: async () => ({ message: { content: PLAN } }) };
    }
    if (userMsg.includes("THE USER NOW SAYS:")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ actions: [
        { op: "patch", path: "styles.css", description: "style a ghost element" },
      ] }) } }) };
    }
    if (userMsg.includes("Here is the current content of styles.css")) {
      // The patched CSS references .ghost, which no HTML ever declares; the
      // stub stays that way through every correction attempt, so the flag is
      // recorded unresolved, and the message's final cross-project check
      // must still see it — a residual that survives to the next message.
      return { ok: true, json: async () => ({ message: { content: `#main-title { color: blue; }\n.ghost { color: red; }` } }) };
    }
    if (userMsg.includes("Here is a file you wrote (styles.css)")) {
      return { ok: true, json: async () => ({ message: { content: `#main-title { color: blue; }\n.ghost { color: red; }` } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: INDEX } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      return { ok: true, json: async () => ({ message: { content: STYLES } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  await withFetch(stub, async () => {
    await runSessionMessage({ dir, request: "a landing page", model: "stub", onProgress: () => {} });
    const second = await runSessionMessage({ dir, request: "style a ghost element", model: "stub", onProgress: () => {} });
    assert.ok(second.finalUnresolved.some((f) => f.file === "styles.css" && f.ref === "ghost"),
      "the unresolved reference must survive the message as a measured residual");
    const flags = JSON.parse(readFileSync(`${dir}/SESSION.json`, "utf8")).continuityFlags;
    assert.ok(flags.some((f) => !f.resolved && f.ref === "ghost"), "SESSION.json must record the unresolved residual");
    assert.ok(readFileSync(`${dir}/BUILD_REPORT.md`, "utf8").includes("ghost"), "the report must show the unresolved reference");
  });
});

test("loadSession returns null on a fresh directory and round-trips saved sessions", () => {
  const dir = tmp("5");
  rmSync(dir, { recursive: true, force: true });
  assert.equal(loadSession(dir), null, "no SESSION.json must mean no prior build");

  const session = { version: 1, request: "x", model: "stub", files: [{ path: "a.html", language: "html" }], messages: [{ kind: "build", message: "x" }] };
  saveSession(dir, session);
  const loaded = loadSession(dir);
  assert.equal(loaded.request, "x");
  assert.equal(loaded.files[0].path, "a.html");
});
