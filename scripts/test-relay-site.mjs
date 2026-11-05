// Browser regression for X07–X10 / MOT-23. Run against an isolated local Relay.
// ORBIS_PLAYWRIGHT_MODULE may point at an existing Playwright installation.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.ORBIS_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.ORBIS_SITE_URL || "http://127.0.0.1:4318/relay/";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Use an isolated local Relay");
const output = resolve(process.env.ORBIS_SITE_EVIDENCE || ".artifacts/ui-regression/20261103-cinematic-fidelity");
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
// Required assets and semantic identities must exist; an empty DOM is never a passing render.
async function requiredImages(page, name) {
  const loaded = () => {
    const logo = globalThis.document.querySelector(".site-header .brand img");
    const picks = [...globalThis.document.querySelectorAll(".agent-pick")];
    const icons = picks.map(pick => pick.querySelector("img"));
    const prefix = new URL("assets/", globalThis.location.href).pathname;
    return logo !== null && picks.length > 0 && icons.every(Boolean)
      && [logo, ...icons].every(image => image.complete && image.naturalWidth > 0
        && new URL(image.currentSrc).pathname.startsWith(prefix));
  };
  await page.waitForFunction(loaded);
  check(name, await page.evaluate(loaded));
}

async function navigationIdentity(page) {
  return page.evaluate(() => {
    const picks = [...globalThis.document.querySelectorAll(".agent-pick")];
    const names = picks.map(pick => pick.title.trim());
    const required = ["Claude Code", "Codex", "Pi", "Codex Desktop", "DeepSeek", "OpenClaw"];
    const selected = picks.filter(pick => pick.getAttribute("aria-pressed") === "true");
    const tabs = [...globalThis.document.querySelectorAll("[role=tab]")];
    const scenes = tabs.map(tab => tab.dataset.scene);
    const selectedTabs = tabs.filter(tab => tab.getAttribute("aria-selected") === "true");
    return required.every(name => names.includes(name)) && names.every(Boolean)
      && new Set(names).size === names.length && selected.length === 1
      && selected[0].title === globalThis.document.querySelector("#agent-name").textContent
      && picks.every(pick => pick.getAttribute("aria-label")?.startsWith(pick.title + "，"))
      && ["chat", "diff", "download", "sessions", "create", "quota", "pair"].every(scene => scenes.includes(scene))
      && new Set(scenes).size === scenes.length && new Set(tabs.map(tab => tab.id)).size === tabs.length
      && tabs.every(tab => tab.id && globalThis.document.getElementById(tab.getAttribute("aria-controls"))?.getAttribute("role") === "tabpanel")
      && selectedTabs.length === 1 && globalThis.document.getElementById(selectedTabs[0].getAttribute("aria-controls"))?.getAttribute("aria-labelledby") === selectedTabs[0].id;
  });
}

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
  await page.locator("#film-viewport").scrollIntoViewIfNeeded();
  await page.waitForFunction(value => globalThis.document.querySelector("#feature-demo").dataset.scene === value, id);
}
async function finished(page) {
  await page.waitForFunction(() => globalThis.document.querySelector("#feature-demo").dataset.animating === "false", null, {timeout:16000});
}
async function opacity(page, selector) {
  return page.locator(selector).evaluate(el=>Number(globalThis.getComputedStyle(el).opacity));
}
async function screenshot(page, name, locator) {
  if (!name.endsWith("-mid")) await page.waitForTimeout(750);
  await (locator ? page.locator(locator) : page).screenshot({ path: `${output}/${name}.png` });
}
async function foreground(page, name, underneath) {
  // Inert pages still paint. Compare real pixels with and without the underlying
  // page so a fully visible but visually occluded destination cannot pass.
  const rect=await page.locator('#s4-scr').boundingBox();
  const clip={x:Math.ceil(rect.x+rect.width*.2),y:Math.ceil(rect.y+rect.height*.2),width:Math.floor(rect.width*.6),height:Math.floor(rect.height*.6)};
  const before=await page.screenshot({clip,path:`${output}/${name}-foreground.png`});
  const previous=await page.locator(underneath).evaluateAll(els=>els.map(el=>{const value=el.style.visibility;el.style.visibility='hidden';return value;}));
  let isolated;
  try { isolated=await page.screenshot({clip,path:`${output}/${name}-isolated.png`}); }
  finally { await page.locator(underneath).evaluateAll((els,values)=>els.forEach((el,i)=>{el.style.visibility=values[i];}),previous); }
  const maxDelta=before.equals(isolated)?0:await page.evaluate(async encoded=>{
    const pixels=await Promise.all(encoded.map(async value=>{
      const bitmap=await globalThis.createImageBitmap(new globalThis.Blob([Uint8Array.from(globalThis.atob(value),c=>c.charCodeAt(0))],{type:'image/png'}));
      const canvas=new globalThis.OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
      context.drawImage(bitmap,0,0);bitmap.close();return context.getImageData(0,0,canvas.width,canvas.height).data;
    }));
    return pixels[0].reduce((max,value,i)=>Math.max(max,Math.abs(value-pixels[1][i])),0);
  },[before.toString('base64'),isolated.toString('base64')]);
  // Compositing can round colors by one channel value; any real overlap must fail.
  check(`${name} paints above its previous page`,maxDelta<=2);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await prepare(context);
  await requiredImages(page, "required brand and Agent images load through the Relay prefix");
  check("required Agent and chapter identities are unique and correctly linked", await navigationIdentity(page));
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
  const orbitFrames = await page.evaluate(() => new Promise(resolve => {
    const frames = [], started = globalThis.performance.now();
    const sample = now => {
      frames.push({ at: now, time: globalThis.document.querySelector("#agents").dataset.time,
        angle: Number(globalThis.gsap.getProperty("#s3-ring", "rotationY")) });
      if (now - started < 350) globalThis.requestAnimationFrame(sample); else resolve(frames);
    };
    globalThis.requestAnimationFrame(sample);
  }));
  await writeFile(`${output}/offscreen-orbit-frames.json`, JSON.stringify(orbitFrames));
  check("offscreen carousel freezes playback time and actual rotation", orbitFrames.length >= 5
    && orbitFrames.at(-1).at - orbitFrames[0].at >= 250
    && orbitFrames.every(frame => frame.time !== undefined && frame.time === orbitFrames[0].time
      && Number.isFinite(frame.angle) && Math.abs(frame.angle - orbitFrames[0].angle) < 0.0001));

  await scene(page,"chat");
  await page.evaluate(() => {
    globalThis.inkFrames = []; globalThis.recordInk = true;
    const sample = now => {
      const text = globalThis.document.querySelector("#s4-p2"), spans = [...text.querySelectorAll("span")];
      globalThis.inkFrames.push({ at: now, text: text.textContent, count: spans.length,
        complete: spans.length > 0 && spans.every(span => Number(globalThis.getComputedStyle(span).opacity) >= 0.999),
        permission: Number(globalThis.getComputedStyle(globalThis.document.querySelector("#s4-ask")).opacity) });
      if (globalThis.recordInk) globalThis.requestAnimationFrame(sample);
    };
    globalThis.requestAnimationFrame(sample);
  });
  await page.locator('#s4-send').click();
  await page.waitForTimeout(240);
  check("send flight moves before handing off the bubble", await opacity(page,"#s4-sf")>0 && await opacity(page,"#s4-qb")<1);
  await screenshot(page,"send-flight-mid","#film-viewport");
  await finished(page);
  const inkFrames = await page.evaluate(() => { globalThis.recordInk = false; return globalThis.inkFrames; });
  await writeFile(`${output}/ink-permission-frames.json`, JSON.stringify(inkFrames));
  const permissionFrames = inkFrames.filter(frame => frame.permission > 0.001);
  check("nonempty ink completes before permission becomes visible", inkFrames.length > 2
    && inkFrames.every(frame => frame.count > 0 && frame.text.trim().length > 0)
    && inkFrames.some(frame => !frame.complete) && permissionFrames.length > 0
    && permissionFrames.every(frame => frame.complete)
    && inkFrames.at(-1).complete && await opacity(page,"#s4-ask") === 1);
  await page.locator('#s4-allow').click();await finished(page);
  check("permission receipt and recent question are visible", (await page.locator('#s4-askst').textContent()).includes("已允许") && await opacity(page,"#s4-remind")===1);
  await page.locator('#s4-remind').click();await finished(page);
  await page.locator('#s4-jump').click();await finished(page);
  check("latest jump dismisses the reminder", await opacity(page,"#s4-remind")===0);
  await screenshot(page,"desktop-chat","#feature-demo");
  await page.locator('#demo-play').click();await page.waitForTimeout(300);await page.locator('#demo-play').click();
  const before=await page.locator('#feature-demo').getAttribute('data-time');await page.waitForTimeout(350);
  check("pause freezes the feature clock",before===await page.locator('#feature-demo').getAttribute('data-time'));
  await page.locator('#demo-replay').click();await page.locator('#s4-send').click();await finished(page);await page.locator('#s4-deny').click();await finished(page);
  check("permission denial has a distinct receipt",(await page.locator('#s4-askst').textContent()).includes("已拒绝") && await opacity(page,'#s4-ask')===0);

  await scene(page,"diff");
  await page.locator('[data-action="diff-next"]').click();await finished(page);
  check("diff next uses second file", await page.locator("#film-pagecount").textContent()==="2 / 3");
  await page.locator('[data-action="diff-next"]').click();await finished(page);
  check("third file includes an actual diff", await page.locator("#s4-pager .dpage").nth(2).locator('.dline').count()>0);
  await page.locator('[data-action="diff-prev"]').click();await finished(page);await page.locator('[data-action="diff-prev"]').click();await finished(page);
  check("diff previous restores first file", await page.locator("#film-pagecount").textContent()==="1 / 3");
  const hit=await page.locator('.film-diff-hit').boundingBox();
  await page.mouse.move(hit.x+hit.width*.8,hit.y+hit.height*.4);await page.mouse.down();await page.mouse.move(hit.x+hit.width*.2,hit.y+hit.height*.4,{steps:12});await page.mouse.up();await finished(page);
  check("diff horizontal drag changes files",await page.locator('#film-pagecount').textContent()==="2 / 3");
  await screenshot(page,"desktop-diff","#feature-demo");
  await page.locator('[data-action="back-chat"]').first().click();await finished(page);
  check("full-page back returns to chat",await page.locator('#feature-demo').getAttribute('data-page')==='chat');
  await page.locator('#s4-diffrow').click();await finished(page);
  await foreground(page,"manual-diff",'#s4-chat');

  await scene(page,"download");
  await page.locator('#s4-f0').click();await page.waitForTimeout(230);
  check("download uses a visible flying file",await opacity(page,'#s4-fly')>0);
  await screenshot(page,"download-flight-mid","#film-viewport");await finished(page);
  await page.locator('#s4-dlbtn').click();await finished(page);
  check("download list contains only the selected file", await page.locator('[data-download-file="0"]').isVisible() && await page.locator('[data-download-file="1"]').isHidden());
  await foreground(page,"manual-download",'#s4-chat');
  await page.locator('[data-action="back-download"]').click();await finished(page);await page.locator('#s4-f1').click();await finished(page);await page.locator('#s4-dlbtn').click();await finished(page);
  check("both downloaded files are saved",await page.locator('[data-download-file]:visible').count()===2 && await opacity(page,'#s4-d0b')===1);
  await screenshot(page,"desktop-download","#feature-demo");

  await scene(page,"sessions");
  await page.locator('#s4-c1').click();await finished(page);await page.locator('#s4-closeall').click();await finished(page);
  check("batch close affects only selected session",await page.locator('#s4-c1').getAttribute('aria-hidden')==='true' && await page.locator('#s4-c0').getAttribute('aria-hidden')==='false' && await page.locator('#s4-c2').getAttribute('aria-hidden')==='false');
  check("toolbar returns after closing selection",(await page.locator('#s4-menu').getAttribute('aria-label'))==='打开会话目录');
  await screenshot(page,"desktop-sessions","#feature-demo");
  await page.locator('#s4-dlhome').click();await finished(page);
  await foreground(page,"home-download",'#s4-home');
  await page.locator('[data-action="back-download"]').click();await finished(page);
  check("downloads returns to its home origin",await page.locator('#feature-demo').getAttribute('data-page')==='home');
  await page.locator('#s4-gearbtn').click();await finished(page);
  await foreground(page,"manual-settings",'#s4-home');
  await page.locator('#s4-set > [data-action="home"]').click();await finished(page);

  await scene(page,"create");
  await page.locator('#s4-menu').click();await finished(page);await page.locator('#s4-newbtn').click();await finished(page);
  await page.locator('[data-action="choose-agent"][data-agent="codex"]').click();await page.locator('#s4-nc-pi').click();await finished(page);
  check("new session keeps chosen Agent",await page.locator('#s4-cn .card-agent').textContent()==='Codex');
  await page.waitForFunction(()=>{const card=globalThis.document.querySelector('#s4-cn'),rect=card.getBoundingClientRect(),screen=globalThis.document.querySelector('#s4-scr').getBoundingClientRect();return globalThis.getComputedStyle(card).opacity==='1' && rect.left>=screen.left-10 && rect.right<=screen.right+10;});
  check("new session is painted inside phone",true);
  check("closed sheet cannot keep keyboard focus",await page.locator('#s4-new').getAttribute('inert')!==null && await page.evaluate(()=>!globalThis.document.activeElement.closest('[inert]')));
  await screenshot(page,"desktop-create","#feature-demo");

  await scene(page,"quota");
  await page.locator('#s4-ccw').click();await finished(page);
  check("quota query reveals five-hour reading",await opacity(page,'#s4-v72')===1);
  await page.locator('#s4-ccw').click();await page.waitForTimeout(220);
  await screenshot(page,"quota-edge-mid","#film-viewport");await finished(page);
  check("coin flips to weekly quota",await opacity(page,'#s4-v41')===1 && await page.locator('#s4-coinrot .rimd').count()===13);
  await screenshot(page,"desktop-quota-week","#feature-demo");
  await page.locator('#s4-ccw').click();await finished(page);
  check("coin flips back to five-hour quota",await opacity(page,'#s4-v72')===1 && await opacity(page,'#s4-v41')===0);

  await scene(page,"pair");await page.locator('[data-action="scan"]').click();await finished(page);
  check("pairing remains explicitly a demonstration",(await page.locator('#s2-ptxt').textContent()).includes('演示配对完成') && (await page.locator('.film-pair-note').textContent()).includes('不连接真实电脑'));
  check("pairing reaches connected page",await page.locator('#feature-demo').getAttribute('data-page')==='connected');
  await screenshot(page,"desktop-pair","#feature-demo");
  await page.locator('#tab-pair').focus();await page.keyboard.press('Home');
  check("chapter Home key selects first scene",await page.locator('#tab-chat').getAttribute('aria-selected')==='true');

  await scene(page,"sessions");
  const card=await page.locator('#s4-c2').boundingBox();
  await page.mouse.move(card.x+card.width*.6,card.y+card.height*.5);await page.mouse.down();await page.waitForTimeout(550);await page.mouse.up();await finished(page);
  check("long press selects from the held card",await page.locator('#s4-c2').getAttribute('aria-pressed')==='true');
  await page.locator('#s4-menu').click();await finished(page);
  check("selection cancellation restores toolbar",await page.locator('#s4-c2').getAttribute('aria-pressed')==='false' && await opacity(page,'#s4-closeall')===0);
  const swipe=await page.locator('#s4-c1').boundingBox();
  await page.evaluate(()=>{
    globalThis.swipeVibrations=[];globalThis.swipeFrames=[];globalThis.swipeSamples=[];globalThis.swipeMoves=[];globalThis.recordShake=true;
    globalThis.document.addEventListener("pointermove", event => { if(event.buttons)globalThis.swipeMoves.push(globalThis.performance.now()); });
    Object.defineProperty(globalThis.navigator,'vibrate',{configurable:true,value:duration=>{globalThis.swipeVibrations.push(duration);return false;}});
    const sample=now=>{const x=Number(globalThis.gsap.getProperty('#s4-shake','x'));globalThis.swipeFrames.push(x);globalThis.swipeSamples.push({at:now,x});if(globalThis.recordShake)globalThis.requestAnimationFrame(sample);};
    globalThis.requestAnimationFrame(sample);
  });
  const startX=swipe.x+swipe.width*.8,startY=swipe.y+swipe.height*.5;
  await page.mouse.move(startX,startY);await page.mouse.down();await page.mouse.move(startX-65,startY,{steps:8});await page.waitForTimeout(80);
  check("sampled below-threshold drag stays still, silent and preserves the session", await page.evaluate(() => {
    const frames = globalThis.swipeSamples, moves = globalThis.swipeMoves;
    return moves.length > 0 && frames.length >= 3 && frames[0].at <= moves[0] + 50
      && frames.at(-1).at >= moves.at(-1) && frames.at(-1).at - frames[0].at >= 60
      && frames.every(frame => frame.x === 0) && globalThis.swipeVibrations.length === 0
      && globalThis.document.querySelector("#s4-c1").getAttribute("aria-hidden") === "false";
  }));
  await page.mouse.move(startX-190,startY,{steps:6});
  await screenshot(page,"swipe-threshold-mid",'#film-viewport');
  await finished(page);
  const shakeFrames=await page.evaluate(()=>{globalThis.recordShake=false;return globalThis.swipeFrames;});
  await writeFile(`${output}/swipe-shake-frames.json`,JSON.stringify(shakeFrames));
  check("swipe threshold shakes both ways and settles",Math.max(...shakeFrames)>1&&Math.min(...shakeFrames)<-1&&await page.locator('#s4-shake').evaluate(el=>Number(globalThis.gsap.getProperty(el,'x'))===0));
  check("swipe threshold requests one short optional vibration",await page.evaluate(()=>JSON.stringify(globalThis.swipeVibrations)==='[12]'));
  await page.mouse.move(startX-65,startY,{steps:6});await page.mouse.move(startX-190,startY,{steps:6});await page.waitForTimeout(80);
  check("crossing again during the same swipe does not repeat feedback",await page.evaluate(()=>globalThis.swipeVibrations.length===1));
  await page.mouse.move(startX-65,startY,{steps:6});await page.mouse.up();await finished(page);
  check("retreat after feedback cancels close and restores the phone",await page.locator('#s4-c1').getAttribute('aria-hidden')==='false'&&await page.locator('#s4-shake').evaluate(el=>Number(globalThis.gsap.getProperty(el,'x'))===0));
  await page.evaluate(()=>Object.defineProperty(globalThis.navigator,'vibrate',{configurable:true,value:()=>{throw new Error('Vibration unavailable');}}));
  for(const [distance,closed] of [[65,false],[190,true]]) {
    await page.mouse.move(swipe.x+swipe.width*.8,swipe.y+swipe.height*.5);await page.mouse.down();await page.mouse.move(swipe.x+swipe.width*.8-distance,swipe.y+swipe.height*.5,{steps:12});await page.mouse.up();await finished(page);
    check(`swipe ${closed?'commits past':'cancels below'} threshold`,(await page.locator('#s4-c1').getAttribute('aria-hidden')==='true')===closed);
  }
  check("release during feedback restores the phone even if vibration fails",await page.locator('#s4-shake').evaluate(el=>Number(globalThis.gsap.getProperty(el,'x'))===0));
  await scene(page,"sessions");
  await page.evaluate(()=>{
    Object.defineProperty(globalThis.navigator,'vibrate',{configurable:true,value:undefined});
    globalThis.document.querySelector('#film-canvas').addEventListener('pointerdown',event=>{globalThis.swipePointer=event.pointerId;},{once:true});
  });
  const cancelCard=await page.locator('#s4-c1').boundingBox();
  await page.mouse.move(cancelCard.x+cancelCard.width*.8,cancelCard.y+cancelCard.height*.5);await page.mouse.down();await page.mouse.move(cancelCard.x+cancelCard.width*.8-190,cancelCard.y+cancelCard.height*.5,{steps:10});
  await page.locator('#s4-c1').dispatchEvent('pointercancel',{pointerId:await page.evaluate(()=>globalThis.swipePointer)});await page.mouse.up();await finished(page);
  check("pointer cancellation with no vibration API preserves the session",await page.locator('#s4-c1').getAttribute('aria-hidden')==='false'&&await page.locator('#s4-shake').evaluate(el=>Number(globalThis.gsap.getProperty(el,'x'))===0));
  await scene(page,"diff");
  const screen=await page.locator('#s4-scr').boundingBox();
  await page.mouse.move(screen.x+8,screen.y+screen.height*.5);await page.mouse.down();await page.mouse.move(screen.x+160,screen.y+screen.height*.5,{steps:14});await page.mouse.up();await finished(page);
  check("edge-back gesture hands control to chat",await page.locator('#feature-demo').getAttribute('data-page')==='chat');

  // Original playback and manual-mode handoff, including intermediate source frames.
  for(const [id,mid] of [['chat',3.34],['diff',13.5],['download',15.2],['sessions',22.65],['create',29.9],['quota',35.65],['pair',6.3]]) {
    await scene(page,id);await page.locator('#demo-play').click();
    await page.waitForFunction(t=>{const d=globalThis.document.querySelector('#feature-demo').dataset;return d.mode==='film'&&Number(d.time)>=t;},mid,{timeout:18000});
    await page.locator('#demo-play').click();
    if(id==='pair')check("pair film includes original laptop",await page.locator('#s2-laptop').evaluate(el=>globalThis.getComputedStyle(el).visibility==='visible'));
    await screenshot(page,`film-${id}-mid`,'#film-viewport');
    await page.locator('#demo-play').click();await finished(page);
    check(`${id} playback returns to an operable scene`,await page.locator('#feature-demo').getAttribute('data-mode')==='interactive');
  }
  await page.locator('#agents').scrollIntoViewIfNeeded();await page.locator('.agent-pick').first().click();await settle(page);await page.locator('#orbit-play').click();
  await page.waitForFunction(()=>{const d=globalThis.document.querySelector('#agents').dataset;return d.mode==='film'&&Number(d.time)>=13.8;},null,{timeout:18000});
  await page.locator('#orbit-play').click();await screenshot(page,'orbit-original-spin-mid','#orbit-stage');
  check("ring playback retains original camera and monitor",await page.locator('#s3-mon').evaluate(el=>globalThis.getComputedStyle(el).display!=='none') && await page.locator('#agents').getAttribute('data-mode')==='film');
  await page.locator('.agent-pick').nth(2).click();await settle(page);
  check("manual choice takes over film playback",await page.locator('#agent-name').textContent()==='Pi' && await page.locator('#agents').getAttribute('data-mode')==='interactive');

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
    await narrow.locator('[data-action="coin"]').click();
    check(`reduced-motion coin remains operable at ${width}px`, await opacity(narrow,"#s4-v41")===1);
    await screenshot(narrow,`viewport-${width}-quota`,"#feature-demo");
    if(width===390){
      await scene(narrow,"sessions");
      await narrow.evaluate(()=>{globalThis.swipeVibrations=[];Object.defineProperty(globalThis.navigator,'vibrate',{configurable:true,value:duration=>{globalThis.swipeVibrations.push(duration);return true;}});});
      const card=await narrow.locator('#s4-c1').boundingBox();
      await narrow.mouse.move(card.x+card.width*.8,card.y+card.height*.5);await narrow.mouse.down();await narrow.mouse.move(card.x+card.width*.8-160,card.y+card.height*.5,{steps:12});await narrow.mouse.up();await finished(narrow);
      check("reduced-motion swipe closes without shake or vibration",await narrow.locator('#s4-c1').getAttribute('aria-hidden')==='true'&&await narrow.evaluate(()=>Number(globalThis.gsap.getProperty('#s4-shake','x'))===0&&globalThis.swipeVibrations.length===0));
    }
    await narrow.locator("#download").scrollIntoViewIfNeeded();
    check(`downloads fit at ${width}px`, await narrow.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
    await requiredImages(narrow, `required brand and Agent images load at ${width}px`);
    await small.close();
  }
  const fallback = await browser.newContext({ viewport:{width:390,height:844} });
  await fallback.addInitScript(() => { delete globalThis.IntersectionObserver; });
  const fallbackPage = await prepare(fallback,null);
  check("missing observer still initializes the content", await fallbackPage.locator(".agent-pick").count()===11);
  check("failed API removes download links", await fallbackPage.locator("#host-downloads a,#app-downloads a").count()===0);
  await scene(fallbackPage,"chat");
  await fallbackPage.locator('[data-action="send"]').click();
  await finished(fallbackPage);
  check("missing observer still allows manual playback", await opacity(fallbackPage,"#s4-ask")===1);
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
