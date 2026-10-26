import { describe, expect, it } from "vitest";
import { RecoverableSessionSource, createToolSummary, projectToolEntry, type SessionPatch,
  type ToolInventoryProduced, type RemoteSessionEntry } from "./index.js";

const agent = { hostId: "host", agentKind: "pi" as const, sessionId: "s" };
const summary = (id: string, order: number) => createToolSummary({ tool: { agent, toolCallId: id }, toolName: "read", phase: "running", order, contents: [] });

describe("tool projection source integration", () => {
  it("pages 200 summaries outside live, preserves mixed message positions and atomically removes committed tools", () => {
    const events: (SessionPatch | ToolInventoryProduced)[] = [];
    const source = new RecoverableSessionSource("s", event => events.push(event), { runtimeId: () => "r", publishTools: event => events.push(event) });
    source.transaction(() => {
      source.setAvailability(true, true);
      source.upsertMessage({ finished: false, contentComplete: true, message: { messageId: "mixed", timestamp: 1, role: "assistant", content: [
        { type: "text", text: "before" }, { type: "tool_call", toolCallId: "a", toolName: "read", summary: summary("a", 0) },
        { type: "text", text: "between" }, { type: "tool_call", toolCallId: "b", toolName: "read", summary: summary("b", 0) },
        { type: "text", text: "after" },
      ] } });
      for (let i = 2; i < 200; i++) source.observe({ type: "tool.activity", summary: summary(`t${i}`, i) });
    });
    const baseline = source.published(), pages = events.filter((event): event is ToolInventoryProduced => event.type === "session.tools.produced");
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap(event => event.page.tools)).toHaveLength(200);
    expect(baseline.live.tools).toEqual([]);
    const ordered = [...baseline.live.messages.map(item => ({ order: item.order!, value: item.message.content[0]!.type === "text" ? item.message.content[0]!.text : "" })),
      ...pages.flatMap(event => event.page.tools).slice(0, 2).map(tool => ({ order: tool.order, value: tool.tool.toolCallId }))].sort((a, b) => a.order - b.order);
    expect(ordered.map(item => item.value)).toEqual(["before", "a", "between", "b", "after"]);
    const count = events.length;
    source.observe({ type: "tool.activity", summary: summary("a", 0) });
    expect(events).toHaveLength(count); // Source owns order; same facts do not produce a revision.
    source.reconcile([{ entryId: "result", parentId: null, type: "message", timestamp: new Date(2).toISOString(),
      data: { message: { role: "toolResult", toolCallId: "a", content: [], toolSummary: summary("a", 0) } } }], "result");
    const committed = events.at(-1)!;
    expect(committed.type).toBe("session.patch");
    expect(committed).toMatchObject({ entries: [{ entryId: "result" }], live: { toolInventory: { totalCount: 199 } } });
  });

  it("retains canonical metadata and image references while removing only raw tool fields", () => {
    const image = { type: "image", mimeType: "image/png", byteLength: 100, ref: { path: "D:/image.png" } };
    const entry: RemoteSessionEntry = { entryId: "e", parentId: null, type: "message", timestamp: new Date(1).toISOString(), data: {
      nativeFlag: true, message: { role: "assistant", usage: { tokens: 42 }, stopReason: "toolUse", content: [image,
        { type: "toolCall", id: "a", name: "read", arguments: { path: "D:/image.png", huge: "PRIVATE".repeat(10000) } }] } } };
    const result = projectToolEntry({ agent, order: 0 }, entry);
    expect(result.data).toMatchObject({ nativeFlag: true, message: { usage: { tokens: 42 }, stopReason: "toolUse", content: [image, { type: "tool_call" }] } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(projectToolEntry({ agent, order: 0 }, entry)).toEqual(result);
  });
});
