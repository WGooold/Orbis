/**
 * ADR-0038：超长文本按线路投影截断，存储保留原文。
 *
 * 只有"发给设备的载荷"会被截断。身份与版本字段（`entryId`、`parentId`、`timestamp`、
 * 修订号、源端指纹）一律来自原文：截断它们会制造比原问题更难查的故障——Host 会认为
 * "没变"从而不产生新 patch，客户端永远显示旧内容且日志无异常。
 *
 * 确定性要求：同一份输入在任何一次投影、任何一页、任何一次重试中必须得到完全相同的结果
 * （ADR-0025 的缓存身份）。因此截断只取决于字符串内容与固定预算，不含时间、不含随机。
 */

/** 单字段上限（ADR-0038 §3）。 */
export const WIRE_FIELD_LIMIT_BYTES = 64 * 1024;
/**
 * 单条 Entry 线路投影上限。History snapshot 同时携带 canonical entry 与显示投影，
 * 因此给正文预留约一半的 64 KiB hard page，避免同一正文在两种表示中翻倍后越界。
 */
export const WIRE_ENTRY_LIMIT_BYTES = 24 * 1024;
/** 递归深度上限：原生 data 可能嵌套很深，超过就当普通值处理。 */
const MAX_DEPTH = 32;
/** Fixed live text target; complete inventories and their identities remain authoritative. */
export const WIRE_LIVE_LIMIT_BYTES = 8 * 1024;
const IDENTITY_FIELDS = new Set(["id", "entryId", "parentId", "messageId", "clientMessageId", "clientMessageIds", "toolCallId",
  "firstKeptEntryId", "type", "role", "timestamp", "toolName", "turnId", "epoch", "checkpointId"]);

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 从末尾裁到不超过 `limit` 字节，且不切裂 UTF-8 字符。 */
function cutToBytes(text: string, limit: number): string {
  if (limit <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  // 退到字符起始字节（UTF-8 续字节形如 10xxxxxx）。
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function marker(originalBytes: number): string {
  return `…（已截断，原始 ${originalBytes} 字节）`;
}

/**
 * 截断一个字符串。收紧已有投影时保留原始大小，同一预算下保持幂等。
 */
export function truncateWireText(text: string, limit = WIRE_FIELD_LIMIT_BYTES): string {
  const bytes = byteLength(text);
  if (bytes <= limit) return text;
  // Tightening an already projected legacy field must retain the original size, otherwise
  // raw commit and recovery page normalize to different text at the same entry identity.
  const previous = /…（已截断，原始 (\d+) 字节）$/u.exec(text);
  const originalBytes = previous === null ? bytes : Math.max(bytes, Number(previous[1]));
  const suffix = marker(originalBytes);
  const budget = limit - byteLength(suffix);
  return cutToBytes(text, budget) + suffix;
}

/**
 * 递归截断任意 JSON 值里的长字符串。结构与身份字段保持不变：
 * 对象键顺序、数组长度、非字符串值都不动（ADR-0038 §4）。
 */
export function truncateWireValue(value: unknown, limit = WIRE_FIELD_LIMIT_BYTES, depth = 0): unknown {
  if (typeof value === "string") return truncateWireText(value, limit);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    const projected = value.map((item) => truncateWireValue(item, limit, depth + 1));
    return projected.every((item, index) => item === value[index]) ? value : projected;
  }
  const record = value as Record<string, unknown>;
  // ADR-0038 §5：内容块被截断时带上结构化标记（客户端可显示原始字节数）；
  // 文本里仍保留可见提示，因为绝大多数渲染路径只读 `text`。
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const projected = IDENTITY_FIELDS.has(key) ? child : truncateWireValue(child, limit, depth + 1);
    if (projected !== child) changed = true;
    next[key] = projected;
  }
  if (record.type === "text" || record.type === "thinking") {
    const field = record.type === "thinking" && typeof record.thinking === "string" ? "thinking" : "text";
    if (typeof record[field] === "string" && next[field] !== record[field]) {
      next.truncated = true;
      next.originalBytes = typeof record.originalBytes === "number" ? record.originalBytes : byteLength(record[field]);
    }
  }
  return changed ? next : value;
}

/** live 载荷（`session.patch.live`）的截断：messages 的正文与 tools 的结果。 */
export function truncateWireLive<T>(live: T, limit = WIRE_FIELD_LIMIT_BYTES): T {
  return truncateWireValue(live, limit) as T;
}

/** Project at the source, before assigning a published seq. Snapshot and patch must reuse it.
 * Inventories and their identities are never dropped to meet a text target. */
export function projectWireLive<T>(live: T): T {
  for (let limit = WIRE_FIELD_LIMIT_BYTES; ; limit = Math.floor(limit / 2)) {
    const candidate = truncateWireLive(live, limit);
    if (byteLength(JSON.stringify(candidate)) <= WIRE_LIVE_LIMIT_BYTES || limit <= 128) return candidate;
  }
}

/**
 * 单条 Entry 的线路投影。
 *
 * 先按字段上限截断；若整条仍超条目预算，就按同一顺序继续收紧字段上限直到装得下
 * （ADR-0038 §3 的"逐次折半"）。大量短字段 / 深层数据仍超限时保留节点身份、压缩边界与
 * 可展开的正文摘要；完整原文由源端保留，通过独立条目读取返回。
 */
export function truncateWireEntry<T extends { data: Record<string, unknown> }>(
  entry: T,
  entryLimit = WIRE_ENTRY_LIMIT_BYTES,
): T {
  let limit = WIRE_FIELD_LIMIT_BYTES;
  const originalBytes = typeof (entry.data.wireTruncation as { originalBytes?: unknown } | undefined)?.originalBytes === "number"
    ? (entry.data.wireTruncation as { originalBytes: number }).originalBytes : byteLength(JSON.stringify(entry.data));
  for (;;) {
    let data = truncateWireValue(entry.data, limit) as Record<string, unknown>;
    if (data !== entry.data) data = { ...data, wireTruncation: { originalBytes } };
    const candidate = data === entry.data ? entry : { ...entry, data };
    if (byteLength(JSON.stringify(candidate)) <= entryLimit) return candidate;
    if (limit <= 1024) {
      const original = entry.data;
      const message = original.message !== null && typeof original.message === "object" && !Array.isArray(original.message)
        ? original.message as Record<string, unknown> : undefined;
      const pick = (value: Record<string, unknown>, keys: readonly string[]) =>
        Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
      const content = [{ type: "text", text: marker(originalBytes), truncated: true, originalBytes }];
      const preview: Record<string, unknown> = {
        ...pick(original, ["firstKeptEntryId", "display"]),
        ...(typeof original.summary === "string" ? { summary: truncateWireText(original.summary, 1024) } : {}),
        ...(message ? { message: { ...pick(message, ["messageId", "role", "timestamp", "clientMessageId", "clientMessageIds", "toolCallId", "toolName", "isError", "stopReason"]), content } } : {}),
        ...(original.content === undefined ? {} : { content }),
        wireTruncation: { originalBytes },
      };
      return { ...entry, data: preview };
    }
    limit = Math.floor(limit / 2);
  }
}

/**
 * 按身份缓存线路投影（ADR-0038：同一 Entry 每次投影结果必须一致）。
 *
 * 条目在 ADR-0035 下是不可变复用对象，因此用同一个对象当键即可安全复用结果。
 */
export class WireTruncator {
  #entries = new WeakMap<object, unknown>();

  entry<T extends { data: Record<string, unknown> }>(entry: T): T {
    const cached = this.#entries.get(entry);
    if (cached !== undefined) return cached as T;
    const projected = truncateWireEntry(entry);
    this.#entries.set(entry, projected);
    return projected;
  }

  entries<T extends { data: Record<string, unknown> }>(entries: readonly T[]): T[] {
    return entries.map((entry) => this.entry(entry));
  }
}
