import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaSchema } from "@orbis/protocol";
import { parseSubscriptionQuota, querySubscriptionQuota } from "./subscription-quota.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("official subscription quota", () => {
  it("converts Claude used percentages and keeps unknown windows unknown", () => {
    const quota = parseSubscriptionQuota("claude", { five_hour: { utilization: 12.5, resets_at: "2026-10-31T12:00:00Z" }, seven_day: null, seven_day_opus: { utilization: 99 }, secret: "never publish" }, 10);
    expect(quota).toEqual({ checkedAt: 10, windows: [{ name: "five_hour", remainingPercent: 87.5, resetsAt: Date.parse("2026-10-31T12:00:00Z") }, { name: "seven_day", remainingPercent: null, resetsAt: null }] });
    expect(SubscriptionQuotaSchema.safeParse(quota).success).toBe(true);
    expect(parseSubscriptionQuota("claude", { five_hour: { utilization: -1 }, seven_day: { utilization: 120 } }).windows.map(w => w.remainingPercent)).toEqual([null, 0]);
  });
  it("classifies Codex windows by duration, not order, and never calls another window a week", () => {
    const quota = parseSubscriptionQuota("codex", { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 1793400000 }, secondary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1793500000 } } });
    expect(quota.windows).toEqual([{ name: "five_hour", remainingPercent: 100, resetsAt: null }, { name: "seven_day", remainingPercent: 80, resetsAt: 1793400000000 }]);
    expect(parseSubscriptionQuota("codex", { rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 2592000 } } }).windows.every(w => w.remainingPercent === null)).toBe(true);
    expect(() => parseSubscriptionQuota("codex", { error: "unexpected" })).toThrow("无法识别");
  });
  it("uses fixed official endpoints and account headers without following redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 } } })));
    vi.stubGlobal("fetch", fetch);
    await querySubscriptionQuota("codex", { tokens: { access_token: "secret", account_id: "account" } });
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer secret", Accept: "application/json", "User-Agent": "codex-cli", "ChatGPT-Account-Id": "account" } }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 5 }, seven_day: { utilization: 90 } })));
    expect((await querySubscriptionQuota("claude", { claudeAiOauth: { accessToken: "claude-secret" } })).windows.map(w => w.remainingPercent)).toEqual([95, 10]);
    expect(fetch.mock.calls[1]![1].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });
  it("refuses API-key-only/expired login, sanitizes upstream errors and supports retry", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(querySubscriptionQuota("codex", { OPENAI_API_KEY: "secret" })).rejects.toThrow("API Key");
    await expect(querySubscriptionQuota("claude", { claudeAiOauth: { accessToken: "secret", expiresAt: 1 } })).rejects.toThrow("过期");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response("secret-provider-body", { status: 401 }));
    await expect(querySubscriptionQuota("codex", { tokens: { access_token: "secret" } })).rejects.toThrow("登录已失效");
    fetch.mockRejectedValueOnce(new Error("secret-token-in-transport-error"));
    await expect(querySubscriptionQuota("codex", { tokens: { access_token: "secret" } })).rejects.toThrow(/^订阅配额查询失败或超时/);
    fetch.mockResolvedValueOnce(new Response("secret-provider-body", { status: 429 }));
    await expect(querySubscriptionQuota("codex", { tokens: { access_token: "secret" } })).rejects.toThrow("过于频繁");
  });
});
