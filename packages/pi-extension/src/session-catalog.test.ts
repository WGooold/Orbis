import { describe, expect, it } from "vitest";
import { createSessionCatalogCache } from "./session-catalog.js";

describe("session catalog cache", () => {
  // 不变量：整库扫描只受 TTL 与显式失效控制——连接抖动/并发请求都不该再扫一遍 517MB。
  it("scans at most once per TTL and always rescans after invalidate", async () => {
    let now = 0;
    let scans = 0;
    const cache = createSessionCatalogCache({
      load: async () => {
        scans += 1;
        await Promise.resolve();
        return [`scan-${scans}`];
      },
      ttlMs: 60_000,
      now: () => now,
    });

    // 并发请求合并成一次扫描。
    const [first, second] = await Promise.all([cache.get(), cache.get()]);
    expect(scans).toBe(1);
    expect(first).toEqual(second);

    // TTL 内复用。
    now = 59_999;
    expect(await cache.get()).toEqual(["scan-1"]);
    expect(scans).toBe(1);

    // 显式失效（rename / tree / 新会话）必须立刻重扫。
    cache.invalidate();
    expect(await cache.get()).toEqual(["scan-2"]);
    expect(scans).toBe(2);

    // TTL 到期自动重扫。
    now = 120_000;
    expect(await cache.get()).toEqual(["scan-3"]);
    expect(scans).toBe(3);
  });
});
