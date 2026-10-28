import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContentLocator, ToolContentReadRequest } from "@orbis/protocol";
import { ToolContentStore } from "./tool-content-store.js";
import { ToolContentCapture } from "./tool-content-capture.js";
const roots: string[] = [], stores: ToolContentStore[] = [], captures: ToolContentCapture[] = [];
afterEach(async () => { for (const capture of captures.splice(0)) await capture.dispose(); for (const store of stores.splice(0)) await store.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const locator: ToolContentLocator = { projectionVersion: 1, tool: { agent: { hostId: "h", agentKind: "pi", sessionId: "s" }, toolCallId: "t" }, part: "output" };
const request = (): ToolContentReadRequest => ({ type: "session.tool.content.read", requestId: Math.random().toString(), viewerId: "v", runtimeId: "r", locator, read: null, offset: 0, maxBytes: 60 * 1024 });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orbis-capture-")); roots.push(root);
  const store = await ToolContentStore.create({ directory: root, producerId: "capture" }); stores.push(store);
  const capture = new ToolContentCapture(store); captures.push(capture); return { store, capture };
}
describe("bounded producer live capture", () => {
  it("bounds a burst before disk work and declares missing UTF-8 suffix", async () => {
    const { capture } = await setup();
    capture.replace(locator, "text", "中文😀".repeat(200_000), false);
    expect(capture.pendingBytes).toBeLessThanOrEqual(1024 * 1024);
    capture.append(locator, "tail"); capture.finish(locator); await capture.flush();
    const page = await capture.read("device", request());
    expect(page.text).not.toContain("�"); expect(page.gaps).toHaveLength(1);
    expect(page.observedThroughOffset).toBe(2_000_004); expect(page.contentFinal).toBe(true);
    expect(page.gaps[0]?.throughOffset).toBe(page.observedThroughOffset);
    expect(capture.pendingBytes).toBe(0);
  });
  it("does not mix a superseded write with the replacement content", async () => {
    const { capture } = await setup();
    capture.replace(locator, "text", "old".repeat(100_000), false);
    await Promise.resolve();
    capture.replace(locator, "text", "new中文", true);
    const page = await capture.read("device", request());
    expect(page.text).toBe("new中文"); expect(page.gaps).toEqual([]); expect(capture.pendingBytes).toBe(0);
    capture.invalidate("s"); expect(capture.has(locator)).toBe(false);
  });
  it("keeps a gap after draining it instead of silently appending over the missing suffix", async () => {
    const { capture } = await setup(); capture.replace(locator, "text", "x".repeat(1024 * 1024 + 4), false);
    await capture.flush(); capture.append(locator, "later"); await capture.flush();
    const page = await capture.read("device", request());
    expect(page.gaps.at(-1)?.throughOffset).toBe(1024 * 1024 + 9);
  });
});
