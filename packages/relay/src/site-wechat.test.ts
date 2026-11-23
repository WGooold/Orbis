import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createWebHandler } from "./web.js";

const siteSource = readFileSync(new URL("./web/site.js", import.meta.url), "utf8");
const wechatSource = siteSource.slice(siteSource.indexOf("function initWechatGroup()"), siteSource.indexOf("function initAppearance()"));

class Element {
  events: Record<string, (event: any) => void> = {};
  open = false;
  focused = false;
  child?: Element;
  contained = new Set<Element>([this]);
  addEventListener(name: string, fn: (event: any) => void) { this.events[name] = fn; }
  querySelector() { return this.child; }
  contains(target: Element) { return this.contained.has(target); }
  focus() { this.focused = true; }
}

function harness() {
  const fab = new Element(), trigger = new Element(), close = new Element(), inside = new Element();
  fab.child = trigger;
  fab.contained.add(trigger);
  fab.contained.add(close);
  fab.contained.add(inside);
  const documentEvents: Record<string, (event: any) => void> = {};
  const document = {
    getElementById(id: string) {
      return ({ "wechat-fab": fab, "wechat-close": close } as Record<string, Element>)[id];
    },
    addEventListener(name: string, fn: (event: any) => void) { documentEvents[name] = fn; },
  };
  runInNewContext(wechatSource, { document });
  return { fab, trigger, close, inside, documentEvents };
}

async function fetchAsset(handler: (request: IncomingMessage, response: ServerResponse, path: string) => Promise<boolean>, path: string) {
  let statusCode = 0;
  let headers: Record<string, string | number> = {};
  let body: Buffer | undefined;
  const response = {
    writeHead(status: number, headerMap: Record<string, string | number>) {
      statusCode = status;
      headers = headerMap;
      return this;
    },
    end(chunk?: Buffer) { body = chunk; },
  } as unknown as ServerResponse;
  const handled = await handler({ method: "GET" } as IncomingMessage, response, path);
  return { handled, statusCode, headers, body };
}

describe("public site WeChat group floating widget", () => {
  it("closes via close button or Escape and restores focus to the trigger", () => {
    const { fab, trigger, close, documentEvents } = harness();
    fab.open = true;
    close.events.click!({});
    expect(fab.open).toBe(false);
    expect(trigger.focused).toBe(true);

    trigger.focused = false;
    fab.open = true;
    let stopped = false;
    fab.events.keydown!({ key: "Escape", stopPropagation() { stopped = true; } });
    expect(stopped).toBe(true);
    expect(fab.open).toBe(false);
    expect(trigger.focused).toBe(true);

    trigger.focused = false;
    fab.open = true;
    documentEvents.keydown!({ key: "Escape" });
    expect(fab.open).toBe(false);
    expect(trigger.focused).toBe(true);
  });

  it("closes on outside pointerdown while ignoring clicks inside the widget", () => {
    const { fab, trigger, inside, documentEvents } = harness();
    fab.open = true;
    documentEvents.pointerdown!({ target: inside });
    expect(fab.open).toBe(true);

    documentEvents.pointerdown!({ target: new Element() });
    expect(fab.open).toBe(false);
    expect(trigger.focused).toBe(false);
  });

  it("ships markup and static assets through the Relay allowlist", async () => {
    const html = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
    expect(html).toContain('<a class="button small" href="#download">下载 <i class="ico i-arrow-right" aria-hidden="true"></i></a>');
    expect(html).toContain('id="wechat-fab"');
    expect(html).toContain('id="wechat-close"');
    expect(html).toContain('src="assets/promo/weixinqrcode.png"');

    const handler = await createWebHandler();
    const qr = await fetchAsset(handler, "/assets/promo/weixinqrcode.png");
    expect(qr.handled).toBe(true);
    expect(qr.statusCode).toBe(200);
    expect(qr.headers["content-type"]).toBe("image/png");
    expect(qr.body?.length).toBeGreaterThan(10000);

    const icon = await fetchAsset(handler, "/assets/promo/icons/wechat.svg");
    expect(icon.handled).toBe(true);
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/svg+xml");
  });
});
