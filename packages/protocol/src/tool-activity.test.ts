import { describe, expect, it } from "vitest";
import {
  TOOL_PAGE_MAX_BYTES, TOOL_SUMMARY_MAX_BYTES, ToolContentCancelSchema, ToolContentLocatorSchema,
  ToolContentPageSchema, ToolContentReadRequestSchema, ToolInventoryPageSchema, ToolInventoryPatchSchema,
  ToolReadFailureSchema, ToolSummarySchema, assertToolWireBudget, createToolSummary, toolContentPageMatchesRequest,
  toolInventoryPageMatchesSnapshot, toolJsonBytes, toolSummaryText,
} from "./tool-activity.js";
import type { ToolContentPage, ToolContentReadRequest, ToolInventoryPage, ToolSummary } from "./tool-activity.js";

const agent = { hostId: "host", agentKind: "codex" as const, sessionId: "session" };
const tool = { agent, toolCallId: "call-1" };
const locator = { projectionVersion: 1 as const, tool, part: "output" as const };
const facts = (toolCallId = "call-1") => ({
  tool: { agent, toolCallId }, toolName: "shell", phase: "running", order: 0,
  contents: [{ part: "output", format: "text", availability: "readable", readCapability: "range" }],
} as const);
const summary = (toolCallId = "call-1"): ToolSummary => createToolSummary({ ...facts(toolCallId),
  contents: [...facts(toolCallId).contents] });
const snapshot = { snapshotId: "snapshot", agent, version: { epoch: "tools-epoch", revision: 5 },
  source: { epoch: "chat-epoch", seq: 12 }, totalCount: 2 };
const inventoryPage = (): ToolInventoryPage => ({ type: "session.tools.page", requestId: "request",
  runtimeId: "runtime", snapshot, startIndex: 0, endIndex: 1, tools: [summary()], nextCursor: "next" });
const request = (): ToolContentReadRequest => ({ type: "session.tool.content.read", requestId: "request",
  runtimeId: "runtime", viewerId: "viewer", locator, read: null, offset: 0, maxBytes: 4096 });
const page = (): ToolContentPage => ({ type: "session.tool.content.page", requestId: "request",
  runtimeId: "runtime", locator, read: { readId: "read", contentEpoch: "content", throughOffset: 8 },
  format: "text", representation: "utf8-fragment", fromOffset: 0, throughOffset: 4,
  availableFromOffset: 0, availableThroughOffset: 12, observedThroughOffset: 12,
  contentFinal: false, text: "😀", nextCursor: 4, gaps: [] });

describe("tool summary contracts (ADR-0045)", () => {
  it("generates deterministic bounded UTF-8 summaries without altering identity", () => {
    const facts = { ...summary(), inputSummary: "中😀".repeat(3000), resultSummary: "\u0000\n\\\"".repeat(2000),
      errorSummary: "错误".repeat(3000) };
    const a = createToolSummary(facts);
    expect(a).toEqual(createToolSummary(facts));
    expect(toolJsonBytes(a)).toBeLessThanOrEqual(TOOL_SUMMARY_MAX_BYTES);
    expect(a.tool).toEqual(tool);
    expect(a.inputSummary?.omitted).toBe(true);
    expect(a.inputSummary?.text).not.toContain("�");
    expect(a.inputSummary?.originalBytes).toBe(Buffer.byteLength(facts.inputSummary));
    expect(ToolSummarySchema.safeParse(a).success).toBe(true);
  });

  it("rejects raw fields, ephemeral state, oversized identities and duplicate parts", () => {
    for (const extra of [{ arguments: { secret: 1 } }, { detail: "output" }, { readId: "random" },
      { expiresAt: 1 }, { runtimeId: "runtime" }, { path: "C:/temp/raw" }]) {
      expect(ToolSummarySchema.safeParse({ ...summary(), ...extra }).success).toBe(false);
    }
    expect(() => createToolSummary({ ...facts(), contents: [...facts().contents], toolName: "中".repeat(100) })).toThrow();
    expect(ToolSummarySchema.safeParse({ ...summary(), contents: [summary().contents[0], summary().contents[0]] }).success).toBe(false);
    expect(ToolContentLocatorSchema.safeParse({ ...locator, path: "C:/private" }).success).toBe(false);
    expect(ToolContentLocatorSchema.safeParse({ ...locator, tool: { ...tool, runtimeId: "r" } }).success).toBe(false);
  });

  it("covers all backend kinds, preserves unknown outcome, and marks omission separately", () => {
    for (const agentKind of ["pi", "codex", "codexDesktop", "dsh"] as const) {
      expect(ToolSummarySchema.parse({ ...summary(), tool: { ...tool, agent: { ...agent, agentKind } } }).isError).toBeUndefined();
    }
    expect(toolSummaryText("中😀a", 6)).toEqual({ text: "中", omitted: true, originalBytes: 8 });
    expect(toolSummaryText("abc", 3)).toEqual({ text: "abc", omitted: false, originalBytes: 3 });
    expect(() => toolSummaryText("text", -1)).toThrow();
  });
});

describe("tool inventory pagination", () => {
  it("pins a source-dependent version without declaring an incomplete first page complete", () => {
    expect(ToolInventoryPageSchema.parse(inventoryPage()).nextCursor).toBe("next");
    expect(ToolInventoryPageSchema.safeParse({ ...inventoryPage(), nextCursor: null }).success).toBe(false);
    expect(ToolInventoryPageSchema.safeParse({ ...inventoryPage(), endIndex: 2 }).success).toBe(false);
    expect(ToolInventoryPageSchema.safeParse({ ...inventoryPage(), tools: [summary(), summary()], endIndex: 2, nextCursor: null }).success).toBe(false);
    expect(ToolInventoryPageSchema.safeParse({ ...inventoryPage(), snapshot: { ...snapshot, totalCount: null } }).success).toBe(true);
    expect(ToolInventoryPageSchema.safeParse({ ...inventoryPage(), tools: [], endIndex: 0 }).success).toBe(false);
  });

  it("rejects cross-session summaries and stale versions even when both pages are individually valid", () => {
    expect(ToolInventoryPageSchema.safeParse({ ...inventoryPage(), tools: [{ ...summary(),
      tool: { ...tool, agent: { ...agent, sessionId: "other" } } }] }).success).toBe(false);
    expect(toolInventoryPageMatchesSnapshot(snapshot, inventoryPage())).toBe(true);
    for (const changed of [{ ...snapshot, snapshotId: "other" }, { ...snapshot, source: { ...snapshot.source, seq: 13 } },
      { ...snapshot, version: { ...snapshot.version, revision: 6 } }]) {
      expect(toolInventoryPageMatchesSnapshot(changed, inventoryPage())).toBe(false);
    }
  });

  it("bounds the full escaped inventory JSON and requires contiguous unambiguous mutations", () => {
    const patch = { type: "session.tools.patch", runtimeId: "runtime", agent,
      version: { epoch: "tools-epoch", revision: 6 }, baseRevision: 5, source: snapshot.source,
      upserts: [summary()], removes: ["older-call"] };
    expect(ToolInventoryPatchSchema.safeParse(patch).success).toBe(true);
    expect(ToolInventoryPatchSchema.safeParse({ ...patch, baseRevision: 4 }).success).toBe(false);
    expect(ToolInventoryPatchSchema.safeParse({ ...patch, removes: ["call-1"] }).success).toBe(false);
    const tools = Array.from({ length: 100 }, (_, i) => createToolSummary({ ...facts(String(i)), contents: [...facts().contents],
      inputSummary: "\n".repeat(800), resultSummary: "\n".repeat(800) }));
    expect(ToolInventoryPageSchema.safeParse({ ...inventoryPage(), tools, endIndex: 100,
      snapshot: { ...snapshot, totalCount: 100 }, nextCursor: null }).success).toBe(false);
  });
});

describe("tool content range contract", () => {
  it("uses UTF-8 coordinates and keeps a pinned throughOffset while the producer appends", () => {
    expect(ToolContentReadRequestSchema.safeParse(request()).success).toBe(true);
    expect(ToolContentPageSchema.safeParse(page()).success).toBe(true);
    expect(toolContentPageMatchesRequest(request(), page())).toBe(true);
    expect(ToolContentPageSchema.safeParse({ ...page(), throughOffset: 2, nextCursor: 2 }).success).toBe(false);
    expect(ToolContentPageSchema.safeParse({ ...page(), availableThroughOffset: 100, observedThroughOffset: 100 }).success).toBe(true);
    const continuation = { ...request(), offset: 4, read: page().read };
    const tail = { ...page(), text: "tail", fromOffset: 4, throughOffset: 8, nextCursor: null };
    expect(ToolContentPageSchema.safeParse(tail).success).toBe(true);
    expect(toolContentPageMatchesRequest(continuation, tail)).toBe(true);
    expect(tail.contentFinal).toBe(false);
  });

  it("rejects malformed cursors, gaps and excess JSON escaping", () => {
    expect(ToolContentPageSchema.safeParse({ ...page(), nextCursor: null }).success).toBe(false);
    expect(ToolContentPageSchema.safeParse({ ...page(), gaps: [{ fromOffset: 1, throughOffset: 3, reason: "quota" }] }).success).toBe(false);
    expect(ToolContentPageSchema.safeParse({ ...page(), availableFromOffset: 4 }).success).toBe(false);
    expect(ToolContentPageSchema.safeParse({ ...page(), observedThroughOffset: 16 }).success).toBe(false);
    const huge = "\u0000".repeat(12_000);
    expect(Buffer.byteLength(huge)).toBeLessThan(TOOL_PAGE_MAX_BYTES);
    expect(ToolContentPageSchema.safeParse({ ...page(), text: huge, throughOffset: huge.length, nextCursor: null,
      read: { ...page().read, throughOffset: huge.length }, availableThroughOffset: huge.length,
      observedThroughOffset: huge.length }).success).toBe(false);
    expect(() => assertToolWireBudget({ page: page(), padding: "x".repeat(TOOL_PAGE_MAX_BYTES) })).toThrow("tool_response_too_large");
  });

  it("rejects correlation/version mismatches and never declares JSON fragments parseable", () => {
    const pinned = { ...request(), read: page().read };
    for (const changed of [{ ...page(), requestId: "other" }, { ...page(), runtimeId: "other" },
      { ...page(), read: { ...page().read, contentEpoch: "replacement" } },
      { ...page(), read: { ...page().read, throughOffset: 12 } },
      { ...page(), locator: { ...locator, part: "arguments" as const } }]) {
      expect(toolContentPageMatchesRequest(pinned, changed)).toBe(false);
    }
    expect(ToolContentPageSchema.parse({ ...page(), format: "json" }).representation).toBe("utf8-fragment");
    expect(ToolContentPageSchema.safeParse({ ...page(), representation: "complete-json" }).success).toBe(false);
    expect(ToolContentReadRequestSchema.safeParse({ ...request(), read: { ...page().read, throughOffset: 0 }, offset: 4 }).success).toBe(false);
    expect(ToolContentCancelSchema.safeParse({ type: "session.tool.content.cancel", requestId: "r",
      runtimeId: "runtime", viewerId: "viewer", readId: "read" }).success).toBe(true);
  });

  it("returns explicit failure rather than an empty successful page, with retry hints only for busy", () => {
    const failure = { type: "session.tool.read.failed", requestId: "r", runtimeId: "runtime", gaps: [] };
    expect(ToolReadFailureSchema.safeParse({ ...failure, reason: "content_expired" }).success).toBe(true);
    expect(ToolReadFailureSchema.safeParse({ ...failure, reason: "busy" }).success).toBe(false);
    expect(ToolReadFailureSchema.safeParse({ ...failure, reason: "busy", retryAfterMs: 100 }).success).toBe(true);
    expect(ToolReadFailureSchema.safeParse({ ...failure, reason: "content_unavailable", retryAfterMs: 100 }).success).toBe(false);
  });
});
