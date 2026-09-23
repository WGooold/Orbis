/**
 * PiBackend 的端口行为：归属判定、命令分派的三态、resume 不认领时抛
 * session_not_found（上层据此问下一个后端）。spawner 本身的细节由 spawner.test 覆盖。
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ActivationError } from "./spawner.js";
import { PiBackend } from "./agent-backend.js";
import type { SpawnedAgent } from "./spawner.js";

function makeSpawned(overrides: Partial<SpawnedAgent> = {}): SpawnedAgent {
  return {
    pid: 4321,
    agentKind: "pi",
    cwd: "D:/repo",
    sessionId: "sess-1",
    spawnMode: "headless",
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeBackend(overrides: Partial<Parameters<typeof makePiBackend>[0]> = {}) {
  return makePiBackend({
    runtimeIds: ["pi-1"],
    sendCommand: vi.fn(() => true),
    ...overrides,
  });
}

function makePiBackend(options: {
  runtimeIds?: string[];
  sendCommand?: (runtimeId: string, commandId: string, command: unknown) => boolean;
  sessionsRoot?: string;
}) {
  const spawner = {
    activate: vi.fn(async () => makeSpawned()),
  } as unknown as import("./spawner.js").SessionSpawner;
  const backend = new PiBackend({
    spawner,
    sendCommand: options.sendCommand ?? (() => true),
    runtimeIds: () => options.runtimeIds ?? [],
    ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
  });
  return { backend, spawner };
}

describe("PiBackend（统一端口的原生实现）", () => {
  it("归属判定跟着 loopback 的 runtime 列表走；dispatch 三态：handled / offline", () => {
    const sendCommand = vi.fn(() => true);
    const { backend } = makeBackend({ runtimeIds: ["pi-1"], sendCommand });

    expect(backend.kind).toBe("pi");
    expect(backend.isReady()).toBe(true);
    expect(backend.ownsRuntime("pi-1")).toBe(true);
    expect(backend.ownsRuntime("codex")).toBe(false);
    expect(backend.dispatchCommand("pi-1", "c1", { type: "stop" })).toBe("handled");
    expect(sendCommand).toHaveBeenCalledWith("pi-1", "c1", { type: "stop" });
    // runtimeId 在列表里但 sendCommand 没送达（进程刚死）→ offline。
    const { backend: dying } = makeBackend({
      runtimeIds: ["pi-1"],
      sendCommand: () => false,
    });
    expect(dying.dispatchCommand("pi-1", "c2", { type: "stop" })).toBe("offline");
  });

  it("resume：目录里没有该会话 → session_not_found（不归 Pi 管，交下一个后端）", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-pibackend-"));
    const { backend, spawner } = makeBackend({ sessionsRoot: root });
    await expect(backend.activate({ type: "resume", sessionId: "no-such" })).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(spawner.activate).not.toHaveBeenCalled();
  });

  it("resume：目录里有该会话 → 交给 spawner，激活结果摊平成 BackendActivation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-pibackend-"));
    // listPiSessions 扫 <root>/<分组>/*.jsonl，首行是 {"type":"session",...} 会话头。
    await mkdir(join(root, "group-a"), { recursive: true });
    await writeFile(join(root, "group-a", "sess-abc1.jsonl"),
      `${JSON.stringify({ type: "session", id: "sess-abc1", cwd: "D:/repo", name: "测试会话" })}\n`, "utf8");

    const { backend, spawner } = makeBackend({ sessionsRoot: root });
    const activated = await backend.activate({ type: "resume", sessionId: "sess-abc1" });
    expect(spawner.activate).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ type: "resume", sessionId: "sess-abc1" }),
    }));
    expect(activated).toMatchObject({ sessionId: "sess-1", spawnMode: "headless", pid: 4321 });
  });

  it("resume 的 session_not_found 是 ActivationError（host-service 靠 code 分派）", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-pibackend-"));
    const { backend } = makeBackend({ sessionsRoot: root });
    const error = await backend.activate({ type: "resume", sessionId: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActivationError);
  });
});
