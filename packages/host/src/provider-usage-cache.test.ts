import { describe, expect, it } from "vitest";
import { ProviderUsageCache } from "./provider-usage-cache.js";
import type { ProviderProfile } from "./provider-manager.js";
import { UsageQueryError } from "./provider-usage.js";

const profile: ProviderProfile = { id: "p", kind: "pi", name: "P", config: { baseUrl: "https://example.test", apiKey: "k", models: [{ id: "m" }] }, usageScript: { enabled: true, language: "javascript", timeout: 5, code: "()", autoQueryInterval: 5 } };
describe("provider usage cache", () => {
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
