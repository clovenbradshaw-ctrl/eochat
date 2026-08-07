#!/usr/bin/env node
// Playwright smoke test for the eoCode tab's WEBLLM path. This sandbox has
// no real WebGPU (checked separately), so a real model download/inference
// isn't possible here — instead this stubs window.EOWebLLM.stream with a
// scripted "model" (same dry-run discipline the repo's own
// scripted-adapter.mjs uses for the offline eval), which validates the
// ACTUAL client<->session-API integration end to end: the browser drives
// promptView -> generate -> /session/:id/step -> repeat, exactly as it will
// with a real WebLLM model, with only the model call itself replaced.
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { readFileSync, existsSync } from "node:fs";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
const page = await browser.newPage();
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console error]", msg.text()); });
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

const CDN_CACHE_DIR = "/tmp/eocode-cdn-cache";
await page.route(/^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\//, async (route) => {
  const url = route.request().url();
  const fn = url.replace(/^https:\/\//, "").replace(/\//g, "_").split("?")[0];
  const path = `${CDN_CACHE_DIR}/${fn}`;
  if (existsSync(path)) {
    const contentType = url.endsWith(".css") ? "text/css" : "application/javascript";
    await route.fulfill({ status: 200, contentType, body: readFileSync(path) });
  } else {
    await route.abort();
  }
});
// The real WebLLM engine module itself (esm.run) is never actually needed
// since window.EOWebLLM.stream gets replaced below before it's called —
// block it outright so the test doesn't depend on reaching esm.run at all.
await page.route(/^https:\/\/esm\.run\//, (route) => route.abort());

await page.goto("http://localhost:8899/index.html?proxyUrl=http://localhost:11435", { waitUntil: "load" });
await page.waitForTimeout(1500);

const openLink = page.locator("text=/Open →/").first();
if (await openLink.isVisible().catch(() => false)) {
  await openLink.click();
} else {
  const plusBtn = page.locator("i.ph-plus").first();
  await plusBtn.click();
  await page.waitForTimeout(500);
  const nameInput = page.locator("input[type=text]:visible").first();
  await nameInput.fill("eoCode webllm smoke");
  await nameInput.press("Enter");
}
await page.waitForTimeout(800);

// Stub the in-browser model to a fixed script instead of a real download —
// see file header. Mutates the SAME singleton index.html already subscribed
// to, then fires _emit() so the app's mirrored state (S.localModelStatus)
// updates exactly the way a real status change would.
await page.evaluate(() => {
  const script = [
    { tool: "write_file", args: { path: "wl.js", content: "console.log('hello from webllm mock');" } },
    { tool: "run_shell", args: { command: "node wl.js" } },
    { tool: "finish", args: { summary: "wrote wl.js via the WebLLM path and ran it" } },
  ];
  let i = 0;
  window.EOWebLLM.status = "ready";
  window.EOWebLLM.modelLabel = () => "Mock-WebLLM-1B";
  window.EOWebLLM.stream = async function* (messages, opts) {
    if (i >= script.length) throw new Error("mock script exhausted");
    yield JSON.stringify(script[i++]);
  };
  window.EOWebLLM._emit();
});

await page.locator("button:has-text('eoCode')").first().click();
await page.waitForTimeout(400);
await page.locator("button:has-text('WebLLM (this browser)')").click();
await page.waitForTimeout(200);

const promptBox = page.locator("textarea[placeholder*='Describe the coding task']");
await promptBox.waitFor({ state: "visible", timeout: 5000 });
await promptBox.fill("Create wl.js containing: console.log('hello from webllm mock'); Then run it and finish once you see it printed.");
const workspaceInput = page.locator("input[placeholder='workspace name']");
const workspace = "webllm-ui-smoke-" + Date.now();
await workspaceInput.fill(workspace);

console.log("clicking Run (WebLLM source)...");
await page.locator("button:has-text('Run')").first().click();

await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Run"),
  { timeout: 30000 },
).catch(() => console.log("WARNING: run did not finish within 30s"));

const bodyText = await page.locator("body").innerText();
const idx = bodyText.indexOf("Live transcript");
console.log("--- transcript area ---");
console.log(idx >= 0 ? bodyText.slice(Math.max(0, idx - 200), idx + 800) : "(no Live transcript section found)");
await page.screenshot({ path: "/tmp/eocode-webllm-ui.png", fullPage: true });

await browser.close();

const fs = await import("node:fs");
const wsFile = `/home/user/work/eochat/eocode-workspace/${workspace}/wl.js`;
console.log("--- workspace file check ---");
console.log(fs.existsSync(wsFile) ? `PASS: ${wsFile} exists — ${fs.readFileSync(wsFile, "utf8")}` : `FAIL: ${wsFile} does not exist`);
