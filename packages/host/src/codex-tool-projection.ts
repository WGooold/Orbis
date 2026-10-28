import {
  createToolSummary, stripInlineMedia, type AgentKey, type ToolSummary, type ToolContentPage,
} from "@orbis/protocol";

type Item = Record<string, unknown>;
type Part = ToolSummary["contents"][number]["part"];
type Format = ToolContentPage["format"];
export type CodexToolProjectionContext = {
  agent: AgentKey; order: number; phase: ToolSummary["phase"]; turnId?: string; entryId?: string;
  /** Supplied only after the adapter establishes a real reader; unknown parts stay unavailable. */
  contentSources?: Partial<Record<Part, Pick<ToolSummary["contents"][number], "availability" | "readCapability">>>;
};
export type CodexToolContent = { part: Part; format: Format; value: unknown };
const isTool = (item: Item): boolean => typeof item.type === "string" && ["commandExecution", "fileChange", "mcpToolCall"].includes(item.type);
const has = (item: Item, key: string): boolean => item[key] !== undefined && item[key] !== null;
const text = (item: Item, key: string): string | undefined => typeof item[key] === "string" ? item[key] : undefined;
const finiteInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function nativeArguments(item: Item): unknown {
  switch (item.type) {
    case "commandExecution": return { ...(has(item, "command") ? { command: item.command } : {}), ...(has(item, "cwd") ? { cwd: item.cwd } : {}) };
    case "fileChange": return has(item, "changes") ? { changes: item.changes } : undefined;
    case "mcpToolCall": return { ...(has(item, "server") ? { server: item.server } : {}), ...(has(item, "tool") ? { tool: item.tool } : {}),
      ...(has(item, "arguments") || has(item, "input") ? { arguments: item.arguments ?? item.input } : {}) };
    default: return undefined;
  }
}

/** Raw native values are exposed solely to producer storage/native readers, never to shared state. */
export function* codexToolContents(item: Item): Generator<CodexToolContent> {
  if (!isTool(item)) return;
  const argumentsValue = nativeArguments(item);
  if (argumentsValue !== undefined && Object.keys(argumentsValue as object).length > 0) yield { part: "arguments", format: "json", value: argumentsValue };
  // aggregatedOutput is the final command output in app-server's full item view.
  const output = ["aggregatedOutput", "output", "outputText", "stdout"].find(key => has(item, key));
  if (output) yield { part: "output", format: typeof item[output] === "string" ? "text" : "json", value: item[output] };
  if (has(item, "result")) yield { part: "result", format: typeof item.result === "string" ? "text" : "json", value: item.result };
  else if (has(item, "structuredContent") || has(item, "content")) yield { part: "result", format: "json", value: {
    ...(has(item, "content") ? { content: item.content } : {}), ...(has(item, "structuredContent") ? { structuredContent: item.structuredContent } : {}),
    ...(has(item, "isError") ? { isError: item.isError } : {}),
  } };
  else if (["status", "exitCode", "stderr", "changes", "error"].some(key => has(item, key))) yield { part: "result", format: "json", value:
    Object.fromEntries(["status", "exitCode", "stderr", "changes", "error"].filter(key => has(item, key)).map(key => [key, item[key]])) };
}

/** ADR-0045 §3：只取已知原生字段生成摘要，不 stringify 原始参数、输出或 MCP 结果。 */
export function codexToolSummary(context: CodexToolProjectionContext, item: Item): ToolSummary | undefined {
  if (!isTool(item)) return undefined;
  if (typeof item.id !== "string") throw new Error("tool_identity_unrepresentable");
  if (context.agent.agentKind !== "codex" && context.agent.agentKind !== "codexDesktop") throw new Error("tool_agent_mismatch");
  const terminal = context.phase === "finished" || context.phase === "cancelled";
  const result = item.result !== null && typeof item.result === "object" ? item.result as Item : undefined;
  const explicitError = item.status === "failed" || item.status === "error" || has(item, "error") || item.isError === true ||
    result?.isError === true || (finiteInteger(item.exitCode) && item.exitCode !== 0);
  const isError = explicitError ? true : terminal && (item.status === "completed" || item.status === "succeeded" ||
    item.isError === false || result?.isError === false || item.exitCode === 0) ? false : undefined;
  const toolName = item.type === "mcpToolCall" ? text(item, "tool") ?? text(item, "server") ?? "mcpToolCall" : String(item.type);
  const count = item.type === "fileChange" && Array.isArray(item.changes) ? item.changes.length : undefined;
  const inputSummary = item.type === "commandExecution" ? text(item, "command") : count === undefined ? undefined : count + " files";
  const resultSummary = terminal && count !== undefined ? count + " files" : undefined;
  // Structured or arbitrary error values are not serialized into a summary.
  const errorObject = item.error !== null && typeof item.error === "object" ? item.error as Item : undefined;
  const errorSummary = explicitError ? text(item, "error") ?? (errorObject ? text(errorObject, "message") : undefined) : undefined;
  const parts: ToolSummary["contents"] = [];
  for (const { part, format } of codexToolContents(item)) parts.push({ part, format,
    ...(context.contentSources?.[part] ?? { availability: terminal ? "temporarily-unavailable" as const : "pending" as const, readCapability: "none" as const }),
  });
  if (!parts.some(part => part.part === "output") && (!terminal || context.contentSources?.output)) parts.push({ part: "output", format: "text",
    ...(context.contentSources?.output ?? { availability: "pending" as const, readCapability: "none" as const }) });
  return createToolSummary({ tool: { agent: context.agent, toolCallId: item.id }, toolName, phase: context.phase, order: context.order,
    messageId: item.id, ...(context.turnId === undefined ? {} : { turnId: context.turnId }), ...(context.entryId === undefined ? {} : { entryId: context.entryId }),
    ...(isError === undefined ? {} : { isError }),
    ...(finiteInteger(item.exitCode) && item.exitCode >= -2147483648 && item.exitCode <= 2147483647 ? { exitCode: item.exitCode } : {}),
    ...(finiteInteger(item.durationMs) && item.durationMs >= 0 ? { durationMs: item.durationMs } : {}),
    ...(inputSummary === undefined ? {} : { inputSummary }), ...(resultSummary === undefined ? {} : { resultSummary }),
    ...(errorSummary === undefined ? {} : { errorSummary }), contents: parts });
}

/** Deterministic JSON text for explicit reads; inline binary remains references under ADR-0034. */
export function codexToolContentText(content: CodexToolContent): string {
  if (content.format === "text") {
    if (typeof content.value !== "string") throw new Error("invalid_codex_tool_content");
    return content.value;
  }
  // stripInlineMedia's general projection tolerates deep/circular input with placeholders.
  // A detail read must fail explicitly rather than report such a placeholder as complete content.
  const ancestors = new Set<object>();
  const validate = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object") return;
    if (depth >= 64 || ancestors.has(value)) throw new Error("invalid_codex_tool_content");
    ancestors.add(value);
    for (const child of Object.values(value)) validate(child, depth + 1);
    ancestors.delete(value);
  };
  validate(content.value, 0);
  const sanitized = stripInlineMedia(content.value);
  const serialized = JSON.stringify(sanitized, (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  if (serialized === undefined) throw new Error("invalid_codex_tool_content");
  return serialized;
}
