import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createRelayServer } from "../../relay/src/index.js";
import { RegistrationAuthority } from "../../relay/src/registration.js";
import { loadDeviceStore, saveDeviceStore } from "@orbis/e2e";
import { DesktopRuntime, validateDesktopRelay, type DesktopEvent } from "./desktop-runtime.js";
import * as claudeInstallation from "./claude-integration-install.js";
import * as claudeVersion from "./claude-version.js";
import { DshRuntime } from "./dsh-runtime.js";
import { HostService } from "./host-service.js";
import type { DshConnection } from "./dsh-client.js";

describe("desktop Host lifecycle", () => {
  // Passive discovery must never attach these isolated test Hosts to a user's Web service.
  beforeEach(() => {
    vi.spyOn(DshRuntime, "connectExisting").mockResolvedValue(undefined);
    vi.spyOn(claudeVersion, "readClaudeVersion").mockResolvedValue("2.1.322");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("recovers an existing DSH bridge with prestart disabled and closes it when paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-dsh-recovery-"));
    const credential = "orbis_host_" + "A".repeat(43);
    const relay = await createRelayServer({ runtimeCredentials: [credential] });
    const runtime = new DesktopRuntime(() => {}, join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const client: DshConnection = { onNotification: undefined, onRequest: undefined, onExit: undefined,
      request: vi.fn(async () => ({ sessions: [] })), notify: vi.fn(), stop: vi.fn(async () => {}) };
    const dsh = new DshRuntime(client, { list: async () => [],
      read: async id => ({ header: { id, cwd: root, createdAt: 1 }, events: [] }), close: async () => {} });
    const start = vi.spyOn(dsh, "start");
    vi.mocked(DshRuntime.connectExisting).mockResolvedValue(dsh);
    const launch = vi.spyOn(DshRuntime, "create").mockRejectedValue(new Error("must not prestart DSH"));
    try {
      await runtime.start({ relayUrl: relay.url, credential, lanPort: 0, codexEnabled: false, dshEnabled: false });
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(launch).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
      await runtime.stop();
      expect(client.stop).toHaveBeenCalledTimes(1);
    } finally { await runtime.close(); await dsh.stop(); await relay.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([undefined, "/local/bin/claude"])("reports native Claude availability %s independently of managed npm Agents", async executable => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-detect-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const find = vi.spyOn(claudeInstallation, "findClaudeExecutable").mockResolvedValue(executable);
    try {
      await runtime.initialize({ claudeIntegrationEnabled: false });
      expect(events).toContainEqual({ event: "claudeStatus", installed: executable !== undefined, minimumVersion: "2.1.287",
        compatible: executable !== undefined, ...(executable ? { version: "2.1.322" } : {}) });
    } finally { find.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  // CLAUDE-MODS-MIN-01: finding a binary is not proof of Mods support. A failed
  // probe stays visible in Agent status without preventing the Host from opening.
  it.each(["2.1.286", "2.1.287", undefined])("reports the native Mods version requirement for %s", async version => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-version-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    vi.spyOn(claudeInstallation, "findClaudeExecutable").mockResolvedValue("/fixture/claude");
    if (version) vi.mocked(claudeVersion.readClaudeVersion).mockResolvedValue(version);
    else vi.mocked(claudeVersion.readClaudeVersion).mockRejectedValue(new Error("无法读取 Claude Code 版本"));
    try {
      await expect(runtime.initialize({ claudeIntegrationEnabled: false })).resolves.toHaveProperty("hostId");
      expect(events).toContainEqual(expect.objectContaining({ event: "claudeStatus", installed: true,
        minimumVersion: "2.1.287", compatible: version === "2.1.287",
        ...(version ? { version } : {}), ...(version === "2.1.287" ? {} : { error: expect.stringContaining(version ? "最低 2.1.287" : "无法读取") }) }));
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  // CLAUDE-MODS-MIN-03: a slow optional version probe must not hold the entire
  // Host at initialization; its result is delivered independently as Agent status.
  it("initializes the Host while a Claude version check is still pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-pending-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    vi.spyOn(claudeInstallation, "findClaudeExecutable").mockResolvedValue("/fixture/claude");
    let finish!: (version: string) => void;
    vi.mocked(claudeVersion.readClaudeVersion).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let initialized = false;
    const pending = runtime.initialize({ claudeIntegrationEnabled: false }).then(() => { initialized = true; });
    try {
      await vi.waitFor(() => expect(claudeVersion.readClaudeVersion).toHaveBeenCalled());
      await vi.waitFor(() => expect(initialized).toBe(true));
      finish("2.1.322");
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: "claudeStatus", version: "2.1.322", compatible: true })));
    } finally { finish?.("2.1.322"); await pending; await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([undefined, true, false])("applies the Claude integration preference %s before Relay activation", async enabled => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-"));
    const runtime = new DesktopRuntime(() => {}, join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const install = vi.spyOn(runtime, "setClaudeIntegration").mockResolvedValue(undefined);
    try {
      await runtime.initialize(enabled === undefined ? {} : { claudeIntegrationEnabled: enabled });
      if (enabled === false) expect(install).not.toHaveBeenCalled();
      else expect(install).toHaveBeenCalledWith(true, true);
    } finally { install.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the desktop usable when automatic Claude registration fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const install = vi.spyOn(runtime, "setClaudeIntegration").mockRejectedValue(new Error("plugin command failed"));
    try {
      await expect(runtime.initialize()).resolves.toHaveProperty("hostId");
      expect(events).toContainEqual({ event: "log", message: "登记 Claude Code 插件失败：plugin command failed" });
    } finally { install.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("previews incomplete provider drafts without weakening save validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-provider-drafts-"));
    const runtime = new DesktopRuntime(() => {}, join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    try {
      for (const kind of ["pi", "codex", "dsh"]) {
        const draft = await runtime.providerDraft(kind) as { id: string; fields: Record<string, unknown>; config: Record<string, unknown> };
        if (kind === "codex") draft.fields.catalog = [{ model: "", displayName: "Work in progress" }];
        const params = { ...draft, kind, name: "Draft", create: true };
        const preview = runtime.providerPreview(params) as { fields: Record<string, unknown> };
        expect(preview.fields.model).toBe(draft.fields.model);
        if (kind === "codex") expect(preview.fields.catalog).toEqual(draft.fields.catalog);
        await expect(runtime.mutateProvider(kind, "save", params)).rejects.toThrow();
        expect(await runtime.listProviders(kind)).toEqual([]);
      }
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("can rename and revoke a paired device while the local Host is stopped", async () => {
    const state = await mkdtemp(join(tmpdir(), "orbis-desktop-devices-"));
    await saveDeviceStore(state, { version: 1, devices: [{ deviceId: "phone", devicePub: "public", pskRoot: "secret", label: "old", createdAt: 1, revoked: false }] });
    const runtime = new DesktopRuntime(() => {}, state);
    await runtime.renameDevice("phone", "My phone");
    expect((await loadDeviceStore(state)).devices[0]?.label).toBe("My phone");
    await runtime.revoke("phone");
    expect((await loadDeviceStore(state)).devices[0]?.revoked).toBe(true);
    await expect(runtime.renameDevice("phone", "old phone")).rejects.toThrow("设备不存在");
    await runtime.close();
  });
  it("requires TLS for public registration and rejects credentials embedded in URLs", () => {
    expect(validateDesktopRelay("wss://example.com/relay/")).toBe("wss://example.com/relay");
    expect(validateDesktopRelay("ws://127.0.0.1:8000")).toBe("ws://127.0.0.1:8000");
    for (const url of ["ws://example.com", "wss://user:password@example.com", "wss://example.com/?token=secret"]) expect(() => validateDesktopRelay(url)).toThrow();
  });
  it("verifies a QQ mailbox, starts the resident Host, pairs using its own credential, closes the pairing window, and stops cleanly", async () => {
    let verificationCode = "";
    const registration = await RegistrationAuthority.create({ sendMail: async mail => { verificationCode = mail.code; } });
    const relay = await createRelayServer({ registration });
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), await mkdtemp(join(tmpdir(), "orbis-desktop-")));
    try {
      const identity = await runtime.initialize() as { hostId: string };
      const request = { email: "owner@qq.com", hostId: identity.hostId };
      const challenge = await registration.requestCode(request, "test");
      const activated = await registration.activate({ ...request, ...challenge, code: verificationCode });
      await runtime.start({ relayUrl: relay.url, credential: activated.credential, lanPort: 0 });
      expect(events).toContainEqual({ event: "state", state: "connected" });
      await expect(runtime.install("pi")).rejects.toThrow("请先暂停 Host");
      await expect(runtime.installAll("update")).rejects.toThrow("请先暂停 Host");
      const pair = await runtime.pair() as { qr: string; expiresAt: number };
      expect(pair.qr).toMatch(/^data:image\/png;base64,/);
      expect(pair.expiresAt).toBeGreaterThan(Date.now());
      runtime.cancelPair();
      await runtime.stop();
      await expect(runtime.pair()).rejects.toThrow("请先连接 Host");
      expect(events).toContainEqual({ event: "state", state: "stopped" });
    } finally { await runtime.close(); await relay.close(); }
  });

  // HOST-ACT-01: deleted Relay registration must return to activation without replacing
  // the Host keys or phone trust. Retained registrations still require mailbox ownership.
  it.each(["deleted", "rotated"])("recovers a %s registration with the same Host identity and phone pairings", async mode => {
    const root = await mkdtemp(join(tmpdir(), "orbis-activation-recovery-"));
    const state = join(root, "host");
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), state,
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    let now = Date.now(), code = "";
    const stateFile = join(root, "registration.json");
    let registration = await RegistrationAuthority.create({ stateFile, now: () => now, sendMail: async mail => { code = mail.code; } });
    let relay: Awaited<ReturnType<typeof createRelayServer>> | undefined;
    try {
      const identity = await runtime.initialize({ claudeIntegrationEnabled: false }) as { hostId: string };
      const body = { email: "owner@qq.com", hostId: identity.hostId };
      let challenge = await registration.requestCode(body, "test");
      const original = await registration.activate({ ...body, ...challenge, code });
      await saveDeviceStore(state, { version: 1, devices: [{ deviceId: "phone", devicePub: "public", pskRoot: "secret", label: "My phone", createdAt: 1, revoked: false }] });
      const hostBefore = await readFile(join(state, "host.json"), "utf8");
      const devicesBefore = await readFile(join(state, "devices.json"), "utf8");
      if (mode === "deleted") {
        await writeFile(stateFile, JSON.stringify({ version: 2, hosts: [] }));
        registration = await RegistrationAuthority.create({ stateFile });
      } else {
        now += 61_000;
        challenge = await registration.requestCode(body, "test");
        await registration.activate({ ...body, ...challenge, code });
      }
      relay = await createRelayServer({ registration });
      const settings = { relayUrl: relay.url, lanPort: 0, codexEnabled: false, dshEnabled: false, piIntegrationEnabled: false, claudeIntegrationEnabled: false };
      await runtime.start({ ...settings, credential: original.credential });
      expect(events.at(-1)).toMatchObject({ event: "state", state: "error", activationRequired: true });
      expect(await readFile(join(state, "host.json"), "utf8")).toBe(hostBefore);
      expect(await readFile(join(state, "devices.json"), "utf8")).toBe(devicesBefore);
      expect(await runtime.initialize({ claudeIntegrationEnabled: false })).toMatchObject({ hostId: identity.hostId });
      let credential: string;
      if (mode === "deleted") {
        ({ credential } = await registration.activate({ hostId: identity.hostId }, "test", () => false));
      } else {
        await expect(registration.activate({ hostId: identity.hostId }, "test", () => false)).rejects.toMatchObject({ code: "host_already_registered" });
        now += 61_000;
        challenge = await registration.requestCode(body, "test");
        ({ credential } = await registration.activate({ ...body, ...challenge, code }));
      }
      await runtime.start({ ...settings, credential });
      expect(events).toContainEqual({ event: "state", state: "connected" });
      expect(await readFile(join(state, "host.json"), "utf8")).toBe(hostBefore);
      expect(await readFile(join(state, "devices.json"), "utf8")).toBe(devicesBefore);
    } finally { await runtime.close(); await relay?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("returns to activation if a previously connected Host is refused during reconnect", async () => {
    // HOST-ACT-02: a reconnect has no pending desktop start command to carry its failure.
    const root = await mkdtemp(join(tmpdir(), "orbis-activation-reconnect-"));
    const events: DesktopEvent[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    let connected: WebSocket | undefined;
    let attempts = 0;
    server.on("connection", socket => {
      socket.once("message", raw => {
        const auth = JSON.parse(raw.toString());
        if (++attempts === 1) {
          connected = socket;
          socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: auth.protocolVersion, runtimeId: auth.runtime.runtimeId }));
        } else {
          socket.send(JSON.stringify({ type: "protocol.error", code: "unauthorized", message: "Invalid runtime credential" }));
        }
      });
    });
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    try {
      await runtime.start({ relayUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, credential: "orbis_host_" + "A".repeat(43),
        lanPort: 0, codexEnabled: false, dshEnabled: false, piIntegrationEnabled: false, claudeIntegrationEnabled: false });
      expect(events).toContainEqual({ event: "state", state: "connected" });
      connected!.close();
      await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ event: "state", state: "error", activationRequired: true }), { timeout: 4_000 });
      const terminal = events.filter(event => event.event === "state");
      await new Promise(resolve => setTimeout(resolve, 1_100));
      expect(events.filter(event => event.event === "state")).toEqual(terminal);
      expect(attempts).toBe(2);
    } finally {
      await runtime.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stays stopped when an already-cancelled connection attempt fails afterwards", async () => {
    // 第一次连接立刻失败，让运行时空转进入重试；第二次挂住，代表“正在连接中被用户暂停”。
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const held: WebSocket[] = [];
    let connections = 0;
    server.on("connection", socket => {
      connections += 1;
      if (connections === 1) { socket.close(); return; }
      held.push(socket);
    });
    const events: DesktopEvent[] = [];
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-desktop-cancel-"));
    let phase = 0;
    let stopPromise: Promise<void> | undefined;
    const runtime: DesktopRuntime = new DesktopRuntime(event => {
      events.push(event);
      if (event.event !== "state") return;
      // 第一次失败排好重试（带 message 的那条“reconnecting”）之后，重试发出的下一条
      // “connecting”就是新尝试刚起步的时刻——旧实现在这里丢掉在途尝试，事后才上报链路状态。
      if (phase === 0 && event.state === "reconnecting" && event.message) { phase = 1; return; }
      if (phase === 1 && event.state === "connecting") { phase = 2; stopPromise = runtime.stop(); }
    }, stateDir);
    try {
      await runtime.start({ relayUrl: `ws://127.0.0.1:${port}`, credential: "orbis_host_" + "A".repeat(43), lanPort: 0, codexEnabled: false, dshEnabled: false });
      const deadline = Date.now() + 2_500;
      while (held.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      await stopPromise;
      // 已暂停就应当允许安装：在途的旧尝试不能把闸门继续锁着。
      await expect(runtime.activateInstallation("pi", "missing")).rejects.toThrow("安装记录不存在");
      // 那条在途连接随后才失败：它的链路状态不能翻回来盖掉“已暂停”，否则界面会卡在
      // “连接已断开”，Agent 安装的门就以“需先暂停 Host”永久挡住。
      for (const socket of held) socket.terminate();
      await new Promise(resolve => setTimeout(resolve, 500));
      expect([...events].reverse().find(event => event.event === "state")?.state).toBe("stopped");
    } finally { await runtime.close(); server.close(); await rm(stateDir, { recursive: true, force: true }); }
  });

  it.each(["backend", "service"] as const)("resumes after a pause that abandoned a retry while it created its %s", async gate => {
    // HOST-LIVE-01: the desktop pauses around a settings or Agent change and resumes right away.
    // A retry abandoned mid-start must unwind first: the resume must not report a running Host, the
    // abandoned service must not read the released Codex Desktop lifecycle, and a DSH backend that the
    // abandoned attempt created after the pause must be disposed instead of being overwritten.
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    let connections = 0;
    server.on("connection", socket => {
      connections += 1;
      if (connections === 1) { socket.close(); return; }
      socket.once("message", raw => {
        const auth = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: auth.protocolVersion, runtimeId: auth.runtime.runtimeId }));
      });
    });
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-resume-"));
    const fakeDsh = (): { client: DshConnection; runtime: DshRuntime } => {
      const client: DshConnection = { onNotification: undefined, onRequest: undefined, onExit: undefined,
        request: vi.fn(async () => ({ sessions: [] })), notify: vi.fn(), stop: vi.fn(async () => {}) };
      return { client, runtime: new DshRuntime(client, { list: async () => [],
        read: async id => ({ header: { id, cwd: root, createdAt: 1 }, events: [] }), close: async () => {} }) };
    };
    const stale = fakeDsh(); const resumedDsh = fakeDsh();
    let release: () => void = () => {};
    let retryHeld = false;
    const hold = async (): Promise<void> => { retryHeld = true; await new Promise<void>(resolve => { release = resolve; }); };
    vi.spyOn(DshRuntime, "create")
      .mockRejectedValueOnce(new Error("first attempt has no DSH"))
      .mockImplementationOnce(async () => { if (gate === "backend") await hold(); return stale.runtime; })
      .mockResolvedValueOnce(resumedDsh.runtime);
    const createService = HostService.create.bind(HostService);
    vi.spyOn(HostService, "create")
      .mockImplementationOnce(createService)
      .mockImplementationOnce(async options => { if (gate === "service") await hold(); return createService(options); });
    const events: DesktopEvent[] = [];
    const settings = { relayUrl: `ws://127.0.0.1:${port}`, credential: "orbis_host_" + "A".repeat(43), lanPort: 0,
      codexEnabled: false, dshEnabled: true, piIntegrationEnabled: false, claudeIntegrationEnabled: false };
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    try {
      await runtime.start({ ...settings });
      await vi.waitFor(() => expect(retryHeld).toBe(true), { timeout: 4_000 });
      await runtime.stop();
      const resumed = runtime.start({ ...settings });
      setTimeout(() => release(), 100);
      await resumed;
      expect([...events].reverse().find(event => event.event === "state")?.state).toBe("connected");
      expect(stale.client.stop).toHaveBeenCalledTimes(1);
      expect(resumedDsh.client.stop).not.toHaveBeenCalled();
      expect(connections).toBe(2);
    } finally {
      await runtime.close();
      await stale.runtime.stop(); await resumedDsh.runtime.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
