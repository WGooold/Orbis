import { PROTOCOL_VERSION, type AgentKind } from "@pi-remote/protocol";
import type { ProviderSummary } from "./provider-manager.js";

export type ProviderRequest = {
  type: "provider.list" | "provider.switch"; protocolVersion: number;
  requestId: string; kind: AgentKind; id?: string; enabled?: boolean;
};
/** Only local saved identities cross the encrypted boundary; never config, paths or npm arguments. */
export function parseProviderRequest(value: unknown): ProviderRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.type !== "provider.list" && data.type !== "provider.switch") return undefined;
  if (data.protocolVersion !== PROTOCOL_VERSION || !["pi", "codex", "dsh"].includes(String(data.kind))) return undefined;
  const valid = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 128;
  if (!valid(data.requestId)) return undefined;
  const keys = data.type === "provider.list" ? ["type", "protocolVersion", "requestId", "kind"] : ["type", "protocolVersion", "requestId", "kind", "id", "enabled"];
  if (Object.keys(data).some(key => !keys.includes(key))) return undefined;
  if (data.type === "provider.switch" && (!valid(data.id) || typeof data.enabled !== "boolean" || (data.kind !== "pi" && !data.enabled))) return undefined;
  return data as ProviderRequest;
}
export function providerResult(request: ProviderRequest, providers: ProviderSummary[]): object {
  return { type: "provider.result", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, kind: request.kind, providers,
    notice: request.type === "provider.switch" ? (request.kind === "pi" ? "显式供应商已更新；已有 Pi 请重新打开，再用 /model 选择模型。" : "供应商已切换；请重新打开会话。独立终端也需重启。") : "" };
}
