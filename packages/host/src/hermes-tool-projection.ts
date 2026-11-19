import { createToolSummary, type AgentKey, type ToolSummary } from "@orbis/protocol";

export function hermesToolIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= 256 ? value : undefined;
}

type ToolFacts = Pick<ToolSummary, "phase" | "entryId" | "turnId" | "isError" | "durationMs"> & {
  toolCallId: string; toolName: string; order: number; args?: unknown; result?: unknown;
};

/** Hermes event payloads can contain full arguments, results, diffs and progress bodies. None are public. */
export function hermesToolSummary(agent: AgentKey, { toolCallId, toolName, order, args, result, ...facts }: ToolFacts): ToolSummary {
  const contents: ToolSummary["contents"] = [];
  for (const [part, value] of [["arguments", args], ["result", result]] as const) {
    if (value !== undefined && value !== null) contents.push({ part, format: typeof value === "string" ? "text" : "json",
      availability: "unrecoverable", readCapability: "none" });
  }
  return createToolSummary({ tool: { agent, toolCallId }, toolName, order, contents, ...facts });
}
