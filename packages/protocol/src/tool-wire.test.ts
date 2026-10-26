import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, RuntimeClientMessageSchema, RuntimeWireEventSchema, RelayToDeviceMessageSchema,
  createToolSummary, projectToolMessage, type ChatMessage, type RuntimeEvent } from "./index.js";
const agent = { hostId: "h", agentKind: "pi" as const, sessionId: "s" };
const summary = createToolSummary({ tool: { agent, toolCallId: "t" }, toolName: "read", order: 0, phase: "finished", contents: [] });
describe("tool summary wire cutover", () => {
  it("rejects raw lifecycle, mixed live tools and unprojected canonical/history results", () => {
    const raw: ChatMessage = { messageId: "m", role: "assistant", timestamp: 1,
      content: [{ type: "tool_call", toolCallId: "t", toolName: "read", arguments: { secret: "raw" } }] };
    const events: RuntimeEvent[] = [{ type: "tool.started", toolCallId: "t", toolName: "read", arguments: {} },
      { type: "message.started", message: raw }, { type: "message.finished", message: { ...raw, role: "tool", toolCallId: "t" } },
      { type: "session.snapshot", sessionId: "s", syncId: "q", cursor: { leafId: "m" }, mode: "replace",
        entries: [{ entryId: "m", parentId: null, type: "message", timestamp: "1", data: { message: raw } }] }];
    for (const event of events) {
      expect(RuntimeWireEventSchema.safeParse(event).success).toBe(false);
      expect(RuntimeClientMessageSchema.safeParse({ type: "runtime.event", protocolVersion: PROTOCOL_VERSION, runtimeId: "r", sequence: 1, event }).success).toBe(false);
    }
    expect(RuntimeWireEventSchema.safeParse({ ...events[3], live: { complete: true, turn: null, messages: [],
      tools: [{ toolCallId: "t", toolName: "read", state: "started", summary }] } }).success).toBe(false);
  });
  it("accepts summary-only calls and empty result bodies, preserving text and media references", () => {
    const message: ChatMessage = { messageId: "m", role: "assistant", timestamp: 1, content: [
      { type: "text", text: "answer" }, { type: "tool_call", toolCallId: "t", toolName: "read", arguments: { path: "x" } }] };
    const projected = projectToolMessage({ agent, order: 0 }, message);
    expect(RuntimeWireEventSchema.safeParse({ type: "message.started", message: projected }).success).toBe(true);
    expect(projected.content[0]).toEqual(message.content[0]);
    expect(JSON.stringify(projected)).not.toContain('"arguments":');
    expect(RuntimeWireEventSchema.safeParse({ type: "message.finished", message: { ...message, role: "tool", content: [], toolCallId: "t", toolSummary: summary } }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({ type: "runtime.event", protocolVersion: PROTOCOL_VERSION - 1, runtimeId: "r", sequence: 1,
      event: { type: "message.started", message: projected } }).success).toBe(false);
  });
});
