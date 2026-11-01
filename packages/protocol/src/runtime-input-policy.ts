import type { RuntimeCommand } from "./index.js";

/** ADR-0055: adding a wire input requires an explicit owner, including non-command ACKs. */
export const runtimeInputOwners = {
  user_message: "backend", "user_message.cancel": "backend", "slash.execute": "backend",
  "permissions.update": "backend", stop: "backend", "interaction.respond": "backend",
  "session.sync": "history", "session.snapshot.ack": "history", "session.entry.request": "history",
  "session.tools.open": "tools", "session.tools.read": "tools",
  "session.tool.content.read": "tools", "session.tool.content.cancel": "tools",
  "session.changes.list": "changes", "session.changes.read": "changes",
  "session.change.detail.read": "changes", "session.change.detail.cancel": "changes",
  "file.download": "transfer", "artifact.download": "transfer", "artifact.cancel": "transfer",
} as const satisfies Record<RuntimeCommand["type"], "backend" | "history" | "tools" | "changes" | "transfer">;

export type RuntimeInputState = {
  phase: "idle" | "running" | "waiting_local_interaction" | "unknown";
  compacting?: boolean;
  starting?: boolean;
  stopping?: boolean;
  mutating?: boolean;
  reconciling?: boolean;
  closing?: boolean;
  offline?: boolean;
  queueDepth?: number;
};

export type MessageInputDecision = { action: "start" } | { action: "queue"; delivery: "followUp" | "steer" }
  | { action: "reject"; error: string };

/** Native adapters supply facts. Presentation status is never used for admission. */
export function messageInputDecision(state: RuntimeInputState, delivery?: "followUp" | "steer"): MessageInputDecision {
  if (state.offline) return { action: "reject", error: "runtime_offline" };
  if (state.closing) return { action: "reject", error: "runtime_closing" };
  if (state.mutating) return { action: "reject", error: "runtime_busy" };
  if (state.reconciling || state.phase === "unknown") return { action: "reject", error: "state_unavailable" };
  const busy = state.phase !== "idle" || state.starting || state.stopping || (state.queueDepth ?? 0) > 0;
  if (busy) return delivery === undefined ? { action: "reject", error: "runtime_busy" } : { action: "queue", delivery };
  if (state.compacting) return { action: "queue", delivery: delivery ?? "followUp" };
  return { action: "start" };
}

export function canDispatchMessage(state: RuntimeInputState): boolean {
  return !state.compacting && !state.starting && !state.stopping && messageInputDecision({ ...state, queueDepth: 0 }).action === "start";
}

/** The adapter classifies native commands; unknown extension effects conservatively mean write. */
export function inputMutationError(state: RuntimeInputState, effect: "read" | "write" | "close" = "write"): string | undefined {
  if (state.offline) return "runtime_offline";
  if (state.closing) return "runtime_closing";
  if (effect === "read" || effect === "close") return undefined;
  const decision = messageInputDecision(state);
  return decision.action === "reject" ? decision.error
    : decision.action === "queue" || !canDispatchMessage(state) ? "runtime_busy" : undefined;
}

/** The operation may have reached its native owner; retry requires evidence. */
export class RuntimeInputUnconfirmedError extends Error {}
