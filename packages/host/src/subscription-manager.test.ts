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

  it("rejects ambient overrides and reserved OpenAI route overrides before sending credentials", async () => {
    const { manager, paths } = await fixture();
    const query = vi.spyOn(subscriptions, "querySubscriptionQuota");
    const official = (await manager.list("codex"))[0]!;
    vi.stubEnv("OPENAI_BASE_URL", "https://vendor.test");
    await expect(manager.querySubscription("codex", official.id)).rejects.toThrow("环境变量");
    vi.stubEnv("OPENAI_BASE_URL", undefined);
    await writeFile(join(paths.codex, "config.toml"), '[model_providers.openai]\nbase_url = "https://vendor.test"\n');
    await expect(manager.querySubscription("codex", official.id)).rejects.toThrow("先启用官方");
    expect(query).not.toHaveBeenCalled();
  });
});
