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

async function fetchAsset(handler: Awaited<ReturnType<typeof createWebHandler>>, path: string, method: "GET" | "HEAD" = "GET") {
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
  const handled = await handler({ method } as IncomingMessage, response, path);
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
    expect(html).not.toContain('assets/promo/weixinqrcode.png');

    const handler = await createWebHandler();
    const antigravity = await fetchAsset(handler, "/assets/promo/agents/antigravity.svg");
    expect(antigravity.handled).toBe(true);
    expect(antigravity.statusCode).toBe(200);
    expect(antigravity.headers["content-type"]).toBe("image/svg+xml");
    expect(antigravity.body?.length).toBeGreaterThan(1000);

    const icon = await fetchAsset(handler, "/assets/promo/icons/wechat.svg");
    expect(icon.handled).toBe(true);
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/svg+xml");
  });

  // SITE-QR-02: the page can use the published URL without requiring an nginx proxy.
  it("serves the stable QR and retains the old asset URL on a direct Relay", async () => {
    const html = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
    expect(html).toContain('src="/downloads/wechat-group.png"');
    const handler = await createWebHandler();
    const stable = await fetchAsset(handler, "/downloads/wechat-group.png");
    const legacy = await fetchAsset(handler, "/assets/promo/weixinqrcode.png");
    for (const qr of [stable, legacy]) {
      expect(qr.handled).toBe(true);
      expect(qr.statusCode).toBe(200);
      expect(qr.headers["content-type"]).toBe("image/png");
      expect(qr.headers["cache-control"]).toBe("no-store");
      expect(qr.body?.length).toBeGreaterThan(10000);
    }
    expect(stable.body).toEqual(legacy.body);
    const head = await fetchAsset(handler, "/downloads/wechat-group.png", "HEAD");
    expect(head).toMatchObject({ handled: true, statusCode: 200, headers: { "content-length": stable.body?.length } });
    expect(head.body).toBeUndefined();
  });
});
