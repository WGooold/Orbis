import { describe, expect, it, vi } from "vitest";
import { truncateWireEntry, type RemoteSessionEntry } from "@orbis/protocol";
import { readFullSessionEntry } from "./session-entry-read.js";

// FT-G12-DETAIL-01: a reachable full-content button must fetch the native text, not echo the cached preview.
describe("full session entry reads", () => {
  const original: RemoteSessionEntry = { entryId: "e", parentId: null, type: "message", timestamp: "2026-11-14",
    data: { message: { role: "assistant", content: [{ type: "text", text: "answer".repeat(20_000) }] } } };
  it("resolves cold-cache and truncated-cache reads from the native source", async () => {
    for (const cached of [undefined, truncateWireEntry(original)]) {
      const read = vi.fn(async () => original);
      expect(await readFullSessionEntry("request", "e", cached, read)).toEqual({
        type: "session.entry.result", requestId: "request", entryId: "e", entry: original,
      });
      expect(read).toHaveBeenCalledOnce();
    }
  });
  it("reuses full legacy cache entries without another native read", async () => {
    const read = vi.fn();
    expect((await readFullSessionEntry("request", "e", original, read)).entry).toEqual(original);
    expect(read).not.toHaveBeenCalled();
  });
  it("returns native text that quotes truncation markers without mistaking the quote for data loss", async () => {
    const native = { ...original, data: { message: { role: "assistant", content: "示例：…（已截断，原始 90000 字节）" } } };
    expect((await readFullSessionEntry("request", "e", undefined, async () => native)).entry).toEqual(native);
  });
  it("does not label missing, mismatched, failed or still-truncated native content as full", async () => {
    const cached = truncateWireEntry(original);
    for (const read of [undefined, async () => undefined, async () => ({ ...original, entryId: "other" }),
      async () => cached, async () => { throw new Error("offline"); }]) {
      const response = await readFullSessionEntry("request", "e", cached, read);
      expect(response.entry).toBeUndefined(); expect(response.error).toBeDefined();
    }
  });
  it("keeps explicit full reads within their independent one-MiB envelope budget", async () => {
    const large = { ...original, data: { message: { role: "assistant", content: "x".repeat(1024 * 1024) } } };
    expect(await readFullSessionEntry("request", "e", undefined, async () => large))
      .toMatchObject({ error: "session_entry_too_large" });
  });
});
