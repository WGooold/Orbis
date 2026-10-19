import type { AgentStateRequest, RelayToDeviceMessage } from "@pi-remote/protocol";
import { AgentStateRegistry, type RegistryChange, type StateScope } from "./agent-state-registry.js";
import { buildAgentStateSnapshotParts } from "./agent-state-snapshot.js";

type Subscription = { deviceId: string; request: AgentStateRequest; scope: StateScope; changed: Set<string> };
const scopeId = (scope: StateScope): string => JSON.stringify(scope);

/** Coalesced complete-domain publications. No I/O or source RPC occurs inside Registry commits. */
export class AgentStateSubscriptions {
  readonly #entries = new Map<string, Subscription>();
  readonly #unsubscribe: () => void;
  #scheduled = false;
  #closed = false;
  constructor(readonly registry: AgentStateRegistry, readonly send: (deviceId: string, message: RelayToDeviceMessage) => void) {
    this.#unsubscribe = registry.subscribe(change => this.#changed(change));
  }
  register(deviceId: string, scope: StateScope, request: AgentStateRequest): boolean {
    const key = JSON.stringify([deviceId, scopeId(scope)]);
    if (request.subscribe === false) { this.#entries.delete(key); return true; }
    if (request.subscribe !== true) return true;
    if (!this.#entries.has(key) && [...this.#entries.values()].filter(entry => entry.deviceId === deviceId).length >= 8) return false;
    this.#entries.set(key, { deviceId, scope: structuredClone(scope), request: structuredClone(request), changed: new Set() });
    return true;
  }
  clearDevice(deviceId: string): void {
    for (const [key, entry] of this.#entries) if (entry.deviceId === deviceId) this.#entries.delete(key);
  }
  #changed(change: RegistryChange): void {
    if (this.#closed || change.kind === "reset") return;
    for (const entry of this.#entries.values()) {
      if (scopeId(entry.scope) !== scopeId(change.scope)) continue;
      if (entry.request.domains && !entry.request.domains.includes(change.domain)) continue;
      entry.changed.add(change.domain);
    }
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      for (const entry of this.#entries.values()) {
        if (entry.changed.size === 0) continue;
        const domains = [...entry.changed]; entry.changed.clear();
        for (const part of buildAgentStateSnapshotParts({ registry: this.registry, scope: entry.scope,
          requestId: entry.request.requestId, identity: entry.request, domains, update: true })) this.send(entry.deviceId, part);
      }
    });
  }
  close(): void { this.#closed = true; this.#unsubscribe(); this.#entries.clear(); }
}
