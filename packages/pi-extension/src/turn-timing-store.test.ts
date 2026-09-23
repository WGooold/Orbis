import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiTurnTimingStore, turnTimingSidecarPath } from "./turn-timing-store.js";

describe("PiTurnTimingStore", () => {
  it("persists completed timings outside the Pi Session file and restores them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-turn-timings-"));
    const sessionFile = join(directory, "session.jsonl");
    const timing = {
      turnId: "turn-1",
      startedAt: 1_000,
      durationMs: 250,
      turnIndex: 0,
      messageId: "assistant-1",
    };

    const first = new PiTurnTimingStore(sessionFile, "session-1");
    await first.record(timing);
    expect(first.list()).toEqual([timing]);
    expect(await readFile(sessionFile, "utf8").catch(() => "")).toBe("");

    const second = new PiTurnTimingStore(sessionFile, "session-1");
    await second.load();
    expect(second.list()).toEqual([timing]);
    expect(turnTimingSidecarPath(sessionFile)).not.toBe(sessionFile);
  });

  it("imports legacy timings without replacing newer sidecar data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-turn-timings-"));
    const sessionFile = join(directory, "session.jsonl");
    const current = {
      turnId: "turn-1",
      startedAt: 1_000,
      durationMs: 300,
      messageId: "assistant-1",
    };
    const legacy = {
      turnId: "turn-2",
      startedAt: 2_000,
      durationMs: 400,
      messageId: "assistant-2",
    };
    const store = new PiTurnTimingStore(sessionFile);

    await store.record(current);
    await store.import([current, legacy]);

    expect(store.list()).toEqual([current, legacy]);
    const restored = new PiTurnTimingStore(sessionFile);
    await restored.load();
    expect(restored.list()).toEqual([current, legacy]);
  });

  it("ignores malformed sidecar data so Session loading can continue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-turn-timings-"));
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(turnTimingSidecarPath(sessionFile), "not-json");

    const store = new PiTurnTimingStore(sessionFile);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});
