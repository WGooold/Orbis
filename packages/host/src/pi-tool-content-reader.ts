import { randomUUID } from "node:crypto";
import { agentKeyId, ToolContentPageSchema, toolContentPageMatchesRequest, type AgentKey, type RuntimeCommand,
  type RuntimeEvent, type ToolContentReadRequest } from "@orbis/protocol";
import { ToolContentReadError, type ToolContentReader } from "@orbis/runtime-bridge";

/** Local loopback correlation. Raw pages are consumed here before shared event/Registry dispatch. */
type Options = { send: (runtimeId: string, commandId: string, command: RuntimeCommand) => boolean;
  scope: (runtimeId: string) => AgentKey | undefined };
export class PiToolContentReader implements ToolContentReader {
  readonly #options: Options;
  readonly #pending = new Map<string, { request: ToolContentReadRequest; resolve: (event: RuntimeEvent) => void;
    reject: (error: Error) => void; owner: string }>();
  readonly #leases = new Map<string, { runtimeId: string; viewerId: string; owner: string; expires: number }>();
  constructor(options: Options) { this.#options = options; }

  async read(owner: string, request: ToolContentReadRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw new ToolContentReadError("cancelled");
    if (this.#pending.size >= 2) throw new ToolContentReadError("busy");
    const scope = this.#options.scope(request.runtimeId);
    if (!scope || agentKeyId(scope) !== agentKeyId(request.locator.tool.agent)) throw new ToolContentReadError("scope_mismatch");
    for (const [id, lease] of this.#leases) if (lease.expires <= Date.now()) this.#leases.delete(id);
    if (request.read && !this.#leases.has(request.read.readId)) throw new ToolContentReadError("content_expired");
    const requestId = randomUUID(), viewerId = request.read ? this.#leases.get(request.read.readId)?.viewerId : randomUUID();
    if (!viewerId || request.read && this.#leases.get(request.read.readId)?.owner !== owner) throw new ToolContentReadError("scope_mismatch");
    if (this.#leases.size >= 64 && !request.read) throw new ToolContentReadError("busy");
    const forwarded = { ...request, requestId, viewerId };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => { this.#pending.get(requestId)?.reject(new ToolContentReadError("cancelled")); };
    let received = false;
    try {
      const event = await new Promise<RuntimeEvent>((resolve, reject) => {
        this.#pending.set(requestId, { request: forwarded, resolve, reject, owner });
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new ToolContentReadError("content_unavailable")), 30_000); timer.unref();
        if (!this.#options.send(request.runtimeId, requestId, forwarded)) reject(new ToolContentReadError("content_unavailable"));
      });
      if (event.type === "session.tool.read.failed") throw new ToolContentReadError(event.reason === "busy" ? "busy" :
        event.reason === "cancelled" ? "cancelled" : event.reason === "content_version_invalid" ? "content_version_invalid" : "content_unavailable", event.gaps);
      const page = ToolContentPageSchema.parse(event);
      if (!toolContentPageMatchesRequest(forwarded, page)) throw new ToolContentReadError("scope_mismatch");
      this.#leases.set(page.read.readId, { runtimeId: request.runtimeId, viewerId, owner, expires: Date.now() + 30_000 });
      received = true;
      return { ...page, requestId: request.requestId };
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#pending.delete(requestId);
      if (!received) this.#options.send(request.runtimeId, randomUUID(), { type: "session.tool.content.cancel", requestId: randomUUID(),
        runtimeId: request.runtimeId, viewerId, readId: request.read?.readId ?? "cancel-pending" });
    }
  }
  accept(runtimeId: string, event: RuntimeEvent): boolean {
    if (event.type !== "session.tool.content.page" && event.type !== "session.tool.read.failed") return false;
    const pending = this.#pending.get(event.requestId);
    if (pending?.request.runtimeId === runtimeId && event.runtimeId === runtimeId) pending.resolve(event);
    return true; // Unknown and late private responses are never broadcast.
  }
  async cancel(owner: string, readId: string): Promise<void> {
    const lease = this.#leases.get(readId); if (!lease || lease.owner !== owner) return;
    this.#leases.delete(readId);
    this.#options.send(lease.runtimeId, randomUUID(), { type: "session.tool.content.cancel", requestId: randomUUID(),
      runtimeId: lease.runtimeId, viewerId: lease.viewerId, readId });
  }
  releaseRuntime(runtimeId: string): void {
    for (const pending of this.#pending.values()) if (pending.request.runtimeId === runtimeId) pending.reject(new ToolContentReadError("content_unavailable"));
    for (const [id, lease] of this.#leases) if (lease.runtimeId === runtimeId) this.#leases.delete(id);
  }
  close(): void { for (const pending of this.#pending.values()) pending.reject(new ToolContentReadError("cancelled")); this.#leases.clear(); }
}
