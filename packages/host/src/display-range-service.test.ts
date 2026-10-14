import { describe, expect, it, vi } from "vitest";

import type { RemoteSessionEntry } from "@pi-remote/protocol";

import { DisplayPageCache } from "./display-page-cache.js";
import { DisplayRangeService, type DisplayRangeRequest } from "./display-range-service.js";

const entry = (entryId: string, parentId: string | null, text: string): RemoteSessionEntry => ({
  entryId, parentId, type: "message", timestamp: "2026-01-01T00:00:00.000Z",
  data: { message: { role: "assistant", content: text } },
});
const branch = (length: number): RemoteSessionEntry[] => Array.from({ length }, (_, index) =>
  entry("e" + index, index === 0 ? null : "e" + (index - 1), "第" + index + "段"));

const request = (over: Partial<DisplayRangeRequest> = {}): DisplayRangeRequest =>
  ({ scopeId: "scope", leafId: "e2", beforeEntryId: null, maxEntries: 30, ...over });

const setup = (over: Partial<{ maxEntriesPerRequest: number; entries: RemoteSessionEntry[] }> = {}) => {
  const entries = over.entries ?? branch(3);
  const provider = vi.fn(async () => ({ sourceEpoch: "epoch-1", sourceRevision: 1, entries, hasOlder: false }));
  const cache = new DisplayPageCache();
  const service = new DisplayRangeService({ provider, cache, ...(over.maxEntriesPerRequest === undefined ? {} : { maxEntriesPerRequest: over.maxEntriesPerRequest }) });
  return { entries, provider, cache, service };
};

describe("DisplayRangeService 编排", () => {
  it("首次读取问 provider，归一后入缓存；第二次直接命中缓存", async () => {
    const { service, provider } = setup();
    const first = await service.read(request());
    expect(first.cached).toBe(false);
    expect(first.entries.map(item => item.entryId)).toEqual(["e0", "e1", "e2"]);
    expect(first.entries[0]?.message?.content[0]).toEqual({ type: "text", text: "第0段" });
    expect(provider).toHaveBeenCalledTimes(1);

    const second = await service.read(request());
    expect(second.cached).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(second.source).toEqual({ sourceEpoch: "epoch-1", sourceRevision: 1 });
  });

  it("同一个窗口的并发请求只问 provider 一次", async () => {
    const { service, provider } = setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.mockImplementationOnce(async () => { await gate; return { sourceEpoch: "epoch-1", sourceRevision: 1, entries: branch(3), hasOlder: false }; });
    const [a, b] = await Promise.all([service.read(request()), service.read(request()), Promise.resolve(undefined).then(async () => { release?.(); return undefined; })]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(a.entries).toHaveLength(3);
    expect(b.cached).toBe(false);
    expect(service.stats().inflight).toBe(0);
  });

  it("请求上限会收敛到配置值，provider 给多了会标记截断", async () => {
    const { service, provider } = setup({ maxEntriesPerRequest: 2, entries: branch(5) });
    const result = await service.read(request({ maxEntries: 999 }));
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ maxEntries: 2 }));
    expect(result.truncated).toBe(true);
    expect(service.stats().cache.pages).toBe(1);
  });
});

describe("DisplayRangeService 来源与失败语义", () => {
  it("observeSource 看到换代次时作废该会话的显示页", async () => {
    const { service, cache } = setup();
    await service.read(request());
    expect(cache.stats().pages).toBe(1);
    service.observeSource("scope", { sourceEpoch: "epoch-1", sourceRevision: 5 });
    expect(cache.stats().pages).toBe(1);
    service.observeSource("scope", { sourceEpoch: "epoch-2", sourceRevision: 0 });
    expect(cache.stats().pages).toBe(0);
  });

  it("provider 换代次时旧页立即作废，新页用新代次存", async () => {
    const { service, cache, provider } = setup();
    await service.read(request());
    provider.mockImplementationOnce(async () => ({ sourceEpoch: "epoch-2", sourceRevision: 0, entries: branch(2), hasOlder: true }));
    const result = await service.read(request({ beforeEntryId: "e0" }));
    expect(result.source?.sourceEpoch).toBe("epoch-2");
    expect(cache.get(request(), { sourceEpoch: "epoch-1" })).toBeUndefined();
    expect(cache.get(request({ beforeEntryId: "e0" }), { sourceEpoch: "epoch-2" })).toBeDefined();
  });

  it("provider 失败返回 unavailable，不写缓存也不冒充空历史", async () => {
    const { service, cache, provider } = setup();
    provider.mockRejectedValueOnce(new Error("adapter down"));
    const result = await service.read(request());
    expect(result).toMatchObject({ status: "unavailable", cached: false, hasOlder: false });
    expect(result.entries).toEqual([]);
    expect(cache.stats().pages).toBe(0);
    // 下一次仍然会去问 provider，而不是记住失败。
    const retry = await service.read(request());
    expect(retry.status).toBe("complete");
    expect(retry.entries).toHaveLength(3);
  });

  it("来源没给代次时仍返回投影，但明确不缓存", async () => {
    const { service, cache, provider } = setup();
    provider.mockImplementationOnce(async () => ({ sourceEpoch: "  ", sourceRevision: 0, entries: branch(3), hasOlder: false }));
    const result = await service.read(request());
    expect(result.source).toBeNull();
    expect(result.cached).toBe(false);
    expect(result.entries).toHaveLength(3);
    expect(cache.stats().pages).toBe(0);
  });

  it("缺父的路径如实报告，并带上覆盖范围", async () => {
    const { service } = setup({ entries: [entry("x", "missing", "孤儿")] });
    const result = await service.read(request({ leafId: "x" }));
    expect(result.status).toBe("missing_parent");
    expect(result.coverage).toMatchObject({ leafId: "x", reachedStart: true });
  });

  it("forget 清掉来源与页，别的会话不受影响", async () => {
    const { service, cache } = setup();
    await service.read(request({ scopeId: "a" }));
    await service.read(request({ scopeId: "b" }));
    expect(service.forget("a")).toBe(1);
    expect(cache.stats().pages).toBe(1);
    expect(service.stats().sources).toBe(1);
  });
});
