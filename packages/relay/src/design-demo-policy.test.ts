import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type DialGeometry = { width: number; height: number; cx: number; cy: number; hole: number; hub: number; seam: number; rim: number; radius: number };
const source = readFileSync(new URL("./web/design-demo.js", import.meta.url), "utf8");
const context = { window: {} as { OrbisDemoPolicy: {
  canSend(text: string): boolean;
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
  // Empty drafts must never create empty sessions; whitespace remains a draft.
  it("starts a session only with a written first message", () => {
    expect(policy.canSend(" \n\t ")).toBe(false);
    expect(policy.canSend(" 帮我检查首页 ")).toBe(true);
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
