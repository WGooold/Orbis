/**
 * Device-side visibility for Agent kinds introduced behind `device.features` (ADR-0076, ADR-0084, ADR-0085).
 * Released Apps validate Agent kinds strictly. A device that has not declared a kind's feature receives no
 * catalog, runtime, Agent state, backend row, provider, operation, or status that names that kind.
 *
 * Host-scope domain values are projected where snapshots are produced, before compact deltas are computed;
 * everything else is filtered per message here.
 */
import { DEVICE_FEATURE_DSH_DESKTOP, DEVICE_FEATURE_OPENCODE, type AgentKind } from "@orbis/protocol";

export const DSH_DESKTOP_KIND = "dshDesktop" satisfies AgentKind;
export const DSH_DESKTOP_RUNTIME_PREFIX = "dsh-desktop:";
export const OPENCODE_KIND = "opencode" satisfies AgentKind;
export const OPENCODE_RUNTIME_PREFIX = "opencode:";
const HIDDEN_KIND_FEATURES: ReadonlyArray<readonly [AgentKind, string]> = [
  [DSH_DESKTOP_KIND, DEVICE_FEATURE_DSH_DESKTOP],
  [OPENCODE_KIND, DEVICE_FEATURE_OPENCODE],
];
const RUNTIME_PREFIXES: Partial<Record<AgentKind, readonly string[]>> = {
  [DSH_DESKTOP_KIND]: [DSH_DESKTOP_RUNTIME_PREFIX],
  [OPENCODE_KIND]: [OPENCODE_RUNTIME_PREFIX],
};

export function hiddenAgentKinds(features: ReadonlySet<string> | undefined): AgentKind[] {
  return HIDDEN_KIND_FEATURES.filter(([, feature]) => !features?.has(feature)).map(([kind]) => kind);
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const asSet = (kinds: readonly AgentKind[] = [DSH_DESKTOP_KIND]): ReadonlySet<AgentKind> => new Set(kinds);
const isHiddenRuntimeId = (value: unknown, kinds: ReadonlySet<AgentKind>): boolean => typeof value === "string"
  && [...kinds].some(kind => RUNTIME_PREFIXES[kind]?.some(prefix => value.startsWith(prefix)) === true);
const withoutKinds = (value: unknown, kinds: ReadonlySet<AgentKind>): unknown => Array.isArray(value)
  ? value.filter(kind => typeof kind !== "string" || !kinds.has(kind as AgentKind)) : value;
const hiddenRuntime = (value: unknown, kinds: ReadonlySet<AgentKind>): boolean => isObject(value)
  && (isHiddenRuntimeId(value.runtimeId, kinds) || isHiddenRuntimeId(value.sessionId, kinds)
    || typeof value.agentKind === "string" && kinds.has(value.agentKind as AgentKind));

/** Catalog values need the Host inventory to keep totals and cursors consistent (see HostStateFacts.legacyCatalog). */
export type CatalogProjection = (value: Obj) => Obj;

/** Project one host-scope domain value for a device without the feature. Pure apart from `catalog`. */
export function legacyHostDomain(domain: string, value: unknown, catalog: CatalogProjection,
  hiddenKinds: readonly AgentKind[] = [DSH_DESKTOP_KIND]): unknown {
  if (!isObject(value) || hiddenKinds.length === 0) return value;
  const hidden = asSet(hiddenKinds);
  if (domain === "catalog") return catalog(value);
  if (domain === "backends") {
    const next: Obj = { ...value };
    if (Array.isArray(value.backends)) next.backends = value.backends.filter(row => !(isObject(row) && hidden.has(row.kind as AgentKind)));
    if ("agents" in value) next.agents = withoutKinds(value.agents, hidden);
    if ("launchableAgents" in value) next.launchableAgents = withoutKinds(value.launchableAgents, hidden);
    if (hidden.has(DSH_DESKTOP_KIND)) delete next.dshDesktop;
    return next;
  }
  if (domain === "providers" && Array.isArray(value.providers)) return {
    ...value, providers: value.providers.filter(row => !(isObject(row) && hidden.has(row.agentKind as AgentKind))),
  };
  if (domain === "operations" && Array.isArray(value.items)) return {
    ...value, items: value.items.filter(row => !(isObject(row) && hidden.has(row.agentKind as AgentKind))),
  };
  return value;
}

/** Whether a message must not reach a device without the corresponding feature. */
export function hiddenFromLegacy(message: object, hiddenKinds: readonly AgentKind[] = [DSH_DESKTOP_KIND]): boolean {
  if (hiddenKinds.length === 0) return false;
  const value = message as Obj;
  const hidden = asSet(hiddenKinds);
  if (isHiddenRuntimeId(value.runtimeId, hidden) || hiddenRuntime(value.runtime, hidden)
    || typeof value.agentKind === "string" && hidden.has(value.agentKind as AgentKind)) return true;
  return value.type === "agent.state.snapshot" && value.scope === "agent"
    && (isHiddenRuntimeId(value.sessionId, hidden) || isHiddenRuntimeId(value.runtimeId, hidden)
      || typeof value.agentKind === "string" && hidden.has(value.agentKind as AgentKind));
}

/** Full per-message projection; `undefined` means do not send. */
export function legacyDeviceMessage(message: object, hiddenKinds: readonly AgentKind[] = [DSH_DESKTOP_KIND]): object | undefined {
  if (hiddenFromLegacy(message, hiddenKinds)) return undefined;
  const value = message as Obj;
  const hidden = asSet(hiddenKinds);
  switch (value.type) {
    case "device.ready": {
      const next: Obj = { ...value };
      if (Array.isArray(value.runtimes)) next.runtimes = value.runtimes.filter(runtime => !hiddenRuntime(runtime, hidden));
      if (Array.isArray(value.agents)) next.agents = withoutKinds(value.agents, hidden);
      if (Array.isArray(value.launchableAgents)) next.launchableAgents = withoutKinds(value.launchableAgents, hidden);
      if (hidden.has(DSH_DESKTOP_KIND)) delete next.dshDesktop;
      return next;
    }
    case "session.list.result": {
      const next: Obj = { ...value };
      if (Array.isArray(value.sessions)) next.sessions = value.sessions.filter(session => !hiddenRuntime(session, hidden));
      if (Array.isArray(value.currentProviders)) next.currentProviders = value.currentProviders.filter(row => !(isObject(row) && hidden.has(row.agentKind as AgentKind)));
      return next;
    }
    case "diagnostics.page": {
      const page = value.page;
      return isObject(page) && Array.isArray(page.records)
        ? { ...value, page: { ...page, records: page.records.filter(record => !(isObject(record) && hidden.has(record.agentKind as AgentKind))) } } : message;
    }
    default:
      return message;
  }
}
