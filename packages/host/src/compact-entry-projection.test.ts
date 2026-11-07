// FT-G08: private native fields never enter the selected public representation;
// display, graph/compaction boundaries, errors and exact command outcomes survive.
import { describe, expect, it } from "vitest";
import { displayBatchFor, type RemoteSessionEntry } from "@orbis/protocol";
import { projectCompactDeviceMessage } from "./device-message-projection.js";

const envelope = <T extends object>(event: T) => ({ type: "runtime.event", protocolVersion: 19, runtimeId: "r", sequence: 1, event });
describe("FT-G08 compact entry projection", () => {
  it("removes raw native metadata while preserving the same display and exact graph", () => {
    const entries: RemoteSessionEntry[] = [
      { entryId: "user", parentId: null, type: "message", timestamp: "2026-11-07T00:00:00Z", data: {
        native: "private".repeat(10000), message: { role: "user", timestamp: 1, clientMessageId: "phone-id", content: "exact input", nativeUsage: { large: "raw".repeat(10000) } } } },
      { entryId: "assistant", parentId: "user", type: "message", timestamp: "2026-11-07T00:00:01Z", data: {
        message: { role: "assistant", content: [{ type: "thinking", thinking: "visible thinking", signature: "private-signature" },
          { type: "text", text: "visible answer", nativeTrace: "private-trace" }], stopReason: "error", errorMessage: "must survive" }, remoteFailure: "actionable failure" } },
      { entryId: "compact", parentId: "assistant", type: "compaction", timestamp: "2026-11-07T00:00:02Z", data: {
        summary: "summary", firstKeptEntryId: "assistant", nativeTokens: 1000 } },
    ];
    const input = envelope({ type: "session.snapshot", source: { ready: true }, entries });
    const result = projectCompactDeviceMessage(input) as typeof input;
    expect(result.event.entries.map(({ entryId, parentId }) => [entryId, parentId])).toEqual(entries.map(({ entryId, parentId }) => [entryId, parentId]));
    const display = (rows: RemoteSessionEntry[]) => displayBatchFor(rows, new Map(rows.map(row => [row.entryId, row])), "compact");
    expect(display(result.event.entries)).toEqual(display(entries));
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.event.entries[0]!.data.message).toMatchObject({ clientMessageId: "phone-id", content: "exact input" });
    expect(result.event.entries[1]!.data.remoteFailure).toBe("actionable failure");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)) / 10);
    expect(input.event.entries[0]!.data).toHaveProperty("native");
  });
  it("keeps explicit native detail, unversioned history, decisions and all registered command results", () => {
    for (const event of [
      { type: "session.entry.result", entry: { data: { native: "explicit detail" } } },
      { type: "session.snapshot", entries: [{ data: { native: "legacy" } }] },
      { type: "interaction.requested", request: { description: "decision" } },
    ]) expect(projectCompactDeviceMessage(envelope(event))).toEqual(envelope(event));
    const result = { sessionId: "exact-session", runtimeId: "exact-runtime", editorText: "complete input".repeat(1000), leafId: "leaf", copied: true,
      nativePayload: "private large output".repeat(1000) };
    const projected = projectCompactDeviceMessage(envelope({ type: "command.result", commandId: "op", ok: true, result })) as { event: { result: object } };
    expect(projected.event.result).toEqual({ sessionId: result.sessionId, runtimeId: result.runtimeId, editorText: result.editorText, leafId: "leaf", copied: true });
    expect(result).toHaveProperty("nativePayload");
  });
});
