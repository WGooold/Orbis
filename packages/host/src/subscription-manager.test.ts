import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "./provider-manager.js";
import * as subscriptions from "./subscription-quota.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-subscription-manager-")); roots.push(root);
  const paths = { pi: join(root, "pi"), codex: join(root, "codex"), claude: join(root, "claude"), dsh: join(root, "dsh") };
  await mkdir(paths.codex);
  await writeFile(join(paths.codex, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "local-only", account_id: "account" } }));
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) vi.stubEnv(name, undefined);
  return { paths, manager: new ProviderManager(join(root, "state"), paths) };
}
const quota = { checkedAt: 1, windows: [{ name: "five_hour" as const, remainingPercent: 60, resetsAt: null }, { name: "seven_day" as const, remainingPercent: 10, resetsAt: null }] };

describe("Host subscription query ownership", () => {
  it("reads the selected official account, coalesces duplicate queries and serializes switching", async () => {
    const { manager, paths } = await fixture();
    const official = (await manager.list("codex"))[0]!;
    await manager.save("codex", "third", "Third", { auth: { OPENAI_API_KEY: "vendor" }, config: 'model_provider = "third"\n[model_providers.third]\nname = "third"\nbase_url = "https://vendor.test/v1"\n' }, true);
    let finish!: (value: typeof quota) => void;
    const query = vi.spyOn(subscriptions, "querySubscriptionQuota").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = manager.querySubscription("codex", official.id);
    const second = manager.querySubscription("codex", official.id);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const switching = manager.switch("codex", "third");
    expect(JSON.parse(await readFile(join(paths.codex, "auth.json"), "utf8")).tokens.access_token).toBe("local-only");
    finish(quota);
    expect(await first).toEqual(quota);
    expect(query).toHaveBeenCalledWith("codex", expect.objectContaining({ tokens: { access_token: "local-only", account_id: "account" } }));
    await switching;
    await expect(manager.querySubscription("codex", official.id)).rejects.toThrow("先启用官方");
    await expect(manager.querySubscription("codex", "third")).rejects.toThrow("先启用官方");
    expect(query).toHaveBeenCalledOnce();
  });

  it("queries Claude native OAuth only for an official card, never trusting category labels", async () => {
    const { manager, paths } = await fixture();
    const credentials = vi.spyOn(subscriptions, "claudeSubscriptionCredentials").mockResolvedValue({ claudeAiOauth: { accessToken: "local-only" } });
    const query = vi.spyOn(subscriptions, "querySubscriptionQuota").mockResolvedValue(quota);
    const official = (await manager.list("claude"))[0]!;
    expect(await manager.querySubscription("claude", official.id)).toEqual(quota);
    expect(credentials).toHaveBeenCalledWith(paths.claude, expect.any(Boolean));
    query.mockRejectedValueOnce(new Error("failed"));
    await expect(manager.querySubscription("claude", official.id)).rejects.toThrow("failed");
    expect(await manager.querySubscription("claude", official.id)).toEqual(quota);
    await manager.save("claude", "third", "Third", { env: { ANTHROPIC_BASE_URL: "https://vendor.test", ANTHROPIC_AUTH_TOKEN: "key" } }, true, true, { category: "official" });
    await manager.switch("claude", "third");
    expect((await manager.list("claude")).find(p => p.id === "third")?.subscriptionSupported).toBe(false);
    await expect(manager.querySubscription("claude", "third")).rejects.toThrow("先启用官方");
    expect(credentials).toHaveBeenCalledTimes(3);
  });

  it("rejects third-party base overrides but allows unrelated API keys when querying official OAuth", async () => {
    const { manager, paths } = await fixture();
    const query = vi.spyOn(subscriptions, "querySubscriptionQuota").mockResolvedValue(quota);
    const official = (await manager.list("codex"))[0]!;
    vi.stubEnv("ORBIS_NO_KEYCHAIN", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-unrelated");
    expect(await manager.querySubscription("codex", official.id)).toEqual(quota);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("OPENAI_BASE_URL", "https://vendor.test");
    await expect(manager.querySubscription("codex", official.id)).rejects.toThrow("环境变量");
    vi.stubEnv("OPENAI_BASE_URL", undefined);
    await writeFile(join(paths.codex, "config.toml"), '[model_providers.openai]\nbase_url = "https://vendor.test"\n');
    await expect(manager.querySubscription("codex", official.id)).rejects.toThrow("先启用官方");
    expect(query).toHaveBeenCalledOnce();
  });

  it("refreshes expired managed Codex OAuth tokens on quota query without rotating valid tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-subscription-oauth-")); roots.push(root);
    const paths = { pi: join(root, "pi"), codex: join(root, "codex"), claude: join(root, "claude"), dsh: join(root, "dsh") };
    await mkdir(paths.codex);
    vi.stubEnv("ORBIS_NO_KEYCHAIN", "1");
    for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"]) vi.stubEnv(name, undefined);
    const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    const validAccess = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const expiredAccess = jwt({ exp: 1000 });
    const refreshedAccess = jwt({ exp: Math.floor(Date.now() / 1000) + 7200 });
    const idToken = jwt({ sub: "user-1", email: "user@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
    await writeFile(join(paths.codex, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: idToken, access_token: validAccess, refresh_token: "refresh-1", account_id: "acct-1" },
      last_refresh: "2026-11-01T00:00:00.000Z",
    }));
    const manager = new ProviderManager(join(root, "state"), paths);
    await manager.oauth("import");
    const accounts = await manager.oauth("list") as { id: string }[];
    const official = (await manager.list("codex"))[0]!;
    await manager.save("codex", official.id, official.name, { auth: {}, config: "" }, false, true, { authBinding: { source: "managed_account", authProvider: "codex_oauth", accountId: accounts[0]!.id } });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 } } })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await manager.querySubscription("codex", official.id)).windows[0]?.remainingPercent).toBe(60);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://chatgpt.com/backend-api/wham/usage");

    await writeFile(join(paths.codex, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: idToken, access_token: expiredAccess, refresh_token: "refresh-1", account_id: "acct-1" },
      last_refresh: "2026-11-01T00:00:00.000Z",
    }));
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: refreshedAccess, refresh_token: "refresh-2", id_token: idToken, expires_in: 7200 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } })));
    expect((await manager.querySubscription("codex", official.id)).windows[0]?.remainingPercent).toBe(75);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://auth.openai.com/oauth/token");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(JSON.parse(await readFile(join(paths.codex, "auth.json"), "utf8")).tokens).toMatchObject({ access_token: refreshedAccess, refresh_token: "refresh-2" });
  });
});
