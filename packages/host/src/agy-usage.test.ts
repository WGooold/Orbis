import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaSchema } from "@orbis/protocol";
import { agyProfile, DEFAULT_AGY_AUTH, type AgyAuthConfig } from "./agy-auth.js";
import { decodeAgyKeyringSecret, queryAgySubscriptionQuota } from "./agy-usage.js";

const personal: AgyAuthConfig = { ...DEFAULT_AGY_AUTH };
const business: AgyAuthConfig = { ...DEFAULT_AGY_AUTH, authMethod: "oauth-business", gcpProject: "fixture", gcpLocation: "global" };

async function tokenFixture(root: string, auth: AgyAuthConfig, expiry = "2099-01-01T00:00:00Z") {
  const profile = agyProfile(root, auth.authMethod);
  const path = join(profile.geminiDir, profile.appDataDir, "antigravity-oauth-token");
  await mkdir(join(profile.geminiDir, profile.appDataDir), { recursive: true });
  await writeFile(path, JSON.stringify({ token: { access_token: "oauth-access-secret", refresh_token: "refresh-secret", expiry } }));
  return path;
}

const fetchResult = (body: unknown, status = 200) => vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  expect(init?.redirect).toBe("manual");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-access-secret");
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
});

describe("AGY-16 subscription quota", () => {
  it("reads CLI-owned OAuth state and merges bounded windows into distinct model pools", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-agy-usage-"));
    try {
      await tokenFixture(root, personal);
      const daily = { groups: [{ displayName: "Gemini", buckets: [
        { bucketId: "gemini-pro", window: "5h", remainingFraction: 0.25, resetTime: "2026-11-27T12:00:00Z" },
        { bucketId: "3p-claude-gpt", window: "weekly", remainingFraction: 0.8, resetTime: "2026-11-30T12:00:00Z" },
      ] }] };
      const prod = { groups: [{ displayName: "Gemini", buckets: [
        { bucketId: "gemini-pro", window: "weekly", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" },
        { bucketId: "gemini-argon-pro", window: "5h", remainingFraction: 0.9, resetTime: "2026-11-27T12:30:00Z" },
      ] }] };
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-access-secret");
        const primary = String(input).startsWith("https://daily-cloudcode-pa.googleapis.com/");
        return new Response(JSON.stringify(primary ? daily : prod), { status: 200, headers: { "content-type": "application/json" } });
      });
      const quota = await queryAgySubscriptionQuota(root, personal, fetcher, Date.parse("2026-11-27T00:00:00Z"));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(quota.windows).toEqual([
        { name: "five_hour", remainingPercent: 25, resetsAt: Date.parse("2026-11-27T12:00:00Z") },
        { name: "seven_day", remainingPercent: 50, resetsAt: Date.parse("2026-12-01T00:00:00Z") },
      ]);
      expect(quota.pools).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "gemini-pro", label: "Gemini", windows: expect.arrayContaining([
          { name: "five_hour", remainingPercent: 25, resetsAt: Date.parse("2026-11-27T12:00:00Z") },
          { name: "seven_day", remainingPercent: 50, resetsAt: Date.parse("2026-12-01T00:00:00Z") },
        ]) }),
        expect.objectContaining({ id: "3p-claude-gpt", label: "Claude & GPT (shared)" }),
      ]));
      expect(SubscriptionQuotaSchema.safeParse(quota).success).toBe(true);
      expect(JSON.stringify(quota)).not.toContain("oauth-access-secret");
      expect(JSON.stringify(quota)).not.toContain("refresh-secret");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the prod quota host first for Enterprise and never tries subscription for API billing", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-agy-business-"));
    try {
      await tokenFixture(root, business);
      const fetcher = fetchResult({ buckets: [{ bucketId: "gemini-pro", window: "5h", remainingFraction: 0.5 }] });
      await queryAgySubscriptionQuota(root, business, fetcher, Date.parse("2026-11-27T00:00:00Z"));
      expect(String(fetcher.mock.calls[0]?.[0])).toContain("https://cloudcode-pa.googleapis.com/");
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ project: "fixture" });
      await expect(queryAgySubscriptionQuota(root, { ...business, authMethod: "gemini-api-key", apiKey: "not-for-subscriptions" }, fetcher))
        .rejects.toThrow("不提供 Google 账号订阅配额");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed for expired or absent CLI OAuth without exposing token material", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-agy-expired-"));
    const fetcher = fetchResult({ buckets: [] });
    try {
      await tokenFixture(root, personal, "2001-01-01T00:00:00Z");
      await expect(queryAgySubscriptionQuota(root, personal, fetcher)).rejects.toThrow("登录已过期");
      expect(fetcher).not.toHaveBeenCalled();
      await rm(join(agyProfile(root, "oauth-personal").geminiDir, "antigravity-acp", "antigravity-oauth-token"));
      await expect(queryAgySubscriptionQuota(root, personal, fetcher)).rejects.toThrow("未找到 Google 账号登录");
      expect(JSON.stringify(fetcher.mock.calls)).not.toContain("oauth-access-secret");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("decodes Go keyring's byte-preserving encodings", () => {
    expect(decodeAgyKeyringSecret(Buffer.from(`go-keyring-base64:${Buffer.from("secret").toString("base64")}`))).toBe("secret");
    expect(decodeAgyKeyringSecret(Buffer.from(`go-keyring-encoded:${Buffer.from("secret").toString("hex")}`))).toBe("secret");
  });
});
