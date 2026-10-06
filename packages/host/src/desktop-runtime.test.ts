import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createRelayServer } from "../../relay/src/index.js";
import { RegistrationAuthority } from "../../relay/src/registration.js";
import { loadDeviceStore, saveDeviceStore } from "@pi-remote/e2e";
import { DesktopRuntime, validateDesktopRelay, type DesktopEvent } from "./desktop-runtime.js";

describe("desktop Host lifecycle", () => {
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
      await runtime.start({ relayUrl: relay.url, credential: activated.credential, lanPort: 0, stunServers: [] });
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
      await runtime.start({ relayUrl: `ws://127.0.0.1:${port}`, credential: "orbis_host_" + "A".repeat(43), lanPort: 0, stunServers: [], codexEnabled: false, dshEnabled: false });
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
});
