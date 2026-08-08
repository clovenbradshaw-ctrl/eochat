// eochat/server · code-longform.test — the code-domain instance of the same
// mechanism narrative-longform.test.js proves for fiction: legality without
// lookahead, real verification, a continuity check that catches a
// cross-file contradiction and doesn't false-positive on a consistent file.

import test from "node:test";
import assert from "node:assert/strict";
import { writeProject } from "./code-longform.js";
import { projectTasks } from "./task-log.js";

// checkCrossFileReferences and verifySyntax are internal (not exported) —
// exercised here through writeProject end to end with a stubbed model,
// the same choice narrative-longform.test.js makes for its heist world:
// the wiring is the thing under test, not a hand-picked internal function.

function stubModel({ badClass = null } = {}) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              sharedVocabulary: [],
              files: [
                { path: "index.html", language: "html", description: "A header id=\"main-title\".", requires: [] },
                { path: "styles.css", language: "css", description: "Styles the header.", requires: ["index.html"] },
                { path: "script.js", language: "js", description: "Logs a click.", requires: ["index.html"] },
              ],
            }),
          },
        }),
      };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><h1 id="main-title">Hi</h1></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      const extra = badClass ? ` .${badClass} { color: red; }` : "";
      return { ok: true, json: async () => ({ message: { content: `#main-title { color: blue; }${extra}` } }) };
    }
    if (userMsg.includes("Here is a file you wrote (styles.css)")) {
      return { ok: true, json: async () => ({ message: { content: `#main-title { color: blue; }` } }) }; // corrected: drops the bad reference
    }
    if (userMsg.includes("NOW WRITE: script.js")) {
      return { ok: true, json: async () => ({ message: { content: `document.getElementById("main-title").addEventListener("click", function(){});` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
}

test("every file — planned or discovered — is tagged SEG at Figure grain, the identical cell narrative-longform.js's discovered characters resolve to", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-cube", onProgress: () => {} });
    const tasks = projectTasks(result.log);
    const index = tasks.find((t) => t.task_id === "file:index.html");
    const styles = tasks.find((t) => t.task_id === "file:styles.css");
    assert.equal(index.operator, "SEG");
    assert.equal(index.grain, "Figure");
    assert.deepEqual(index.cell, styles.cell, "every registered file resolves to the same cube cell regardless of order or which file it is");
    // Advisory cube-progression check must be clean on a real, successful run.
    assert.deepEqual(result.cubeFlags, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stray unmatched triple-quote marker is stripped from EITHER end, never assumed paired", async () => {
  // MEASURED on two separate real runs: styles.css began with a bare `"""`
  // line (no markdown fence, no closing quote) on one run, and ended with
  // one on a LATER run — proving it's not a half-stripped Python docstring
  // wrapper but an unpredictable one-sided marker. stripFences must strip
  // it from whichever end it lands on, independently.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      return { ok: true, json: async () => ({ message: { content: `"""\nbody { color: red; }\n"""` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-0", onProgress: () => {} });
    assert.equal(result.contents["styles.css"], `body { color: red; }`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a syntactically valid JS file passes verification", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-1", onProgress: () => {} });
    const js = result.verifications.find((v) => v.path === "script.js");
    assert.equal(js.syntaxOk, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a REAL JS syntax error is caught, not just a heuristic guess", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "script.js", language: "js", description: "x", requires: [] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) return { ok: true, json: async () => ({ message: { content: "<html><head></head><body></body></html>" } }) };
    if (userMsg.includes("NOW WRITE: script.js")) return { ok: true, json: async () => ({ message: { content: "function broken( { console.log('unbalanced parens');" } }) };
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-2", onProgress: () => {} });
    const js = result.verifications.find((v) => v.path === "script.js");
    assert.equal(js.syntaxOk, false);
    assert.ok(js.syntaxReason, "a real SyntaxError message must be captured, not just a boolean");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a CSS file referencing a class no HTML file ever declared is flagged and corrected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel({ badClass: "nonexistent-class" });
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-3", onProgress: () => {} });
    const flag = result.continuityFlags.find((f) => f.path === "styles.css");
    assert.ok(flag, "must flag the undeclared class");
    assert.equal(flag.resolved, true, "the correction attempt must have succeeded");
    assert.ok(!result.contents["styles.css"].includes("nonexistent-class"), "the KEPT file must be the corrected version");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a fully consistent project is NOT flagged — no false positives", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-4", onProgress: () => {} });
    assert.deepEqual(result.continuityFlags, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("files are written in dependency order — HTML before what references it", async () => {
  const originalFetch = globalThis.fetch;
  const order = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    const m = /NOW WRITE: (\S+)/.exec(userMsg);
    if (m) order.push(m[1]);
    return stubModel()(url, opts);
  };
  try {
    await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-5", onProgress: () => {} });
    assert.equal(order[0], "index.html", "the file nothing depends on must be written first");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a CYCLIC requires graph is broken, not deadlocked — zero writes is never a legal outcome", async () => {
  // MEASURED on a real run: the model planned index.html requires
  // [styles.css, script.js] while styles.css and script.js each required
  // index.html back — a cycle. Existence-dependency gating then returned
  // "close" with NO file written and NO error: a silent empty build. The
  // cycle must be broken (write the first unwritten file) so every planned
  // file lands on disk and is verified.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect. Decompose")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: ["styles.css", "script.js"] },
        { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
        { path: "script.js", language: "js", description: "x", requires: ["index.html"] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><h1 id="t">Hi</h1></body></html>` } }) };
    if (userMsg.includes("NOW WRITE: styles.css")) return { ok: true, json: async () => ({ message: { content: `#t { color: blue; }` } }) };
    if (userMsg.includes("NOW WRITE: script.js")) return { ok: true, json: async () => ({ message: { content: `document.getElementById("t");` } }) };
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-6", onProgress: () => {} });
    assert.equal(result.files.length, 3, "all planned files must be written");
    assert.equal(Object.keys(result.contents).length, 3, "a cycle must not leave a planned file unbuilt");
    assert.equal(result.verifications.length, 3, "every written file must be verified");
    assert.ok(result.verifications.every((v) => v.syntaxOk), "the cycle-broken build must be fully verified");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Two real bugs found on a real run, pinned so they cannot recur ───────

test("a planned file at a nested path (e.g. js/script.js) is written without crashing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "js/script.js", language: "js", description: "x", requires: ["index.html"] }, // MEASURED: this exact nested path crashed a real run with ENOENT
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) return { ok: true, json: async () => ({ message: { content: "<html><head></head><body></body></html>" } }) };
    if (userMsg.includes("NOW WRITE: js/script.js")) return { ok: true, json: async () => ({ message: { content: "console.log('ok');" } }) };
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-6", onProgress: () => {} });
    assert.deepEqual(Object.keys(result.contents).sort(), ["index.html", "js/script.js"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CSS hex colors and decimal values are NOT mistaken for undeclared ids/classes", async () => {
  // MEASURED: a real generated stylesheet with `color: #333;`, `background:
  // #f9f9f9;`, `border: 1px solid #fff;`, `line-height: 1.6;` produced 21
  // false-positive continuity flags — the naive whole-file regex could not
  // tell a CSS VALUE from a CSS SELECTOR.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><h1 id="main-title" class="hero">Hi</h1></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      return { ok: true, json: async () => ({ message: { content:
        `#main-title.hero { color: #333; background: #f9f9f9; border: 1px solid #fff; line-height: 1.6; opacity: 0.1; }` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-7", onProgress: () => {} });
    assert.deepEqual(result.continuityFlags, [], "hex colors and decimal values must never be treated as id/class references");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── The watchmaker fix: the plan grows, and each file is stable before the
// next depends on it ──────────────────────────────────────────────────────

test("a file referencing a path the original plan never included is DISCOVERED and added, not silently missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      // The plan deliberately omits "extra.js", which index.html references —
      // the exact shape of the real defect: a smaller upfront plan than the
      // finished HTML actually needs. "notes.html" is a harmless second file
      // only so this satisfies planFiles' own >= 2 validation floor —
      // the mechanism under test is what happens with the THIRD, undeclared
      // file, not whether a 1-file plan is legal.
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "notes.html", language: "html", description: "x", requires: [] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head><script src="extra.js"></script></head><body></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: notes.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: extra.js")) {
      return { ok: true, json: async () => ({ message: { content: `console.log("discovered");` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-8", onProgress: () => {} });
    assert.ok(result.discoveryLog.some((d) => d.path === "extra.js" && d.discoveredFrom === "index.html"));
    assert.ok(result.contents["extra.js"], "the discovered file must actually get written, not just logged");
    assert.equal(result.files.length, 3, "the plan must have grown from 2 planned files to 3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a reference to a non-generatable asset (an image) is reported as a gap, never faked as text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "notes.html", language: "html", description: "x", requires: [] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><img src="logo.png"></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: notes.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body></body></html>` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-9", onProgress: () => {} });
    assert.ok(result.assetGaps.some((g) => g.path === "logo.png"));
    assert.equal(result.files.length, 2, "an unauthorable asset must never be added to the file plan as if it could be written");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("continuity is checked and corrected INLINE, per file — a later file never builds on unverified ground", async () => {
  // Hora, not Tempus: styles.css's bad reference must be caught and fixed
  // BEFORE script.js is even written, not batched into one pass at the end
  // after every file already exists. Proven by ORDER of calls: the
  // correction call for styles.css must occur before the write call for
  // script.js.
  const originalFetch = globalThis.fetch;
  const callOrder = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
        { path: "script.js", language: "js", description: "x", requires: ["index.html"] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      callOrder.push("write:index.html");
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><h1 id="main-title">Hi</h1></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      callOrder.push("write:styles.css");
      return { ok: true, json: async () => ({ message: { content: `.undeclared-class { color: red; }` } }) };
    }
    if (userMsg.includes("Here is a file you wrote (styles.css)")) {
      callOrder.push("correct:styles.css");
      return { ok: true, json: async () => ({ message: { content: `#main-title { color: red; }` } }) };
    }
    if (userMsg.includes("NOW WRITE: script.js")) {
      callOrder.push("write:script.js");
      return { ok: true, json: async () => ({ message: { content: `console.log("ok");` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-10", onProgress: () => {} });
    const correctIdx = callOrder.indexOf("correct:styles.css");
    const scriptIdx = callOrder.indexOf("write:script.js");
    assert.ok(correctIdx < scriptIdx, `styles.css must be corrected (index ${correctIdx}) before script.js is written (index ${scriptIdx}), not after`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Escalation: a structural mismatch patches the earlier file, additively ──

test("more than the structural-mismatch threshold of unresolved references escalates to patching the HTML additively", async () => {
  // MEASURED shape, reproduced small: styles.css wants 4 classes (over the
  // threshold of 3) that a minimal index.html never declared — the real
  // Meridian Structural run's exact failure mode, at test scale.
  const originalFetch = globalThis.fetch;
  const callOrder = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      callOrder.push("write:index.html");
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><header id="hero-section"></header></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      callOrder.push("write:styles.css");
      // 4 undeclared classes — over STRUCTURAL_MISMATCH_THRESHOLD (3).
      return { ok: true, json: async () => ({ message: { content: `.container{} .header{} .services{} .nav{}` } }) };
    }
    // The normal per-reference fix prompt: return the SAME unfixed content,
    // so only escalation (not ordinary correction) can resolve this case —
    // isolating exactly the mechanism under test.
    if (userMsg.includes("Here is a file you wrote (styles.css)")) {
      callOrder.push("correct:styles.css");
      return { ok: true, json: async () => ({ message: { content: `.container{} .header{} .services{} .nav{}` } }) };
    }
    if (userMsg.startsWith("Here is an HTML file (index.html)")) {
      callOrder.push("escalate:index.html");
      return { ok: true, json: async () => ({ message: { content:
        `<html><head></head><body><header id="hero-section" class="header"><div class="container"><div class="services"></div></div></header><nav class="nav"></nav></body></html>` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-11", onProgress: () => {} });
    assert.ok(callOrder.includes("escalate:index.html"), "the normal per-file correction alone cannot fix this; escalation must fire");
    const resolved = result.continuityFlags.find((f) => f.path === "styles.css" && f.resolved);
    assert.ok(resolved, "must end up resolved, via escalation");
    assert.equal(resolved.escalated, true);
    // ADDITIVE ONLY: the original id must still be there — escalation must
    // never remove or rename what was already stable and depended upon.
    assert.ok(result.contents["index.html"].includes('id="hero-section"'), "escalation must not destroy what already existed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Real bug: syntax verification must reflect the KEPT content, never a
// discarded draft ──────────────────────────────────────────────────────────

test("syntax verification reflects the file AFTER continuity correction, not the discarded first draft", async () => {
  // MEASURED on a real run: script.js's first draft had BOTH a real syntax
  // error and an undeclared reference. The continuity-correction loop fixed
  // the reference and, incidentally, the syntax too — but verifications had
  // already recorded the FIRST draft's failure and nothing ever re-checked
  // the version actually written to disk. BUILD_REPORT.md reported
  // "script.js: FAILED" for a file that was, in fact, fine.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "script.js", language: "js", description: "x", requires: ["index.html"] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><h1 id="main-title">Hi</h1></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: script.js")) {
      // Broken AND references an undeclared id.
      return { ok: true, json: async () => ({ message: { content: `javascript document.getElementById("missing-id");` } }) };
    }
    if (userMsg.includes("Here is a file you wrote (script.js)")) {
      // The correction call replaces the file wholesale — this version is
      // both syntactically valid and reference-clean.
      return { ok: true, json: async () => ({ message: { content: `document.getElementById("main-title");` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-14", onProgress: () => {} });
    const v = result.verifications.find((v) => v.path === "script.js");
    assert.equal(result.contents["script.js"], `document.getElementById("main-title");`, "the corrected content must be what's kept");
    assert.equal(v.syntaxOk, true, "verification must be re-run against the KEPT content, not report the discarded draft's syntax error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a correction prompt for a RIGHT-NAME-WRONG-KIND reference tells the model the vocabulary's declared kind, not just \"doesn't exist\"", async () => {
  // MEASURED: the vocabulary declares class="mobileMenuToggle"; a real run's
  // CSS wrote the correct NAME as an id selector (#mobileMenuToggle) and
  // survived 2 correction attempts unresolved, because buildFixPrompt never
  // told the model the vocabulary already settles which kind it is —
  // every correction attempt was guessing from scratch, same as the first
  // draft. The coalgebra must read from the SAME declared structure at
  // every step, not just the first.
  const originalFetch = globalThis.fetch;
  let fixPromptSeen = null;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        sharedVocabulary: [{ name: "mobileMenuToggle", kind: "class", meaning: "the button that opens the mobile nav" }],
        files: [
          { path: "index.html", language: "html", description: "x", requires: [] },
          { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
        ],
      }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><button class="mobileMenuToggle"></button></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      return { ok: true, json: async () => ({ message: { content: `#mobileMenuToggle { color: red; }` } }) }; // right name, wrong selector kind
    }
    if (userMsg.includes("Here is a file you wrote (styles.css)")) {
      fixPromptSeen = userMsg;
      return { ok: true, json: async () => ({ message: { content: `.mobileMenuToggle { color: red; }` } }) }; // corrected once told the kind
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-15", onProgress: () => {} });
    assert.ok(fixPromptSeen.includes("the shared vocabulary declares it as a class"), "the fix prompt must name the mismatch specifically, not just say the reference doesn't exist");
    assert.equal(result.contents["styles.css"], `.mobileMenuToggle { color: red; }`);
    const flag = result.continuityFlags.find((f) => f.path === "styles.css");
    assert.equal(flag.resolved, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Shared vocabulary: declared ONCE at plan time, read verbatim by every
// file — the fix for two files independently NAMING the same concept
// differently (styles.css wanting ".services", index.html escalation-
// patched to ".services-container"). This is the claim the whole fix rests
// on: prove the SAME declared name reaches two DIFFERENT files' prompts
// unchanged, not that either file's stub happens not to drift.

test("a shared vocabulary entry decided at plan time reaches EVERY file's write prompt verbatim", async () => {
  const originalFetch = globalThis.fetch;
  const prompts = {};
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        sharedVocabulary: [{ name: "services", kind: "class", meaning: "the section listing offered services" }],
        files: [
          { path: "index.html", language: "html", description: "x", requires: [] },
          { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
        ],
      }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      prompts["index.html"] = userMsg;
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body><div class="services"></div></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css")) {
      prompts["styles.css"] = userMsg;
      return { ok: true, json: async () => ({ message: { content: `.services { display: block; }` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-13", onProgress: () => {} });
    const vocabLine = `- class="services" — the section listing offered services`;
    assert.ok(prompts["index.html"].includes(vocabLine), "the FIRST file to touch the concept must already read the declared name, not invent it");
    assert.ok(prompts["styles.css"].includes(vocabLine), "a LATER file must read the SAME declared line, not a re-derived one");
    assert.equal(result.continuityFlags.length, 0, "neither file drifted from the declared vocabulary, so nothing needed correction");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an escalation patch that fails its OWN syntax check is discarded, not kept broken", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise software architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ sharedVocabulary: [], files: [
        { path: "index.html", language: "html", description: "x", requires: [] },
        { path: "styles.css", language: "css", description: "x", requires: ["index.html"] },
      ] }) } }) };
    }
    if (userMsg.includes("NOW WRITE: index.html")) {
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body></body></html>` } }) };
    }
    if (userMsg.includes("NOW WRITE: styles.css") || userMsg.includes("Here is a file you wrote (styles.css)")) {
      return { ok: true, json: async () => ({ message: { content: `.a{} .b{} .c{} .d{}` } }) };
    }
    if (userMsg.startsWith("Here is an HTML file (index.html)")) {
      // A broken escalation attempt — missing </html>, fails verifySyntax's
      // own well-formedness floor.
      return { ok: true, json: async () => ({ message: { content: `<html><head></head><body>` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeProject("a test site", { model: "stub", outDir: "/tmp/code-longform-test-12", onProgress: () => {} });
    assert.equal(result.contents["index.html"], `<html><head></head><body></body></html>`, "a broken escalation patch must never overwrite the good original");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
