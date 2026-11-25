import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RelayBandwidth } from "./bandwidth.js";

describe("X11 / RELAY-BW-01 device bandwidth", () => {
  // Same-second bursts and both directions must share one sample; idle time must not dilute demand.
  it("counts device bytes separately, combines each active second, and keeps exact peaks", async () => {
    let now = Date.parse("2026-11-05T12:00:00Z");
    const meter = await RelayBandwidth.create({ now: () => now });
    meter.record("phone", "upload", 100);
    meter.record("phone", "upload", 50);
    meter.record("phone", "download", 850);
    meter.record("tablet", "download", 25);
    expect(meter.snapshot().devices[0]?.today).toMatchObject({ uploadBytes: 150, downloadBytes: 850, activeSeconds: 0 });
    now += 1_000;
    const first = meter.snapshot().devices.find(device => device.deviceId === "phone")!.today;
    expect(first).toMatchObject({ totalBytes: 1_000, activeSeconds: 1, combined: { meanBps: 8_000, peakBps: 8_000 } });
    now += 60_000;
    meter.record("phone", "download", 3_000);
    now += 1_000;
    const phone = meter.snapshot().devices.find(device => device.deviceId === "phone")!.today;
    expect(phone).toMatchObject({ totalBytes: 4_000, activeSeconds: 2, combined: { meanBps: 16_000, p95Bps: 24_000, peakBps: 24_000 } });
    expect(meter.snapshot().devices.find(device => device.deviceId === "tablet")!.today.totalBytes).toBe(25);
  });

  // A percentile of daily percentiles is wrong: merge histogram populations across days instead.
  it("computes P95 across samples and UTC days within its stated upper-bound error", async () => {
    let now = Date.parse("2026-11-04T23:59:00Z");
    const meter = await RelayBandwidth.create({ now: () => now });
    for (let index = 0; index < 100; index++) {
      meter.record("phone", "upload", index < 95 ? 101 : 10_000);
      now += 1_000;
    }
    const device = meter.snapshot().devices[0]!;
    expect(device.days).toHaveLength(2);
    expect(device.last7Days.activeSeconds).toBe(100);
    expect(device.last7Days.combined.p95Bps).toBeGreaterThanOrEqual(101 * 8);
    expect(device.last7Days.combined.p95Bps).toBeLessThanOrEqual(101 * 8 * 1.045);
    expect(device.last7Days.combined.peakBps).toBe(80_000);
    expect(device.today.uploadBytes).toBe(35 * 101 + 5 * 10_000);
    now += 10 * 86_400_000;
    expect(meter.snapshot().devices[0]!.last7Days.totalBytes).toBe(0);
    now += 30 * 86_400_000;
    expect(meter.snapshot().devices).toEqual([]);
  });

  // A save during a live second, then restart/reconnect, must neither lose nor sample that second twice.
  it("persists pending samples and restores counters without duplicating them", async () => {
    let now = Date.parse("2026-11-05T12:00:00Z");
    const directory = await mkdtemp(join(tmpdir(), "orbis-bandwidth-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const stateFile = join(directory, "traffic.json");
    const options = { stateFile, now: () => now };
    const meter = await RelayBandwidth.create(options);
    meter.record("phone", "upload", 150);
    await meter.flush();
    const restored = await RelayBandwidth.create(options);
    restored.record("phone", "download", 850);
    now += 1_000;
    await Promise.all([restored.flush(), restored.flush()]);
    const restarted = await RelayBandwidth.create(options);
    expect(restarted.snapshot().devices[0]!.today).toMatchObject({ uploadBytes: 150, downloadBytes: 850, activeSeconds: 1, combined: { meanBps: 8_000, peakBps: 8_000 } });
    // Windows stat synthesizes mode bits; the deployed POSIX filesystem enforces 0600.
    if (process.platform !== "win32") expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    const state = await readFile(stateFile, "utf8");
    expect(JSON.parse(state)).toMatchObject({ version: 1, savedAt: now });
    expect(state).not.toMatch(/credential|ciphertext|envelope|email/);
  });

  // Traffic may advance a pending second while filesystem I/O is in flight; a saved snapshot must stay coherent.
  it("captures an immutable save before allowing the next second to mutate live counters", async () => {
    let now = Date.parse("2026-11-05T12:00:00Z");
    const directory = await mkdtemp(join(tmpdir(), "orbis-bandwidth-concurrent-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const stateFile = join(directory, "traffic.json");
    const options = { stateFile, now: () => now };
    const meter = await RelayBandwidth.create(options);
    meter.record("phone", "upload", 100);
    const saving = meter.flush();
    await Promise.resolve();
    now += 1_000;
    meter.record("phone", "download", 900);
    await saving;
    const saved = await RelayBandwidth.create(options);
    expect(saved.snapshot().devices[0]!.today).toMatchObject({ uploadBytes: 100, downloadBytes: 0, activeSeconds: 1, combined: { meanBps: 800, peakBps: 800 } });
    await meter.flush();
    now += 1_000;
    const latest = await RelayBandwidth.create(options);
    expect(latest.snapshot().devices[0]!.today).toMatchObject({ totalBytes: 1_000, activeSeconds: 2, combined: { meanBps: 4_000, peakBps: 7_200 } });
  });

  // Telemetry storage failures must leave traffic accounting usable and report persistence health.
  it("reports corrupt or unwritable storage and recovers after a successful save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-bandwidth-error-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const stateFile = join(directory, "traffic.json");
    await writeFile(stateFile, "corrupt");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const meter = await RelayBandwidth.create({ stateFile });
      expect(meter.snapshot().storageError).toBe(true);
      meter.record("phone", "download", 100);
      await meter.flush();
      expect(meter.snapshot().storageError).toBe(false);
      const unwritable = await RelayBandwidth.create({ stateFile: join(stateFile, "child.json") });
      unwritable.record("phone", "download", 10);
      await expect(unwritable.flush()).rejects.toThrow();
      expect(unwritable.snapshot()).toMatchObject({ storageError: true, devices: [{ today: { downloadBytes: 10 } }] });
    } finally { warn.mockRestore(); }
  });
});
