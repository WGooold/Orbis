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
});
