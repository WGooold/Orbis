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
/** 单条 Entry 上限：等于页预算，使一条大条目最多独占一页，不会顶到 1MB 兜底。 */
export const WIRE_ENTRY_LIMIT_BYTES = 256 * 1024;
/** 递归深度上限：原生 data 可能嵌套很深，超过就当普通值处理。 */
const MAX_DEPTH = 8;

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
 * 截断一个字符串。已经带标记的串直接返回，保证幂等（重复投影结果一致）。
 */
export function truncateWireText(text: string, limit = WIRE_FIELD_LIMIT_BYTES): string {
  const bytes = byteLength(text);
  if (bytes <= limit) return text;
  const suffix = marker(bytes);
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
  if (Array.isArray(value)) return value.map((item) => truncateWireValue(item, limit, depth + 1));
  const record = value as Record<string, unknown>;
  // ADR-0038 §5：内容块被截断时带上结构化标记（客户端可显示原始字节数）；
  // 文本里仍保留可见提示，因为绝大多数渲染路径只读 `text`。
  if ((record.type === "text" || record.type === "thinking") && typeof record.text === "string") {
    const text = record.text;
    const bytes = byteLength(text);
    if (bytes > limit) {
      return { ...record, text: truncateWireText(text, limit), truncated: true as const, originalBytes: bytes };
    }
    return record;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const projected = truncateWireValue(child, limit, depth + 1);
    if (projected !== child) changed = true;
    next[key] = projected;
  }
  return changed ? next : value;
}

/** live 载荷（`session.patch.live`）的截断：messages 的正文与 tools 的结果。 */
export function truncateWireLive<T>(live: T, limit = WIRE_FIELD_LIMIT_BYTES): T {
  return truncateWireValue(live, limit) as T;
}

/**
 * 单条 Entry 的线路投影。
 *
 * 先按字段上限截断；若整条仍超条目预算，就按同一顺序继续收紧字段上限直到装得下
 * （ADR-0038 §3 的"逐次折半"）。装不下时返回最后一次结果——精确的 1MB 兜底仍然存在，
 * 这里不做丢弃决定。
 */
export function truncateWireEntry<T extends { data: Record<string, unknown> }>(
  entry: T,
  entryLimit = WIRE_ENTRY_LIMIT_BYTES,
): T {
  let limit = WIRE_FIELD_LIMIT_BYTES;
  for (;;) {
    const data = truncateWireValue(entry.data, limit) as Record<string, unknown>;
    const candidate = data === entry.data ? entry : { ...entry, data };
    if (byteLength(JSON.stringify(candidate)) <= entryLimit || limit <= 1024) return candidate;
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
