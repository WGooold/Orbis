/** Extend the released Desktop capability filter without assuming that support for one kind implies another. */
import type { AgentKind } from "@orbis/protocol";
import { OPENCLAW_PREFIX } from "./openclaw-history.js";

export const DSH_DESKTOP_KIND = "dshDesktop" satisfies AgentKind;
export const DSH_DESKTOP_RUNTIME_PREFIX = "dsh-desktop:";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
export const isDshDesktopRuntime = (value: unknown): boolean => typeof value === "string" && value.startsWith(DSH_DESKTOP_RUNTIME_PREFIX);
type HiddenKind = "dshDesktop" | "openclaw";
const legacyKinds = [DSH_DESKTOP_KIND] as const;
const gatedKind = (value: unknown): HiddenKind | undefined => value === "openclaw" || value === DSH_DESKTOP_KIND ? value : undefined;
export function kindForRuntime(value: unknown): HiddenKind | undefined {
  if (isDshDesktopRuntime(value)) return DSH_DESKTOP_KIND;
  if (typeof value === "string" && value.startsWith(OPENCLAW_PREFIX)) return "openclaw";
  return undefined;
}
const hiddenKind = (value: unknown, hidden: readonly HiddenKind[]): boolean => hidden.some(kind => kind === gatedKind(value));
const hiddenId = (value: unknown, hidden: readonly HiddenKind[]): boolean => hidden.some(kind => kind === kindForRuntime(value));
const withoutKinds = (value: unknown, hidden: readonly HiddenKind[]): unknown => Array.isArray(value) ? value.filter(kind => !hiddenKind(kind, hidden)) : value;
const hiddenRuntime = (value: unknown, hidden: readonly HiddenKind[]): boolean => isObject(value) &&
  (hiddenId(value.runtimeId, hidden) || hiddenId(value.sessionId, hidden) || hiddenKind(value.agentKind, hidden));

/** Catalog values need the Host inventory to keep totals and cursors consistent (see HostStateFacts.hiddenCatalog). */
export type CatalogProjection = (value: Obj) => Obj;

/** Project one host-scope domain value for a device without the feature. Pure apart from `catalog`. */
export function legacyHostDomain(domain: string, value: unknown, catalog: CatalogProjection, hidden: readonly HiddenKind[] = legacyKinds): unknown {
  if (!isObject(value)) return value;
  if (domain === "catalog") return catalog(value);
  if (domain === "backends" || domain === "management") {
    const next: Obj = { ...value };
    if (Array.isArray(value.backends)) next.backends = value.backends.filter(row => !(isObject(row) && hiddenKind(row.kind, hidden)));
    if ("agents" in value) next.agents = withoutKinds(value.agents, hidden);
    if ("launchableAgents" in value) next.launchableAgents = withoutKinds(value.launchableAgents, hidden);
    if (hidden.includes(DSH_DESKTOP_KIND)) delete next.dshDesktop;
    return next;
  }
  if (domain === "providers" && Array.isArray(value.providers)) return { ...value, providers: value.providers.filter(row => !(isObject(row) && hiddenKind(row.agentKind, hidden))) };
  if (domain === "operations" && Array.isArray(value.items)) return { ...value, items: value.items.filter(row => !hiddenRuntime(row, hidden)) };
  return value;
}

export function projectDeviceDomain(domain: string, value: unknown, hidden: readonly HiddenKind[]): unknown {
  if (domain !== "operations" || !isObject(value) || !hidden.length) return value;
  // The same pairing can re-handshake from a rolled-back App; old command
  // receipts still in this device's own ledger must not disclose gated IDs.
  return Object.fromEntries(Object.entries(value).filter(([, item]) => !hiddenRuntime(item, hidden)));
}

/**
 * Whether a message must not reach a device without the feature at all. Covers
 * broadcasts that are encoded once for every device.
 */
export function hiddenFromLegacy(message: object, hidden: readonly HiddenKind[] = legacyKinds): boolean {
  const value = message as Obj;
  if (hiddenRuntime(value, hidden)) return true;
  if (value.type === "runtime.online" && hiddenRuntime(value.runtime, hidden)) return true;
  const target = value.type === "session.activate" ? value.target : undefined;
  if (hiddenRuntime(target, hidden)) return true;
  if (value.type === "session.catalog.query" && isObject(value.query) && hiddenKind(value.query.agentKind, hidden)) return true;
  return false;
}

/** Full per-message projection for a device without the feature; `undefined` means do not send. */
export function legacyDeviceMessage(message: object, hidden: readonly HiddenKind[] = legacyKinds): object | undefined {
  if (hiddenFromLegacy(message, hidden)) return undefined;
  const value = message as Obj;
  switch (value.type) {
    case "device.ready": {
      const next: Obj = { ...value };
      if (Array.isArray(value.runtimes)) next.runtimes = value.runtimes.filter(runtime => !hiddenRuntime(runtime, hidden));
      if (Array.isArray(value.agents)) next.agents = withoutKinds(value.agents, hidden);
      if (Array.isArray(value.launchableAgents)) next.launchableAgents = withoutKinds(value.launchableAgents, hidden);
      if (hidden.includes(DSH_DESKTOP_KIND)) delete next.dshDesktop;
      if (hidden.includes("openclaw")) delete next.deviceFeatures;
      return next;
    }
    case "session.list.result": {
      const next: Obj = { ...value };
      if (Array.isArray(value.sessions)) next.sessions = value.sessions.filter(session => !hiddenRuntime(session, hidden));
      if (Array.isArray(value.currentProviders)) next.currentProviders = value.currentProviders.filter(row => !(isObject(row) && hiddenKind(row.agentKind, hidden)));
      return next;
    }
    case "diagnostics.page": {
      const page = value.page;
      return isObject(page) && Array.isArray(page.records)
        ? { ...value, page: { ...page, records: page.records.filter(record => !(isObject(record) && hiddenKind(record.agentKind, hidden))) } } : message;
    }
    default:
      return message;
  }
}
