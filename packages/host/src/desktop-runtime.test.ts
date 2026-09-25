import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRelayServer } from "../../relay/src/index.js";
import { RegistrationAuthority } from "../../relay/src/registration.js";
import { loadDeviceStore, saveDeviceStore } from "@pi-remote/e2e";
import { DesktopRuntime, validateDesktopRelay, type DesktopEvent } from "./desktop-runtime.js";

describe("desktop Host lifecycle", () => {
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
});
