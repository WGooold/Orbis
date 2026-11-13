/**
 * Device-side visibility of the `dshDesktop` entry (ADR-0076 DSH-DESKTOP-06, ADR-0064).
 *
 * Released Apps validate agent kinds strictly in places (iOS rejects a whole Host
 * catalog page with an unknown `agentKind`). A device that has not declared
 * `agent.dshDesktop` therefore receives the Host exactly as before this entry
 * existed: no `dshDesktop` kind, session, runtime, backend row or status. Old
 * Apps keep using the Web entry.
 *
 * Host-scope domain values are projected where snapshots are produced, before
 * compact deltas are computed; everything else is filtered per message here.
 */
import type { AgentKind } from "@orbis/protocol";

export const DSH_DESKTOP_KIND = "dshDesktop" satisfies AgentKind;
export const DSH_DESKTOP_RUNTIME_PREFIX = "dsh-desktop:";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
export const isDshDesktopRuntime = (value: unknown): boolean => typeof value === "string" && value.startsWith(DSH_DESKTOP_RUNTIME_PREFIX);
const hiddenKind = (value: unknown): boolean => value === DSH_DESKTOP_KIND;
const withoutKinds = (value: unknown): unknown => Array.isArray(value) ? value.filter(kind => !hiddenKind(kind)) : value;
const hiddenRuntime = (value: unknown): boolean => isObject(value) && (isDshDesktopRuntime(value.runtimeId) || isDshDesktopRuntime(value.sessionId) || hiddenKind(value.agentKind));

/** Catalog values need the Host inventory to keep totals and cursors consistent (see HostStateFacts.legacyCatalog). */
export type CatalogProjection = (value: Obj) => Obj;

/** Project one host-scope domain value for a device without the feature. Pure apart from `catalog`. */
export function legacyHostDomain(domain: string, value: unknown, catalog: CatalogProjection): unknown {
  if (!isObject(value)) return value;
  if (domain === "catalog") return catalog(value);
  if (domain === "backends") {
    const next: Obj = { ...value };
    if (Array.isArray(value.backends)) next.backends = value.backends.filter(row => !(isObject(row) && hiddenKind(row.kind)));
    if ("agents" in value) next.agents = withoutKinds(value.agents);
    if ("launchableAgents" in value) next.launchableAgents = withoutKinds(value.launchableAgents);
    delete next.dshDesktop;
    return next;
  }
  if (domain === "providers" && Array.isArray(value.providers)) return { ...value, providers: value.providers.filter(row => !(isObject(row) && hiddenKind(row.agentKind))) };
  if (domain === "operations" && Array.isArray(value.items)) return { ...value, items: value.items.filter(row => !(isObject(row) && hiddenKind(row.agentKind))) };
  return value;
}

/**
 * Whether a message must not reach a device without the feature at all. Covers
 * broadcasts that are encoded once for every device.
 */
export function hiddenFromLegacy(message: object): boolean {
  const value = message as Obj;
  if (isDshDesktopRuntime(value.runtimeId) || hiddenKind(value.agentKind)) return true;
  if (value.type === "runtime.online" && hiddenRuntime(value.runtime)) return true;
  if (value.type === "agent.state.snapshot" && value.scope === "agent" && isDshDesktopRuntime(value.sessionId)) return true;
  return false;
}

/** Full per-message projection for a device without the feature; `undefined` means do not send. */
export function legacyDeviceMessage(message: object): object | undefined {
  if (hiddenFromLegacy(message)) return undefined;
  const value = message as Obj;
  switch (value.type) {
    case "device.ready": {
      const next: Obj = { ...value };
      if (Array.isArray(value.runtimes)) next.runtimes = value.runtimes.filter(runtime => !hiddenRuntime(runtime));
      if (Array.isArray(value.agents)) next.agents = withoutKinds(value.agents);
      if (Array.isArray(value.launchableAgents)) next.launchableAgents = withoutKinds(value.launchableAgents);
      delete next.dshDesktop;
      return next;
    }
    case "session.list.result": {
      const next: Obj = { ...value };
      if (Array.isArray(value.sessions)) next.sessions = value.sessions.filter(session => !hiddenRuntime(session));
      if (Array.isArray(value.currentProviders)) next.currentProviders = value.currentProviders.filter(row => !(isObject(row) && hiddenKind(row.agentKind)));
      return next;
    }
    case "diagnostics.page": {
      const page = value.page;
      return isObject(page) && Array.isArray(page.records)
        ? { ...value, page: { ...page, records: page.records.filter(record => !(isObject(record) && hiddenKind(record.agentKind))) } } : message;
    }
    default:
      return message;
  }
}
