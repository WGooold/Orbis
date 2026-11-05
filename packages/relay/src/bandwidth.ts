import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 30;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const samplesSchema = z.object({
  bytes: integer,
  peakBytes: integer,
  // Sixteen buckets per power of two: P95 is an upper bound within 4.5%.
  histogram: z.record(z.string().regex(/^(0|[1-9]\d{0,2})$/), integer),
});
const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  uploadBytes: integer,
  downloadBytes: integer,
  activeSeconds: integer,
  upload: samplesSchema,
  download: samplesSchema,
  combined: samplesSchema,
});
const pendingSchema = z.object({ second: integer, uploadBytes: integer, downloadBytes: integer });
const stateSchema = z.object({
  version: z.literal(1),
  savedAt: integer,
  devices: z.array(z.object({
    deviceId: z.string(),
    firstSeenAt: integer,
    lastSeenAt: integer,
    days: z.array(daySchema),
    pending: pendingSchema.optional(),
  })),
});
type Samples = z.infer<typeof samplesSchema>;
type Day = z.infer<typeof daySchema>;
type Pending = z.infer<typeof pendingSchema>;
type Device = { deviceId: string; firstSeenAt: number; lastSeenAt: number; days: Map<string, Day>; pending?: Pending };

export type BandwidthRate = { meanBps: number; p95Bps: number; peakBps: number };
export type BandwidthDay = {
  date: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  activeSeconds: number;
  upload: BandwidthRate;
  download: BandwidthRate;
  combined: BandwidthRate;
};

const dateOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
const samples = (): Samples => ({ bytes: 0, peakBytes: 0, histogram: {} });
const emptyDay = (date: string): Day => ({ date, uploadBytes: 0, downloadBytes: 0, activeSeconds: 0, upload: samples(), download: samples(), combined: samples() });
const addSample = (target: Samples, bytes: number): void => {
  const bucket = bytes === 0 ? 0 : Math.ceil(Math.log2(bytes) * 16) + 1;
  target.bytes += bytes;
  target.peakBytes = Math.max(target.peakBytes, bytes);
  target.histogram[bucket] = (target.histogram[bucket] ?? 0) + 1;
};
const rate = (target: Samples, count: number): BandwidthRate => {
  let remaining = Math.ceil(count * 0.95);
  let p95Bytes = 0;
  if (remaining > 0) {
    for (const bucket of Object.keys(target.histogram).map(Number).sort((a, b) => a - b)) {
      remaining -= target.histogram[bucket]!;
      if (remaining <= 0) { p95Bytes = bucket === 0 ? 0 : Math.floor(2 ** ((bucket - 1) / 16)); break; }
    }
  }
  return { meanBps: count === 0 ? 0 : target.bytes * 8 / count, p95Bps: Math.min(p95Bytes, target.peakBytes) * 8, peakBps: target.peakBytes * 8 };
};
const summarize = (day: Day): BandwidthDay => ({
  date: day.date, uploadBytes: day.uploadBytes, downloadBytes: day.downloadBytes,
  totalBytes: day.uploadBytes + day.downloadBytes, activeSeconds: day.activeSeconds,
  upload: rate(day.upload, day.activeSeconds), download: rate(day.download, day.activeSeconds), combined: rate(day.combined, day.activeSeconds),
});
const aggregate = (days: Day[], date: string): BandwidthDay => {
  const result = emptyDay(date);
  for (const day of days) {
    result.uploadBytes += day.uploadBytes;
    result.downloadBytes += day.downloadBytes;
    result.activeSeconds += day.activeSeconds;
    for (const key of ["upload", "download", "combined"] as const) {
      const target = result[key], source = day[key];
      target.bytes += source.bytes;
      target.peakBytes = Math.max(target.peakBytes, source.peakBytes);
      for (const [bucket, count] of Object.entries(source.histogram)) target.histogram[bucket] = (target.histogram[bucket] ?? 0) + count;
    }
  }
  return summarize(result);
};

/** X11 / RELAY-BW-01: count each authenticated device edge once, without retaining frames or credentials. */
export class RelayBandwidth {
  readonly #devices = new Map<string, Device>();
  #lastPrunedDate = "";
  #revision = 0;
  #savedRevision = 0;
  #persistence = Promise.resolve();
  #savedAt: number | null = null;
  #storageError = false;

  private constructor(private readonly options: { stateFile?: string; now?: () => number }) {}

  static async create(options: { stateFile?: string; now?: () => number } = {}): Promise<RelayBandwidth> {
    const telemetry = new RelayBandwidth(options);
    if (options.stateFile) {
      try {
        const state = stateSchema.parse(JSON.parse(await readFile(options.stateFile, "utf8")));
        for (const device of state.devices) {
          const { pending, ...fields } = device;
          telemetry.#devices.set(device.deviceId, { ...fields, days: new Map(device.days.map(day => [day.date, day])), ...(pending ? { pending } : {}) });
        }
        telemetry.#savedAt = state.savedAt;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          // A broken optional telemetry file must not prevent encrypted traffic.
          telemetry.#storageError = true;
          console.warn(JSON.stringify({ event: "relay.bandwidth.load_failed" }));
        }
      }
    }
    telemetry.#prune(telemetry.#now());
    return telemetry;
  }

  #now(): number { return this.options.now?.() ?? Date.now(); }

  #prune(now: number): void {
    const date = dateOf(now);
    if (date === this.#lastPrunedDate) return;
    this.#lastPrunedDate = date;
    const cutoff = dateOf(now - (RETENTION_DAYS - 1) * DAY_MS);
    for (const [id, device] of this.#devices) {
      for (const day of device.days.keys()) if (day < cutoff || day > date) { device.days.delete(day); this.#revision++; }
      if (device.pending && (dateOf(device.pending.second * 1000) < cutoff || device.pending.second > Math.floor(now / 1000))) { delete device.pending; this.#revision++; }
      if (device.days.size === 0) { this.#devices.delete(id); this.#revision++; }
    }
  }

  #complete(device: Device, beforeSecond: number): void {
    const pending = device.pending;
    if (!pending || pending.second >= beforeSecond) return;
    const day = device.days.get(dateOf(pending.second * 1000));
    if (day) {
      day.activeSeconds++;
      addSample(day.upload, pending.uploadBytes);
      addSample(day.download, pending.downloadBytes);
      addSample(day.combined, pending.uploadBytes + pending.downloadBytes);
    }
    delete device.pending;
    this.#revision++;
  }

  record(deviceId: string, direction: "upload" | "download", bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    const now = this.#now();
    this.#prune(now);
    let device = this.#devices.get(deviceId);
    if (!device) {
      device = { deviceId, firstSeenAt: now, lastSeenAt: now, days: new Map() };
      this.#devices.set(deviceId, device);
    }
    const second = Math.floor(now / 1000);
    this.#complete(device, second);
    const date = dateOf(now);
    const day = device.days.get(date) ?? emptyDay(date);
    device.days.set(date, day);
    const pending = device.pending ?? { second, uploadBytes: 0, downloadBytes: 0 };
    const key = direction === "upload" ? "uploadBytes" : "downloadBytes";
    day[key] += bytes;
    pending[key] += bytes;
    device.pending = pending;
    device.lastSeenAt = now;
    this.#revision++;
  }

  snapshot() {
    const now = this.#now();
    this.#prune(now);
    const today = dateOf(now);
    const devices = [...this.#devices.values()].map(device => {
      this.#complete(device, Math.floor(now / 1000));
      const days = [...device.days.values()].sort((a, b) => b.date.localeCompare(a.date));
      return {
        deviceId: device.deviceId, firstSeenAt: device.firstSeenAt, lastSeenAt: device.lastSeenAt,
        today: summarize(device.days.get(today) ?? emptyDay(today)),
        last7Days: aggregate(days.filter(day => day.date >= dateOf(now - 6 * DAY_MS)), today),
        last30Days: aggregate(days, today),
        days: days.map(summarize),
      };
    });
    return {
      featureId: "X11", generatedAt: now, today, timezone: "UTC", retentionDays: RETENTION_DAYS,
      sampleSeconds: 1, percentileRelativeError: 0.045,
      scope: "authenticated-device-relay-message-bytes", ratePopulation: "completed-active-seconds",
      persistent: this.options.stateFile !== undefined, lastSavedAt: this.#savedAt, storageError: this.#storageError,
      devices,
    };
  }

  async flush(): Promise<void> {
    // Serialize saves, capturing state inside the queue so slow writes cannot overwrite newer totals.
    const pending = this.#persistence.then(async () => {
      this.snapshot();
      if (!this.options.stateFile || (this.#savedRevision === this.#revision && !this.#storageError)) return;
      const revision = this.#revision;
      const savedAt = this.#now();
      const state = {
        version: 1, savedAt,
        devices: [...this.#devices.values()].map(device => ({ ...device, days: [...device.days.values()] })),
      };
      // Freeze nested day/pending values before the first await; live traffic keeps mutating them.
      const contents = JSON.stringify(state);
      const path = this.options.stateFile;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, path);
      this.#savedRevision = revision;
      this.#savedAt = savedAt;
      this.#storageError = false;
    });
    this.#persistence = pending.catch(() => { this.#storageError = true; });
    return pending;
  }
}
