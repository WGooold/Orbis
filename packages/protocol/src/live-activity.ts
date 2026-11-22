import type { AgentKind } from "./agent-kind.js";

/** ActivityKit v1 updates are not negotiated per device. Keep the released
 * App's kind set until a different envelope can be opted into. */
export const LIVE_ACTIVITY_AGENT_KINDS = ["pi", "codex", "codexDesktop", "claude", "dsh", "dshDesktop", "opencode"] as const satisfies readonly AgentKind[];
export type LiveActivityAgentKind = typeof LIVE_ACTIVITY_AGENT_KINDS[number];

export function liveActivitySupportsAgent(kind: unknown): kind is LiveActivityAgentKind {
  return (LIVE_ACTIVITY_AGENT_KINDS as readonly unknown[]).includes(kind);
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
