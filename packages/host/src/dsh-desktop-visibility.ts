/** Feature-gated agent projections, before per-device encoding or compact deltas. */
import type { AgentKind } from "@orbis/protocol";

export const DSH_DESKTOP_KIND = "dshDesktop" satisfies AgentKind;
export const DSH_DESKTOP_RUNTIME_PREFIX = "dsh-desktop:";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
export const isDshDesktopRuntime = (value: unknown): boolean => typeof value === "string" && value.startsWith(DSH_DESKTOP_RUNTIME_PREFIX);
export const isHermesRuntime = (value: unknown): boolean => typeof value === "string" && value.startsWith("hermes:");
export type GatedKind = "dshDesktop" | "hermes";
const legacy: readonly GatedKind[] = ["dshDesktop"];
const hiddenKind = (value: unknown, hide: readonly GatedKind[]): boolean => hide.some(kind => value === kind);
const hiddenRuntimeId = (value: unknown, hide: readonly GatedKind[]): boolean =>
  hide.some(kind => kind === "dshDesktop" ? isDshDesktopRuntime(value) : isHermesRuntime(value));
const withoutKinds = (value: unknown, hide: readonly GatedKind[]): unknown => Array.isArray(value) ? value.filter(kind => !hiddenKind(kind, hide)) : value;
const hiddenRuntime = (value: unknown, hide: readonly GatedKind[]): boolean => isObject(value) && (hiddenRuntimeId(value.runtimeId, hide) || hiddenRuntimeId(value.sessionId, hide) || hiddenKind(value.agentKind, hide));

/** Catalog values need the Host inventory to keep totals and cursors consistent (see HostStateFacts.hiddenCatalog). */
export type CatalogProjection = (value: Obj) => Obj;

/** Project one host-scope domain value for a device without the feature. Pure apart from `catalog`. */
export function legacyHostDomain(domain: string, value: unknown, catalog: CatalogProjection, hide: readonly GatedKind[] = legacy): unknown {
  if (!isObject(value)) return value;
  if (domain === "catalog") return catalog(value);
  if (domain === "backends") {
    const next: Obj = { ...value };
    if (Array.isArray(value.backends)) next.backends = value.backends.filter(row => !(isObject(row) && hiddenKind(row.kind, hide)));
    if ("agents" in value) next.agents = withoutKinds(value.agents, hide);
    if ("launchableAgents" in value) next.launchableAgents = withoutKinds(value.launchableAgents, hide);
    if (hide.includes("dshDesktop")) delete next.dshDesktop;
    return next;
  }
  if (domain === "providers" && Array.isArray(value.providers)) return { ...value, providers: value.providers.filter(row => !(isObject(row) && hiddenKind(row.agentKind, hide))) };
  if (domain === "management" && Array.isArray(value.backends)) return { ...value, backends: value.backends.filter(row => !(isObject(row) && hiddenKind(row.kind, hide))) };
  if (domain === "operations" && Array.isArray(value.items)) return { ...value, items: value.items.filter(row => !(isObject(row) && hiddenKind(row.agentKind, hide))) };
  return value;
}

/**
 * Whether a message must not reach a device without the feature at all. Covers
 * broadcasts that are encoded once for every device.
 */
export function hiddenFromLegacy(message: object, hide: readonly GatedKind[] = legacy): boolean {
  const value = message as Obj;
  if (hiddenRuntimeId(value.runtimeId, hide) || hiddenKind(value.agentKind, hide)) return true;
  if (isObject(value.target) && (hiddenKind(value.target.agentKind, hide) || hiddenRuntimeId(value.target.sessionId, hide))) return true;
  if (isObject(value.query) && hiddenKind(value.query.agentKind, hide)) return true;
  if (value.type === "runtime.online" && hiddenRuntime(value.runtime, hide)) return true;
  if (value.type === "agent.state.snapshot" && value.scope === "agent" && hiddenRuntimeId(value.sessionId, hide)) return true;
  return false;
}

/** Full per-message projection for a device without the feature; `undefined` means do not send. */
export function legacyDeviceMessage(message: object, hide: readonly GatedKind[] = legacy): object | undefined {
  if (hiddenFromLegacy(message, hide)) return undefined;
  const value = message as Obj;
  switch (value.type) {
    case "device.ready": {
      const next: Obj = { ...value };
      if (Array.isArray(value.runtimes)) next.runtimes = value.runtimes.filter(runtime => !hiddenRuntime(runtime, hide));
      if (Array.isArray(value.agents)) next.agents = withoutKinds(value.agents, hide);
      if (Array.isArray(value.launchableAgents)) next.launchableAgents = withoutKinds(value.launchableAgents, hide);
      if (hide.includes("dshDesktop")) delete next.dshDesktop;
      return next;
    }
    case "session.list.result": {
      const next: Obj = { ...value };
      if (Array.isArray(value.sessions)) next.sessions = value.sessions.filter(session => !hiddenRuntime(session, hide));
      if (Array.isArray(value.currentProviders)) next.currentProviders = value.currentProviders.filter(row => !(isObject(row) && hiddenKind(row.agentKind, hide)));
      return next;
    }
    case "diagnostics.page": {
      const page = value.page;
      return isObject(page) && Array.isArray(page.records)
        ? { ...value, page: { ...page, records: page.records.filter(record => !(isObject(record) && hiddenKind(record.agentKind, hide))) } } : message;
    }
    default:
      return message;
  }
}
