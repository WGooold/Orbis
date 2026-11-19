import { DEVICE_FEATURE_DSH_DESKTOP, DEVICE_FEATURE_KIMI_CODE, DEVICE_FEATURE_OPENCLAW, DEVICE_FEATURE_HERMES, DEVICE_FEATURE_OPENCODE, type AgentKind } from "@orbis/protocol";
import { isKimiId, KIMI_KIND } from "./kimi-sessions.js";
export const DSH_DESKTOP_KIND = "dshDesktop" satisfies AgentKind;
export const OPENCODE_KIND = "opencode" satisfies AgentKind;
export const OPENCODE_RUNTIME_PREFIX = "opencode:";
const isDshDesktopRuntime = (value: unknown): boolean => typeof value === "string" && value.startsWith("dsh-desktop:");

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : undefined;

/** Each distinct hidden-kind set is one directory/cursor projection. */
const negotiatedAgents = [
  [KIMI_KIND, DEVICE_FEATURE_KIMI_CODE], [DSH_DESKTOP_KIND, DEVICE_FEATURE_DSH_DESKTOP], ["openclaw", DEVICE_FEATURE_OPENCLAW], ["hermes", DEVICE_FEATURE_HERMES], [OPENCODE_KIND, DEVICE_FEATURE_OPENCODE],
] as const;
export type AgentView = number;
export const agentViews = Array.from({ length: 1 << negotiatedAgents.length }, (_, view) => view);
export const hiddenKinds = (view: AgentView): readonly AgentKind[] => negotiatedAgents.flatMap(([kind], index) => view & (1 << index) ? [kind] : []);
export function deviceAgentView(features?: ReadonlySet<string>): AgentView {
  return negotiatedAgents.reduce((view, [, feature], index) => view | (features?.has(feature) ? 0 : 1 << index), 0);
}
export const allowsAgent = (view: AgentView, kind: unknown): boolean => !hiddenKinds(view).some(hidden => hidden === kind);
export const allowsRuntime = (view: AgentView, id: unknown): boolean =>
  (!(view & 1) || !isKimiId(id)) && (!(view & 2) || !isDshDesktopRuntime(id)) &&
  (!(view & 4) || typeof id !== "string" || !id.startsWith("openclaw:")) &&
  (!(view & 8) || typeof id !== "string" || !id.startsWith("hermes:")) &&
  (!(view & 16) || typeof id !== "string" || !id.startsWith(OPENCODE_RUNTIME_PREFIX));
export function allowsAgentIdentity(view: AgentView, value: object): boolean {
  const row = value as Obj;
  return allowsAgent(view, row.agentKind) && allowsAgent(view, row.kind) && allowsRuntime(view, row.sessionId) && allowsRuntime(view, row.runtimeId);
}

const safeIdentity = (view: AgentView, value: unknown): boolean => {
  const row = object(value); return row === undefined || allowsAgentIdentity(view, row);
};
const filter = (view: AgentView, value: unknown): unknown => Array.isArray(value) ? value.filter(row => safeIdentity(view, row)) : value;

/** Inspect named protocol envelopes only; user input, messages and tool results are opaque. */
export function allowsAgentRequest(view: AgentView, message: object): boolean {
  const row = message as Obj;
  if (!allowsAgentIdentity(view, row)) return false;
  if (row.type === "transport.fields.read") return allowsAgent(view, row.backend);
  switch (row.type) {
    case "session.activate": return safeIdentity(view, row.target);
    case "session.catalog.query": return safeIdentity(view, row.query);
    case "runtime.command": return safeIdentity(view, row.command) && safeIdentity(view, object(row.command)?.agent);
    default: return true;
  }
}

export function projectAgentMessage(view: AgentView, message: object): object | undefined {
  const value = message as Obj;
  if (!allowsAgentIdentity(view, value)) return undefined;
  switch (value.type) {
    case "runtime.online": return safeIdentity(view, value.runtime) ? message : undefined;
    case "device.ready": {
      const next: Obj = { ...value, runtimes: filter(view, value.runtimes) };
      for (const key of ["agents", "launchableAgents"]) if (Array.isArray(value[key])) next[key] = value[key].filter(kind => allowsAgent(view, kind));
      if (!allowsAgent(view, DSH_DESKTOP_KIND)) delete next.dshDesktop;
      if (!allowsAgent(view, "openclaw")) delete next.deviceFeatures;
      return next;
    }
    case "session.list.result": return { ...value, sessions: filter(view, value.sessions), currentProviders: filter(view, value.currentProviders) };
    case "diagnostics.page": {
      const page = object(value.page);
      return page ? { ...value, page: { ...page, records: filter(view, page.records) } } : message;
    }
    default: return message;
  }
}

export function projectBackendDomain(view: AgentView, domain: string, value: unknown): unknown {
  const row = object(value);
  if (!row || !view) return value;
  if (domain === "backends" || domain === "management") {
    const next: Obj = { ...row, backends: filter(view, row.backends) };
    for (const key of ["agents", "launchableAgents"]) if (Array.isArray(row[key])) next[key] = row[key].filter(kind => allowsAgent(view, kind));
    if (!allowsAgent(view, DSH_DESKTOP_KIND)) delete next.dshDesktop;
    return next;
  }
  if (domain === "providers") return { ...row, providers: filter(view, row.providers) };
  if (domain === "operations") return { ...row, items: filter(view, row.items) };
  return value;
}

/** Wire epoch is session/view-local, but the committed model still has one owner/revision. */
export function applyDeviceViewEpoch(message: object, epoch: string | undefined): object {
  if (!epoch) return message;
  const value = message as Obj;
  const assign = (row: Obj) => row.modelEpoch === null ? row : { ...row, modelEpoch: epoch };
  switch (value.type) {
    case "device.ready": return assign(value);
    case "session.catalog.page":
    case "agent.state.range.page": {
      const page = object(value.page); return page ? { ...value, page: assign(page) } : message;
    }
    case "agent.state.snapshot": return { ...assign(value), ...(Array.isArray(value.domains) ? { domains: value.domains.map((entry: Obj) => {
      const ref = entry.domain === "records" ? object(entry.value) : undefined;
      return { ...assign(entry), ...(ref && "modelEpoch" in ref ? { value: assign(ref) } : {}) };
    }) } : {}) };
    default: return message;
  }
}
