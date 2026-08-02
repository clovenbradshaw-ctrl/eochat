// eochat/server · svg-longform.test — the third-modality instance of the
// same proof narrative-longform.test.js and code-longform.test.js already
// give for their domains: legality without lookahead, real verification,
// a continuity check that catches a cross-reference contradiction and
// doesn't false-positive on a consistent diagram. Plus things unique to
// this domain: layout is computed arithmetic, never generated; the
// arrowhead marker is synthesized in code, never asked of the model; and
// xmllint (genuinely present on this machine) gives a REAL check exercised
// for real in several tests below, not mocked.

import test from "node:test";
import assert from "node:assert/strict";
import { writeDiagram, computeLayout, verifySyntax } from "./svg-longform.js";

function planResponse() {
  const elements = [
    { id: "start", kind: "node", description: "the start step", role: null, col: 0, row: 0 },
    { id: "end", kind: "node", description: "the end step", role: null, col: 1, row: 0 },
    { id: "e1", kind: "edge", description: "connects start to end", from: "start", to: "end", label: null },
  ];
  return { sharedStyle: [], elements };
}

function stubModel({ badRef = null } = {}) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"')) {
      // Local (0,0)-anchored frame — no absolute position, no <g id> of its
      // own, matching the current contract (see buildWritePrompt's node
      // branch): code wraps this in the real positioned <g>.
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64" fill="#4CAF50"/><text x="75" y="35">Start</text>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"')) {
      const ref = badRef ? ` fill="url(#${badRef})"` : "";
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"${ref}/><text x="75" y="35">End</text>` } }) };
    }
    if (userMsg.includes("Here is an SVG fragment you wrote")) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/><text x="75" y="35">End</text>` } }) }; // corrected: drops the bad reference
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return { ok: true, json: async () => ({ message: { content: `<g id="e1"><line x1="245" y1="222" x2="655" y2="222" stroke="#333" marker-end="url(#arrowhead)"/></g>` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
}

test("computeLayout derives distinct columns from the edge graph — a direct edge forces its target one column later", () => {
  const elements = [
    { id: "a", kind: "node" },
    { id: "b", kind: "node" },
    { id: "c", kind: "node" },
    { id: "e1", kind: "edge", from: "a", to: "b" }, // a -> b: b must land one column after a
  ];
  const { positions, cols } = computeLayout(elements);
  assert.equal(cols, 2, "a->b spans exactly 2 ranks; c (no edges) sits at rank 0 alongside a");
  assert.notEqual(positions.get("a").x, positions.get("b").x, "a direct edge must force distinct columns");
  assert.equal(positions.get("a").x, positions.get("c").x, "c shares a's rank (no edges touch it), so it shares a's column");
  assert.notEqual(positions.get("a").y, positions.get("c").y, "siblings sharing a rank (a and c) must still get distinct rows, never the same cell");
});

test("computeLayout gives every node in a dense diagram (no two sharing both rank and row) a distinct, non-overlapping center", () => {
  // 8 nodes in a single chain: a->b->c->...->h. Every node must land on its
  // own column since each directly depends on the one before it.
  const ids = "abcdefgh".split("");
  const elements = [
    ...ids.map((id) => ({ id, kind: "node" })),
    ...ids.slice(0, -1).map((id, i) => ({ id: `${id}->${ids[i + 1]}`, kind: "edge", from: id, to: ids[i + 1] })),
  ];
  const { positions, box, cols } = computeLayout(elements);
  assert.equal(cols, 8, "an 8-node chain must produce 8 distinct ranks");
  assert.ok(box.w > 0 && box.h > 0, "box must stay positive even on a dense chain");
  const seen = new Set();
  for (const id of ids) {
    const p = positions.get(id);
    const key = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    assert.ok(!seen.has(key), `node "${id}" must not share a center with an earlier node`);
    seen.add(key);
  }
});

test("computeLayout tolerates a genuine cycle (a retry loop) without infinite growth or a crash", () => {
  // a -> b -> c -> a: a real cycle, no valid topological order exists.
  const elements = [
    { id: "a", kind: "node" }, { id: "b", kind: "node" }, { id: "c", kind: "node" },
    { id: "e1", kind: "edge", from: "a", to: "b" },
    { id: "e2", kind: "edge", from: "b", to: "c" },
    { id: "e3", kind: "edge", from: "c", to: "a" }, // the back-edge
  ];
  const { positions, cols } = computeLayout(elements);
  // The back-edge (c->a) is excluded from ranking entirely, so this is a
  // tight bound, not just "doesn't blow up": a->b->c is the only forward
  // path, so exactly 3 ranks.
  assert.equal(cols, 3, "the back-edge must be excluded from ranking, leaving only the forward a->b->c chain");
  assert.ok(["a", "b", "c"].every((id) => positions.has(id) && Number.isFinite(positions.get(id).x)));
});

test("a node's placement is correct regardless of what the model draws inside its local frame — even a stray transform or absolute coordinates it wasn't given", async () => {
  // MEASURED on a real run: given an ABSOLUTE center to place itself at, the
  // model added its own rotate/skew transform and, separately, used a
  // nonexistent `<g x=".." y="..">` attribute that silently did nothing —
  // both left the shape nowhere near where it was supposed to be. The fix
  // stops asking the model to position itself at all: it draws in a local
  // (0,0)-anchored frame, and code wraps that in the real translate. This
  // must hold even when the model's own fragment is adversarial — using
  // some unrelated absolute coordinate, or adding its own transform.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"')) {
      // Adversarial: an unrelated absolute position AND the model's own transform.
      return { ok: true, json: async () => ({ message: { content: `<g transform="rotate(15)"><rect x="9999" y="9999" width="150" height="64"/></g>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"')) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/>` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-10/diagram.svg", onProgress: () => {} });
    const startPos = result.layout.positions.get("start");
    assert.ok(result.contents["start"].includes(`<g id="start" transform="translate(`), "the OUTER wrapper, supplied by code, must carry the real computed position");
    assert.ok(result.contents["start"].includes(`translate(${(startPos.x - startPos.w / 2).toFixed(1)}`), "the translate must be the code-computed value, not derived from anything the model wrote");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a node with a self-closed, empty <text> (syntactically valid, reference-clean, but INVISIBLE) is flagged and corrected", async () => {
  // MEASURED: a real run's node fragment was `<text ... />` — passes
  // xmllint (well-formed) and checkSvgReferences (nothing undeclared) but
  // renders NO label at all. Neither existing check catches this; it needs
  // its own.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"')) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/><text x="10" y="30"/>` } }) }; // self-closed, no content
    }
    if (userMsg.includes("Here is an SVG fragment you wrote")) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/><text x="10" y="30">Start</text>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-12/diagram.svg", onProgress: () => {} });
    assert.ok(result.contents["start"].includes(">Start<"), "the corrected, visibly-labeled version must be what's kept");
    const flag = result.continuityFlags.find((f) => f.id === "start" && f.resolved);
    assert.ok(flag, "the missing-label issue must be reported as resolved once corrected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a node whose label stays empty after correction attempts is reported unresolved, never silently shipped invisible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"') || userMsg.includes("Here is an SVG fragment you wrote")) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/>` } }) }; // never gets a label, even after correction
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-13/diagram.svg", onProgress: () => {} });
    const flag = result.continuityFlags.find((f) => f.id === "start" && f.issue === "missing-label");
    assert.ok(flag, "must be reported as an unresolved missing-label issue");
    assert.equal(flag.resolved, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a percentage coordinate (resolves against the wrong viewport, renders far outside its box) is flagged and corrected", async () => {
  // MEASURED: a real fragment used x="50%" y="40%" on its label text.
  // Percentages resolve against the ROOT viewport in this design (there is
  // no nested viewport for them to be relative to), so the label rendered
  // nowhere near its own box — syntactically fine, reference-clean, still
  // wrong.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"')) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/><text x="50%" y="40%">Start</text>` } }) };
    }
    if (userMsg.includes("Here is an SVG fragment you wrote")) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/><text x="40" y="30">Start</text>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-14/diagram.svg", onProgress: () => {} });
    assert.ok(!result.contents["start"].includes("%"), "the corrected version must not contain a percentage coordinate");
    const flag = result.continuityFlags.find((f) => f.id === "start" && f.resolved);
    assert.ok(flag, "the percent-coordinate issue must be reported as resolved once corrected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an edge that invents its own <marker>/<symbol> redefining the arrowhead is flagged and corrected", async () => {
  // MEASURED: an edge fragment defined its own <symbol id="arrowhead">,
  // apparently unsure whether the shared one already existed —
  // well-formed XML, just inert clutter nobody asked for.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return { ok: true, json: async () => ({ message: { content: `<symbol id="arrowhead"><path d="M0,0 L1,1 Z"/></symbol><g id="e1"><line x1="0" y1="0" x2="10" y2="10" marker-end="url(#arrowhead)"/></g>` } }) };
    }
    if (userMsg.includes("Here is an SVG fragment you wrote")) {
      return { ok: true, json: async () => ({ message: { content: `<g id="e1"><line x1="0" y1="0" x2="10" y2="10" marker-end="url(#arrowhead)"/></g>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "end"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-15/diagram.svg", onProgress: () => {} });
    assert.ok(!result.contents["e1"].includes("<symbol"), "the invented redefinition must be removed from the KEPT content");
    const flag = result.continuityFlags.find((f) => f.id === "e1" && f.resolved);
    assert.ok(flag, "the invented-definition issue must be reported as resolved once corrected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an edge's <path> with x1/y1/x2/y2 but no \"d\" attribute (draws NOTHING, invisible) is flagged and corrected", async () => {
  // MEASURED: half the edges on a real run vanished this way — <path>
  // only understands "d"; x1/y1/x2/y2 are <line>-only attributes. A
  // <path> with none of those and no "d" is well-formed XML and
  // reference-clean, and renders literally nothing.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return { ok: true, json: async () => ({ message: { content: `<g id="e1"><path x1="0" y1="0" x2="10" y2="10" stroke="#333" marker-end="url(#arrowhead)"/></g>` } }) };
    }
    if (userMsg.includes("Here is an SVG fragment you wrote")) {
      return { ok: true, json: async () => ({ message: { content: `<g id="e1"><path d="M 0,0 L 10,10" stroke="#333" marker-end="url(#arrowhead)"/></g>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "end"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-16/diagram.svg", onProgress: () => {} });
    assert.ok(result.contents["e1"].includes('d="M 0,0 L 10,10"'), "the corrected version, with a real d attribute, must be what's kept");
    const flag = result.continuityFlags.find((f) => f.id === "e1" && f.resolved);
    assert.ok(flag, "the no-renderable-geometry issue must be reported as resolved once corrected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a <line> element (which legitimately uses x1/y1/x2/y2) is NOT mistaken for the path-without-d defect", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return { ok: true, json: async () => ({ message: { content: `<g id="e1"><line x1="0" y1="0" x2="10" y2="10" stroke="#333" marker-end="url(#arrowhead)"/></g>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "end"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-17/diagram.svg", onProgress: () => {} });
    assert.deepEqual(result.continuityFlags, [], "a legitimate <line> must never be flagged as missing geometry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an oversized font-size on a node label is clamped to fit its box, mechanically — not routed through a correction round-trip", async () => {
  // MEASURED: several nodes used font-size="24" inside a box only 64px
  // tall, overflowing above/below and visually colliding with
  // NEIGHBORING nodes' text. Unlike position, the safe font-size range is
  // already fully known (the box height), so this is clamped directly —
  // no model round-trip needed, and no correction attempt should even be
  // logged for it.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"')) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/><text x="20" y="30" font-size="24">Start</text>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-18/diagram.svg", onProgress: () => {} });
    assert.ok(!result.contents["start"].includes('font-size="24"'), "the oversized font-size must be clamped down");
    assert.equal(result.continuityFlags.filter((f) => f.id === "start").length, 0, "clamping must not consume a correction attempt or get logged as an unresolved issue");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifySyntax (REAL xmllint check, not mocked): valid SVG passes", () => {
  const result = verifySyntax(`<rect x="0" y="0" width="10" height="10" fill="#333"/>`);
  assert.equal(result.ok, true);
});

test("verifySyntax (REAL xmllint check, not mocked): a bare '&' is caught, which a tag-balance heuristic would miss", () => {
  const result = verifySyntax(`<text>Terms & Conditions</text>`);
  assert.equal(result.ok, false);
  assert.ok(result.reason, "a real parser error message must be captured, not just a boolean");
});

test("verifySyntax (REAL xmllint check, not mocked): mismatched tags are caught", () => {
  const result = verifySyntax(`<g><rect/></rect>`);
  assert.equal(result.ok, false);
});

test("a legitimate xlink:href reference passes verification — the xlink namespace must be declared", () => {
  // MEASURED: xmllint prints a namespace error to stderr for an
  // undeclared xlink prefix but exits 0 — a real run's assembled document
  // passed this check yet failed to render in an actual browser.
  // Declaring xmlns:xlink unconditionally on the wrapper closes this gap.
  const result = verifySyntax(`<use xlink:href="#arrowhead" width="16" height="16"/>`);
  assert.equal(result.ok, true, "a legitimate xlink:href must not be rejected once the namespace is declared");
});

test("the assembled document declares the xlink namespace on its root — xlink:href must actually render in a browser, not just pass xmllint's exit code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-11/diagram.svg", onProgress: () => {} });
    assert.ok(result.svg.includes('xmlns:xlink="http://www.w3.org/1999/xlink"'), "the root <svg> must declare xmlns:xlink unconditionally");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the arrowhead marker is synthesized deterministically — no model call ever asked to author it", async () => {
  const originalFetch = globalThis.fetch;
  let arrowheadPromptSeen = false;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.includes('element "arrowhead"')) arrowheadPromptSeen = true;
    return stubModel()(url, opts);
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-0/diagram.svg", onProgress: () => {} });
    assert.equal(arrowheadPromptSeen, false, "the model must never be asked to write the arrowhead marker");
    assert.ok(result.svg.includes('<marker id="arrowhead"'), "the synthesized marker must still be present in the assembled document");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a malformed plan element (missing id/kind) is filtered out and reported as a gap, never silently collided with another one", async () => {
  // MEASURED on a real run: the model returned an element with neither id
  // nor kind. Before validation, this collided with a second malformed
  // element on the SAME synthetic task_id "el:undefined", silently
  // dropping one instead of reporting either.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        sharedStyle: [],
        elements: [
          { id: "start", kind: "node", description: "x", col: 0, row: 0 },
          { id: "end", kind: "node", description: "x", col: 1, row: 0 },
          { id: "e1", kind: "edge", description: "x", from: "start", to: "end" },
          {}, // malformed: no id, no kind
          { description: "also malformed, no id or kind" },
        ],
      }) } }) };
    }
    return stubModel()(url, opts);
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-8/diagram.svg", onProgress: () => {} });
    assert.equal(result.elements.length, 3, "only the 3 valid elements must survive into the driven plan");
    assert.equal(result.gaps.length, 2, "both malformed elements must be reported as gaps, not silently merged into one");
    assert.ok(result.contents["start"] && result.contents["end"] && result.contents["e1"], "the valid elements must still get written normally");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an edge referencing a node id absent from the plan is filtered out as a gap rather than crashing the whole build", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        sharedStyle: [],
        elements: [
          { id: "start", kind: "node", description: "x", col: 0, row: 0 },
          { id: "end", kind: "node", description: "x", col: 1, row: 0 },
          { id: "e1", kind: "edge", description: "x", from: "start", to: "end" },
          { id: "e2", kind: "edge", description: "x", from: "start", to: "nonexistentNode" },
        ],
      }) } }) };
    }
    return stubModel()(url, opts);
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-9/diagram.svg", onProgress: () => {} });
    assert.ok(!result.elements.some((e) => e.id === "e2"), "an edge pointing at a nonexistent node must be dropped");
    assert.ok(result.gaps.some((g) => g.id === "e2"), "the drop must be reported as a gap, naming which edge and why");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a fully consistent diagram is NOT flagged — no false positives", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-1/diagram.svg", onProgress: () => {} });
    assert.deepEqual(result.continuityFlags, []);
    assert.ok(result.verifications.every((v) => v.syntaxOk), "every element must pass the real xmllint check");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an edge referencing a marker id that does not exist is flagged and corrected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel({ badRef: "nonexistent-marker" });
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-2/diagram.svg", onProgress: () => {} });
    const flag = result.continuityFlags.find((f) => f.id === "end");
    assert.ok(flag, "must flag the undeclared reference");
    assert.equal(flag.resolved, true, "the correction attempt must have succeeded");
    assert.ok(!result.contents["end"].includes("nonexistent-marker"), "the KEPT fragment must be the corrected version");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("elements are written in existence-dependency order — an edge never precedes either endpoint it connects", async () => {
  const originalFetch = globalThis.fetch;
  const order = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    const m = /NOW WRITE the SVG markup fragment for element "(\S+)"/.exec(userMsg);
    if (m) order.push(m[1]);
    return stubModel()(url, opts);
  };
  try {
    await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-3/diagram.svg", onProgress: () => {} });
    const edgeIdx = order.indexOf("e1");
    const startIdx = order.indexOf("start");
    const endIdx = order.indexOf("end");
    assert.ok(startIdx < edgeIdx && endIdx < edgeIdx, `edge "e1" (index ${edgeIdx}) must come after BOTH endpoints (start=${startIdx}, end=${endIdx})`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires for an edge is DERIVED from from/to, ignoring any separately declared list that might drift from them", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        sharedStyle: [],
        elements: [
          { id: "start", kind: "node", description: "x", col: 0, row: 0 },
          { id: "end", kind: "node", description: "x", col: 1, row: 0 },
          // requires deliberately WRONG/empty — must be ignored and derived from from/to instead
          { id: "e1", kind: "edge", description: "x", from: "start", to: "end", requires: [] },
        ],
      }) } }) };
    }
    return stubModel()(url, opts);
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-4/diagram.svg", onProgress: () => {} });
    assert.ok(result.contents["start"] && result.contents["end"] && result.contents["e1"], "all three elements must still get written despite the wrong declared requires");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the correction prompt carries sharedStyle from the FIRST attempt — learned proactively from code-longform.js's own gap, not rediscovered reactively here", async () => {
  const originalFetch = globalThis.fetch;
  let fixPromptSeen = null;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        sharedStyle: [{ name: "errorFill", value: "#F44336", meaning: "a rejected/error step" }],
        elements: [
          { id: "start", kind: "node", description: "x", col: 0, row: 0 },
          { id: "end", kind: "node", description: "x", col: 1, row: 0 },
          { id: "e1", kind: "edge", description: "x", from: "start", to: "end" },
        ],
      }) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"')) {
      return { ok: true, json: async () => ({ message: { content: `<rect fill="url(#missing)"/>` } }) };
    }
    if (userMsg.includes("Here is an SVG fragment you wrote")) {
      fixPromptSeen = userMsg;
      return { ok: true, json: async () => ({ message: { content: `<rect fill="#F44336"/>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"') || userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return stubModel()(url, opts);
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-5/diagram.svg", onProgress: () => {} });
    assert.ok(fixPromptSeen.includes('"errorFill" = #F44336'), "the fix prompt must carry the shared style, not just the bare undeclared-reference list");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("syntax verification reflects the fragment AFTER correction, not a discarded first draft", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.startsWith("You are a precise diagram architect")) {
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(planResponse()) } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "start"')) {
      return { ok: true, json: async () => ({ message: { content: `<rect width="150" height="64"/>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "end"')) {
      // Both malformed (unclosed tag) AND references a missing id.
      return { ok: true, json: async () => ({ message: { content: `<rect fill="url(#missing)">` } }) };
    }
    if (userMsg.includes("Here is an SVG fragment you wrote")) {
      return { ok: true, json: async () => ({ message: { content: `<rect fill="#333"/>` } }) };
    }
    if (userMsg.includes('NOW WRITE the SVG markup fragment for element "e1"')) {
      return { ok: true, json: async () => ({ message: { content: `<g id="e1"></g>` } }) };
    }
    return { ok: true, json: async () => ({ message: { content: "" } }) };
  };
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-6/diagram.svg", onProgress: () => {} });
    const v = result.verifications.find((v) => v.id === "end");
    assert.ok(result.contents["end"].includes(`<rect fill="#333"/>`), "the KEPT content must be the corrected inner fragment");
    assert.ok(!result.contents["end"].includes("missing"), "the malformed/undeclared-reference draft must not survive");
    assert.equal(v.syntaxOk, true, "verification must reflect the KEPT, corrected fragment, not the malformed first draft");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the assembled SVG document is itself real, valid XML (end-to-end, REAL xmllint, not mocked)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubModel();
  try {
    const result = await writeDiagram("a simple flowchart", { model: "stub", outPath: "/tmp/svg-longform-test-7/diagram.svg", onProgress: () => {} });
    const wholeDoc = verifySyntax(result.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, ""));
    assert.equal(wholeDoc.ok, true, `assembled document must itself be well-formed: ${wholeDoc.reason}`);
    assert.ok(result.svg.includes('id="arrowhead"'));
    assert.ok(result.svg.includes('id="start"'));
    assert.ok(result.svg.includes('id="end"'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
