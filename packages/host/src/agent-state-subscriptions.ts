import { stateDelta, type AgentStateRequest, type RelayToDeviceMessage } from "@orbis/protocol";
import { AgentStateRegistry, type RegistryChange, type StateScope, type StateDomain } from "./agent-state-registry.js";
import { buildAgentStateSnapshotParts } from "./agent-state-snapshot.js";

type Subscription = { deviceId: string; request: AgentStateRequest; scope: StateScope; changed: Set<string>; baseline: Map<string, ReturnType<AgentStateRegistry["snapshot"]>[number]["state"]> };
const scopeId = (scope: StateScope): string => JSON.stringify(scope);
// Match the conversation model's 256 current sessions; host/device subscriptions use separate scopes.
const MAX_AGENT_SUBSCRIPTIONS_PER_DEVICE = 256;

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
    // A runtime can switch Sessions without changing runtimeId. Replace its old routing subscription.
    const replaced = scope.kind === "agent" && request.runtimeId !== undefined
      ? [...this.#entries].filter(([entryKey, entry]) => entryKey !== key && entry.deviceId === deviceId &&
        entry.scope.kind === "agent" && entry.request.runtimeId === request.runtimeId)
      : [];
    if (scope.kind === "agent" && !this.#entries.has(key) &&
        [...this.#entries.values()].filter(entry => entry.deviceId === deviceId && entry.scope.kind === "agent").length - replaced.length >= MAX_AGENT_SUBSCRIPTIONS_PER_DEVICE) return false;
    for (const [entryKey] of replaced) this.#entries.delete(entryKey);
    this.#entries.set(key, { deviceId, scope: structuredClone(scope), request: structuredClone(request), changed: new Set(), baseline: new Map(request.stateFormat === "compact-v2" ? this.registry.snapshot(scope).filter(({ domain }) => !request.domains || request.domains.includes(domain)).map(({ domain, state }) => [domain, state]) : []) });
    return true;
  }
  clearDevice(deviceId: string): void {
    for (const [key, entry] of this.#entries) if (entry.deviceId === deviceId) this.#entries.delete(key);
  }
  supportsSharedContent(deviceId: string): boolean {
    return [...this.#entries.values()].some(entry => entry.deviceId === deviceId && entry.request.stateFormat === "compact-v2");
  }
  owns(deviceId: string, runtimeId: string, domain: string): boolean {
    return [...this.#entries.values()].some(entry => entry.deviceId === deviceId && entry.scope.kind === "agent" &&
      entry.request.runtimeId === runtimeId && (entry.request.domains === undefined || entry.request.domains.includes(domain)));
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
          requestId: entry.request.requestId, identity: entry.request, domains, update: true, stateFormat: entry.request.stateFormat })) {
          if (entry.request.stateFormat === "compact-v2") for (const current of part.domains) {
            const old = entry.baseline.get(current.domain);
            if (old && old.modelEpoch === current.modelEpoch && old.revision < current.revision &&
              old.availability === "ready" && current.availability === "ready" &&
              old.source.producer === current.source.producer && old.source.sourceEpoch === current.source.sourceEpoch && old.source.sourceId === current.source.sourceId) {
              const operations = stateDelta(old.value, current.value);
              const delta = operations && { baseRevision: old.revision, operations };
              if (delta && Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(current.value)) * 0.8) {
                current.delta = delta; current.value = null;
              }
            }
          }
          this.send(entry.deviceId, part);
        }
        if (entry.request.stateFormat === "compact-v2") for (const domain of domains) {
          const state = this.registry.read(entry.scope, domain as StateDomain);
          if (state) entry.baseline.set(domain, state); else entry.baseline.delete(domain);
        }
      }
    });
  }
  close(): void { this.#closed = true; this.#unsubscribe(); this.#entries.clear(); }
}
