import { agentKeyId, ToolContentPageSchema, ToolReadFailureSchema, toolContentPageMatchesRequest,
  type AgentKey, type RuntimeEvent, type ToolContentReadRequest } from "@orbis/protocol";
import { ToolContentReadError, waitForToolRead, type ToolContentReader } from "@orbis/runtime-bridge";

type Active = { runtimeId: string; viewerId: string; controller: AbortController; owner: string; request: ToolContentReadRequest };
type Lease = { reader: ToolContentReader; owner: string; readId: string; expires: number; runtimeId: string; viewerId: string };
type ToolContentServiceOptions = {
  scope: (runtimeId: string) => AgentKey | undefined;
  reader: (runtimeId: string) => ToolContentReader | undefined;
  send: (deviceId: string, runtimeId: string, event: RuntimeEvent) => boolean;
  observe?: (runtimeId: string, event: "request" | "page" | "failure", bytes: number, gaps: number) => void;
};

/** ADR-0045 §6/§8：详情只属于发起设备，读取成功不改变 conversation 或通用命令回执。 */
export class ToolContentService {
  readonly #options: ToolContentServiceOptions;
  readonly #active = new Map<string, Map<string, Active>>();
  readonly #leases = new Map<string, Map<string, Lease>>();
  #closed = false;
  constructor(options: ToolContentServiceOptions) { this.#options = options; }

  #failure(deviceId: string, request: ToolContentReadRequest, reason: ToolContentReadError["reason"],
    gaps: ToolContentReadError["gaps"] = []): void {
    this.#options.observe?.(request.runtimeId, "failure", 0, gaps.length);
    try { this.#options.send(deviceId, request.runtimeId, ToolReadFailureSchema.parse({ type: "session.tool.read.failed",
      requestId: request.requestId, runtimeId: request.runtimeId, reason, gaps,
      ...(reason === "busy" ? { retryAfterMs: 250 } : {}) })); } catch { /* A lost path cannot fail the shared source. */ }
  }

  async read(deviceId: string, runtimeId: string, request: ToolContentReadRequest): Promise<void> {
    if (this.#closed) return;
    this.#options.observe?.(runtimeId, "request", 0, 0);
    this.#sweep();
    const scope = this.#options.scope(runtimeId), reader = this.#options.reader(runtimeId);
    if (!scope || runtimeId !== request.runtimeId || agentKeyId(scope) !== agentKeyId(request.locator.tool.agent)) {
      this.#failure(deviceId, request, "scope_mismatch"); return;
    }
    if (!reader) { this.#failure(deviceId, request, "content_unavailable"); return; }
    const viewers = this.#active.get(deviceId) ?? new Map<string, Active>();
    if (viewers.size >= 2 || viewers.has(request.viewerId) ||
      new Set([...this.#active.keys(), ...this.#leases.keys()]).size >= 256 && !this.#active.has(deviceId) && !this.#leases.has(deviceId)) {
      this.#failure(deviceId, request, "busy"); return;
    }
    const leases = this.#leases.get(deviceId) ?? new Map<string, Lease>();
    for (const [id, lease] of leases) if (lease.expires <= Date.now()) {
      leases.delete(id); void lease.reader.cancel(lease.owner, lease.readId).catch(() => undefined);
    }
    if (leases.size >= 64 && (request.read === null || !leases.has(request.read.readId))) {
      this.#failure(deviceId, request, "busy"); return;
    }
    const owner = JSON.stringify([deviceId, request.viewerId]);
    if (request.read && (leases.get(request.read.readId)?.owner !== owner || leases.get(request.read.readId)?.runtimeId !== runtimeId)) {
      this.#failure(deviceId, request, "scope_mismatch"); return;
    }
    const active: Active = { runtimeId, viewerId: request.viewerId, owner, request, controller: new AbortController() };
    viewers.set(request.viewerId, active); this.#active.set(deviceId, viewers); this.#leases.set(deviceId, leases);
    const timer = setTimeout(() => active.controller.abort(), 30_000); timer.unref();
    try {
      const work = reader.read(owner, request, active.controller.signal);
      void work.then(page => {
        if (active.controller.signal.aborted || this.#closed || viewers.get(request.viewerId) !== active)
          void reader.cancel(owner, page.read.readId).catch(() => undefined);
      }, () => undefined);
      const page = ToolContentPageSchema.parse(await waitForToolRead(work, active.controller.signal));
      if (active.controller.signal.aborted || this.#closed || viewers.get(request.viewerId) !== active) return;
      const current = this.#options.scope(runtimeId);
      if (!current || agentKeyId(current) !== agentKeyId(scope) || !toolContentPageMatchesRequest(request, page)) {
        throw new ToolContentReadError("scope_mismatch");
      }
      leases.set(page.read.readId, { reader, owner, readId: page.read.readId, expires: Date.now() + 30_000,
        runtimeId, viewerId: request.viewerId });
      if (!this.#options.send(deviceId, runtimeId, page)) this.#failure(deviceId, request, "busy");
      else this.#options.observe?.(runtimeId, "page", Buffer.byteLength(JSON.stringify(page), "utf8"), page.gaps.length);
    } catch (error) {
      if (!this.#closed && viewers.get(request.viewerId) === active) this.#failure(deviceId, request,
        error instanceof ToolContentReadError ? error.reason : "content_unavailable", error instanceof ToolContentReadError ? error.gaps : []);
    } finally {
      clearTimeout(timer);
      if (viewers.get(request.viewerId) === active) viewers.delete(request.viewerId);
      if (!viewers.size) this.#active.delete(deviceId);
      if (!leases.size) this.#leases.delete(deviceId);
    }
  }

  cancel(deviceId: string, runtimeId: string, viewerId: string, readId: string): void {
    const viewers = this.#active.get(deviceId), active = viewers?.get(viewerId);
    if (active?.runtimeId === runtimeId) { viewers!.delete(viewerId); active.controller.abort(); }
    const leases = this.#leases.get(deviceId), lease = leases?.get(readId);
    if (lease?.runtimeId === runtimeId && lease.viewerId === viewerId) {
      leases!.delete(readId); void lease.reader.cancel(lease.owner, readId).catch(() => undefined);
    }
    if (viewers?.size === 0) this.#active.delete(deviceId);
    if (leases?.size === 0) this.#leases.delete(deviceId);
  }
  #sweep(): void {
    for (const [device, leases] of this.#leases) {
      for (const [id, lease] of leases) if (lease.expires <= Date.now()) {
        leases.delete(id); void lease.reader.cancel(lease.owner, lease.readId).catch(() => undefined);
      }
      if (!leases.size) this.#leases.delete(device);
    }
  }

  releaseDevice(deviceId: string): void {
    for (const active of this.#active.get(deviceId)?.values() ?? []) active.controller.abort();
    this.#active.delete(deviceId);
    for (const lease of this.#leases.get(deviceId)?.values() ?? []) void lease.reader.cancel(lease.owner, lease.readId).catch(() => undefined);
    this.#leases.delete(deviceId);
  }
  releaseRuntime(runtimeId: string): void {
    for (const [deviceId, viewers] of this.#active) for (const active of viewers.values()) {
      if (active.runtimeId === runtimeId) this.cancel(deviceId, runtimeId, active.viewerId, "cancel-pending");
    }
    for (const [deviceId, leases] of this.#leases) for (const lease of leases.values()) {
      if (lease.runtimeId === runtimeId) this.cancel(deviceId, runtimeId, lease.viewerId, lease.readId);
    }
  }
  close(): void {
    this.#closed = true;
    for (const id of new Set([...this.#active.keys(), ...this.#leases.keys()])) this.releaseDevice(id);
  }
}
