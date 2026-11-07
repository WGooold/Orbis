import { createHash } from "node:crypto";
import type { DomainState } from "@orbis/protocol";
import { AgentStateRegistry, type StateScope, type StateDomain } from "./agent-state-registry.js";
import { projectDeviceMessage } from "./device-message-projection.js";
import { MenuOptionCatalogs } from "./menu-option-catalogs.js";

/** FT-G04: independently version the explicitly requested compact representation.
 * Canonical/native facts retain the released shape. A dynamic metadata change can
 * therefore change the legacy identity revision without changing compact identity.
 * Source/Host generations and quality remain part of the represented facts.
 */
export class CompactStateModel {
  readonly registry: AgentStateRegistry;
  readonly menuOptions = new MenuOptionCatalogs();
  readonly #scopes = new Map<string, StateScope>();
  readonly #unsubscribe: () => void;
  constructor(readonly source: AgentStateRegistry) {
    this.registry = new AgentStateRegistry({ modelEpoch: source.currentModelEpoch(), maxValueBytes: 4 * 1024 * 1024 });
    this.#unsubscribe = source.subscribe(change => {
      if (change.kind === "reset") { this.registry.beginModelEpoch(change.modelEpoch); this.#scopes.clear(); this.menuOptions.clear(); return; }
      if (!this.#scopes.has(JSON.stringify(change.scope))) return;
      if (change.kind === "closed") { this.registry.endScope(change.scope); this.#scopes.delete(JSON.stringify(change.scope)); this.menuOptions.release(JSON.stringify(change.scope)); return; }
      this.#commit(change.scope, change.domain, change.state);
    });
  }

  ensure(scope: StateScope): AgentStateRegistry {
    const key = JSON.stringify(scope);
    if (!this.#scopes.has(key)) {
      this.#scopes.set(key, structuredClone(scope));
      for (const { domain, state } of this.source.snapshot(scope)) this.#commit(scope, domain, state);
    }
    return this.registry;
  }

  #commit(scope: StateScope, domain: StateDomain, state: DomainState<unknown>): void {
    let value = state.value;
    if (scope.kind === "agent" && domain === "identity" && value && typeof value === "object") {
      const identity = value as Record<string, unknown>;
      value = Object.fromEntries(["runtimeId", "name", "cwd", "sessionId", "sessionGraphSync", "hostname", "sessionName", "hostId", "agentKind"]
        .filter(key => Object.hasOwn(identity, key)).map(key => [key, identity[key]]));
    } else if (scope.kind === "agent") {
      const projected = projectDeviceMessage({ type: "agent.state.snapshot", scope: "agent", domains: [{ domain, value }] }) as { domains: Array<{ value: unknown }> };
      value = projected.domains[0]!.value;
      if (domain === "capabilities") value = this.menuOptions.project(JSON.stringify(scope), this.registry.currentModelEpoch() + ":" + state.source.sourceEpoch, value);
      // Resource consumers refer to the same catalog; they never carry a second
      // inline tree. A nonbuiltin command remains scoped by its exact name.
      if (domain === "resources" && value && typeof value === "object") value = Object.fromEntries(Object.entries(value).map(([key, command]) => {
        const item = command as Record<string, unknown>;
        return [key, { name: item.name, source: item.source, capabilityRef: key }];
      }));
    }
    const result = this.registry.commitValue(scope, domain, { ...state, value,
      source: { ...state.source, sourceEpoch: createHash("sha256").update("compact-v1:" + state.source.sourceEpoch).digest("base64url") } });
    if (!result.ok) throw new Error(`Compact state rejected: ${result.code}`);
  }

  close(): void { this.#unsubscribe(); this.#scopes.clear(); this.menuOptions.clear(); }
}
