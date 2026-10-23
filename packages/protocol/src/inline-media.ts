/**
 * ADR-0034：图片以引用（而不是 base64）进入统一模型。
 *
 * 原生载荷里的 `{ type: "image", data: <base64> }`（Pi 的 `read` 工具结果、用户粘贴图）
 * 统一降成确定性占位：`{ type: "image", mimeType, byteLength }`。占位只来自原生事实
 * （mime、字节数），同一 Entry ID 每次投影都得到同一份结果——ADR-0025 的缓存身份要求。
 *
 * 手机今天不渲染图片：`RemoteContent` 没有 image 类型，display 投影只取 text/thinking/
 * tool_call。所以这些字节在旧实现里是纯死重量，却进了 canonical Entry、live 工具状态和
 * 每一次 sync/每一条 session.patch。
 */
export function stripInlineMedia(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= 64) return "[Truncated]";
  if (ancestors.has(value)) return "[Circular]";
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map((item) => stripInlineMedia(item, depth + 1, nextAncestors));
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "image" || type === "input_image") {
    const inline = typeof record.data === "string"
      ? record.data
      : typeof record.image_url === "string" && record.image_url.startsWith("data:")
        ? record.image_url.slice(record.image_url.indexOf(",") + 1)
        : undefined;
    if (inline !== undefined) {
      const mimeType = typeof record.mimeType === "string"
        ? record.mimeType
        : typeof record.image_url === "string" && /^data:([^;,]+)/.exec(record.image_url)?.[1];
      const padding = inline.endsWith("==") ? 2 : inline.endsWith("=") ? 1 : 0;
      return {
        type: "image",
        ...(mimeType === undefined ? {} : { mimeType }),
        byteLength: Math.max(0, Math.floor((inline.length * 3) / 4) - padding),
      };
    }
  }
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    projected[key] = stripInlineMedia(child, depth + 1, nextAncestors);
  }
  return projected;
}
