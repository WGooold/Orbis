import { describe, expect, it } from "vitest";

import type { RemoteSessionEntry } from "@orbis/protocol";

import { DisplayEntrySchema, SessionPatchSchema } from "@orbis/protocol";

import {
  DISPLAY_PROJECTION_VERSION, buildDisplayPath, displayBatchFromProjection, projectDisplayEntries, toDisplayBatch,
} from "./display-entries.js";

const at = "2026-01-01T00:00:00.000Z";
const entry = (
  entryId: string, parentId: string | null, type: string,
  data: Record<string, unknown> = {}, timestamp = at,
): RemoteSessionEntry => ({ entryId, parentId, type, timestamp, data });
const message = (
  entryId: string, parentId: string | null, payload: Record<string, unknown>, data: Record<string, unknown> = {},
): RemoteSessionEntry => entry(entryId, parentId, "message", { message: payload, ...data });
const artifactFixture = {
  artifactId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", fileName: "report.pdf", mimeType: "application/pdf",
  size: 1_024, sha256: "a".repeat(64),
};

describe("显示投影：路径与压缩", () => {
  it("按时间顺序返回从根到叶子的可见条目", () => {
    const entries = [entry("a", null, "custom"), message("b", "a", { role: "user", content: "你好" })];
    const projection = projectDisplayEntries(entries, "b");
    expect(buildDisplayPath(entries, "b").path.map(item => item.entryId)).toEqual(["a", "b"]);
    expect(projection.status).toBe("complete");
    expect(projection.headEntryId).toBe("b");
    expect(projection.projectionVersion).toBe(DISPLAY_PROJECTION_VERSION);
  });

  it("压缩点只保留它声明保留的那一段", () => {
    const entries = [
      message("u1", null, { role: "user", content: "旧问题" }),
      message("a1", "u1", { role: "assistant", content: "旧回答" }),
      message("u2", "a1", { role: "user", content: "保留的问题" }),
      entry("c1", "u2", "compaction", { summary: "前面聊了旧话题", firstKeptEntryId: "u2" }),
      message("a2", "c1", { role: "assistant", content: "压缩后的回答" }),
    ];
    const projection = projectDisplayEntries(entries, "a2");
    expect(projection.compactionEntryId).toBe("c1");
    expect(projection.entries.map(item => item.entryId)).toEqual(["c1", "u2", "a2"]);
    expect(projection.entries[0]?.kind).toBe("summary");
    expect(projection.entries[0]?.message?.content[0]).toEqual({ type: "text", text: "压缩摘要：前面聊了旧话题" });
    // 显示窗口与渲染锚点是投影说出来的事实：被裁掉的 u1/a1 之外，窗口从保留段开始，
    // 摘要渲染在窗口顶部，而不是它在路径里的位置（它在 u2 之后）。
    expect(projection.windowStart).toBe("u2");
    expect(projection.entries[0]?.anchor).toBe("head");
    expect(projection.entries[1]?.anchor).toBeUndefined();
    expect(toDisplayBatch(projection)?.windowStart).toBe("u2");
  });

  it("没有保留段时窗口从压缩点本身开始，没有压缩时整条路径都是窗口", () => {
    const trimmed = [
      message("u1", null, { role: "user", content: "旧问题" }),
      entry("c1", "u1", "compaction", { summary: "摘要", firstKeptEntryId: "missing" }),
      message("a1", "c1", { role: "assistant", content: "之后" }),
    ];
    expect(projectDisplayEntries(trimmed, "a1").windowStart).toBe("c1");
    const plain = [message("u1", null, { role: "user", content: "问题" })];
    expect(projectDisplayEntries(plain, "u1").windowStart).toBeNull();
  });

  it("firstKeptEntryId 指不到有效位置时只保留压缩点及之后", () => {
    const entries = [
      message("u1", null, { role: "user", content: "旧问题" }),
      entry("c1", "u1", "compaction", { summary: "摘要", firstKeptEntryId: "missing" }),
      message("a1", "c1", { role: "assistant", content: "之后" }),
    ];
    expect(projectDisplayEntries(entries, "a1").entries.map(item => item.entryId)).toEqual(["c1", "a1"]);
  });
});

describe("显示投影：消息语义", () => {
  it("角色映射与正文块和客户端一致", () => {
    const entries = [
      message("m1", null, { role: "user", content: "问题" }),
      message("m2", "m1", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想一想" },
          { type: "text", text: "答案" },
          { type: "tool_call", id: "t1", name: "read", arguments: { path: "a" } },
        ],
        timestamp: 1_700_000_000_000,
      }),
      message("m3", "m2", { role: "toolResult", content: "结果", toolCallId: "t1", toolName: "read" }),
    ];
    const projection = projectDisplayEntries(entries, "m3");
    expect(projection.entries.map(item => item.message?.role)).toEqual(["user", "assistant", "tool"]);
    expect(projection.entries[1]?.message?.content).toEqual([
      { type: "thinking", text: "想一想" },
      { type: "text", text: "答案" },
      { type: "tool_call", toolCallId: "t1", toolName: "read", arguments: { path: "a" } },
    ]);
    expect(projection.entries[1]?.message?.timestamp).toBe(1_700_000_000_000);
    expect(projection.entries[2]?.message?.toolCallId).toBe("t1");
  });

  it("shell 执行合成 system 行，未知角色与隐藏的自定义消息不猜内容", () => {
    const entries = [
      message("s1", null, { role: "bashExecution", command: "ls", output: "a.txt" }),
      message("x1", "s1", { role: "something-new", content: "?" }),
      message("c1", "x1", { role: "custom", display: false, content: "隐藏" }),
    ];
    const projection = projectDisplayEntries(entries, "c1");
    expect(projection.entries[0]?.message).toMatchObject({ role: "system" });
    expect(projection.entries[0]?.message?.content).toEqual([{ type: "text", text: "$ ls\na.txt" }]);
    // 认识但不可显示 / 完全没见过，都保留身份与原因，而不是静默丢掉。
    expect(projection.entries[1]).toMatchObject({ kind: "undisplayable", nativeType: "message", reason: "not_rendered" });
    expect(projection.entries[2]).toMatchObject({ kind: "undisplayable", reason: "not_rendered" });
  });

  it("用户消息的手机发送身份随显示行带出，其它角色和非法值不带（ADR-0049）", () => {
    const entries = [
      message("u1", null, { role: "user", content: "你好", clientMessageId: "app-1" }),
      message("a1", "u1", { role: "assistant", content: "收到", clientMessageId: "app-2" }),
      message("u2", "a1", { role: "user", content: "再问", clientMessageId: "" }),
    ];
    const projection = projectDisplayEntries(entries, "u2");
    expect(projection.entries.map(row => row.message?.clientMessageId)).toEqual(["app-1", undefined, undefined]);
    expect(projection.entries[0]?.message?.messageId).toBe("u1");
    expect(DisplayEntrySchema.safeParse(projection.entries[0]).success).toBe(true);
  });

  it("失败文本优先用 remoteFailure，缺失时回退 provider 文案且不重复追加", () => {
    const entries = [
      message("f1", null, { role: "assistant", stopReason: "error", errorMessage: "上游 500" }),
      message("f2", "f1", { role: "assistant", stopReason: "aborted", content: "已取消" }, { remoteFailure: "用户中断" }),
      message("f3", "f2", { role: "assistant", content: [{ type: "text", text: "同样的失败" }], errorMessage: "同样的失败" }),
    ];
    const projection = projectDisplayEntries(entries, "f3");
    expect(projection.entries[0]?.message?.isError).toBe(true);
    expect(projection.entries[0]?.message?.content).toEqual([{ type: "text", text: "上游 500" }]);
    expect(projection.entries[1]?.message?.content).toEqual([
      { type: "text", text: "已取消" }, { type: "text", text: "用户中断" },
    ]);
    // 同一段文字已经在正文里就不再追加第二遍。
    expect(projection.entries[2]?.message?.content).toEqual([{ type: "text", text: "同样的失败" }]);
  });

  it("自定义消息按声明显示，并带上产物引用", () => {
    const entries = [
      entry("k1", null, "custom_message", { display: true, content: "生成完成", details: { remoteArtifact: artifactFixture } }),
      entry("k2", "k1", "custom_message", { display: false, content: "内部" }),
      entry("k3", "k2", "message", {}),
    ];
    const projection = projectDisplayEntries(entries, "k3");
    expect(projection.entries[0]?.message?.role).toBe("custom");
    expect(projection.entries[0]?.message?.content).toHaveLength(2);
    expect(projection.entries[0]?.message?.content[1]).toMatchObject({ type: "artifact", artifact: { fileName: "report.pdf" } });
    expect(projection.entries[1]).toMatchObject({ kind: "undisplayable", reason: "not_rendered" });
    expect(projection.entries[2]).toMatchObject({ kind: "undisplayable", reason: "missing_content" });
  });
});

describe("显示投影：不认识的原生条目", () => {
  it("已知但不渲染的类型标 not_rendered，未知类型标 unknown_native_type", () => {
    const entries = [
      entry("n1", null, "label", { label: "x" }),
      entry("n2", "n1", "thinking_level_change", { level: "high" }),
      entry("n3", "n2", "brand_new_event", { payload: 1 }),
    ];
    const projection = projectDisplayEntries(entries, "n3");
    expect(projection.entries.map(item => item.reason)).toEqual(["not_rendered", "not_rendered", "unknown_native_type"]);
    // 身份与原生类型仍然可查，诊断不会因为「不显示」而丢信息。
    expect(projection.entries[2]).toMatchObject({ entryId: "n3", nativeType: "brand_new_event", message: null });
  });

  it("分支摘要为空时不渲染，非空时按摘要渲染", () => {
    const entries = [
      entry("b1", null, "branch_summary", { summary: "" }),
      entry("b2", "b1", "branch_summary", { summary: "另一条分支" }),
    ];
    const projection = projectDisplayEntries(entries, "b2");
    expect(projection.entries[0]).toMatchObject({ kind: "undisplayable", reason: "not_rendered" });
    expect(projection.entries[1]?.message?.content[0]).toEqual({ type: "text", text: "分支摘要：另一条分支" });
  });
});

describe("显示批次：随 snapshot/patch 一起发给客户端", () => {
  it("patch 可以携带与条目对应的显示批次，且原因取值受限", () => {
    const entries = [message("m1", null, { role: "user", content: "问题" })];
    const batch = toDisplayBatch(projectDisplayEntries(entries, "m1"));
    expect(batch?.projectionVersion).toBe(DISPLAY_PROJECTION_VERSION);
    const patch = SessionPatchSchema.parse({
      type: "session.patch", sessionId: "s", source: { epoch: "e1", seq: 1, ready: true }, baseSeq: 0, seq: 1,
      checkpointId: "c1", head: { leafId: "m1" }, headCompleteness: "complete",
      live: { complete: true, turn: null, messages: [], tools: [] },
      entries, display: batch,
    });
    expect(patch.display?.entries[0]).toMatchObject({ displayId: "m1", kind: "message" });
    expect(() => DisplayEntrySchema.parse({
      displayId: "x", entryId: "x", nativeType: "message", kind: "undisplayable", message: null, reason: "whatever",
    })).toThrow();
  });

  it("分页：一次投影多页发出，每页只拿自己那几条，窗口与投影版本一致", () => {
    const entries = [
      message("u1", null, { role: "user", content: "问题" }),
      message("a1", "u1", { role: "assistant", content: "回答" }),
      message("u2", "a1", { role: "user", content: "继续" }),
    ];
    const projection = projectDisplayEntries(entries, "u2");
    expect(displayBatchFromProjection(projection, [entries[0]!])?.entries.map(item => item.displayId)).toEqual(["u1"]);
    expect(displayBatchFromProjection(projection, [entries[1]!, entries[2]!])?.entries.map(item => item.displayId))
      .toEqual(["a1", "u2"]);
    expect(displayBatchFromProjection(projection, [])).toBeUndefined();
  });

  it("路径不完整时不产生显示批次：半截的「完整样子」比不给更糟", () => {
    const entries = [entry("a", null, "custom"), entry("b", "a", "custom")];
    expect(toDisplayBatch(projectDisplayEntries(entries, "nope"))).toBeUndefined();
    expect(toDisplayBatch(projectDisplayEntries(entries, "b"))?.entries).toHaveLength(2);
  });
});

describe("显示投影：路径不完整时如实报告", () => {
  it("叶子不在这一页、缺父、成环、空 head 各有明确状态", () => {
    const entries = [entry("a", "missing", "custom"), entry("b", "a", "custom")];
    expect(projectDisplayEntries(entries, "nope").status).toBe("leaf_not_found");
    expect(projectDisplayEntries(entries, "b").status).toBe("missing_parent");
    expect(projectDisplayEntries([entry("x", "y", "custom"), entry("y", "x", "custom")], "x").status).toBe("cycle_detected");
    const empty = projectDisplayEntries(entries, null);
    expect(empty).toMatchObject({ status: "complete", headEntryId: null, compactionEntryId: null, windowStart: null });
    expect(empty.entries).toEqual([]);
  });

  it("走到已验证的原生边界不算缺父：有界读取的分支照样能发显示结果", () => {
    const entries = [entry("a", "native-tail", "custom"), entry("b", "a", "custom")];
    expect(projectDisplayEntries(entries, "b").status).toBe("missing_parent");
    const bounded = projectDisplayEntries(entries, "b", { boundaryParentId: "native-tail" });
    expect(bounded.status).toBe("complete");
    expect(bounded.entries.map(item => item.entryId)).toEqual(["a", "b"]);
    // 只在真的走到那条边界时才算完整：叶子不在、或边界对不上，都如实报告。
    expect(projectDisplayEntries(entries, "nope", { boundaryParentId: "native-tail" }).status).toBe("leaf_not_found");
    expect(projectDisplayEntries(entries, "b", { boundaryParentId: "other" }).status).toBe("missing_parent");
    expect(projectDisplayEntries(entries, "b", { boundaryParentId: null }).status).toBe("missing_parent");
  });
});
