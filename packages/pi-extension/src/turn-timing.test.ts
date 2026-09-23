import { describe, expect, it } from "vitest";
import {
  formatTurnDuration,
  PiTurnTiming,
} from "./turn-timing.js";

describe("PiTurnTiming", () => {
  it("formats timing labels like the Android chat UI", () => {
    expect(formatTurnDuration(59_999)).toBe("59s");
    expect(formatTurnDuration(60_000)).toBe("1m 0s");
    expect(formatTurnDuration(125_000)).toBe("2m 5s");
  });

  it("correlates one start and end with the Pi timestamp", () => {
    let now = 1_500;
    const timing = new PiTurnTiming(() => "turn-1", () => now);
    expect(timing.start(2, 1_000)).toEqual({
      type: "turn.started", turnId: "turn-1", startedAt: 1_000, turnIndex: 2,
    });
    now = 1_275;
    expect(timing.finish(2, "live-assistant", "assistant-entry")).toEqual({
      type: "turn.finished", turnId: "turn-1", startedAt: 1_000, durationMs: 275, turnIndex: 2,
      messageId: "live-assistant", persistedMessageId: "assistant-entry",
    });
  });

  it("ignores mismatched end events and falls back for invalid timestamps", () => {
    let now = 2_000;
    const timing = new PiTurnTiming(() => "turn-2", () => now);
    expect(timing.start(0, -1)).toMatchObject({ type: "turn.started", startedAt: 2_000 });
    expect(timing.finish(1)).toBeUndefined();
    now = 2_250;
    expect(timing.finish(0)?.durationMs).toBe(250);
  });
});
