import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TOOL_PAGE_BODY_MAX_BYTES, ToolContentLocatorSchema, ToolContentReadRequestSchema, createToolContentPage,
  agentKeyId, toolContentLocatorId, toolIdentityId, type AgentKey, type ToolContentGap, type ToolContentLocator, type ToolContentPage,
  type ToolContentReadIdentity, type ToolContentReadRequest,
} from "@orbis/protocol";

export const TOOL_CONTENT_DEFAULTS = {
  perPartBytes: 16 * 1024 * 1024, perToolBytes: 16 * 1024 * 1024, producerBytes: 64 * 1024 * 1024, maxParts: 256,
  retentionMs: 10 * 60_000, readLeaseMs: 30_000, maxReads: 64, maxRequests: 256,
  maxPendingBytes: 1024 * 1024, maxPendingOperations: 64, maxWriteBytes: 1024 * 1024,
} as const;
type Limits = { [K in keyof typeof TOOL_CONTENT_DEFAULTS]: number };
type Format = ToolContentPage["format"];
export type ToolContentStatus = {
  contentEpoch: string; format: Format; observedThroughOffset: number; availableThroughOffset: number;
  contentFinal: boolean; gaps: ToolContentGap[];
};
type Part = ToolContentStatus & { locator: ToolContentLocator; path: string; updatedAt: number };
type Lease = { key: string; owner: string; identity: ToolContentReadIdentity; expiresAt: number };
type RequestRecord = { fingerprint: string; readId: string; expiresAt: number };

export class ToolContentReadError extends Error {
  constructor(readonly reason: "content_expired" | "content_unavailable" | "content_version_invalid" |
    "content_range_unavailable" | "invalid_utf8_offset" | "busy" | "cancelled" | "scope_mismatch",
    readonly gaps: readonly ToolContentGap[] = []) {
    super(reason);
  }
}

/** Implemented by native-history readers and by the live producer store. No transport or Registry ownership. */
export interface ToolContentReader {
  read(owner: string, request: ToolContentReadRequest, signal?: AbortSignal): Promise<ToolContentPage>;
  cancel(owner: string, readId: string): Promise<void>;
}

/** Reclaim only this producer's lock after the OS proves its former process no longer exists. */
export async function createProcessToolContentStore(directory: string, producerId: string): Promise<ToolContentStore> {
  const hash = createHash("sha256").update(producerId).digest("hex");
  let reclaimStale = false;
  try {
    const lock = JSON.parse(await readFile(join(directory, `tool-content-${hash}.lock`), "utf8")) as { pid?: unknown };
    if (typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0) {
      try { process.kill(lock.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") reclaimStale = true; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return ToolContentStore.create({ directory, producerId, reclaimStale });
}

/**
 * Producer-owned temporary content. Host and Pi can use the same implementation.
 * Append calls must use complete Unicode strings, in source order; adapters chunk large source values.
 * A busy rejection is explicit: callers must retry or report a source gap, never silently drop it.
 */
export class ToolContentStore implements ToolContentReader {
  readonly #parts = new Map<string, Part>();
  readonly #leases = new Map<string, Lease>();
  readonly #expired = new Map<string, number>();
  readonly #requests = new Map<string, RequestRecord>();
  readonly #limits: Limits;
  readonly #clock: () => number;
  readonly #root: string;
  readonly #lockPath: string;
  readonly #maintenance: ReturnType<typeof setInterval>;
  #maintenanceFailures = 0;
  #bytes = 0;
  #pendingBytes = 0;
  #pendingOperations = 0;
  #reads = 0;
  #cacheHits = 0;
  #busyHits = 0;
  #quotaHits = 0;
  #gapBytes = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(root: string, lockPath: string, limits: Limits, clock: () => number) {
    this.#root = root; this.#lockPath = lockPath; this.#limits = limits; this.#clock = clock;
    this.#maintenance = setInterval(() => {
      void this.sweep().catch(error => {
        if (!(error instanceof ToolContentReadError && error.reason === "busy")) this.#maintenanceFailures++;
      });
    }, Math.min(30_000, limits.retentionMs, limits.readLeaseMs));
    this.#maintenance.unref();
  }

  /** One producerId per native producer; the caller must prove exclusive ownership before reclaiming a stale lock. */
  static async create(options: { directory: string; producerId: string; limits?: Partial<Limits>;
    clock?: () => number; reclaimStale?: boolean }): Promise<ToolContentStore> {
    const limits = { ...TOOL_CONTENT_DEFAULTS, ...options.limits };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_tool_content_limit:${name}`);
    }
    if (limits.perPartBytes > limits.perToolBytes || limits.maxWriteBytes > limits.maxPendingBytes) {
      throw new Error("invalid_tool_content_limits");
    }
    if (!options.producerId.trim() || Buffer.byteLength(options.producerId) > 1024) throw new Error("invalid_tool_content_producer");
    await mkdir(options.directory, { recursive: true });
    const producerHash = createHash("sha256").update(options.producerId).digest("hex");
    const root = join(options.directory, `tool-content-${producerHash}`);
    const lockPath = join(options.directory, `tool-content-${producerHash}.lock`);
    if (options.reclaimStale === true) await rm(lockPath, { force: true });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    try {
      // Remove only this exclusively-owned producer directory, including files from a previous crash.
      await rm(root, { recursive: true, force: true }); await mkdir(root);
      return new ToolContentStore(root, lockPath, limits, options.clock ?? Date.now);
    } catch (error) { await rm(lockPath, { force: true }); throw error; }
  }

  get usage(): { retainedBytes: number; parts: number; reads: number; pendingBytes: number; maintenanceFailures: number;
    readRequests: number; cacheHits: number; busyHits: number; quotaHits: number; gapBytes: number } {
    return { retainedBytes: this.#bytes, parts: this.#parts.size, reads: this.#leases.size,
      pendingBytes: this.#pendingBytes, maintenanceFailures: this.#maintenanceFailures,
      readRequests: this.#reads, cacheHits: this.#cacheHits, busyHits: this.#busyHits, quotaHits: this.#quotaHits, gapBytes: this.#gapBytes };
  }

  // ADR-0045 §4：内部 IO 队列和其持有的原文也有上限；不把写盘背压传给原生执行。
  #run<T>(bytes: number, operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new ToolContentReadError("content_unavailable"));
    if (this.#pendingOperations >= this.#limits.maxPendingOperations ||
      this.#pendingBytes + bytes > this.#limits.maxPendingBytes) { this.#busyHits++; return Promise.reject(new ToolContentReadError("busy")); }
    this.#pendingOperations++; this.#pendingBytes += bytes;
    const result = this.#tail.then(operation).finally(() => { this.#pendingOperations--; this.#pendingBytes -= bytes; });
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #evict(key: string): Promise<void> {
    const part = this.#parts.get(key);
    if (part === undefined) return;
    await rm(part.path, { force: true });
    this.#bytes -= part.availableThroughOffset;
    this.#parts.delete(key);
    this.#expired.delete(key); this.#expired.set(key, this.#clock());
    while (this.#expired.size > this.#limits.maxParts * 2) this.#expired.delete(this.#expired.keys().next().value!);
    for (const [id, lease] of this.#leases) if (lease.key === key) this.#leases.delete(id);
  }

  async #expire(): Promise<void> {
    const now = this.#clock();
    for (const [id, lease] of this.#leases) if (lease.expiresAt <= now) this.#leases.delete(id);
    for (const [key, part] of this.#parts) if (now - part.updatedAt >= this.#limits.retentionMs) await this.#evict(key);
    for (const [key, at] of this.#expired) if (now - at >= this.#limits.retentionMs) this.#expired.delete(key);
    for (const [key, record] of this.#requests) if (record.expiresAt <= now) this.#requests.delete(key);
  }

  #part(key: string, epoch?: string): Part {
    const part = this.#parts.get(key);
    if (part === undefined) throw new ToolContentReadError(this.#expired.has(key) ? "content_expired" : "content_unavailable");
    if (epoch !== undefined && epoch !== part.contentEpoch) throw new ToolContentReadError("content_version_invalid");
    return part;
  }

  #status(part: Part): ToolContentStatus {
    return { contentEpoch: part.contentEpoch, format: part.format, observedThroughOffset: part.observedThroughOffset,
      availableThroughOffset: part.availableThroughOffset, contentFinal: part.contentFinal,
      gaps: part.gaps.map(gap => ({ ...gap })) };
  }

  #oldest(exclude?: string): string | undefined {
    return [...this.#parts].filter(([key]) => key !== exclude).sort(([, a], [, b]) =>
      Number(b.contentFinal) - Number(a.contentFinal) || a.updatedAt - b.updatedAt)[0]?.[0];
  }

  /** Invalidate only one logical session; other producers/sessions keep their content and leases. */
  invalidateAgent(agent: AgentKey): Promise<void> {
    return this.#run(0, async () => {
      for (const [key, part] of this.#parts) if (agentKeyId(part.locator.tool.agent) === agentKeyId(agent)) await this.#evict(key);
    });
  }

  /** Also replaces an existing part. Old reads fail with an explicit content epoch mismatch. */
  begin(locator: ToolContentLocator, format: Format): Promise<ToolContentStatus> {
    locator = ToolContentLocatorSchema.parse(locator);
    const key = toolContentLocatorId(locator);
    return this.#run(0, async () => {
      await this.#expire();
      const old = this.#parts.get(key);
      if (old !== undefined) {
        await rm(old.path, { force: true });
        this.#bytes -= old.availableThroughOffset; this.#parts.delete(key);
        for (const [id, lease] of this.#leases) if (lease.key === key) this.#leases.delete(id);
      }
      while (this.#parts.size >= this.#limits.maxParts) await this.#evict(this.#oldest()!);
      const path = join(this.#root, randomUUID());
      await writeFile(path, new Uint8Array(), { flag: "wx" });
      const part: Part = { locator, path, contentEpoch: randomUUID(), format, observedThroughOffset: 0,
        availableThroughOffset: 0, contentFinal: false, gaps: [], updatedAt: this.#clock() };
      this.#expired.delete(key); this.#parts.set(key, part);
      return this.#status(part);
    });
  }

  append(locator: ToolContentLocator, contentEpoch: string, text: string): Promise<ToolContentStatus> {
    const length = Buffer.byteLength(text, "utf8");
    if (length > this.#limits.maxWriteBytes) return Promise.reject(new Error("tool_content_write_too_large"));
    const key = toolContentLocatorId(ToolContentLocatorSchema.parse(locator));
    return this.#run(length, async () => {
      await this.#expire();
      const part = this.#part(key, contentEpoch);
      if (part.contentFinal) throw new Error("tool_content_already_final");
      if (length === 0) return this.#status(part);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.toString("utf8") !== text) throw new Error("invalid_tool_content_unicode");
      if (!Number.isSafeInteger(part.observedThroughOffset + length)) throw new Error("tool_content_offset_overflow");
      const toolId = toolIdentityId(part.locator.tool);
      const toolBytes = [...this.#parts.values()].filter(value => toolIdentityId(value.locator.tool) === toolId)
        .reduce((total, value) => total + value.availableThroughOffset, 0);
      // Once a suffix gap exists, retain no later suffix: never present discontinuous bytes as one text.
      let keep = part.gaps.length > 0 ? 0 : Math.min(length, this.#limits.perPartBytes - part.availableThroughOffset,
        this.#limits.perToolBytes - toolBytes);
      while (this.#bytes + keep > this.#limits.producerBytes) {
        const candidate = this.#oldest(key);
        if (candidate === undefined) { keep = Math.max(0, this.#limits.producerBytes - this.#bytes); break; }
        await this.#evict(candidate);
      }
      while (keep > 0 && keep < length && (bytes[keep]! & 0xc0) === 0x80) keep--;
      if (keep > 0) {
        const file = await open(part.path, "r+");
        try {
          let written = 0;
          while (written < keep) {
            const result = await file.write(bytes, written, keep - written, part.availableThroughOffset + written);
            if (result.bytesWritten === 0) throw new Error("tool_content_write_stalled");
            written += result.bytesWritten;
          }
        } catch (error) {
          // Do not leave an unaccounted partial suffix after a failed write.
          await file.truncate(part.availableThroughOffset);
          throw error;
        } finally { await file.close(); }
      }
      part.availableThroughOffset += keep; this.#bytes += keep; part.observedThroughOffset += length;
      if (keep < length) { this.#quotaHits++; this.#gapBytes += length - keep; }
      if (keep < length) part.gaps = [{ fromOffset: part.availableThroughOffset,
        throughOffset: part.observedThroughOffset, reason: part.gaps[0]?.reason ?? "quota" }];
      part.updatedAt = this.#clock();
      return this.#status(part);
    });
  }

  /** The adapter knows bytes were not retained (for example after upstream loss or a rejected enqueue). */
  recordGap(locator: ToolContentLocator, contentEpoch: string, bytes: number,
    reason: "quota" | "source-missing"): Promise<ToolContentStatus> {
    if (!Number.isSafeInteger(bytes) || bytes < 1) return Promise.reject(new Error("invalid_tool_content_gap"));
    const key = toolContentLocatorId(ToolContentLocatorSchema.parse(locator));
    return this.#run(0, async () => {
      await this.#expire(); const part = this.#part(key, contentEpoch);
      if (part.contentFinal) throw new Error("tool_content_already_final");
      if (!Number.isSafeInteger(part.observedThroughOffset + bytes)) throw new Error("tool_content_offset_overflow");
      part.observedThroughOffset += bytes;
      this.#gapBytes += bytes;
      part.gaps = [{ fromOffset: part.availableThroughOffset, throughOffset: part.observedThroughOffset,
        reason: part.gaps[0]?.reason ?? reason }];
      part.updatedAt = this.#clock(); return this.#status(part);
    });
  }

  finish(locator: ToolContentLocator, contentEpoch: string): Promise<ToolContentStatus> {
    const key = toolContentLocatorId(ToolContentLocatorSchema.parse(locator));
    return this.#run(0, async () => {
      await this.#expire(); const part = this.#part(key, contentEpoch);
      part.contentFinal = true; part.updatedAt = this.#clock(); return this.#status(part);
    });
  }

  // ADR-0045 §6：读取固定可用前缀，后续 append 不改变旧读取上界；replace 必须失效。
  read(owner: string, request: ToolContentReadRequest, signal?: AbortSignal): Promise<ToolContentPage> {
    request = ToolContentReadRequestSchema.parse(request);
    this.#reads++;
    if (request.read !== null) this.#cacheHits++;
    if (!owner.trim()) return Promise.reject(new ToolContentReadError("scope_mismatch"));
    return this.#run(0, async () => {
      if (signal?.aborted) throw new ToolContentReadError("cancelled");
      await this.#expire();
      const key = toolContentLocatorId(request.locator);
      const part = this.#part(key, request.read?.contentEpoch);
      const requestKey = JSON.stringify([owner, request.requestId]);
      const fingerprint = JSON.stringify(request);
      const previous = this.#requests.get(requestKey);
      if (previous !== undefined && previous.fingerprint !== fingerprint) throw new ToolContentReadError("scope_mismatch");
      const retried = previous === undefined ? undefined : this.#leases.get(previous.readId);
      if (previous !== undefined && retried === undefined) throw new ToolContentReadError("content_expired");
      // Pinned continuations derive idempotency from readId/epoch/range and need no per-page record.
      if (request.read === null && previous === undefined && this.#requests.size >= this.#limits.maxRequests) {
        throw new ToolContentReadError("busy");
      }
      let lease: Lease;
      if (request.read === null && retried === undefined) {
        if (this.#leases.size >= this.#limits.maxReads) throw new ToolContentReadError("busy");
        lease = { key, owner, expiresAt: this.#clock() + this.#limits.readLeaseMs, identity: {
          readId: randomUUID(), contentEpoch: part.contentEpoch, throughOffset: part.availableThroughOffset } };
      } else if (request.read === null) {
        lease = retried!;
      } else {
        const existing = this.#leases.get(request.read.readId);
        if (existing === undefined) throw new ToolContentReadError("content_expired");
        if (existing.owner !== owner || existing.key !== key) throw new ToolContentReadError("scope_mismatch");
        if (existing.identity.throughOffset !== request.read.throughOffset || existing.identity.contentEpoch !== request.read.contentEpoch) {
          throw new ToolContentReadError("content_version_invalid");
        }
        lease = existing;
      }
      if (request.offset > lease.identity.throughOffset) throw new ToolContentReadError("content_range_unavailable", part.gaps);
      const count = Math.min(request.maxBytes, TOOL_PAGE_BODY_MAX_BYTES, lease.identity.throughOffset - request.offset);
      const buffer = Buffer.alloc(count + (count > 0 && request.offset + count < lease.identity.throughOffset ? 1 : 0));
      const file = await open(part.path, "r");
      try {
        let read = 0;
        while (read < buffer.length) {
          const result = await file.read(buffer, read, buffer.length - read, request.offset + read);
          if (result.bytesRead === 0) throw new ToolContentReadError("content_unavailable");
          read += result.bytesRead;
        }
      } finally { await file.close(); }
      if (count > 0 && (buffer[0]! & 0xc0) === 0x80) throw new ToolContentReadError("invalid_utf8_offset");
      let end = count;
      while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
      if (signal?.aborted) throw new ToolContentReadError("cancelled");
      const page = createToolContentPage({ type: "session.tool.content.page", requestId: request.requestId,
        runtimeId: request.runtimeId, locator: request.locator, read: lease.identity, format: part.format,
        representation: "utf8-fragment", fromOffset: request.offset, availableFromOffset: 0,
        availableThroughOffset: part.availableThroughOffset, observedThroughOffset: part.observedThroughOffset,
        contentFinal: part.contentFinal, gaps: part.gaps.map(gap => ({ ...gap })) },
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end)));
      lease.expiresAt = this.#clock() + this.#limits.readLeaseMs;
      this.#leases.set(lease.identity.readId, lease);
      if (request.read === null && previous === undefined) {
        this.#requests.set(requestKey, { fingerprint, readId: lease.identity.readId,
          expiresAt: this.#clock() + this.#limits.retentionMs });
      }
      return page;
    });
  }

  cancel(owner: string, readId: string): Promise<void> {
    return this.#run(0, async () => {
      const lease = this.#leases.get(readId);
      if (lease !== undefined && lease.owner !== owner) throw new ToolContentReadError("scope_mismatch");
      this.#leases.delete(readId);
    });
  }

  sweep(): Promise<void> { return this.#run(0, () => this.#expire()); }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    clearInterval(this.#maintenance);
    this.#closed = true; await this.#tail;
    await rm(this.#root, { recursive: true, force: true });
    await rm(this.#lockPath, { force: true });
    this.#parts.clear(); this.#leases.clear(); this.#expired.clear(); this.#requests.clear(); this.#bytes = 0;
  }
}
