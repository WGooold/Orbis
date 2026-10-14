import { describe, expect, it } from "vitest";

import { DisplayPageCache, type DisplayPageRequest } from "./display-page-cache.js";
import { DISPLAY_PROJECTION_VERSION, projectDisplayEntries } from "./display-entries.js";
import type { RemoteSessionEntry } from "@pi-remote/protocol";

const entry = (entryId: string, parentId: string | null): RemoteSessionEntry =>
  ({ entryId, parentId, type: "custom", timestamp: "2026-01-01T00:00:00.000Z", data: {} });

/** 一条线性分支 a0 → a1 → …，方便按窗口取页。 */
const chain = (length: number): RemoteSessionEntry[] => {
  const entries: RemoteSessionEntry[] = [];
  for (let index = 0; index < length; index += 1) entries.push(entry("e" + index, index === 0 ? null : "e" + (index - 1)));
  return entries;
};
const projectionOf = (entries: RemoteSessionEntry[], leafId: string | null) => projectDisplayEntries(entries, leafId);
const request = (over: Partial<DisplayPageRequest> = {}): DisplayPageRequest =>
  ({ scopeId: "scope", leafId: "e4", beforeEntryId: null, maxEntries: 30, ...over });
const source = (over: Partial<{ sourceEpoch: string; sourceRevision: number }> = {}) =>
  ({ sourceEpoch: "epoch-1", sourceRevision: 1, ...over });

describe("DisplayPageCache 有效性", () => {
  it("同一代次里的历史页持续有效：判据是代次，不是 revision", () => {
    const cache = new DisplayPageCache();
    const entries = chain(5);
    cache.put(request(), { source: source({ sourceRevision: 1 }), projection: projectionOf(entries, "e4"), hasOlder: false });
    // 后续 live 内容会把 revision 推高；更旧的范围没有被改写，所以仍然命中。
    cache.put(request({ beforeEntryId: "e0" }), { source: source({ sourceRevision: 9 }), projection: projectionOf(entries, "e4"), hasOlder: true });
    const hit = cache.get(request(), { sourceEpoch: "epoch-1" });
    expect(hit?.entries.map(item => item.entryId)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect(hit?.sourceRevision).toBe(1);
    expect(hit?.projectionVersion).toBe(DISPLAY_PROJECTION_VERSION);
  });

  it("换代次后旧页作废并被丢弃", () => {
    const cache = new DisplayPageCache();
    cache.put(request(), { source: source(), projection: projectionOf(chain(3), "e2"), hasOlder: true });
    expect(cache.get(request(), { sourceEpoch: "epoch-2" })).toBeUndefined();
    expect(cache.stats().pages).toBe(0);
  });

  it("运行期换投影语义时用 invalidateAll 清空，并把版本记在页上", () => {
    const cache = new DisplayPageCache();
    const page = cache.put(request(), { source: source(), projection: projectionOf(chain(2), "e1"), hasOlder: true });
    expect(page?.projectionVersion).toBe(DISPLAY_PROJECTION_VERSION);
    expect(cache.projectionVersion).toBe(DISPLAY_PROJECTION_VERSION);
    cache.invalidateAll();
    expect(cache.get(request(), { sourceEpoch: "epoch-1" })).toBeUndefined();
  });
});

describe("DisplayPageCache 边界与淘汰", () => {
  it("超过页数上限时淘汰最久未使用的一页", () => {
    const cache = new DisplayPageCache({ maxPages: 2 });
    const entries = chain(3);
    for (const before of [null, "e2", "e1"]) {
      cache.put(request({ beforeEntryId: before }), { source: source(), projection: projectionOf(entries, "e2"), hasOlder: true });
    }
    // 第一页（beforeEntryId=null）被挤掉，后两页仍在。
    expect(cache.get(request({ beforeEntryId: null }), { sourceEpoch: "epoch-1" })).toBeUndefined();
    expect(cache.get(request({ beforeEntryId: "e2" }), { sourceEpoch: "epoch-1" })).toBeDefined();
    expect(cache.stats().pages).toBe(2);
  });

  it("命中会刷新最近使用顺序，避免刚用过的页被淘汰", () => {
    const cache = new DisplayPageCache({ maxPages: 2 });
    const entries = chain(3);
    cache.put(request({ beforeEntryId: null }), { source: source(), projection: projectionOf(entries, "e2"), hasOlder: true });
    cache.put(request({ beforeEntryId: "e2" }), { source: source(), projection: projectionOf(entries, "e2"), hasOlder: true });
    cache.get(request({ beforeEntryId: null }), { sourceEpoch: "epoch-1" });
    cache.put(request({ beforeEntryId: "e1" }), { source: source(), projection: projectionOf(entries, "e2"), hasOlder: true });
    expect(cache.get(request({ beforeEntryId: "e2" }), { sourceEpoch: "epoch-1" })).toBeUndefined();
    expect(cache.get(request({ beforeEntryId: null }), { sourceEpoch: "epoch-1" })).toBeDefined();
  });

  it("单页就超过总预算时不缓存，但调用方仍拿得到投影", () => {
    const cache = new DisplayPageCache({ maxBytes: 32 });
    const stored = cache.put(request(), { source: source(), projection: projectionOf(chain(40), "e39"), hasOlder: false });
    expect(stored).toBeUndefined();
    expect(cache.stats().pages).toBe(0);
  });

  it("每页条数上限会截断并标记，字节预算内按最久未使用淘汰", () => {
    const cache = new DisplayPageCache({ maxEntriesPerPage: 2, maxPages: 8 });
    const page = cache.put(request(), { source: source(), projection: projectionOf(chain(6), "e5"), hasOlder: false });
    expect(page?.entries).toHaveLength(2);
    expect(page?.truncated).toBe(true);

    const greedy = new DisplayPageCache({ maxPages: 8, maxBytes: 900 });
    for (const before of [null, "e5", "e4", "e3", "e2", "e1"]) {
      greedy.put(request({ beforeEntryId: before }), { source: source(), projection: projectionOf(chain(20), "e19"), hasOlder: true });
    }
    expect(greedy.stats().bytes).toBeLessThanOrEqual(900);
    expect(greedy.stats().pages).toBeLessThan(6);
  });
});

describe("DisplayPageCache 范围索引", () => {
  it("只有更旧的页会把最旧边界往前推，reachedStart 在到起点时置位", () => {
    const cache = new DisplayPageCache();
    const entries = chain(6);
    cache.put(request({ beforeEntryId: null }), { source: source(), projection: projectionOf(entries.slice(0, 3), "e2"), hasOlder: true });
    let coverage = cache.coverage("scope");
    expect(coverage).toMatchObject({ leafId: "e4", oldestEntryId: "e0", reachedStart: false, pages: 1 });

    cache.put(request({ beforeEntryId: "e2" }), { source: source(), projection: projectionOf(entries.slice(2, 5), "e4"), hasOlder: false });
    coverage = cache.coverage("scope");
    expect(coverage).toMatchObject({ oldestEntryId: "e2", reachedStart: true, pages: 2, entries: 6 });
  });

  it("head 改变会重置该会话的覆盖范围与旧页", () => {
    const cache = new DisplayPageCache();
    const entries = chain(4);
    cache.put(request({ leafId: "e3" }), { source: source(), projection: projectionOf(entries, "e3"), hasOlder: true });
    expect(cache.coverage("scope")?.leafId).toBe("e3");
    cache.put(request({ leafId: "e1" }), { source: source(), projection: projectionOf(entries, "e1"), hasOlder: false });
    expect(cache.coverage("scope")).toMatchObject({ leafId: "e1", reachedStart: true, pages: 1 });
    expect(cache.get(request({ leafId: "e3" }), { sourceEpoch: "epoch-1" })).toBeUndefined();
  });

  it("按作用域作废不影响别的会话，全量作废清空一切", () => {
    const cache = new DisplayPageCache();
    const entries = chain(3);
    cache.put(request({ scopeId: "a" }), { source: source(), projection: projectionOf(entries, "e2"), hasOlder: false });
    cache.put(request({ scopeId: "b" }), { source: source(), projection: projectionOf(entries, "e2"), hasOlder: false });
    expect(cache.invalidateScope("a")).toBe(1);
    expect(cache.get(request({ scopeId: "a" }), { sourceEpoch: "epoch-1" })).toBeUndefined();
    expect(cache.get(request({ scopeId: "b" }), { sourceEpoch: "epoch-1" })).toBeDefined();
    expect(cache.coverage("a")).toBeUndefined();
    cache.invalidateAll();
    expect(cache.stats()).toMatchObject({ pages: 0, bytes: 0, scopes: 0 });
  });
});
