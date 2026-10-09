import { describe, expect, it } from "vitest";
import { CodexNotificationBuffer } from "./codex-notification-buffer.js";

const chunk = (itemId: string, delta: string, turnId = "turn") => ({
  method: "item/agentMessage/delta", params: { threadId: "thread", turnId, itemId, delta },
});

describe("Codex bounded native notification buffer", () => {
  it("preserves thousands of consecutive text chunks as one ordered notification", () => {
    const buffer = new CodexNotificationBuffer();
    for (let i = 0; i < 5000; ++i) expect(buffer.push(chunk("message", `${i},`))).toBe("accepted");
    expect(buffer.length).toBe(1);
    expect(buffer.take()).toEqual([chunk("message", Array.from({ length: 5000 }, (_, i) => `${i},`).join(""))]);
  });

  it("never merges across item identities, turns or lifecycle events", () => {
    const buffer = new CodexNotificationBuffer();
    const events = [chunk("a", "first"), chunk("b", "second"), chunk("b", "third", "next"),
      { method: "item/completed", params: { item: { id: "b" } } }, chunk("b", "fourth", "next")];
    events.forEach(event => buffer.push(event));
    expect(buffer.take()).toEqual(events);
  });

  it("reports overflow once, discards the incomplete prefix and freezes until a new native read", () => {
    const buffer = new CodexNotificationBuffer(2);
    expect(buffer.push(chunk("a", "a"))).toBe("accepted");
    expect(buffer.push(chunk("b", "b"))).toBe("accepted");
    expect(buffer.push(chunk("c", "c"))).toBe("overflow");
    for (let i = 0; i < 3000; ++i) expect(buffer.push(chunk(`${i}`, "late"))).toBe("dropped");
    expect(buffer.take()).toEqual([]);
    expect(buffer.overflowed).toBe(true);
    buffer.reset();
    expect(buffer.push(chunk("fresh", "fresh"))).toBe("accepted");
    expect(buffer.take()).toEqual([chunk("fresh", "fresh")]);
  });

  it("bounds byte usage even when chunks coalesce into a single notification", () => {
    const buffer = new CodexNotificationBuffer(512, 1024);
    expect(buffer.push(chunk("a", "中".repeat(100)))).toBe("accepted");
    expect(buffer.push(chunk("a", "中".repeat(400)))).toBe("overflow");
    expect(buffer.take()).toEqual([]);
  });
});
