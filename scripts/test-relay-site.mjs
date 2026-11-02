// Browser regression for X07–X10 / MOT-23. Run against an isolated local Relay.
// ORBIS_PLAYWRIGHT_MODULE may point at an existing Playwright installation.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.ORBIS_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.ORBIS_SITE_URL || "http://127.0.0.1:4318/relay/";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Use an isolated local Relay");
const output = resolve(process.env.ORBIS_SITE_EVIDENCE || ".artifacts/ui-regression/20261103-cinematic-site");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.ORBIS_CHROME ? { executablePath: process.env.ORBIS_CHROME } : {}) });
const checks = [];
const errors = [];
const fixture = {
  windows: [
    { name: "OrbisHost-0.1.9-windows-x64-setup.exe", url: "downloads/OrbisHost-0.1.9-windows-x64-setup.exe", checksumUrl: "downloads/OrbisHost-0.1.9-windows-x64-setup.exe.sha256", bytes: 10485760 },
    { name: "OrbisHost-0.1.12-windows-x64-setup.exe", url: "downloads/OrbisHost-0.1.12-windows-x64-setup.exe", checksumUrl: "downloads/OrbisHost-0.1.12-windows-x64-setup.exe.sha256", bytes: 12582912 },
  ],
  macos: [], android: "https://orbising.com/downloads/orbis.apk", androidVersion: "0.1.49", ios: null,
};
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const settle = async page => page.waitForTimeout(1250);
async function prepare(context, api = fixture) {
  await context.route("**/v1/site", route => route.fulfill({ status: api ? 200 : 503, json: api || { error: "unavailable" } }));
  await context.route("**/v1/registration/status", route => route.fulfill({ json: { enabled: true, qqEmailVerificationRequired: false } }));
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.sitePolicyViolations = [];
    globalThis.document.addEventListener("securitypolicyviolation", event => globalThis.sitePolicyViolations.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  await page.goto(base);
  await page.waitForSelector(".agent-pick");
  return page;
}
async function scene(page, id) {
  await page.locator(`#tab-${id}`).click();
  await page.waitForFunction(value => globalThis.document.querySelector("#demo-phone").dataset.scene === value, id);
  if (await page.locator("#demo-play").getAttribute("aria-label") === "暂停功能演示") await page.locator("#demo-play").click();
}
async function phase(page, value) {
  await page.waitForFunction(n => globalThis.document.querySelector("#phone-content").classList.contains(`phase-${n}`), value, { timeout: 16000 });
}
async function screenshot(page, name, locator) {
  if (!name.endsWith("-mid")) await page.waitForTimeout(750);
  await (locator ? page.locator(locator) : page).screenshot({ path: `${output}/${name}.png` });
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await prepare(context);
  check("prefix-safe assets and complete initial render", await page.evaluate(() => [...globalThis.document.images].every(image => image.complete && image.naturalWidth > 0)));
  check("11 Agent choices and 7 feature chapters", await page.locator(".agent-pick").count() === 11 && await page.locator("[role=tab]").count() === 7);
  check("old marketing sections removed", await page.locator("#feature-tour, #use-cases, #faq, #value-private").count() === 0);
  await page.locator("#orbit-play").click();
  await screenshot(page,"desktop-hero");
  await page.locator(".agent-pick").nth(1).click();
  check("Agent click selects Codex", await page.locator("#agent-name").textContent() === "Codex");
  await page.keyboard.press("ArrowRight");
  check("Agent keyboard arrow selects Pi", await page.locator("#agent-name").textContent() === "Pi");
  await page.keyboard.press("End");
  check("planned Agent is identified", await page.locator("#agent-name").textContent() === "OpenClaw" && await page.locator("#agent-availability").textContent() === "即将接入");
  await page.locator(".agent-pick").first().click();
  await settle(page);
  const orbit = await page.locator("#orbit-stage").boundingBox();
  await page.mouse.move(orbit.x + orbit.width / 2, orbit.y + orbit.height / 2);
  await page.mouse.down();
  await page.mouse.move(orbit.x + orbit.width / 2 - 250, orbit.y + orbit.height / 2, { steps: 12 });
  await screenshot(page,"orbit-drag-mid");
  await page.mouse.up();
  await settle(page);
  check("horizontal drag snaps to the next Agent", await page.locator("#agent-name").textContent() === "Codex");
  for (const index of [8,2,10,4]) await page.locator(".agent-pick").nth(index).click();
  await settle(page);
  check("rapid selection settles on the latest choice", await page.locator("#agent-name").textContent() === "DeepSeek" && await page.locator('.agent-pick[aria-pressed="true"]').count() === 1);
  await page.locator("#orbit-play").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#agent-name").textContent !== "DeepSeek", null, { timeout: 12000 });
  check("automatic rotation advances", true);
  await page.locator("#experience").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => globalThis.document.querySelector("#agents").dataset.playing === "false");
  check("offscreen carousel stops its clock", true);

  await scene(page,"chat");
  await page.locator('[data-action="send"]').click();
  await phase(page,3);
  check("send and ordered stream finish", await page.locator(".ink-char:not(.is-visible)").count() === 0);
  await screenshot(page,"desktop-chat","#feature-demo");
  if (await page.locator("#demo-play").getAttribute("aria-label") === "暂停功能演示") await page.locator("#demo-play").click();
  const before = await page.locator("#chapter-progress").getAttribute("style");
  await page.waitForTimeout(350);
  check("pause freezes the feature clock", before === await page.locator("#chapter-progress").getAttribute("style"));

  await scene(page,"diff");
  await page.locator('[data-action="diff-next"]').click();
  check("diff next uses second file", await page.locator("#diff-page-label").textContent() === "2 / 3");
  await page.locator('[data-action="diff-prev"]').click();
  check("diff previous restores first file", await page.locator("#diff-page-label").textContent() === "1 / 3");
  await screenshot(page,"desktop-diff","#feature-demo");

  await scene(page,"download");
  await page.locator('[data-action="download-file"]').first().click();
  await phase(page,2);
  await page.locator('[data-action="download-open"]').click();
  await phase(page,3);
  check("download flight leads to saved files", await page.locator(".download-saved-view .file-card").count() === 2 && await page.locator(".download-saved-view").isVisible());
  await screenshot(page,"desktop-download","#feature-demo");

  await scene(page,"sessions");
  await page.locator('[data-action="session-reset"]').click();
  await page.locator('[data-action="select-session"][data-index="1"]').click();
  await page.locator('[data-action="close-selected"]').click();
  await phase(page,5);
  check("batch close affects only the selected session", await page.locator('[data-row="1"]').getAttribute("aria-hidden") === "true" && await page.locator('[data-row="0"]').getAttribute("aria-hidden") === "false" && await page.locator('[data-row="2"]').getAttribute("aria-hidden") === "false");
  await screenshot(page,"desktop-sessions","#feature-demo");

  await scene(page,"create");
  await page.locator('[data-action="create-open"]').last().click();
  await phase(page,1);
  await page.locator('[data-action="create-agent"][data-agent="1"]').click();
  await page.locator('[data-action="create-submit"]').click();
  await phase(page,3);
  check("new session keeps the chosen Agent", await page.locator(".new-session-card small").textContent() === "Codex · 新会话");
  await page.waitForFunction(() => {
    const card=globalThis.document.querySelector(".new-session-card");
    const rect=card.getBoundingClientRect();
    const screen=globalThis.document.querySelector("#phone-screen").getBoundingClientRect();
    return globalThis.getComputedStyle(card).opacity === "1" && rect.left >= screen.left - 10 && rect.right <= screen.right + 10;
  });
  check("new session is actually painted inside the phone",true);
  check("closed sheet cannot keep keyboard focus", await page.locator(".new-session-sheet").getAttribute("inert") !== null);
  await screenshot(page,"desktop-create","#feature-demo");

  await scene(page,"quota");
  await page.locator('[data-action="coin"]').click();
  await phase(page,2);
  await page.locator('[data-action="coin"]').click();
  await phase(page,3);
  await page.waitForTimeout(650);
  check("coin flips to weekly quota", (await page.locator("#quota-caption").textContent()).includes("41%"));
  await screenshot(page,"desktop-quota-week","#feature-demo");
  await page.locator('[data-action="coin"]').click();
  await phase(page,4);
  check("coin flips back to five-hour quota", (await page.locator("#quota-caption").textContent()).includes("72%"));

  await scene(page,"pair");
  await page.locator('[data-action="scan"]').click();
  await phase(page,2);
  check("pairing remains explicitly a demonstration", (await page.locator(".pair-status").textContent()).includes("演示完成") && (await page.locator(".pair-note").textContent()).includes("不会配对真实电脑"));
  await screenshot(page,"desktop-pair","#feature-demo");
  await page.locator("#tab-pair").focus();
  await page.keyboard.press("Home");
  check("chapter Home key selects first scene", await page.locator("#tab-chat").getAttribute("aria-selected") === "true");

  await page.locator("#download").scrollIntoViewIfNeeded();
  check("download chooses numerically latest release", (await page.locator("#host-version").textContent()).includes("0.1.12"));
  check("download URL preserves Relay prefix", (await page.locator("#host-downloads .button").evaluate(link => link.href)).includes("/relay/downloads/"));
  await page.locator("#host-platform").selectOption("macos-arm64");
  check("unpublished desktop platform has no download", await page.locator("#host-downloads a").count() === 0);
  await page.locator("#app-platform").selectOption("ios");
  check("unpublished iOS has no invented link", await page.locator("#app-downloads a").count() === 0);
  await page.locator("#app-platform").selectOption("android");
  check("Android link follows publication API", await page.locator("#app-downloads .button").getAttribute("href") === fixture.android);
  await screenshot(page,"desktop-download-section","#download");
  check("no inline-script/style CSP violations", (await page.evaluate(() => globalThis.sitePolicyViolations)).length === 0);
  check("no JavaScript errors", errors.length === 0);

  // A1 / A2 / A3 / A4: fixed light material, browser dark preference, narrow / zoom,
  // and actual prefers-reduced-motion. This does not assert native-device acceptance.
  for (const width of [320,390,768,1920]) {
    const small = await browser.newContext({ viewport:{width,height:width<500?844:1000}, reducedMotion:"reduce", colorScheme:width===390?"dark":"light", deviceScaleFactor:1 });
    const narrow = await prepare(small);
    check(`no horizontal overflow at ${width}px`, await narrow.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
    check(`reduced motion starts both stages paused at ${width}px`, await narrow.locator("#agents").getAttribute("data-playing") === "false" && await narrow.locator("#feature-demo").getAttribute("data-playing") === "false");
    await screenshot(narrow,`viewport-${width}-hero`);
    await scene(narrow,"quota");
    await narrow.locator('[data-action="coin"]').click();
    check(`reduced-motion coin remains operable at ${width}px`, (await narrow.locator("#quota-caption").textContent()).includes("41%"));
    await screenshot(narrow,`viewport-${width}-quota`,"#feature-demo");
    await narrow.locator("#download").scrollIntoViewIfNeeded();
    check(`downloads fit at ${width}px`, await narrow.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
    check(`assets complete at ${width}px`, await narrow.evaluate(() => [...globalThis.document.images].every(image=>image.complete && image.naturalWidth>0)));
    await small.close();
  }
  const fallback = await browser.newContext({ viewport:{width:390,height:844} });
  await fallback.addInitScript(() => { delete globalThis.IntersectionObserver; });
  const fallbackPage = await prepare(fallback,null);
  check("missing observer still initializes the content", await fallbackPage.locator(".agent-pick").count()===11);
  check("failed API removes download links", await fallbackPage.locator("#host-downloads a,#app-downloads a").count()===0);
  await scene(fallbackPage,"chat");
  await fallbackPage.locator('[data-action="send"]').click();
  await phase(fallbackPage,3);
  check("missing observer still allows manual playback", await fallbackPage.locator(".ink-char:not(.is-visible)").count() === 0);
  await fallbackPage.emulateMedia({reducedMotion:"reduce"});
  await fallbackPage.waitForFunction(() => globalThis.document.querySelector("#agents").dataset.playing === "false");
  check("changing motion preference pauses playback", await fallbackPage.locator("#agents").getAttribute("data-playing")==="false");
  await fallback.close();

  const noScript=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  const plain=await noScript.newPage();
  await plain.goto(base);
  check("no-JavaScript page has headline and release fallback", await plain.locator("h1").isVisible() && await plain.locator("noscript a").count()===1);
  await screenshot(plain,"no-javascript-hero");
  await noScript.close();
  await context.close();
  check("all browser contexts remained error-free",errors.length===0);
} finally {
  await writeFile(`${output}/browser-results.json`,JSON.stringify({base,browser:browser.version(),checks,errors},null,2));
  await browser.close();
}
console.log(`${checks.length} browser checks passed. Evidence: ${output}`);
