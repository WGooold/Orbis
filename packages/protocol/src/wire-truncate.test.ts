import { describe, expect, it } from "vitest";
import {
  WIRE_FIELD_LIMIT_BYTES, truncateWireEntry, truncateWireText, truncateWireValue, WireTruncator,
} from "./index.js";

describe("wire truncation (ADR-0038)", () => {
  it("is deterministic and idempotent, and never splits a UTF-8 character", () => {
    const source = "中文🙂".repeat(20_000);
    const once = truncateWireText(source);
    const twice = truncateWireText(once);
    expect(twice).toBe(once);
    expect(once).toBe(truncateWireText(source));
    expect(Buffer.byteLength(once)).toBeLessThanOrEqual(WIRE_FIELD_LIMIT_BYTES);
    expect(once).toContain("已截断");
    // 截断点落在字符边界：解码后不应出现替换字符。
    expect(once).not.toContain("\ufffd");
  });

  it("keeps structure and identity fields, truncating only payload strings", () => {
    const entry = {
      entryId: "e1", parentId: null, type: "tool", timestamp: "2026-10-22T00:00:00.000Z",
      data: { message: { toolCallId: "c1", arguments: { path: "/a", content: "x".repeat(200_000) } } },
    };
    const projected = truncateWireEntry(entry);
    expect(projected.entryId).toBe("e1");
    expect(projected.timestamp).toBe(entry.timestamp);
    const message = (projected.data as { message: { toolCallId: string; arguments: { path: string; content: string } } }).message;
    expect(message.toolCallId).toBe("c1");
    // `arguments` 逐字段截断，不能被整段替换成字符串（工具卡片还要渲染）。
    expect(message.arguments.path).toBe("/a");
    expect(message.arguments.content).toContain("已截断");
    // 原文不受影响。
    expect(entry.data.message.arguments.content.length).toBe(200_000);
  });

  it("caches by entry identity so repeated prepares cost nothing", () => {
    const truncator = new WireTruncator();
    const entry = { entryId: "e", parentId: null, type: "message", timestamp: "t", data: { text: "y".repeat(100_000) } };
    const first = truncator.entry(entry);
    expect(truncator.entry(entry)).toBe(first);
    expect(truncateWireValue(1)).toBe(1);
  });

  it("marks truncated content blocks with structured fields (ADR-0038 §5)", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "z".repeat(100_000) }] };
    const projected = truncateWireValue(message) as { content: Array<{ text: string; truncated?: boolean; originalBytes?: number }> };
    const block = projected.content[0]!;
    expect(block.truncated).toBe(true);
    expect(block.originalBytes).toBe(100_000);
    expect(block.text).toContain("已截断");
    expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(WIRE_FIELD_LIMIT_BYTES);
    // 未超限的内容块保持原对象，不额外加字段。
    const small = { type: "text", text: "hi" };
    expect(truncateWireValue(small)).toBe(small);
  });
});
