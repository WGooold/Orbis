import { SESSION_SYNC_MAX_BYTES, SESSION_SYNC_WRAPPER_BYTES, type RemoteSessionEntry, type RuntimeEvent } from "@orbis/protocol";

const legacyContentTruncated = (content: unknown): boolean => typeof content === "string"
  ? /…（已截断，原始 \d+ 字节）$/u.test(content)
  : Array.isArray(content) && content.some(block => block !== null && typeof block === "object" &&
    (block.type === "text" || block.type === "thinking") && block.truncated === true);
const truncated = (entry: RemoteSessionEntry): boolean => {
  const message = entry.data.message as { content?: unknown } | undefined;
  return entry.data.wireTruncation !== undefined || legacyContentTruncated(message?.content) ||
    legacyContentTruncated(entry.data.content) || legacyContentTruncated(entry.data.summary);
};

/** A detail response is either complete native content or an explicit error, never another wire preview. */
export async function readFullSessionEntry(requestId: string, entryId: string, cached: RemoteSessionEntry | undefined,
  read: (() => Promise<RemoteSessionEntry | undefined>) | undefined): Promise<Extract<RuntimeEvent, { type: "session.entry.result" }>> {
  const result = { type: "session.entry.result" as const, requestId, entryId };
  try {
    const entry = cached && !truncated(cached) ? cached : await read?.();
    if (!entry || entry.entryId !== entryId) return { ...result, error: "entry_not_found" };
    // Native records may themselves quote a truncation marker or describe a tool's truncation.
    // Only our explicit wire preview metadata proves that a native reader returned a preview.
    if (entry.data.wireTruncation !== undefined) return { ...result, error: "entry_content_unavailable" };
    const response = { ...result, entry };
    return Buffer.byteLength(JSON.stringify(response), "utf8") + SESSION_SYNC_WRAPPER_BYTES > SESSION_SYNC_MAX_BYTES
      ? { ...result, error: "session_entry_too_large" } : response;
  } catch { return { ...result, error: "entry_content_unavailable" }; }
}
