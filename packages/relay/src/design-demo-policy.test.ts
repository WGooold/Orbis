import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type DialGeometry = {
  width: number; height: number; cx: number; cy: number;
  hole: number; hub: number; seam: number; rim: number; radius: number;
  agentRadius: number; pinStart: number; pinTravel: number;
  pinChannelLeft: number; pinChannelWidth: number;
};
const source = readFileSync(new URL("./web/design-demo.js", import.meta.url), "utf8");
const context = {
  window: {} as {
    OrbisDemoPolicy: {
      draftAction(text: string): { label: string; icon: string };
      swipeArmed(distance: number, width: number): boolean;
      dialGeometry(width?: number, height?: number): DialGeometry;
      dialLayer(x: number, y: number, touch: boolean, geometry?: DialGeometry): string | null;
      dialInPinChannel(x: number, y: number, geometry?: DialGeometry): boolean;
      dialPinHorizontal(dx: number, dy: number): boolean;
      dialPinDrag(enabled: boolean, dx: number, travel: number): number;
      dialPinArmed(enabled: boolean, position: number): boolean;
      dialPinReleaseHint(enabled: boolean, activeSessions?: number): string;
      dialPinCentre(geometry: DialGeometry, distance: number, travel: number): { x: number; y: number };
      dialIndex(layer: string, start: number, distance: number, count?: number): number;
      dialRelease(layer: string, position: number, velocity: number, count?: number): number;
      profileAction(agent: number | string, active: boolean, moving: boolean): { disabled: boolean; label: string };
    };
  },
};
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
    const g = policy.dialGeometry(393, 360);
    expect(g.rim).toBe(199);
    expect(g.radius).toBe(243);
    expect(policy.dialLayer(19, g.cy, true, g)).toBeNull();
    expect(policy.dialLayer(g.cx + g.hole - 1, g.cy, false, g)).toBeNull();
    expect(policy.dialLayer(g.cx + g.hole + 1, g.cy, false, g)).toBe("agent");
    expect(policy.dialLayer(g.cx + g.hub + 1, g.cy, false, g)).toBeNull();
    expect(policy.dialLayer(g.cx + g.seam + 1, g.cy, false, g)).toBe("profile");
    // A point above the centre is classified by radius, not the same x-only strip.
    expect(policy.dialLayer(g.cx + g.hole + 1, 0, false, g)).toBe("profile");
  });
  // AGENT-DIAL-01 / AGENT-DIAL-04: horizontal pin groove enables/disables docked Agents.
  it("handles the horizontal Agent enablement pin geometry and arming thresholds", () => {
    const g = policy.dialGeometry(393, 360);
    expect(g.pinTravel).toBe(g.seam - g.agentRadius);
    expect(policy.dialInPinChannel(g.pinStart + g.pinTravel / 2, g.cy, g)).toBe(true);
    expect(policy.dialInPinChannel(g.pinStart, g.cy + 40, g)).toBe(false);
    expect(policy.dialPinHorizontal(20, 10)).toBe(true);
    expect(policy.dialPinHorizontal(10, 20)).toBe(false);
    expect(policy.dialPinDrag(false, g.pinTravel * 0.6, g.pinTravel)).toBeCloseTo(0.6);
    expect(policy.dialPinArmed(false, 0.55)).toBe(true);
    expect(policy.dialPinArmed(false, 0.45)).toBe(false);
    expect(policy.dialPinArmed(true, 0.45)).toBe(true);
    expect(policy.dialPinArmed(true, 0.55)).toBe(false);
    expect(policy.dialPinReleaseHint(false, 0)).toBe("松手启用");
    expect(policy.dialPinReleaseHint(true, 0)).toBe("松手停用");
    expect(policy.dialPinReleaseHint(true, 2)).toBe("松手后确认停用");
    const seated = policy.dialPinCentre(g, 0, 1);
    expect(seated.x).toBeCloseTo(g.cx + g.seam, 3);
    expect(seated.y).toBeCloseTo(g.cy, 3);
    const retracted = policy.dialPinCentre(g, 1, 1);
    expect(Math.hypot(retracted.x - g.cx, retracted.y - g.cy)).toBeCloseTo(g.agentRadius, 3);
  });
  it("snaps Agent movement without velocity and clamps both dials", () => {
    expect(policy.dialRelease("agent", 1.2, 1)).toBe(1);
    expect(policy.dialRelease("profile", 1.2, 0.006)).toBe(2);
    expect(policy.dialRelease("profile", 1.2, 0.06)).toBe(3);
    expect(policy.dialIndex("agent", 1, -40)).toBe(1);
    expect(policy.dialIndex("agent", 1, -43)).toBe(2);
    expect(policy.dialIndex("profile", 1, -49)).toBe(2);
    expect(policy.dialIndex("agent", 0, 900)).toBe(0);
    expect(policy.dialIndex("profile", 0, -900)).toBe(3);
    expect(policy.dialIndex("agent", 0, -900, 12)).toBe(11);
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

class MockNode {
  innerHTML = "";
  className = "";
  id = "";
  value = "";
  dataset: Record<string, string> = {};
  children: MockNode[] = [];
  events: Record<string, (event: any) => void> = {};
  classList = { add() {}, toggle() {} };
  style: Record<string, string> = {};
  offsetHeight = 200;
  focused = false;
  querySelector(selector: string): MockNode | null { return selector === ".demo-dial" ? null : new MockNode(); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 200, width: 393, height: 200 }; }
  addEventListener(name: string, handler: (event: any) => void) { this.events[name] = handler; }
  setAttribute() {}
  append() {}
  focus() { this.focused = true; }
  cloneNode() { return new MockNode(); }
  remove() {}
}

// Exercise the shipped handlers and rendered output in a lightweight Node VM harness.
function demoHarness(scene = "create") {
  let mode = "system", material = "mist";
  const root = new MockNode(), screen = new MockNode();
  const runtime = {
    document: { createElement: () => root, activeElement: null },
    window: {
      createOrbisDesignDemo: null as unknown as (options: { screen: MockNode; scene: string; reduced: () => boolean; onPlayback: () => void }) => { destroy(): void },
      createOrbisPreviewDemo: null as unknown as (options: { screen: MockNode; scene: string; reduced: () => boolean; onPlayback: () => void }) => { destroy(): void },
      createOrbisPrivacyDemo: null as unknown as (options: { screen: MockNode; scene: string; reduced: () => boolean; onPlayback: () => void }) => { destroy(): void },
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
  if (scene === "preview") runtime.window.createOrbisPreviewDemo({ screen, scene, reduced: () => true, onPlayback: () => {} });
  else if (scene === "privacy") runtime.window.createOrbisPrivacyDemo({ screen, scene, reduced: () => true, onPlayback: () => {} });
  else runtime.window.createOrbisDesignDemo({ screen, scene, reduced: () => true, onPlayback: () => {} });
  const clickAttr = (attr: string, prop: string, value: string, fields: Record<string, string> = {}) => {
    const target = new MockNode();
    target.dataset = { [prop]: value, ...fields };
    Object.assign(target, { closest: (selector: string) => selector === `[${attr}]` ? target : null });
    root.events.click!({ target, clientX: 100 });
  };
  const action = (demoAction: string, fields: Record<string, string> = {}) => clickAttr("data-demo-action", "demoAction", demoAction, fields);
  const previewAction = (value: string, fields: Record<string, string> = {}) => clickAttr("data-preview-action", "previewAction", value, fields);
  const privacyAction = (value: string, fields: Record<string, string> = {}) => clickAttr("data-privacy-action", "privacyAction", value, fields);
  const text = (value: string) => root.events.input!({ target: { id: "demo-first-message", value } });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { root, action, previewAction, privacyAction, text, flush, mode: () => mode };
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
    expect(app.root.innerHTML).toContain(">Codex 桌面版<i");
    app.action("draft-send"); await app.flush();
    expect(app.root.dataset.page).toBe("chat");
    expect(app.root.innerHTML).toContain("Codex 桌面版</strong>");
    app.action("back-home");
    app.action("draft-toggle"); await app.flush();
    app.action("codex-variant", { value: "terminal" });
    // Changing a later draft must never rewrite the version of an existing session.
    expect(app.root.innerHTML).toContain(">Codex 终端版<i");
    expect(app.root.innerHTML).toContain(">Codex 桌面版</b>");
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

  it("exposes all 12 Host Agents on the upgraded switching dial and enforces enablement and reload confirmations", async () => {
    const app = demoHarness("agent");
    expect(app.root.innerHTML).toContain("<h2>Agent</h2>");
    expect(app.root.innerHTML).toContain("9 / 12 已启用");
    expect(app.root.innerHTML).toContain('data-kind="openclaw"');
    expect(app.root.innerHTML).toContain('data-kind="hermes"');
    app.action("provider-apply");
    expect(app.root.innerHTML).toContain("已有会话需要重新打开");
    expect(app.root.innerHTML).toContain("切换并重载 Agent");
    expect(app.root.innerHTML).not.toContain("正在运行的会话不受影响");
    app.action("provider-cancel");

    // Select disabled Hermes Agent (index 10) and enable it via the primary action button.
    app.action("dial-agent", { index: "10" });
    expect(app.root.innerHTML).toContain("未启用");
    expect(app.root.innerHTML).toContain("启用 Hermes Agent");
    app.action("provider-apply");
    expect(app.root.innerHTML).toContain("10 / 12 已启用");
    expect(app.root.innerHTML).toContain("已启用");
  });

  it("previews HTML, image, Markdown and video files inline and full-screen", () => {
    const app = demoHarness("preview");
    expect(app.root.innerHTML).toContain("launch-report.html");
    expect(app.root.innerHTML).toContain("hero-banner.png");
    expect(app.root.innerHTML).toContain("release-notes.md");
    expect(app.root.innerHTML).toContain("refresh-demo.mp4");
    expect(app.root.innerHTML).toContain("离线安全渲染");

    app.previewAction("fullscreen", { file: "html" });
    expect(app.root.dataset.page).toBe("reader");
    app.previewAction("html-filter", { value: "ios" });
    expect(app.root.innerHTML).toContain("118 ms");

    app.previewAction("close-reader");
    app.previewAction("toggle", { file: "image" });
    app.previewAction("fullscreen", { file: "image" });
    app.previewAction("image-zoom", { value: "4" });
    expect(app.root.innerHTML).toContain('data-zoom="4"');

    app.previewAction("close-reader");
    app.previewAction("toggle", { file: "markdown" });
    expect(app.root.innerHTML).toContain("移动端回归清单");

    app.previewAction("fullscreen", { file: "video" });
    expect(app.root.innerHTML).toContain("refresh-demo.mp4");
    expect(app.root.innerHTML).toContain("0:18");
  });

  it("walks through QR key exchange to end-to-end encrypted privacy status", () => {
    const app = demoHarness("privacy");
    expect(app.root.dataset.page).toBe("entry");
    expect(app.root.innerHTML).toContain("扫码交换密钥");
    expect(app.root.innerHTML).toContain("演示二维码，不连接真实电脑");

    app.privacyAction("start-scan");
    expect(app.root.dataset.page).toBe("secured");
    expect(app.root.innerHTML).toContain("端到端加密已建立");
    expect(app.root.innerHTML).toContain("X25519 / HKDF-SHA256 / AES-256-GCM");

    app.privacyAction("route", { value: "relay" });
    expect(app.root.innerHTML).toContain("中继仅转发密文，不可读取");
    expect(app.root.innerHTML).toContain("仅路由头，不可读取");

    expect(app.root.innerHTML).toContain('role="switch" aria-checked="false"');
    // SC134: explanation is opt-in to view, independent of the telemetry switch.
    expect(app.root.innerHTML).not.toContain("规划服务器开支");
    app.privacyAction("telemetry-info");
    expect(app.root.innerHTML).toContain("规划服务器开支");
    expect(app.root.innerHTML).toContain("此设备的收发流量");
    expect(app.root.innerHTML).toContain("不会收集聊天内容、文件内容或密码");
    expect(app.root.innerHTML).toContain('role="switch" aria-checked="false"');
    app.privacyAction("telemetry-info-close");
    expect(app.root.innerHTML).not.toContain("规划服务器开支");
    app.privacyAction("telemetry-toggle");
    expect(app.root.innerHTML).toContain('role="switch" aria-checked="true"');
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
