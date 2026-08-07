#!/usr/bin/env node
// One-off Playwright smoke test for the eoCode tab: opens the real UI,
// clicks the tab, submits a task, and confirms the live SSE transcript
// actually renders in the DOM (not just that the server accepts it).
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { readFileSync, existsSync } from "node:fs";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
const page = await browser.newPage();
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console error]", msg.text()); });
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

// This sandbox's outbound network goes through an agent-proxy relay that
// doesn't speak Chromium's plain-HTTP-proxy dialect. Since these are just
// vendored, version-pinned CDN scripts the app boots with (React, katex,
// etc.), serve them from a local cache fetched once via curl (which the
// shell's proxy handles fine) instead of fighting browser proxy config.
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

await page.goto("http://localhost:8899/index.html?proxyUrl=http://localhost:11435", { waitUntil: "load" });
await page.waitForTimeout(1500);

await page.screenshot({ path: "/tmp/eocode-ui-1.png" });
console.log("BODY TEXT:", (await page.locator("body").innerText()).slice(0, 1500));
const allButtons = await page.locator("button").allInnerTexts();
console.log("visible buttons:", JSON.stringify(allButtons.filter(Boolean).slice(0, 40)));

// A prior run of this smoke test may have left the project behind (the
// project store persists server-side) — reuse it via "Open →" if so,
// otherwise create one via the sidebar "+".
const openLink = page.locator("text=/Open →/").first();
if (await openLink.isVisible().catch(() => false)) {
  console.log("reusing existing project");
  await openLink.click();
  await page.waitForTimeout(600);
} else {
  const plusBtn = page.locator("i.ph-plus").first();
  if (await plusBtn.isVisible().catch(() => false)) {
    console.log("clicking the sidebar + (new project)");
    await plusBtn.click();
    await page.waitForTimeout(500);
    const nameInput = page.locator("input[type=text]:visible, input:not([type]):visible").first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill("eoCode smoke test");
      await nameInput.press("Enter");
      await page.waitForTimeout(800);
    }
  }
}
await page.screenshot({ path: "/tmp/eocode-ui-2.png" });
console.log("BODY TEXT 2:", (await page.locator("body").innerText()).slice(0, 1500));

await page.locator("button:has-text('eoCode')").first().click();
await page.waitForTimeout(500);
console.log("clicked eoCode tab");

const promptBox = page.locator("textarea[placeholder*='Describe the coding task']");
await promptBox.waitFor({ state: "visible", timeout: 5000 });
await promptBox.fill("Create ok.js containing: console.log('OK'); Then run it with run_shell (node ok.js) and finish once you see OK printed.");

const workspaceInput = page.locator("input[placeholder='workspace name']");
await workspaceInput.fill("ui-smoke-" + Date.now());

await page.locator("button:has-text('Run')").first().click();
console.log("clicked Run — waiting for live transcript entries...");

await page.waitForFunction(
  () => document.body.innerText.includes("step 0:"),
  { timeout: 30000 },
).catch(() => console.log("WARNING: no 'step 0:' text appeared within 30s"));

// Wait for the run to actually finish (Run button reappears once eoCodeRunning
// flips false) rather than a fixed sleep — real completion, not a guess.
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Run"),
  { timeout: 240000 },
).catch(() => console.log("WARNING: run did not finish within 240s"));

const bodyText = await page.locator("body").innerText();
const transcriptLines = bodyText.split("\n").filter((l) => /^(◌|◇|→|←|⚠|⊙|●|⊘)/.test(l.trim()) || /step \d+:/.test(l) || /^(Finished|Stopped)/.test(l.trim()));
console.log("--- visible transcript-ish lines ---");
console.log(transcriptLines.join("\n"));
console.log(`--- (${transcriptLines.length} matching lines total) ---`);
await page.screenshot({ path: "/tmp/eocode-ui-3.png", fullPage: true });

await browser.close();
