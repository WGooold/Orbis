import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type DialGeometry = { width: number; height: number; cx: number; cy: number; hole: number; hub: number; seam: number; rim: number; radius: number };
const source = readFileSync(new URL("./web/design-demo.js", import.meta.url), "utf8");
const context = { window: {} as { OrbisDemoPolicy: {
  draftAction(text: string): { label: string; icon: string };
  swipeArmed(distance: number, width: number): boolean;
  dialGeometry(width?: number, height?: number): DialGeometry;
  dialLayer(x: number, y: number, touch: boolean, geometry?: DialGeometry): string | null;
  dialIndex(layer: string, start: number, distance: number): number;
  dialRelease(layer: string, position: number, velocity: number): number;
  profileAction(agent: number, active: boolean, moving: boolean): { disabled: boolean; label: string };
} } };
runInNewContext(source.slice(0, source.indexOf("window.createOrbisDesignDemo")), context);
const policy = context.window.OrbisDemoPolicy;

describe("approved public demo interaction policy", () => {
  // S49 / SC70: the action itself distinguishes direct start from sending a first message.
  it("offers start for empty drafts and send for a written first message", () => {
    expect(policy.draftAction("")).toEqual({ label: "启动", icon: "play" });
    expect(policy.draftAction(" \n\t ")).toEqual({ label: "启动", icon: "play" });
    expect(policy.draftAction(" 帮我检查首页 ")).toEqual({ label: "发送第一句话", icon: "arrow-up" });
  });
  // Closing is distance-based, with a threshold proportional to the actual card width.
  it("arms only after forty percent of the card and disarms immediately on return", () => {
    expect(policy.swipeArmed(143.9, 360)).toBe(false);
    expect(policy.swipeArmed(144, 360)).toBe(true);
    expect(policy.swipeArmed(143, 360)).toBe(false);
    expect(policy.swipeArmed(120, 300)).toBe(true);
  });
  // The hollow core, moat and system-edge strip must not accidentally select either dial.
  it("keeps the two gesture regions separate and ignores dead zones", () => {
    const g=policy.dialGeometry(393,360);
    expect(g.rim).toBe(199);
    expect(g.radius).toBe(243);
    expect(policy.dialLayer(19,g.cy,true,g)).toBeNull();
    expect(policy.dialLayer(g.cx+g.hole-1,g.cy,false,g)).toBeNull();
    expect(policy.dialLayer(g.cx+g.hole+1,g.cy,false,g)).toBe("agent");
    expect(policy.dialLayer(g.cx+g.hub+1,g.cy,false,g)).toBeNull();
    expect(policy.dialLayer(g.cx+g.seam+1,g.cy,false,g)).toBe("profile");
    // A point above the centre is classified by radius, not the same x-only strip.
    expect(policy.dialLayer(g.cx+g.hole+1,0,false,g)).toBe("profile");
  });
  it("snaps Agent movement without velocity and clamps both dials", () => {
    expect(policy.dialRelease("agent",1.2,1)).toBe(1);
    expect(policy.dialRelease("profile",1.2,.006)).toBe(2);
    expect(policy.dialRelease("profile",1.2,.06)).toBe(3);
    expect(policy.dialIndex("agent", 1, -40)).toBe(1);
    expect(policy.dialIndex("agent", 1, -43)).toBe(2);
    expect(policy.dialIndex("profile", 1, -49)).toBe(2);
    expect(policy.dialIndex("agent", 0, 900)).toBe(0);
    expect(policy.dialIndex("profile", 0, -900)).toBe(3);
  });
  // Pi uses additive enable/remove; exclusive agents require a separate apply action.
  it("keeps browsing distinct from applying, and preserves Pi additive actions", () => {
    expect(policy.profileAction(1, true, false)).toEqual({ disabled: true, label: "正在使用 " });
    expect(policy.profileAction(1, false, false)).toEqual({ disabled: false, label: "切换到 " });
    expect(policy.profileAction(0, true, false)).toEqual({ disabled: false, label: "移出 " });
    expect(policy.profileAction(0, false, false)).toEqual({ disabled: false, label: "启用 " });
    expect(policy.profileAction(0, true, true).disabled).toBe(true);
    expect(policy.profileAction(1, false, true).disabled).toBe(true);
  });
});

// Exercise the shipped handlers and rendered output: variants must survive draft collapse and
// creation, and opening optional protocol help must not silently change the selected protocol.
function demoHarness() {
  let mode = "system", material = "mist";
  class Node {
    innerHTML = "";
    className = "";
    id = "";
    value = "";
    dataset: Record<string, string> = {};
    children: Node[] = [];
    events: Record<string, (event: any) => void> = {};
    classList = { add() {} };
    offsetHeight = 200;
    focused = false;
    querySelector(selector: string): Node | null { return selector === ".demo-dial" ? null : new Node(); }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 200, width: 393, height: 200 }; }
    addEventListener(name: string, handler: (event: any) => void) { this.events[name] = handler; }
    setAttribute() {}
    append() {}
    focus() { this.focused = true; }
    cloneNode() { return new Node(); }
    remove() {}
  }
  const root = new Node(), screen = new Node();
  const runtime = {
    document: { createElement: () => root, activeElement: null },
    window: {
      createOrbisDesignDemo: null as unknown as (options: { screen: Node; scene: string; reduced: () => boolean; onPlayback: () => void }) => { destroy(): void },
      orbisAppearance: {
        current: () => ({ mode, material, dark: mode === "dark" }),
        update: (patch: { mode?: string; material?: string }) => { mode = patch.mode || mode; material = patch.material || material; },
        subscribe: () => () => {},
      },
      getComputedStyle: () => ({ getPropertyValue: () => "none" }),
      cancelAnimationFrame() {},
      clearTimeout() {},
    },
  };
  runInNewContext(source, runtime);
  runtime.window.createOrbisDesignDemo({ screen, scene: "create", reduced: () => true, onPlayback: () => {} });
  const action = (demoAction: string, fields: Record<string, string> = {}) => {
    const target = new Node();
    target.dataset = { demoAction, ...fields };
    Object.assign(target, { closest: (selector: string) => selector === "[data-demo-action]" ? target : null });
    root.events.click!({ target });
  };
  const text = (value: string) => root.events.input!({ target: { id: "demo-first-message", value } });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { root, action, text, flush, mode: () => mode };
}

describe("public demo refined controls", () => {
  // Empty creation must not fall back to the demonstration's seeded chat or fabricate a reply.
  it.each(["", " \n\t "])("opens an empty session from draft %j without inventing a message", async text => {
    const app = demoHarness();
    app.action("draft-toggle"); await app.flush();
    expect(app.root.innerHTML).toContain('data-demo-action="draft-send" aria-label="启动"');
    expect(app.root.innerHTML).not.toContain("发出第一句话，才会在电脑上创建这个会话");
    app.text(text);
    app.action("draft-send"); await app.flush();
    expect(app.root.dataset.page).toBe("chat");
    expect(app.root.innerHTML).toContain("<h2>orbis</h2>");
    expect(app.root.innerHTML).not.toContain('class="demo-message-user"');
    expect(app.root.innerHTML).not.toContain('class="demo-message-assistant"');
  });

  it("keeps the selected Codex variant through collapse, creation, and later draft changes", async () => {
    const app = demoHarness();
    app.action("draft-toggle"); await app.flush();
    app.action("codex-menu");
    expect(app.root.innerHTML).toContain('role="menu" aria-label="Codex 版本"');
    expect(app.root.innerHTML).toContain('data-value="terminal"');
    expect(app.root.innerHTML).toContain('data-value="desktop"');
    app.action("codex-variant", { value: "desktop" });
    app.text("检查版本选择");
    app.action("draft-toggle"); await app.flush();
    app.action("draft-toggle"); await app.flush();
    expect(app.root.innerHTML).toContain('>Codex 桌面版<i');
    app.action("draft-send"); await app.flush();
    expect(app.root.dataset.page).toBe("chat");
    expect(app.root.innerHTML).toContain('Codex 桌面版</strong>');
    app.action("back-home");
    app.action("draft-toggle"); await app.flush();
    app.action("codex-variant", { value: "terminal" });
    // Changing a later draft must never rewrite the version of an existing session.
    expect(app.root.innerHTML).toContain('>Codex 终端版<i');
    expect(app.root.innerHTML).toContain('>Codex 桌面版</b>');
  });

  it("shows protocol state on the right and opens QUIC consequences only on request", () => {
    const app = demoHarness();
    app.action("tab", { page: "settings" });
    return app.flush().then(() => {
      expect(app.root.innerHTML).toContain('<strong>连接协议</strong><span class="demo-protocol-value">自动');
      app.action("protocol");
      expect(app.root.innerHTML).not.toContain("当前网络不支持 QUIC 时无法连接");
      app.action("protocol-info");
      expect(app.root.innerHTML).toContain("当前网络不支持 QUIC 时无法连接");
      app.action("protocol-info-close");
      expect(app.root.innerHTML).toContain('aria-checked="true" data-demo-action="protocol-choice" data-value="auto"');
      app.action("protocol-choice", { value: "quic" });
      expect(app.root.innerHTML).toContain("切换到 QUIC 并重连");
      app.action("protocol-cancel");
      expect(app.root.innerHTML).toContain('<span class="demo-protocol-value">自动');
    });
  });

  it("states the provider reload effect in the confirmation action", async () => {
    const app = demoHarness();
    app.action("tab", { page: "providers" }); await app.flush();
    app.action("provider-apply");
    expect(app.root.innerHTML).toContain("已有会话需要重新打开");
    expect(app.root.innerHTML).toContain("切换并重载 Agent");
    expect(app.root.innerHTML).not.toContain("正在运行的会话不受影响");
  });

  it("makes follow system an explicit idempotent choice without an explanatory subtitle", async () => {
    const app = demoHarness();
    app.action("tab", { page: "settings" }); await app.flush();
    expect(app.root.innerHTML).not.toContain("随手机的浅色与深色自动切换");
    expect(app.root.innerHTML).toContain('data-demo-action="appearance-follow" role="radio" aria-checked="true"');
    app.action("appearance-follow");
    expect(app.mode()).toBe("system");
    app.action("appearance-mode", { value: "dark" });
    expect(app.mode()).toBe("dark");
    expect(app.root.innerHTML).toContain('data-demo-action="appearance-follow" role="radio" aria-checked="false"');
    app.action("appearance-follow");
    expect(app.mode()).toBe("system");
    expect(app.root.innerHTML).not.toContain("·");
  });
});

// Product copy uses layout or natural punctuation rather than middle-dot separators.
it("keeps middle-dot separators out of first-party public UI sources", () => {
  for (const file of ["design-demo.js", "film-markup.js", "film.js", "site.js", "admin.js", "index.html", "admin.html"]) {
    expect(readFileSync(new URL(`./web/${file}`, import.meta.url), "utf8"), file).not.toContain("·");
  }
});
