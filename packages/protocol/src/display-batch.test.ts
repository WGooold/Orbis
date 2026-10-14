import { describe, expect, it } from "vitest";

import { RecoverableSessionSource } from "./session-source.js";
import type { RemoteSessionEntry, RuntimeEvent } from "./index.js";

const message = (entryId: string, parentId: string | null, role: string, content: unknown): RemoteSessionEntry => ({
  entryId, parentId, type: "message", timestamp: "2026-01-01T00:00:00.000Z",
  data: { message: { role, content } },
});

const collect = (): { source: RecoverableSessionSource; published: RuntimeEvent[] } => {
  const published: RuntimeEvent[] = [];
  const source = new RecoverableSessionSource("s1", event => published.push(event));
  source.setAvailability(true, true);
  return { source, published };
};

const lastPatch = (published: readonly RuntimeEvent[]) =>
  published.filter(event => event.type === "session.patch").at(-1);

describe("来源发布 patch 时附上显示批次", () => {
  it("批次只覆盖本次提交的条目，并已由适配层解释成可渲染结果", () => {
    const { source, published } = collect();
    source.reconcile([message("e1", null, "user", "你好")], "e1");
    const patch = lastPatch(published);
    expect(patch?.entries?.map(entry => entry.entryId)).toEqual(["e1"]);
    expect(patch?.display?.entries.map(item => item.displayId)).toEqual(["e1"]);
    expect(patch?.display?.entries[0]?.message?.content[0]).toEqual({ type: "text", text: "你好" });
    expect(patch?.display?.projectionVersion).toBeGreaterThan(0);
  });

  it("增量提交只带新条目的显示结果，不重发整段历史", () => {
    const { source, published } = collect();
    source.reconcile([message("e1", null, "user", "第一句")], "e1");
    source.reconcile([message("e1", null, "user", "第一句"), message("e2", "e1", "assistant", "第二句")], "e2");
    const patch = lastPatch(published);
    expect(patch?.display?.entries.map(item => item.displayId)).toEqual(["e2"]);
  });

  it("路径不完整时不附批次：半截的完整样子会覆盖客户端已有内容", () => {
    const { source, published } = collect();
    source.reconcile([message("e1", "ghost", "user", "断了")], "e1");
    const patch = lastPatch(published);
    expect(patch?.entries?.map(entry => entry.entryId)).toEqual(["e1"]);
    expect(patch?.display).toBeUndefined();
  });

  it("声明已验证的原生边界后，有界读取的分支也能发显示结果", () => {
    const { source, published } = collect();
    source.setHistoryBoundary("native-tail");
    source.reconcile([message("e1", "native-tail", "user", "只有尾部")], "e1");
    const patch = lastPatch(published);
    expect(patch?.display?.entries.map(item => item.displayId)).toEqual(["e1"]);
    expect(patch?.display?.windowStart).toBeNull();
  });

  it("压缩落地时用 windowStart 作废旧显示内容，并把摘要标成窗口顶部", () => {
    const { source, published } = collect();
    const first = message("e1", null, "user", "旧问题");
    const kept = message("e2", "e1", "user", "保留的问题");
    source.reconcile([first, kept], "e2");
    expect(lastPatch(published)?.display?.windowStart).toBeNull();
    const compaction: RemoteSessionEntry = {
      entryId: "c1", parentId: "e2", type: "compaction", timestamp: "2026-01-01T00:00:00.000Z",
      data: { summary: "摘要", firstKeptEntryId: "e2" },
    };
    source.reconcile([first, kept, compaction], "c1");
    const patch = lastPatch(published);
    expect(patch?.display?.entries.map(item => item.displayId)).toEqual(["c1"]);
    expect(patch?.display?.entries[0]?.anchor).toBe("head");
    expect(patch?.display?.windowStart).toBe("e2");
  });
});
