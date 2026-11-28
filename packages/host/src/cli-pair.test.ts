import type { DeviceRecord, PairingQrPayload } from "@orbis/e2e";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runPairingWindow } from "./cli-pair.js";

const windowMs = 120_000;
const payload: PairingQrPayload = {
  v: 2, relayUrl: "ws://127.0.0.1:8787", code: "TESTCODE", hostId: "test-host", hostName: "test",
  hostPub: "test-pub", psk: "test-psk", exp: 0, lan: [{ host: "192.0.2.1", port: 42130 }],
};
const device: DeviceRecord = { deviceId: "test-device", devicePub: "test-", pskRoot: "test-", label: "", createdAt: 0, revoked: false };

function makePairing() {
  const service = {
    start: vi.fn(async () => {}),
    openPairingWindow: vi.fn(async () => ({ code: payload.code, payload, expiresAtMs: Date.now() + windowMs })),
    stop: vi.fn(async () => {}),
  };
  let onPaired!: (record: DeviceRecord) => void;
  const paired = new Promise<DeviceRecord>(resolve => { onPaired = resolve; });
  return { service, paired, onPaired };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("prints only the pairing JSON to stdout and cancels the timer on success", async () => {
  const { service, paired, onPaired } = makePairing();
  const pairing = runPairingWindow(service, paired, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  onPaired(device);
  await expect(pairing).resolves.toBe("paired");
  expect(service.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(console.log).toHaveBeenCalledTimes(1);
  expect(console.log).toHaveBeenCalledWith(JSON.stringify(payload));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("192.0.2.1:42130"));
  expect(console.error).toHaveBeenCalledWith("配对成功：test-device");
});

it("keeps the expiry timer until an unpaired window expires", async () => {
  const { service, paired } = makePairing();
  const pairing = runPairingWindow(service, paired, true);
  await vi.advanceTimersByTimeAsync(windowMs - 1);
  expect(service.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pairing).resolves.toBe("expired");
  expect(service.stop).toHaveBeenCalledTimes(1);
  expect(console.log).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("配对窗口已过期"));
});

// A user-initiated CLI shutdown is not an expired window or a successful pairing.
it("clears the pairing window and stops the service on shutdown", async () => {
  const { service, paired } = makePairing();
  let requestShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => { requestShutdown = resolve; });
  const pairing = runPairingWindow(service, paired, true, shutdown);
  await vi.advanceTimersByTimeAsync(0);
  requestShutdown();
  await expect(pairing).resolves.toBe("cancelled");
  expect(service.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(console.error).not.toHaveBeenCalledWith(expect.stringMatching(/配对窗口已过期|配对成功/u));
});

it("stops the service if opening the pairing window fails", async () => {
  const { service, paired } = makePairing();
  service.openPairingWindow.mockRejectedValueOnce(new Error("Relay refused pairing"));
  await expect(runPairingWindow(service, paired, true)).rejects.toThrow("Relay refused pairing");
  expect(service.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(console.log).not.toHaveBeenCalled();
});
