import {
  RemoteArtifactSchema, type ChatMessage, type DisplayBatch, type DisplayEntry, type RemoteContent,
  type RemoteSessionEntry,
} from "./index.js";

/**
 * 统一的历史显示投影（ADR-0032 §5）。
 *
 * 原生 Entry 仍是历史权威：这里只把它解释成客户端可以直接渲染的标准结果，原生 id/parent/type
 * 与不可显示的原因全部保留。纯函数，不写状态、不发消息。
 *
 * 它住在协议层而不是 Host 里：**产出 display 批次的是适配层**，其中 Pi 扩展与 Host 内的
 * Codex/DSH 都要用它，Host 只负责校验、缓存与转发。模块只依赖本包的 schema 与其类型。
 *
 * 与今天 Android 的投影保持同一语义（压缩裁剪、角色映射、失败回填、忽略名单），差别是三处
 * 有意的改进：
 * - 不可显示的条目不再被静默丢弃，而是带着 `nativeType` 与原因留在结果里；
 * - 结果带 `projectionVersion`：投影算法变化时，消费方能据此失效自己的显示缓存；
 * - 显示窗口与渲染锚点是**投影说出来的事实**（`windowStart` / `anchor`），客户端不必再自己
 *   解释「哪一段被压缩裁剪掉了、摘要该渲染在哪」，见下。
 *
 * 显示窗口：
 * - `windowStart` 是路径上仍然可见的最旧条目；比它更旧的路径条目已经被历史改写（压缩）覆盖，
 *   不再显示。它是**显示窗口的起点**，不是「什么都没有」的证明：null 表示整条路径都是窗口。
 * - `anchor: "head"` 的条目渲染在窗口顶部，而不是它在 canonical 路径里的位置。摘要描述的是
 *   比它更旧的那段历史，因此排在它覆盖的内容之前；没有这个声明的条目按路径顺序渲染。
 */

/**
 * 投影算法版本。改变任何显示语义都要 +1，否则旧缓存会继续用旧表示。
 *
 * v2：批次开始携带 `windowStart`，压缩摘要带 `anchor: "head"`——窗口与顺序从「客户端自己算」
 * 变成「投影说出来」，这是 App 能够删掉原生解释的前提。
 */
export const DISPLAY_PROJECTION_VERSION = 3;

/**
 * 显示结果与显示批次的形状定义在协议里（它是线上负载），这里只做投影：
 * 同一份类型既给 Host 侧缓存用，也给适配层在 snapshot/patch 上附带时用。
 */
export type DisplayUndisplayableReason = DisplayEntry["reason"] & string;
/** 形状的唯一来源在协议；这里转出去，Host 侧模块不必各自再 import 一次。 */
export type { DisplayBatch, DisplayEntry } from "@orbis/protocol";

export type DisplayProjection = {
  readonly projectionVersion: number;
  /** 显示结果，已按渲染顺序排列（窗口顶部的条目在最前）。 */
  readonly entries: DisplayEntry[];
  /** 走到的 canonical 叶子；null 表示没有 head。 */
  readonly headEntryId: string | null;
  /** 生效的最新压缩条目；客户端据此知道这里有一段被压缩掉的历史。 */
  readonly compactionEntryId: string | null;
  /** 显示窗口起点（canonical entryId）：比它更旧的路径条目不显示。null = 整条路径都是窗口。 */
  readonly windowStart: string | null;
  /** 路径重建结果。不是 complete 时，客户端必须知道显示内容不完整。 */
  readonly status: "complete" | "leaf_not_found" | "missing_parent" | "cycle_detected";
};

/**
 * 投影的输入口径。
 *
 * `boundaryParentId` 是「原生历史到此为止」的已验证边界：走到它就等于走到了起点，不算缺父。
 * 有界读取（只加载了尾部若干条目）的分支靠它把自己的起点说清楚，而不是冒充成完整祖先链。
 */
export type DisplayProjectionOptions = {
  readonly boundaryParentId?: string | null | undefined;
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
/**
 * 本次提交条目的显示批次——适配层在 snapshot/patch 上附显示结果时的统一入口。
 *
 * 只覆盖这一批条目（不是整条路径）：客户端按 id 增量更新，不必每次重收整段历史。
 * 路径不完整时返回 undefined：半截的「完整样子」会覆盖客户端已有的正确内容，比不发更糟。
 * 被压缩裁剪掉的、以及不在当前 head 路径上的条目自然会被过滤掉。
 */
export function displayBatchFor(
  committed: readonly RemoteSessionEntry[],
  entries: ReadonlyMap<string, RemoteSessionEntry>,
  head: string | null,
  options: DisplayProjectionOptions = {},
): DisplayBatch | undefined {
  if (committed.length === 0) return undefined;
  return displayBatchFromProjection(projectDisplayEntries([...entries.values()], head, options), committed);
}

/**
 * 从一份已经算好的投影里取出这一批条目的显示结果。
 *
 * 分页（一次投影、多页发出）走这条路径：投影只算一次，每页只挑自己那几条。语义与
 * `displayBatchFor` 完全相同——只覆盖这一批条目，路径不完整时不发。
 */
export function displayBatchFromProjection(
  projection: DisplayProjection,
  committed: readonly RemoteSessionEntry[],
): DisplayBatch | undefined {
  if (committed.length === 0 || projection.status !== "complete") return undefined;
  const ids = new Set(committed.map(entry => entry.entryId));
  const visible = projection.entries.filter(entry => entry.entryId !== null && ids.has(entry.entryId));
  return visible.length === 0 ? undefined : {
    projectionVersion: projection.projectionVersion,
    entries: visible,
    windowStart: projection.windowStart,
  };
}

/**
 * 把一次投影整理成可以附在 snapshot/patch 上的显示批次。
 *
 * 只有 `complete` 的路径才附带：路径不完整时给客户端一批「看起来完整」的显示结果，
 * 比不给更糟——它会覆盖掉客户端手里已有的正确内容。
 */
export function toDisplayBatch(projection: DisplayProjection): DisplayBatch | undefined {
  if (projection.status !== "complete") return undefined;
  return {
    projectionVersion: projection.projectionVersion,
    entries: projection.entries,
    windowStart: projection.windowStart,
  };
}

export function projectDisplayEntries(
  entries: readonly RemoteSessionEntry[],
  leafId: string | null,
  options: DisplayProjectionOptions = {},
): DisplayProjection {
  const { path, status } = buildDisplayPath(entries, leafId, options.boundaryParentId);
  const trimmed = trimAtCompaction(path);
  return {
    projectionVersion: DISPLAY_PROJECTION_VERSION,
    entries: trimmed.path.flatMap(projectEntry),
    headEntryId: leafId,
    compactionEntryId: trimmed.compactionEntryId,
    windowStart: trimmed.windowStart,
    status,
  };
}

/** 从叶子沿 parentId 回溯并反转成时间顺序；同时报告路径为什么可能不完整。 */
export function buildDisplayPath(
  entries: readonly RemoteSessionEntry[],
  leafId: string | null,
  boundaryParentId?: string | null,
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
      // 走到已验证的原生边界：那就是这条分支的起点，不是缺父。
      if (boundaryParentId !== undefined && boundaryParentId !== null && cursor === boundaryParentId) break;
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
  windowStart: string | null;
} {
  let latest = -1;
  for (let index = 0; index < path.length; index += 1) if (path[index]!.type === "compaction") latest = index;
  if (latest < 0) return { path, compactionEntryId: null, windowStart: null };
  const compaction = path[latest]!;
  const firstKeptId = asString(compaction.data["firstKeptEntryId"]);
  let firstKept = -1;
  if (firstKeptId !== undefined) {
    for (let index = 0; index < path.length; index += 1) if (path[index]!.entryId === firstKeptId) { firstKept = index; break; }
  }
  const kept = firstKept >= 0 && firstKept < latest ? path.slice(firstKept, latest) : [];
  // 窗口起点是路径上仍然可见的最旧条目：有保留段就是它的开头，否则就是压缩点本身。
  const windowStart = kept.length > 0 ? path[firstKept]!.entryId : compaction.entryId;
  return {
    path: [compaction, ...kept, ...path.slice(latest + 1)],
    compactionEntryId: compaction.entryId,
    windowStart,
  };
}

function projectEntry(entry: RemoteSessionEntry): DisplayEntry[] {
  switch (entry.type) {
    case "message": return projectMessage(entry);
    case "custom_message": return projectCustomMessage(entry);
    case "compaction": return [summaryEntry(entry, "压缩摘要", "summary", "head")];
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
  const rawClientMessageId = role === "user" ? asString(message["clientMessageId"]) : undefined;
  const clientMessageId = rawClientMessageId !== undefined && rawClientMessageId.length > 0 && rawClientMessageId.length <= 256
    ? rawClientMessageId : undefined;
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
      ...(message["toolSummary"] === undefined ? {} : { toolSummary: message["toolSummary"] as ChatMessage["toolSummary"] }),
      // ADR-0049 §2：只复制身份对应，不改变显示语义，因此不升级 projectionVersion。
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
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

/**
 * 摘要条目。压缩摘要带 `anchor: "head"`：它描述的是比它更旧的那段历史，因此渲染在窗口顶部，
 * 而不是它自己的 canonical 位置。分支摘要留在原位（路径顺序）。
 */
function summaryEntry(entry: RemoteSessionEntry, label: string, field: string, anchor?: "head"): DisplayEntry {
  return {
    displayId: entry.entryId,
    entryId: entry.entryId,
    nativeType: entry.type,
    kind: "summary",
    reason: null,
    ...(anchor === undefined ? {} : { anchor }),
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
          ...(block["summary"] === undefined ? { arguments: block["arguments"] } : { summary: block["summary"] as Extract<RemoteContent, { type: "tool_call" }>["summary"] }),
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
