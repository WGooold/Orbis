import {
  AgentStateDomainSchema, DeviceStateDomainSchema, HostStateDomainSchema, PROTOCOL_VERSION,
  type AgentStateDomainSnapshot, type AgentStateSnapshot, type RelayToDeviceMessage,
} from "@pi-remote/protocol";

import type { AgentStateRegistry, StateScope } from "./agent-state-registry.js";

/**
 * 把已提交的模型投影整理成线上快照（ADR-0032，issue #10 的服务端一半）。
 *
 * 纯函数：只读 Registry，不发消息、不写状态，因此预算、缺失语义与排序都能单独验证。
 * 三条硬要求：
 * - 点名要但确实没有状态的领域必须出现在 `missing` 里（`no_state`），不能悄悄缺席；
 * - 领域名不在该作用域的枚举里是 `unknown_domain`，不是「没有状态」；
 * - 超出字节预算时按序截断并置 `truncated`，而不是发一个半截却不自知的快照。
 */

/** 快照的字节预算：一次应答不能把整份模型塞进控制帧。 */
const DEFAULT_MAX_BYTES = 256 * 1024;

export type AgentStateSnapshotIdentity = {
  readonly runtimeId?: string | undefined;
  readonly agentKind?: string | undefined;
  readonly sessionId?: string | undefined;
};

export type AgentStateSnapshotInput = {
  readonly registry: AgentStateRegistry;
  readonly requestId: string;
  readonly scope: StateScope;
  /** 客户端点名的领域；缺省表示该作用域里当前存在的全部。 */
  readonly domains?: readonly string[];
  readonly identity?: AgentStateSnapshotIdentity;
  readonly maxBytes?: number;
  readonly known?: readonly { domain: string; modelEpoch: string; revision: number }[];
  readonly update?: boolean;
};

export type AgentStateSnapshotMessage = Extract<RelayToDeviceMessage, { type: "agent.state.snapshot" }>;

/** Domain publications are independently versioned. Split a large response only at domain boundaries;
 * no supported domain can be permanently starved behind a large alphabetically earlier domain. */
export function buildAgentStateSnapshotParts(input: AgentStateSnapshotInput): AgentStateSnapshotMessage[] {
  const domains = input.domains ?? input.registry.snapshot(input.scope).map(entry => entry.domain);
  // Initial reads and updates use the same split, including missing/unchanged execution responses.
  // Only the small execution frame is eligible for ctl; history/live keep their msg budget.
  if (input.scope.kind === "agent" && domains.includes("execution") && domains.some(domain => domain !== "execution")) {
    return [
      ...buildAgentStateSnapshotParts({ ...input, domains: ["execution"] }),
      ...buildAgentStateSnapshotParts({ ...input, domains: domains.filter(domain => domain !== "execution") }),
    ];
  }
  const first = buildAgentStateSnapshot(input);
  if (!first.truncated) return [first];
  return domains.map(domain => buildAgentStateSnapshot({ ...input, domains: [domain], maxBytes: 4 * 1024 * 1024 + 64 * 1024 }));
}

export function buildAgentStateSnapshot(input: AgentStateSnapshotInput): AgentStateSnapshotMessage {
  const budget = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowed = allowedDomains(input.scope);
  const wanted = input.domains;
  const present = input.registry.snapshot(input.scope)
    .filter(entry => wanted === undefined || wanted.includes(entry.domain))
    .filter(entry => wanted === undefined || allowed.has(entry.domain))
    .sort((left, right) => left.domain.localeCompare(right.domain));

  // 按客户端点名的顺序逐条回答：名字不属于这个作用域是名字错，缺状态是「确实还没有」。
  const missing: AgentStateSnapshotMessage["missing"] = [];
  for (const domain of wanted ?? []) {
    if (!allowed.has(domain)) missing.push({ domain, reason: "unknown_domain" });
    else if (!present.some(entry => entry.domain === domain)) missing.push({ domain, reason: "no_state" });
  }

  const domains: AgentStateDomainSnapshot[] = [];
  const unchanged: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of present) {
    if (input.known?.some(known => known.domain === entry.domain && known.modelEpoch === entry.state.modelEpoch && known.revision === entry.state.revision)) {
      unchanged.push(entry.domain);
      continue;
    }
    const snapshot: AgentStateDomainSnapshot = {
      domain: entry.domain,
      modelEpoch: entry.state.modelEpoch,
      revision: entry.state.revision,
      availability: entry.state.availability,
      completeness: entry.state.completeness,
      source: entry.state.source,
      checkedAt: entry.state.checkedAt,
      value: entry.state.value,
      projectionComplete: true,
    };
    const size = byteLength(snapshot);
    if (bytes + size > budget) { truncated = true; break; }
    bytes += size;
    domains.push(snapshot);
  }

  return {
    type: "agent.state.snapshot",
    protocolVersion: PROTOCOL_VERSION,
    requestId: input.requestId,
    scope: input.scope.kind,
    ...(input.identity?.runtimeId === undefined ? {} : { runtimeId: input.identity.runtimeId }),
    ...(input.identity?.agentKind === undefined ? {} : { agentKind: input.identity.agentKind as AgentStateSnapshot["agentKind"] }),
    // identity.agentKind 是宽松字符串（调用方来自请求对象），这里已经过 allowedDomains 的同源校验。
    ...(input.identity?.sessionId === undefined ? {} : { sessionId: input.identity.sessionId }),
    modelEpoch: input.registry.currentModelEpoch(),
    domains,
    missing,
    truncated,
    ...(input.update === undefined ? {} : { update: input.update }),
    ...(unchanged.length === 0 ? {} : { unchanged }),
  };
}

/** 每个作用域认识哪些领域：名字错了要报 unknown_domain，而不是当成空状态。 */
function allowedDomains(scope: StateScope): ReadonlySet<string> {
  if (scope.kind === "host") return new Set(HostStateDomainSchema.options);
  if (scope.kind === "device") return new Set(DeviceStateDomainSchema.options);
  return new Set(AgentStateDomainSchema.options);
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
