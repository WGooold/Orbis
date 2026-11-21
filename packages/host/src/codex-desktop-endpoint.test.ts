/**
 * The endpoint descriptor is the whole interface between the wrapper and Host (ADR-0096). A wrong
 * acceptance either retries a dead port forever or points Host somewhere it must not connect; a wrong
 * removal hides a live Desktop from Host until it is republished.
 */
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { publishEndpoint, readCodexDesktopEndpoint, readEndpointRecord, withdrawEndpoint, type CodexDesktopEndpointRecord } from "./codex-desktop-endpoint.js";

const DEAD_PID = 0x7ffffff0;

async function descriptor(value: unknown): Promise<string> {
  const dir = await testDirectory(join(tmpdir(), "orbis-desktop-endpoint-"));
  const path = join(dir, "codex-desktop-endpoint.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

describe("Codex Desktop endpoint descriptor", () => {
  it("accepts only a live bridge and backend publishing a loopback websocket", async () => {
    const now = new Date().toISOString();
    const alive = await descriptor({ schema: 1, url: "ws://127.0.0.1:55384", bridgePid: process.pid, codexPid: process.pid, startedAt: now });
    expect(readCodexDesktopEndpoint(alive)).toEqual({ url: "ws://127.0.0.1:55384", bridgePid: process.pid });
    // Released wrappers may omit codexPid; the bridge alone then decides.
    expect(readCodexDesktopEndpoint(await descriptor({ schema: 1, url: "ws://127.0.0.1:1", bridgePid: process.pid }))).toBeDefined();
    for (const value of [
      { schema: 1, url: "ws://127.0.0.1:55384", bridgePid: DEAD_PID, startedAt: now },
      { schema: 1, url: "ws://127.0.0.1:55384", bridgePid: process.pid, codexPid: DEAD_PID, startedAt: now },
      { schema: 1, url: "ws://10.0.0.5:55384", bridgePid: process.pid, startedAt: now },
      { schema: 2, url: "ws://127.0.0.1:55384", bridgePid: process.pid, startedAt: now },
      '{"schema":1,"url":"ws://127.0.0.1:553',
    ]) expect(readCodexDesktopEndpoint(await descriptor(value))).toBeUndefined();
    expect(readCodexDesktopEndpoint(join(tmpdir(), "orbis-missing-endpoint.json"))).toBeUndefined();
  });

  // After a reboot the recorded PID may name an unrelated process.
  it("rejects a descriptor written before this boot even when its PID is alive again", async () => {
    const stale = await descriptor({ schema: 1, url: "ws://127.0.0.1:55384", bridgePid: process.pid, codexPid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" });
    expect(readCodexDesktopEndpoint(stale)).toBeUndefined();
    expect(readEndpointRecord(stale)?.codexPid).toBe(process.pid);
  });

  it("publishes atomically and withdraws only the descriptor of the same bridge", async () => {
    const dir = await testDirectory(join(tmpdir(), "orbis-desktop-endpoint-owner-"));
    const path = join(dir, "codex-desktop-endpoint.json");
    const old: CodexDesktopEndpointRecord = { schema: 1, url: "ws://127.0.0.1:50001", codexPid: process.pid, bridgePid: process.pid, startedAt: new Date(Date.now() - 1000).toISOString(), instanceId: "11111111-1111-4111-8111-111111111111" };
    const next: CodexDesktopEndpointRecord = { ...old, url: "ws://127.0.0.1:50002", startedAt: new Date().toISOString(), instanceId: "22222222-2222-4222-8222-222222222222" };
    publishEndpoint(path, old);
    publishEndpoint(path, next);
    expect(await readdir(dir)).toEqual(["codex-desktop-endpoint.json"]);
    // A bridge that shuts down late must not remove its successor's descriptor.
    withdrawEndpoint(path, old);
    expect(readEndpointRecord(path)).toMatchObject({ url: next.url, instanceId: next.instanceId });
    withdrawEndpoint(path, next);
    expect(readEndpointRecord(path)).toBeUndefined();
  });
});
