import { describe, expect, it } from "vitest";
import { RuntimeEventSchema, selectSessionSyncSnapshot, SessionPatchSchema } from "./index.js";

const source = {
  version: { epoch: "source", seq: 10, ready: true },
  checkpoint: {
    checkpointId: "capture-10", head: { leafId: null },
    headCompleteness: "complete" as const, inventoryComplete: true,
  },
  live: { complete: true, turn: null, messages: [], tools: [] },
};
const checkpoint = () => selectSessionSyncSnapshot([], "session", null, {
  sessionId: "session", syncId: "request", range: "preview",
}, [], source);

describe("source state contract", () => {
  it.each(["history", "catchup"] as const)("keeps %s pages independent from the current checkpoint", (range) => {
    const page = selectSessionSyncSnapshot([], "session", null, {
      sessionId: "session", syncId: range, range,
    }, [], source);
    expect(page).not.toHaveProperty("source");
    expect(page).not.toHaveProperty("checkpoint");
    expect(page).not.toHaveProperty("live");
    expect(RuntimeEventSchema.safeParse(page).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({ ...checkpoint(), range }).success).toBe(false);
  });

  it("rejects partial state envelopes and missing head instead of guessing current state", () => {
    const snapshot = checkpoint();
    expect(RuntimeEventSchema.safeParse(snapshot).success).toBe(true);
    for (const key of ["source", "checkpoint", "live"] as const) {
      const incomplete = { ...snapshot };
      delete incomplete[key];
      expect(RuntimeEventSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(RuntimeEventSchema.safeParse({
      ...snapshot, checkpoint: { ...source.checkpoint, head: undefined },
    }).success).toBe(false);
    expect(RuntimeEventSchema.safeParse({
      ...snapshot, live: { ...source.live, complete: false },
    }).success).toBe(false);
  });

  it("validates the same source boundary through direct and runtime event parsing", () => {
    const patch = {
      type: "session.patch", sessionId: "session", source: source.version,
      baseSeq: 8, seq: 10, checkpointId: "capture-10", head: { leafId: null },
      headCompleteness: "complete", live: source.live,
    };
    for (const schema of [SessionPatchSchema, RuntimeEventSchema]) {
      expect(schema.safeParse(patch).success).toBe(true);
      expect(schema.safeParse({ ...patch, seq: 9 }).success).toBe(false);
      expect(schema.safeParse({ ...patch, baseSeq: 10 }).success).toBe(false);
      expect(schema.safeParse({ ...patch, baseSeq: 11 }).success).toBe(false);
    }
  });
});
