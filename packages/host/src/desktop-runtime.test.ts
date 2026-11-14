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
import { CodexAppServer } from "./codex-daemon.js";
import { CodexDesktopLifecycle } from "./codex-desktop-lifecycle.js";
import * as claudeInstallation from "./claude-integration-install.js";
import * as claudeVersion from "./claude-version.js";
import { DshRuntime } from "./dsh-runtime.js";
import * as dshDesktopLifecycle from "./dsh-desktop-lifecycle.js";
import { HostService } from "./host-service.js";
import { ProviderManager } from "./provider-manager.js";
import { RelayAuthenticationError } from "./relay-client.js";
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

  // HOST-DESKTOP-CANCEL-01: invalidate desktop discovery before waiting for the
  // service drain, so a slow shutdown cannot authorize a late GUI launch.
  it.each(["stop", "close"] as const)("cancels Desktop lifecycles and makes concurrent %s await the original service drain", async action => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-slow-stop-"));
    const credential = "orbis_host_" + "A".repeat(43);
    const relay = await createRelayServer({ runtimeCredentials: [credential] });
    vi.spyOn(CodexDesktopLifecycle.prototype, "isInstalled").mockResolvedValue(false);
    vi.spyOn(CodexDesktopLifecycle.prototype, "probe").mockResolvedValue(undefined);
    vi.spyOn(dshDesktopLifecycle.DshDesktopLifecycle.prototype, "isInstalled").mockResolvedValue(false);
    vi.spyOn(dshDesktopLifecycle.DshDesktopLifecycle.prototype, "watch").mockImplementation(() => {});
    const codexStop = vi.spyOn(CodexDesktopLifecycle.prototype, "stop");
    const dshStop = vi.spyOn(dshDesktopLifecycle.DshDesktopLifecycle.prototype, "stop");
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    let release = (): void => {};
    let held = false;
    let stopping: Promise<void> | undefined;
    let overlapping: Promise<void> | undefined;
    const originalStop = HostService.prototype.stop;
    try {
      await runtime.start({ relayUrl: relay.url, credential, lanPort: 0, codexEnabled: false, dshEnabled: false,
        piIntegrationEnabled: false, claudeIntegrationEnabled: false });
      codexStop.mockClear(); dshStop.mockClear();
      vi.spyOn(HostService.prototype, "stop").mockImplementationOnce(async function (this: HostService) {
        held = true;
        await new Promise<void>(resolve => { release = resolve; });
        await originalStop.call(this);
      });
      stopping = runtime.stop();
      await vi.waitFor(() => expect(held).toBe(true));
      expect(codexStop).toHaveBeenCalledOnce();
      expect(dshStop).toHaveBeenCalledOnce();
      let finished = false;
      overlapping = runtime[action]().then(() => { finished = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(finished).toBe(false);
      // close may also wait for unrelated background tasks; its internal stop
      // must itself remain pending instead of announcing a completed pause early.
      expect(events.filter(event => event.event === "state" && event.state === "stopped")).toHaveLength(0);
      release(); await Promise.all([stopping, overlapping]);
    } finally { release(); await Promise.all([stopping, overlapping]); await runtime.close(); await relay.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a queued Desktop ensure from the service abandoned by pause", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-stale-ensure-"));
    const credential = "orbis_host_" + "A".repeat(43);
    const relay = await createRelayServer({ runtimeCredentials: [credential] });
    vi.spyOn(CodexDesktopLifecycle.prototype, "isInstalled").mockResolvedValue(false);
    vi.spyOn(CodexDesktopLifecycle.prototype, "probe").mockResolvedValue(undefined);
    vi.spyOn(dshDesktopLifecycle.DshDesktopLifecycle.prototype, "isInstalled").mockResolvedValue(false);
    vi.spyOn(dshDesktopLifecycle.DshDesktopLifecycle.prototype, "watch").mockImplementation(() => {});
    const ensure = vi.spyOn(CodexDesktopLifecycle.prototype, "ensureReady").mockRejectedValue(new Error("unexpected stale launch"));
    const create = vi.spyOn(HostService, "create");
    const runtime = new DesktopRuntime(() => {}, join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    try {
      await runtime.start({ relayUrl: relay.url, credential, lanPort: 0, codexEnabled: false, dshEnabled: false,
        piIntegrationEnabled: false, claudeIntegrationEnabled: false });
      const stale = create.mock.calls[0]![0].ensureCodexDesktop!;
      await runtime.stop();
      await expect(stale()).rejects.toThrow("已取消 Codex 桌面版接入");
      expect(ensure).not.toHaveBeenCalled();
    } finally { await runtime.close(); await relay.close(); await rm(root, { recursive: true, force: true }); }
  });

  // HOST-DESKTOP-CANCEL-01: activation loss retains desired settings until its
  // service drain finishes. The disposed lifecycle must reject already queued
  // session requests so they cannot leave a new native connection without an owner.
  it("revokes a queued Desktop ensure before activation-loss disposal finishes draining", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-activation-dispose-"));
    const credential = "orbis_host_" + "A".repeat(43);
    const relay = await createRelayServer({ runtimeCredentials: [credential] });
    vi.spyOn(CodexDesktopLifecycle.prototype, "isInstalled").mockResolvedValue(false);
    vi.spyOn(CodexDesktopLifecycle.prototype, "probe").mockResolvedValue(undefined);
    vi.spyOn(dshDesktopLifecycle.DshDesktopLifecycle.prototype, "isInstalled").mockResolvedValue(false);
    vi.spyOn(dshDesktopLifecycle.DshDesktopLifecycle.prototype, "watch").mockImplementation(() => {});
    const ensure = vi.spyOn(CodexDesktopLifecycle.prototype, "ensureReady").mockRejectedValue(new Error("unexpected stale launch"));
    const create = vi.spyOn(HostService, "create");
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    let release = (): void => {};
    let draining = false;
    const originalStop = HostService.prototype.stop;
    try {
      await runtime.start({ relayUrl: relay.url, credential, lanPort: 0, codexEnabled: false, dshEnabled: false,
        piIntegrationEnabled: false, claudeIntegrationEnabled: false });
      const old = create.mock.calls[0]![0];
      vi.spyOn(HostService.prototype, "stop").mockImplementationOnce(async function (this: HostService) {
        draining = true;
        await new Promise<void>(resolve => { release = resolve; });
        await originalStop.call(this);
      });
      old.onRelayAuthenticationError!(new RelayAuthenticationError("unauthorized", "fixture activation revoked"));
      await vi.waitFor(() => expect(draining).toBe(true));
      await expect(old.ensureCodexDesktop!()).rejects.toThrow("已取消 Codex 桌面版接入");
      expect(ensure).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(events.some(event => event.activationRequired === true)).toBe(true));
    } finally { release(); await runtime.close(); await relay.close(); await rm(root, { recursive: true, force: true }); }
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
      // ADR-0081 review: the executable is found but its version is still being read. That is still
      // detection, not an incompatible install; the desktop showed 需升级 for the whole probe.
      expect(events.filter(event => event.event === "claudeStatus").at(-1)).toMatchObject({ installed: true, detecting: true });
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
      else expect(install).toHaveBeenCalledWith(true, true, expect.any(AbortSignal));
    } finally { install.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the desktop usable when automatic Claude registration fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const install = vi.spyOn(runtime, "setClaudeIntegration").mockRejectedValue(new Error("plugin command failed"));
    try {
      await expect(runtime.initialize()).resolves.toHaveProperty("hostId");
      await vi.waitFor(() => expect(events).toContainEqual({ event: "log", message: "登记 Claude Code 插件失败：plugin command failed" }));
      expect(events).toContainEqual({ event: "preparation", kind: "claude", state: "error", message: "plugin command failed" });
    } finally { install.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  // HOST-PREP-04 (ADR-0081 §5-1): plugin registration may run four `claude` commands of up to 60 s
  // each. It used to finish before initialize answered and again before start connected the Relay.
  it("answers initialize and connects the Relay while Claude plugin registration is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-background-"));
    const credential = "orbis_host_" + "A".repeat(43);
    const relay = await createRelayServer({ runtimeCredentials: [credential] });
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    let signal: AbortSignal | undefined;
    const install = vi.spyOn(runtime, "setClaudeIntegration").mockImplementation((_enabled, _missing, received) => {
      signal = received;
      return new Promise<void>((_resolve, reject) => received?.addEventListener("abort", () => reject(received.reason)));
    });
    try {
      await expect(runtime.initialize()).resolves.toHaveProperty("hostId");
      expect(events).toContainEqual({ event: "preparation", kind: "claude", state: "preparing" });
      await runtime.start({ relayUrl: relay.url, credential, lanPort: 0, codexEnabled: false, dshEnabled: false, piIntegrationEnabled: false });
      expect(events).toContainEqual({ event: "state", state: "connected" });
      // Registration still in flight: start reused it instead of running the commands a second time.
      expect(install).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(false);
      // Closing the Host cancels the registration rather than leaving `claude` subprocesses behind.
      await runtime.close();
      expect(signal?.aborted).toBe(true);
      expect(events.at(-1)).not.toMatchObject({ event: "preparation", kind: "claude", state: "error" });
    } finally { install.mockRestore(); await runtime.close(); await relay.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("lets the settings switch supersede an automatic registration still in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-switch-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const calls: [boolean, boolean][] = [];
    const install = vi.spyOn(runtime, "setClaudeIntegration").mockImplementation(async (enabled, missing = false, signal) => {
      calls.push([enabled, missing]);
      if (signal) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    try {
      await runtime.initialize();
      // Turning the integration off cancels the automatic run first; the two never run `claude plugin` at once.
      await runtime.configureClaudeIntegration(false);
      expect(calls).toEqual([[true, true], [false, false]]);
    } finally { install.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("clears a failed automatic registration once the settings switch succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-claude-retry-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const install = vi.spyOn(runtime, "setClaudeIntegration").mockRejectedValueOnce(new Error("plugin command failed")).mockResolvedValue(undefined);
    // Native version detection finishes independently and may be the latest
    // event; registration recovery is judged by its own preparation state.
    const preparation = () => events.filter(event => event.event === "preparation" && event.kind === "claude").at(-1);
    try {
      await runtime.initialize();
      await vi.waitFor(() => expect(preparation()).toMatchObject({ event: "preparation", kind: "claude", state: "error" }));
      await runtime.configureClaudeIntegration(true);
      // Without this the desktop kept showing "插件未登记" after the user fixed it from Settings.
      expect(preparation()).toEqual({ event: "preparation", kind: "claude", state: "idle" });
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
  // DSH-DESKTOP-09: opening DeepSeek Desktop may wait for the user to quit an instance Orbis did not open. It must
  // not hold the serialized desktop command queue; its progress reaches the Host UI as events.
  it("returns from opening DeepSeek Desktop at once and reports the wait as events", async () => {
    const state = await mkdtemp(join(tmpdir(), "orbis-desktop-dsh-open-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => { events.push(event); }, state);
    let release = (): void => {};
    const open = vi.spyOn(dshDesktopLifecycle, "openDshDesktopFromHost").mockImplementation(async options => {
      options.onWaiting?.(true);
      await new Promise<void>(resolve => { release = resolve; });
      options.onWaiting?.(false);
      return "opened";
    });
    const states = () => events.filter(event => event.event === "dshDesktopOpen").map(event => event.state);
    try {
      await runtime.openAgent("dshDesktop");
      expect(states()).toEqual(["opening", "waiting"]);
      // A second click while waiting keeps the same open.
      await runtime.openAgent("dshDesktop");
      expect(open).toHaveBeenCalledOnce();
      release();
      await vi.waitFor(() => expect(states()).toEqual(["opening", "waiting", "opening", "idle"]));
      expect(events.at(-1)).toEqual({ event: "dshDesktopOpen", state: "idle" });
      open.mockRejectedValueOnce(new Error("未找到 DeepSeek 桌面版安装"));
      await runtime.openAgent("dshDesktop");
      await vi.waitFor(() => expect(events.at(-1)).toEqual({ event: "dshDesktopOpen", state: "idle", error: "未找到 DeepSeek 桌面版安装" }));
    } finally {
      await runtime.close();
      await rm(state, { recursive: true, force: true });
    }
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

  // SC75 follow-up: preparing the terminal Codex backend may download the matching official
  // server package (>100 MB). It must never hold the Relay connection: before this change a
  // phone could only see "正在准备" while the Host was actually still downloading.
  it("connects the Relay before the terminal Codex backend is ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-codex-prepare-"));
    const credential = "orbis_host_" + "A".repeat(43);
    const relay = await createRelayServer({ runtimeCredentials: [credential] });
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const create = vi.spyOn(CodexAppServer, "create").mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new Error("Codex 0.169.0 官方终端发布包不可用（HTTP 404）");
    });
    try {
      await runtime.start({ relayUrl: relay.url, credential, lanPort: 0, codexEnabled: true, dshEnabled: false,
        piIntegrationEnabled: false, claudeIntegrationEnabled: false });
      // The start resolves with the Relay online, before the delayed preparation failure lands.
      expect(events).toContainEqual({ event: "state", state: "connected" });
      expect(events).toContainEqual(expect.objectContaining({ event: "preparation", kind: "codex", state: "preparing" }));
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: "preparation", kind: "codex", state: "error",
        message: expect.stringContaining("官方终端发布包不可用") })), { timeout: 5_000 });
      const connectedAt = events.findIndex(event => event.event === "state" && event.state === "connected");
      const failedAt = events.findIndex(event => event.event === "preparation" && event.kind === "codex" && event.state === "error");
      expect(connectedAt).toBeGreaterThanOrEqual(0);
      expect(connectedAt).toBeLessThan(failedAt);
      // A failed preparation is reported, not retried silently or masked by a state change.
      expect(events.filter(event => event.event === "state").at(-1)).toMatchObject({ state: "connected" });
    } finally {
      create.mockRestore();
      await runtime.close(); await relay.close(); await rm(root, { recursive: true, force: true });
    }
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

  // HOST-LANE-01 (ADR-0081 §5-2): a pause is no longer queued behind start. One that arrives while start
  // is still preparing must cancel it; one that arrives mid-handshake must not wait for the Relay timeout.
  it("lets a pause cancel a start that has not connected yet", async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    let connections = 0;
    // The Relay accepts the socket but never confirms the runtime: a start would wait 25 s for it.
    server.on("connection", () => { connections += 1; });
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-preempt-"));
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const settings = { relayUrl: `ws://127.0.0.1:${port}`, credential: "orbis_host_" + "A".repeat(43), lanPort: 0,
      codexEnabled: false, dshEnabled: false, piIntegrationEnabled: false, claudeIntegrationEnabled: false };
    try {
      // Before the Host is marked running: the start gives up without opening a connection.
      const early = runtime.start({ ...settings });
      await runtime.stop();
      await early;
      expect(connections).toBe(0);
      expect(events.filter(event => event.event === "state").map(event => event.state)).toEqual(["stopped"]);

      // Mid-handshake: the pause returns at once, and the abandoned start settles quietly.
      const late = runtime.start({ ...settings });
      await vi.waitFor(() => expect(connections).toBe(1));
      const paused = Date.now();
      await runtime.stop();
      expect(Date.now() - paused).toBeLessThan(2_000);
      await expect(late).resolves.toBeUndefined();
      expect([...events].reverse().find(event => event.event === "state")?.state).toBe("stopped");
      // The pause really released the attempt: a new start is accepted.
      const again = runtime.start({ ...settings });
      await vi.waitFor(() => expect(connections).toBe(2));
      await runtime.stop(); await again;
    } finally {
      await runtime.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  // HOST-PREP-06 (ADR-0081 §5-4): local routing has no time limit. It no longer holds initialize, but
  // the terminal Codex backend still waits for it because the app-server reads the configuration it rewrites.
  it("initializes before local routing settles and starts Codex only after it", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-desktop-routing-"));
    const credential = "orbis_host_" + "A".repeat(43);
    const relay = await createRelayServer({ runtimeCredentials: [credential] });
    const events: DesktopEvent[] = [];
    let routed!: () => void;
    vi.spyOn(ProviderManager.prototype, "startRouting").mockImplementation(() => new Promise<void>(resolve => { routed = resolve; }));
    const create = vi.spyOn(CodexAppServer, "create").mockRejectedValue(new Error("synthetic Codex failure"));
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"),
      { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    try {
      await expect(runtime.initialize({ claudeIntegrationEnabled: false })).resolves.toHaveProperty("hostId");
      await runtime.start({ relayUrl: relay.url, credential, lanPort: 0, codexEnabled: true, dshEnabled: false,
        piIntegrationEnabled: false, claudeIntegrationEnabled: false });
      expect(events).toContainEqual({ event: "state", state: "connected" });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(create).not.toHaveBeenCalled();
      routed();
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    } finally { routed?.(); await runtime.close(); await relay.close(); await rm(root, { recursive: true, force: true }); }
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
    // An abandoned attempt must unwind first: the resume must not report a running Host, the abandoned
    // service must not read the released Codex Desktop lifecycle, and a DSH backend the abandoned run
    // created after the pause must be disposed instead of being attached or overwriting the resumed one.
    // HOST-PREP-05 moved the DSH prestart after the Relay connection, so "backend" pauses a connected run
    // while its background DeepSeek start is still in flight; the pause must not wait for that start.
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    let connections = 0;
    server.on("connection", socket => {
      connections += 1;
      // "service" first lets one attempt fail so that the paused attempt is a retry, as before.
      if (gate === "service" && connections === 1) { socket.close(); return; }
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
    let held = false;
    const hold = async (): Promise<void> => { held = true; await new Promise<void>(resolve => { release = resolve; }); };
    const create = vi.spyOn(DshRuntime, "create");
    if (gate === "backend") create.mockImplementationOnce(async () => { await hold(); return stale.runtime; });
    create.mockResolvedValue(resumedDsh.runtime);
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
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 4_000 });
      const paused = Date.now();
      await runtime.stop();
      expect(Date.now() - paused).toBeLessThan(2_000);
      const resumed = runtime.start({ ...settings });
      setTimeout(() => release(), 100);
      await resumed;
      expect([...events].reverse().find(event => event.event === "state")?.state).toBe("connected");
      await vi.waitFor(() => expect(events).toContainEqual({ event: "preparation", kind: "dsh", state: "ready" }));
      if (gate === "backend") await vi.waitFor(() => expect(stale.client.stop).toHaveBeenCalledTimes(1));
      expect(resumedDsh.client.stop).not.toHaveBeenCalled();
      // The abandoned "service" retry never reached the Relay; the abandoned "backend" run had connected.
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
