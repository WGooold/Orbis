import { RemoteArtifactSchema, type ChatMessage, type RemoteContent, type RemoteSessionEntry } from "@pi-remote/protocol";

/**
 * 统一的历史显示投影（ADR-0032 §5，issue #7 的 Host 侧）。
 *
 * 原生 Entry 仍是历史权威：这里只把它解释成客户端可以直接渲染的标准结果，原生 id/parent/type
 * 与不可显示的原因全部保留。本模块是纯函数，不写模型、不发消息——协议层接入（issue #10）之前
 * 它只被测试与后续 Host 侧缓存使用。
 *
 * 与今天 Android 的投影保持同一语义（压缩裁剪、角色映射、失败回填、忽略名单），差别只有两处
 * 有意的改进：
 * - 不可显示的条目不再被静默丢弃，而是带着 `nativeType` 与原因留在结果里；
 * - 结果带 `projectionVersion`：投影算法变化时，消费方能据此失效自己的显示缓存。
 */

/** 投影算法版本。改变任何显示语义都要 +1，否则旧缓存会继续用旧表示。 */
export const DISPLAY_PROJECTION_VERSION = 1;

export type DisplayUndisplayableReason =
  /** 原生类型从未见过：保留身份，不猜内容。 */
  | "unknown_native_type"
  /** 认识这个类型，但它的语义就是不显示（自定义事件、模型切换、标签等）。 */
  | "not_rendered"
  /** 认识这个类型，但缺少可显示的内容。 */
  | "missing_content";

export type DisplayEntry = {
  /** 稳定的显示身份：canonical 条目就是 entryId。 */
  readonly displayId: string;
  readonly entryId: string | null;
  readonly nativeType: string | null;
  readonly kind: "message" | "summary" | "undisplayable";
  /** 可直接渲染的消息；`undisplayable` 时为 null。 */
  readonly message: ChatMessage | null;
  readonly reason: DisplayUndisplayableReason | null;
};

export type DisplayProjection = {
  readonly projectionVersion: number;
  readonly entries: DisplayEntry[];
  /** 走到的 canonical 叶子；null 表示没有 head。 */
  readonly headEntryId: string | null;
  /** 生效的最新压缩条目；客户端据此知道这里有一段被压缩掉的历史。 */
  readonly compactionEntryId: string | null;
  /** 路径重建结果。不是 complete 时，客户端必须知道显示内容不完整。 */
  readonly status: "complete" | "leaf_not_found" | "missing_parent" | "cycle_detected";
};

const ROLE_MAP: Record<string, ChatMessage["role"]> = {
  user: "user", assistant: "assistant", toolResult: "tool", tool: "tool", custom: "custom", bashExecution: "system",
};
/** 认识但不显示的条目类型（原生事件，不是对话内容）。 */
const NOT_RENDERED_TYPES = new Set(["custom", "thinking_level_change", "model_change", "label", "session_info"]);

/**
 * 把 canonical 条目投影成显示结果。
 *
 * `leafId` 为空时返回空投影；缺父、成环、找不到叶子都会在 `status` 里如实报告，而不是
 * 假装历史是完整的。
 */
export function projectDisplayEntries(entries: readonly RemoteSessionEntry[], leafId: string | null): DisplayProjection {
  const { path, status } = buildDisplayPath(entries, leafId);
  const trimmed = trimAtCompaction(path);
  return {
    projectionVersion: DISPLAY_PROJECTION_VERSION,
    entries: trimmed.path.flatMap(projectEntry),
    headEntryId: leafId,
    compactionEntryId: trimmed.compactionEntryId,
    status,
  };
}

/** 从叶子沿 parentId 回溯并反转成时间顺序；同时报告路径为什么可能不完整。 */
export function buildDisplayPath(
  entries: readonly RemoteSessionEntry[],
  leafId: string | null,
): { path: RemoteSessionEntry[]; status: DisplayProjection["status"] } {
  if (leafId === null) return { path: [], status: "complete" };
  const indexed = new Map(entries.map(entry => [entry.entryId, entry]));
  const path: RemoteSessionEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  let status: DisplayProjection["status"] = "complete";
  while (cursor !== null) {
    if (seen.has(cursor)) { status = "cycle_detected"; break; }
    seen.add(cursor);
    const entry = indexed.get(cursor);
    if (entry === undefined) {
      // 一个都没走到：叶子本身不在这一页里；走到一半断掉：中间缺父。
      status = path.length === 0 ? "leaf_not_found" : "missing_parent";
      break;
    }
    path.push(entry);
    cursor = entry.parentId;
  }
  return { path: path.reverse(), status };
}

/**
 * 压缩裁剪：只保留压缩点、它声明保留的那一段，以及压缩之后的条目。
 * `firstKeptEntryId` 指不到有效位置时，同样只保留压缩点及其之后的内容。
 */
function trimAtCompaction(path: readonly RemoteSessionEntry[]): {
  path: readonly RemoteSessionEntry[];
  compactionEntryId: string | null;
} {
  let latest = -1;
  for (let index = 0; index < path.length; index += 1) if (path[index]!.type === "compaction") latest = index;
  if (latest < 0) return { path, compactionEntryId: null };
  const compaction = path[latest]!;
  const firstKeptId = asString(compaction.data["firstKeptEntryId"]);
  let firstKept = -1;
  if (firstKeptId !== undefined) {
    for (let index = 0; index < path.length; index += 1) if (path[index]!.entryId === firstKeptId) { firstKept = index; break; }
  }
  const kept = firstKept >= 0 && firstKept < latest ? path.slice(firstKept, latest) : [];
  return { path: [compaction, ...kept, ...path.slice(latest + 1)], compactionEntryId: compaction.entryId };
}

function projectEntry(entry: RemoteSessionEntry): DisplayEntry[] {
  switch (entry.type) {
    case "message": return projectMessage(entry);
    case "custom_message": return projectCustomMessage(entry);
    case "compaction": return [summaryEntry(entry, "压缩摘要", "summary")];
    case "branch_summary": {
      const summary = asString(entry.data["summary"]);
      return summary === undefined || summary.length === 0
        ? [undisplayable(entry, "not_rendered")]
        : [summaryEntry(entry, "分支摘要", "summary")];
    }
    default:
      if (NOT_RENDERED_TYPES.has(entry.type)) return [undisplayable(entry, "not_rendered")];
      return [undisplayable(entry, "unknown_native_type")];
  }
}

function projectMessage(entry: RemoteSessionEntry): DisplayEntry[] {
  const message = asRecord(entry.data["message"]);
  if (message === undefined) return [undisplayable(entry, "missing_content")];
  const rawRole = asString(message["role"]);
  const role = rawRole === undefined ? undefined : ROLE_MAP[rawRole];
  // 自定义消息可以显式声明「不要显示」；未知角色同样不猜。
  if (role === undefined || (rawRole === "custom" && message["display"] === false)) {
    return [undisplayable(entry, "not_rendered")];
  }
  const failure = asString(entry.data["remoteFailure"])?.trim();
  const blocks = rawRole === "bashExecution"
    ? [shellBlock(message)]
    : contentBlocks(message["content"]);
  const isError = message["isError"] === true;
  const stopReason = asString(message["stopReason"]);
  const failed = (failure !== undefined && failure.length > 0) || isError || stopReason === "error" || stopReason === "aborted";
  // 旧缓存条目没有 remoteFailure：失败时必须退回 provider 文案，否则这一行会消失。
  const fallback = failed ? asString(message["errorMessage"])?.trim() : undefined;
  const failureLine = failure !== undefined && failure.length > 0 ? failure : fallback;
  const content = failureLine !== undefined && failureLine.length > 0 &&
    !blocks.some(block => block.type === "text" && block.text === failureLine)
    ? [...blocks, { type: "text" as const, text: failureLine }]
    : blocks;
  const toolCallId = asString(message["toolCallId"]);
  const toolName = asString(message["toolName"]);
  return [{
    displayId: entry.entryId,
    entryId: entry.entryId,
    nativeType: entry.type,
    kind: "message",
    reason: null,
    message: {
      messageId: entry.entryId,
      role,
      content,
      timestamp: asNumber(message["timestamp"]) ?? toTimestampMillis(entry.timestamp),
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(toolName === undefined ? {} : { toolName }),
      isError: failed,
    },
  }];
}

function projectCustomMessage(entry: RemoteSessionEntry): DisplayEntry[] {
  if (entry.data["display"] !== true) return [undisplayable(entry, "not_rendered")];
  const content = contentBlocks(entry.data["content"]);
  const artifact = RemoteArtifactSchema.safeParse(asRecord(entry.data["details"])?.["remoteArtifact"]);
  return [{
    displayId: entry.entryId,
    entryId: entry.entryId,
    nativeType: entry.type,
    kind: "message",
    reason: null,
    message: {
      messageId: entry.entryId,
      role: "custom",
      content: artifact.success ? [...content, { type: "artifact", artifact: artifact.data }] : content,
      timestamp: toTimestampMillis(entry.timestamp),
    },
  }];
}

function summaryEntry(entry: RemoteSessionEntry, label: string, field: string): DisplayEntry {
  return {
    displayId: entry.entryId,
    entryId: entry.entryId,
    nativeType: entry.type,
    kind: "summary",
    reason: null,
    message: {
      messageId: entry.entryId,
      role: "system",
      content: [{ type: "text", text: `${label}：${asString(entry.data[field]) ?? ""}` }],
      timestamp: toTimestampMillis(entry.timestamp),
    },
  };
}

function undisplayable(entry: RemoteSessionEntry, reason: DisplayUndisplayableReason): DisplayEntry {
  return { displayId: entry.entryId, entryId: entry.entryId, nativeType: entry.type, kind: "undisplayable", message: null, reason };
}

function shellBlock(message: Record<string, unknown>): RemoteContent {
  const command = asString(message["command"])?.trim();
  const output = asString(message["output"])?.trim();
  const text = [command === undefined || command.length === 0 ? "" : `$ ${command}`, output ?? ""]
    .filter(part => part.length > 0).join("\n");
  return { type: "text", text };
}

/** 正文块：字符串、文本/思考块、以及两种历史命名下的工具调用。未知块不猜。 */
function contentBlocks(value: unknown): RemoteContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  const blocks: RemoteContent[] = [];
  for (const raw of value) {
    const block = asRecord(raw);
    if (block === undefined) continue;
    switch (asString(block["type"])) {
      case "text": blocks.push({ type: "text", text: asString(block["text"]) ?? "" }); break;
      case "thinking":
        blocks.push({ type: "thinking", text: asString(block["thinking"]) ?? asString(block["text"]) ?? "" });
        break;
      case "toolCall":
      case "tool_call":
        blocks.push({
          type: "tool_call",
          toolCallId: asString(block["toolCallId"]) ?? asString(block["id"]) ?? "",
          toolName: asString(block["toolName"]) ?? asString(block["name"]) ?? "",
          arguments: block["arguments"],
        });
        break;
      default: break;
    }
  }
  return blocks;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/** 原生条目时间戳是 ISO 字符串；解不出来就是 0（与客户端既有行为一致，不伪造时间）。 */
const toTimestampMillis = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};
