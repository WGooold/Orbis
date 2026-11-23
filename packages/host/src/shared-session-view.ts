import { RUNTIME_VIEW_CLOSE_CAPABILITY, type AgentKind, type RuntimeCommand, type RuntimeSlashCommand } from "@orbis/protocol";

export const sharedViewBackend = (kind: AgentKind): boolean =>
  kind === "opencode" || kind === "kimiCode" || kind === "hermes" || kind === "openclaw";

export function exitViewCapability(generation: string): RuntimeSlashCommand {
  return { name: RUNTIME_VIEW_CLOSE_CAPABILITY, source: "builtin", closeGeneration: generation };
}

/** Direct/queued dispatch must still match the attachment authorized by Host. */
export function matchesViewExit(command: RuntimeCommand, sessionId: string, generation: string): boolean {
  return command.type === "session.close" && command.sessionId === sessionId && command.closeGeneration === generation;
}
