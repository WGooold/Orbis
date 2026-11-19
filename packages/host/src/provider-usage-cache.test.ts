import { describe, expect, it, vi } from "vitest";
import { ProviderUsageCache } from "./provider-usage-cache.js";
import type { ProviderProfile } from "./provider-manager.js";
import { UsageQueryError } from "./provider-usage.js";

const profile: ProviderProfile = { id: "p", kind: "pi", name: "P", config: { baseUrl: "https://example.test", apiKey: "k", models: [{ id: "m" }] }, usageScript: { enabled: true, language: "javascript", timeout: 5, code: "()", autoQueryInterval: 5 } };
describe("provider usage cache", () => {
  it("does not poll a disabled provider or publish its in-flight result after re-enabling", async () => {
    let generation: object | undefined;
    let release!: (value: unknown[]) => void;
    const changed = vi.fn();
    const query = vi.fn(() => new Promise<unknown[]>(resolve => { release = resolve; }));
    const cache = new ProviderUsageCache(async () => [profile], changed, query, Date.now, () => {
      const admitted = generation;
      return () => admitted !== undefined && generation === admitted;
    });
    await cache.tick();
    expect(query).not.toHaveBeenCalled();
    generation = {};
    const pending = cache.refresh(profile);
    const rejected = expect(pending).rejects.toThrow("用量查询已停止");
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    generation = undefined;
    generation = {};
    const resumed = cache.refresh(profile);
    release([{ remaining: 1 }]);
    await rejected;
    expect(changed).not.toHaveBeenCalled();
    expect(cache.get("pi", "p")).toBeUndefined();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    release([{ remaining: 2 }]);
    expect(await resumed).toEqual([{ remaining: 2 }]);
    expect(changed).toHaveBeenCalledTimes(1);
    generation = undefined;
    expect(cache.get("pi", "p")).toBeUndefined();
    await cache.close();
  });

  it("deduplicates concurrent requests and keeps the last result for transient errors", async () => {
    let calls = 0; let fail = false; let now = 1000;
    const changed: unknown[] = [];
    const cache = new ProviderUsageCache(async () => [profile], () => {}, async () => { calls++; if (fail) throw new UsageQueryError("temporary", true); return [{ remaining: calls }]; }, () => now);
    expect(await Promise.all([cache.refresh(profile), cache.refresh(profile)])).toEqual([[{ remaining: 1 }], [{ remaining: 1 }]]);
    expect(calls).toBe(1);
    fail = true; now += 1000;
    await expect(cache.refresh(profile)).rejects.toThrow("temporary");
    expect(cache.get("pi", "p")).toMatchObject({ data: [{ remaining: 1 }], error: "temporary" });
    await cache.close();
    expect(changed).toHaveLength(0);
  });
});
