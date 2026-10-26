import { describe, expect, it } from "vitest";
import { TOOL_SUMMARY_MAX_BYTES, toolJsonBytes, type AgentKind } from "@orbis/protocol";
import { codexToolContents, codexToolContentText, codexToolSummary, type CodexToolProjectionContext } from "./codex-tool-projection.js";

const context = (agentKind: AgentKind = "codex"): CodexToolProjectionContext => ({
  agent: { hostId: "host", agentKind, sessionId: "session" }, order: 4, phase: "finished", turnId: "turn",
});

describe("Codex producer tool projection (ADR-0045)", () => {
  it.each(["codex", "codexDesktop"] as const)("separates 10 MiB aggregatedOutput from the %s summary", kind => {
    const output = "x".repeat(10 * 1024 * 1024);
    const item = { id: "tool", type: "commandExecution", command: "npm test", cwd: "C:/repo", status: "completed", exitCode: 0, durationMs: 32, aggregatedOutput: output };
    const summary = codexToolSummary(context(kind), item)!;
    expect(summary).toMatchObject({ inputSummary: { text: "npm test" }, phase: "finished", isError: false, exitCode: 0, durationMs: 32 });
    expect(toolJsonBytes(summary)).toBeLessThan(1024);
    expect(summary.contents.map(part => part.part)).toEqual(["arguments", "output", "result"]);
    expect([...codexToolContents(item)].find(part => part.part === "output")?.value).toBe(output);
    expect(codexToolContentText([...codexToolContents(item)].find(part => part.part === "output")!)).toBe(output);
    expect(JSON.stringify(summary)).not.toContain(output.slice(0, 100));
    expect(codexToolSummary(context(kind), item)).toEqual(summary);
  });

  it("keeps large MCP arguments and structured results out of shared summaries", () => {
    const item = { id: "mcp", type: "mcpToolCall", server: "local", tool: "search", status: "completed",
      arguments: { query: "sensitive-input".repeat(100_000) },
      result: { content: [{ type: "text", text: "sensitive-output".repeat(100_000) }], structuredContent: { count: 12 }, isError: true } };
    const summary = codexToolSummary(context(), item)!;
    expect(summary.isError).toBe(true); expect(summary.toolName).toBe("search");
    expect(summary.inputSummary).toBeUndefined(); expect(summary.resultSummary).toBeUndefined();
    expect(JSON.stringify(summary)).not.toMatch(/sensitive-input|sensitive-output|structuredContent/);
    expect([...codexToolContents(item)].find(part => part.part === "result")?.value).toEqual(item.result);
    expect(toolJsonBytes(summary)).toBeLessThan(1024);
  });

  it("only reports explicit status facts and never infers success from output text", () => {
    const item = { id: "cmd", type: "commandExecution", command: "run", aggregatedOutput: "SUCCESS" };
    expect(codexToolSummary({ ...context(), phase: "running" }, item)?.isError).toBeUndefined();
    expect(codexToolSummary(context(), item)?.isError).toBeUndefined();
    expect(codexToolSummary({ ...context(), phase: "cancelled" }, { ...item, status: "cancelled" })?.isError).toBeUndefined();
    expect(codexToolSummary(context(), { ...item, exitCode: 2 })?.isError).toBe(true);
    expect(codexToolSummary(context(), { ...item, status: "completed" })?.isError).toBe(false);
    expect(codexToolSummary(context(), { ...item, status: "failed", error: { message: "verified error", arbitrary: "private" } })?.errorSummary?.text).toBe("verified error");
    expect(codexToolSummary(context(), { ...item, status: "failed", error: { arbitrary: "private" } })?.errorSummary).toBeUndefined();
  });

  it("uses known operation fields and UTF-8 omission without slicing structured arguments", () => {
    const command = "界😀".repeat(20_000);
    const summary = codexToolSummary(context(), { id: "tool", type: "commandExecution", command, error: "错".repeat(2000) })!;
    expect(toolJsonBytes(summary)).toBeLessThanOrEqual(TOOL_SUMMARY_MAX_BYTES);
    expect(summary.inputSummary).toMatchObject({ omitted: true, originalBytes: Buffer.byteLength(command) });
    expect(summary.inputSummary?.text).not.toContain("�");
    const changes = [{ path: "a", diff: "private diff".repeat(100_000) }, { path: "b", diff: "patch" }];
    const files = codexToolSummary(context(), { id: "files", type: "fileChange", changes, status: "completed" })!;
    expect(files.inputSummary?.text).toBe("2 files"); expect(JSON.stringify(files)).not.toContain("private diff");
  });

  it("does not claim a reader exists until explicitly established and handles missing native sections", () => {
    const item = { id: "mcp", type: "mcpToolCall", tool: "search" };
    const pending = codexToolSummary({ ...context(), phase: "started" }, item)!;
    expect(pending.contents).toEqual([{ part: "arguments", format: "json", availability: "pending", readCapability: "none" },
      { part: "output", format: "text", availability: "pending", readCapability: "none" }]);
    const readable = codexToolSummary({ ...context(), contentSources: { arguments: { availability: "readable", readCapability: "whole-source" } } }, item)!;
    expect(readable.contents[0]).toMatchObject({ availability: "readable", readCapability: "whole-source" });
    expect(readable.contents.some(part => part.part === "result")).toBe(false);
    expect(codexToolSummary(context(), { id: "text", type: "agentMessage", text: "answer" })).toBeUndefined();
    expect(() => codexToolSummary(context(), { type: "commandExecution" })).toThrow("tool_identity_unrepresentable");
    expect(() => codexToolSummary(context("pi"), { id: "cmd", type: "commandExecution" })).toThrow("tool_agent_mismatch");
  });

  it("serializes JSON deterministically and removes media bytes without modifying native values", () => {
    const image = { type: "image", mimeType: "image/png", data: "YWJj" };
    const first = { part: "result" as const, format: "json" as const, value: { z: 1, a: [image], structuredContent: { z: 2, a: 1 } } };
    const second = { ...first, value: { structuredContent: { a: 1, z: 2 }, a: [image], z: 1 } };
    const serialized = codexToolContentText(first);
    expect(serialized).toBe(codexToolContentText(second)); expect(serialized).not.toContain("YWJj");
    expect(JSON.parse(serialized).a).toEqual([{ byteLength: 3, mimeType: "image/png", type: "image" }]);
    expect(image.data).toBe("YWJj");
    const native = { id: "mcp", type: "mcpToolCall", structuredContent: { answer: 42 }, content: [{ type: "text", text: "ok" }], isError: false };
    expect([...codexToolContents(native)].find(part => part.part === "result")?.value).toEqual({ structuredContent: native.structuredContent, content: native.content, isError: false });
  });

  it("fails unrepresentable detail content instead of reporting truncation as complete JSON", () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => codexToolContentText({ part: "result", format: "json", value: circular })).toThrow("invalid_codex_tool_content");
    let deep: unknown = "content";
    for (let i = 0; i < 65; i++) deep = { child: deep };
    expect(() => codexToolContentText({ part: "result", format: "json", value: deep })).toThrow("invalid_codex_tool_content");
    expect(() => codexToolContentText({ part: "result", format: "json", value: undefined })).toThrow("invalid_codex_tool_content");
  });
});
