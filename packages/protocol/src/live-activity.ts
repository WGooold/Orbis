import type { AgentKind } from "./agent-kind.js";

/** LA-COMPAT-01: v1 summaries reach released Relays and widgets without negotiation. */
export const LIVE_ACTIVITY_V1_WIRE_AGENT_KINDS = ["pi", "codex", "codexDesktop", "claude", "dsh", "dshDesktop"] as const satisfies readonly AgentKind[];
export const LIVE_ACTIVITY_AGENT_KINDS = [...LIVE_ACTIVITY_V1_WIRE_AGENT_KINDS, "opencode"] as const satisfies readonly AgentKind[];
export type LiveActivityAgentKind = typeof LIVE_ACTIVITY_V1_WIRE_AGENT_KINDS[number];

export function liveActivitySupportsAgent(kind: unknown): boolean {
  return (LIVE_ACTIVITY_AGENT_KINDS as readonly unknown[]).includes(kind);
}

export function liveActivityV1AgentKind(kind: unknown): LiveActivityAgentKind | null {
  return (LIVE_ACTIVITY_V1_WIRE_AGENT_KINDS as readonly unknown[]).includes(kind) ? kind as LiveActivityAgentKind : null;
}

export type LiveActivityOutcome = "completed" | "failed" | "cancelled" | "unknown";
export type LiveActivityContentState = {
  version: 1;
  phase: "running" | "attention" | "ended" | "stale";
  runningCount: number;
  pendingCount: number;
  focusKey: string | null;
  agentKind: LiveActivityAgentKind | null;
  startedAt: number | null;
  updatedAt: number;
  outcome: LiveActivityOutcome | null;
};

export const LIVE_ACTIVITY_FRESHNESS_MS = 600_000;
