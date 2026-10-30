/**
 * PiBackend 的端口行为：归属判定、命令分派的三态、resume 不认领时抛
 * session_not_found（上层据此问下一个后端）。spawner 本身的细节由 spawner.test 覆盖。
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ActivationError } from "./spawner.js";
import { ClaudeBackend, PiBackend } from "./agent-backend.js";
import { ClaudeArchiveStore, ClaudeSessionCatalog } from "./claude-catalog.js";
import { ClaudeHookBridge } from "./claude-hook-bridge.js";
import type { ClaudeLauncher, ClaudeLaunchRequest } from "./claude-launcher.js";
import { CLAUDE_BRIDGE_CAPABILITIES, ClaudeModsBridge } from "./claude-mods-bridge.js";
import { ClaudeSessionHistory } from "./claude-session-history.js";
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
    const root = await mkdtemp(join(tmpdir(), "orbis-pibackend-"));
    const { backend, spawner } = makeBackend({ sessionsRoot: root });
    await expect(backend.activate({ type: "resume", sessionId: "no-such" })).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(spawner.activate).not.toHaveBeenCalled();
  });

  it("resume：目录里有该会话 → 交给 spawner，激活结果摊平成 BackendActivation", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-pibackend-"));
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
    const root = await mkdtemp(join(tmpdir(), "orbis-pibackend-"));
    const { backend } = makeBackend({ sessionsRoot: root });
    const error = await backend.activate({ type: "resume", sessionId: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActivationError);
  });
});

describe("ClaudeBackend（Hook bridge 的统一端口）", () => {
  it("closes only the selected native process and sends success before taking its runtime offline", async () => {
    let finish!: () => void;
    const terminate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const events: unknown[] = [];
    const bridge = new ClaudeHookBridge();
    const modsBridge = new ClaudeModsBridge({
      processControl: { capture: async pid => ({ pid, started: "start", executable: "claude", command: "claude" }), terminate },
      createHistory: (id, config, publish) => new ClaudeSessionHistory(id, config, publish, { locate: async () => undefined }),
      onRuntimeOffline: runtimeId => events.push({ offline: runtimeId }),
    });
    const backend = new ClaudeBackend({ bridge, modsBridge, runtimeIds: () => modsBridge.runtimeIds(),
      onCommandResult: (_id, event) => events.push(event) });
    for (const [sessionId, processId] of [["first", 4242], ["second", 4243]] as const) {
      expect(modsBridge.hello({ type: "hello", instanceId: sessionId, sessionId, cwd: "/repo", claudeVersion: "2.1.310",
        bridgeVersion: "2", capabilities: CLAUDE_BRIDGE_CAPABILITIES, processId }).ok).toBe(true);
    }
    await Promise.resolve();
    expect(backend.dispatchCommand("claude:first", "close", { type: "slash.execute", name: "quit", args: "" })).toBe("handled");
    expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }), expect.any(Function));
    expect(modsBridge.runtimeIds()).toEqual(["claude:first", "claude:second"]);
    expect(events).toEqual([{ type: "command.result", commandId: "close", ok: true, status: "pending" }]);
    finish();
    await vi.waitFor(() => expect(modsBridge.runtimeIds()).toEqual(["claude:second"]));
    expect(events.slice(-2)).toEqual([
      { type: "command.result", commandId: "close", ok: true, status: "success" }, { offline: "claude:first" },
    ]);
    modsBridge.close(); bridge.close();
  });

  it("keeps the runtime online when the Host cannot terminate its process", async () => {
    const events: unknown[] = [];
    const modsBridge = new ClaudeModsBridge({
      processControl: { capture: async pid => ({ pid, started: "start", executable: "claude", command: "claude" }),
        terminate: async () => { throw new Error("permission denied"); } },
      createHistory: (id, config, publish) => new ClaudeSessionHistory(id, config, publish, { locate: async () => undefined }),
    });
    const backend = new ClaudeBackend({ bridge: new ClaudeHookBridge(), modsBridge, runtimeIds: () => modsBridge.runtimeIds(),
      onCommandResult: (_id, event) => events.push(event) });
    modsBridge.hello({ type: "hello", instanceId: "one", sessionId: "one", cwd: "/repo", claudeVersion: "2.1.310",
      bridgeVersion: "2", capabilities: CLAUDE_BRIDGE_CAPABILITIES, processId: 4242 });
    await Promise.resolve();
    backend.dispatchCommand("claude:one", "close", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "command.result", commandId: "close", ok: false, status: "failure", error: "permission denied" }));
    expect(modsBridge.isOnline("claude:one")).toBe(true);
    modsBridge.close();
  });
  const permission = {
    hook_event_name: "PermissionRequest",
    session_id: "claude-session",
    cwd: "D:/repo",
    tool_name: "Bash",
    tool_input: { command: "echo ok" },
  };
  const ask = {
    hook_event_name: "PreToolUse",
    session_id: "claude-session",
    cwd: "D:/repo",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "环境？", options: [{ label: "dev" }] }] },
  };

  function fixture() {
    const events: unknown[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const modsBridge = new ClaudeModsBridge();
    let runtimes = ["claude:claude-session"];
    const backend = new ClaudeBackend({
      bridge,
      modsBridge,
      runtimeIds: () => runtimes,
      onCommandResult: (_runtimeId, event) => events.push(event),
    });
    return { bridge, backend, events, removeRuntime: () => { runtimes = []; } };
  }

  it("只认领在线 Claude runtime，并通过 interaction.respond 返回回执", async () => {
    const { bridge, backend, events } = fixture();
    const pending = bridge.accept(permission);
    await Promise.resolve();
    const request = events.find((event): event is { type: "interaction.requested"; request: { requestId: string } } =>
      typeof event === "object" && event !== null && (event as { type?: unknown }).type === "interaction.requested");
    expect(request).toBeDefined();
    expect(backend.kind).toBe("claude");
    expect(backend.isReady()).toBe(true);
    expect(backend.ownsRuntime("claude:claude-session")).toBe(true);
    expect(backend.ownsRuntime("claude:other")).toBe(false);
    expect(backend.dispatchCommand("claude:claude-session", "command-1", {
      type: "interaction.respond", requestId: request!.request.requestId, extensionId: "claude-code", response: { kind: "confirm", value: true },
    })).toBe("handled");
    await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    expect(events).toContainEqual({ type: "command.result", commandId: "command-1", ok: true, status: "success" });
    expect(backend.dispatchCommand("claude:claude-session", "command-2", {
      type: "interaction.respond", requestId: request!.request.requestId, extensionId: "claude-code", response: { kind: "confirm", value: true },
    })).toBe("handled");
    expect(events).toContainEqual({ type: "command.result", commandId: "command-2", ok: true, status: "already_delivered" });
  });

  it("对取消、未知请求和非交互命令返回明确结果", async () => {
    const { bridge, backend, events, removeRuntime } = fixture();
    const pending = bridge.accept(ask);
    await Promise.resolve();
    const request = events.find((event): event is { type: "interaction.requested"; request: { requestId: string } } =>
      typeof event === "object" && event !== null && (event as { type?: unknown }).type === "interaction.requested");
    expect(request).toBeDefined();
    expect(backend.dispatchCommand("claude:claude-session", "cancel", {
      type: "interaction.respond", requestId: request!.request.requestId, extensionId: "claude-code", response: { kind: "cancel" },
    })).toBe("handled");
    await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(backend.dispatchCommand("claude:claude-session", "cancel", {
      type: "interaction.respond", requestId: "missing", extensionId: "claude-code", response: { kind: "cancel" },
    })).toBe("handled");
    expect(events).toContainEqual({ type: "command.result", commandId: "cancel", ok: false, status: "failure", error: "interaction_not_found" });
    expect(backend.dispatchCommand("claude:claude-session", "unsupported", { type: "stop" })).toBe("unsupported");
    removeRuntime();
    expect(backend.dispatchCommand("claude:claude-session", "offline", { type: "stop" })).toBe("offline");
  });
  it("answers session.sync with delivery, transcript snapshot and pending interactions", async () => {
    const events: { type: string }[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const modsBridge = new ClaudeModsBridge({ createHistory: (sessionId, configDir, publish) =>
      new ClaudeSessionHistory(sessionId, configDir, publish, { locate: async () => undefined }) });
    const hello = modsBridge.hello({ type: "hello", instanceId: "i", sessionId: "claude-session", cwd: "D:/repo", claudeVersion: "2.1.312",
      bridgeVersion: "2", capabilities: [...CLAUDE_BRIDGE_CAPABILITIES] });
    expect(hello.ok).toBe(true);
    const backend = new ClaudeBackend({ bridge, modsBridge, runtimeIds: () => ["claude:claude-session"],
      onCommandResult: (_runtimeId, event) => events.push(event), onEvent: (_runtimeId, event) => events.push(event) });
    void bridge.accept(permission);
    await Promise.resolve();
    expect(backend.dispatchCommand("claude:claude-session", "sync-1", { type: "session.sync", sessionId: "claude-session", syncId: "sync-1", range: "preview" })).toBe("handled");
    await vi.waitFor(() => expect(events.some(event => event.type === "interaction.snapshot")).toBe(true));
    const types = events.map(event => event.type);
    expect(types.indexOf("delivery.snapshot")).toBeLessThan(types.indexOf("session.snapshot"));
    expect(events.find(event => event.type === "interaction.snapshot")).toMatchObject({ requests: [{ kind: "confirm", runtimeId: "claude:claude-session" }] });
    bridge.close();
  });
});

describe("ClaudeBackend directory, archive and phone-opened TUIs", () => {
  async function fixture(launch: (request: ClaudeLaunchRequest, mods: ClaudeModsBridge) => Promise<void> = async () => undefined) {
    const root = await mkdtemp(join(tmpdir(), "orbis-claude-backend-"));
    const config = join(root, "config");
    const repo = join(root, "repo");
    await mkdir(join(config, "projects", "-repo"), { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(config, "projects", "-repo", "saved.jsonl"), [
      { type: "user", uuid: "u", cwd: repo, timestamp: "2026-10-01T00:00:00.000Z", message: { content: "hello" } },
      { type: "ai-title", aiTitle: "Saved work" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const events: unknown[] = [];
    const bridge = new ClaudeHookBridge();
    const mods = new ClaudeModsBridge({ createHistory: (sessionId, configDir, publish) =>
      new ClaudeSessionHistory(sessionId, configDir, publish, { locate: async () => undefined, settleTimeoutMs: 0 }) });
    const launches: ClaudeLaunchRequest[] = [];
    const launcher: ClaudeLauncher = { unavailable: async () => undefined, launch: async request => { launches.push(request); await launch(request, mods); } };
    const backend = new ClaudeBackend({ bridge, modsBridge: mods, runtimeIds: () => mods.runtimeIds(), configDirs: () => [config],
      catalog: new ClaudeSessionCatalog(), archive: new ClaudeArchiveStore(join(root, "claude-archive.json")), launcher, launchTimeoutMs: 200,
      onCommandResult: (_id, event) => events.push(event), onEvent: (_id, event) => events.push(event) });
    return { backend, mods, launches, events, repo, root };
  }
  const connect = (mods: ClaudeModsBridge, sessionId: string, launchId?: string, cwd = "/repo") => {
    const result = mods.hello({ type: "hello", instanceId: `i-${sessionId}`, sessionId, cwd, claudeVersion: "2.1.312", bridgeVersion: "2",
      capabilities: [...CLAUDE_BRIDGE_CAPABILITIES], ...(launchId === undefined ? {} : { launchId }) });
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  it("lists transcripts as the Claude directory and archives them in Host state", async () => {
    const { backend, mods } = await fixture();
    expect(backend.isReady()).toBe(true);
    expect(await backend.catalog()).toEqual([expect.objectContaining({ sessionId: "saved", agentKind: "claude", name: "Saved work", firstMessage: "hello", archived: false })]);
    await backend.setArchived("saved", true);
    expect(await backend.catalog()).toEqual([]);
    expect(await backend.catalog(true)).toEqual([expect.objectContaining({ sessionId: "saved", archived: true })]);
    await expect(backend.setArchived("missing", true)).rejects.toMatchObject({ code: "session_not_found" });
    connect(mods, "saved");
    await expect(backend.setArchived("saved", false)).rejects.toMatchObject({ code: "session_busy" });
  });

  it("resumes a saved Session by opening its TUI and waiting for that bridge", async () => {
    const { backend, launches, repo } = await fixture(async (request, mods) => { setTimeout(() => connect(mods, request.resume!, request.launchId, repo), 5); });
    await expect(backend.activate({ type: "resume", sessionId: "saved" })).resolves.toEqual({ sessionId: "saved", spawnMode: "tui" });
    expect(launches).toEqual([expect.objectContaining({ cwd: repo, resume: "saved" })]);
    // Already attached: nothing to open.
    await expect(backend.activate({ type: "resume", sessionId: "saved" })).resolves.toEqual({ sessionId: "saved", spawnMode: "tui" });
    expect(launches).toHaveLength(1);
    // Codex thread ids are UUIDs too; a Session without a transcript belongs to another backend.
    await expect(backend.activate({ type: "resume", sessionId: "not-claude" })).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("starts a new Session in a terminal and reports why an opened TUI never connected", async () => {
    const { backend, repo, root } = await fixture(async (request, mods) => {
      if (request.cwd.endsWith("repo")) setTimeout(() => connect(mods, "fresh", request.launchId, request.cwd), 5);
    });
    await expect(backend.activate({ type: "new", cwd: repo })).resolves.toEqual({ sessionId: "fresh", spawnMode: "tui" });
    await expect(backend.activate({ type: "new", cwd: join(root, "missing") })).rejects.toMatchObject({ code: "cwd_missing" });
    await expect(backend.activate({ type: "new", cwd: root })).rejects.toMatchObject({ code: "spawn_failed", message: expect.stringContaining("目录信任") });
  });

  it("routes slash commands the TUI listed and passes attachments as paths", async () => {
    const { backend, mods, events } = await fixture();
    const current = connect(mods, "live");
    mods.receiveEvent(current.runtimeId, current.generation, { type: "session.state", state: { commands: [{ name: "compact", source: "builtin" }] } });
    expect(backend.dispatchCommand(current.runtimeId, "c1", { type: "slash.execute", name: "compact", args: "" })).toBe("handled");
    expect(backend.dispatchCommand(current.runtimeId, "c2", { type: "slash.execute", name: "config", args: "" })).toBe("unsupported");
    expect(backend.dispatchCommand(current.runtimeId, "c3", { type: "user_message", text: "看这个", attachments: ["/tmp/a.png"] })).toBe("handled");
    expect(backend.dispatchCommand(current.runtimeId, "c4", { type: "user_message", text: "now", delivery: "steer" })).toBe("handled");
    expect(mods.poll(current.runtimeId, current.generation)).toMatchObject({ commands: [
      { commandId: "c1", command: { type: "slash", name: "compact", args: "" } },
      { commandId: "c3", command: { type: "user_message", text: "看这个\n\n附件路径：\n/tmp/a.png" } },
    ] });
    expect(events).toContainEqual({ type: "command.result", commandId: "c4", ok: false, status: "failure", error: "claude_steer_unsupported" });
  });

  it("is not launchable without a launcher and stays out of the directory without a catalog", async () => {
    const mods = new ClaudeModsBridge();
    const backend = new ClaudeBackend({ bridge: new ClaudeHookBridge(), modsBridge: mods, runtimeIds: () => mods.runtimeIds() });
    expect(backend.isReady()).toBe(false);
    expect(await backend.launchable()).toBe(false);
    expect(await backend.catalog()).toEqual([]);
    await expect(backend.activate({ type: "resume", sessionId: "x" })).rejects.toMatchObject({ code: "session_not_found" });
  });
});
