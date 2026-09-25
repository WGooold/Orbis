import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexOAuthAccounts, managedAuthMarker } from "./provider-oauth.js";

const jwt = (claims: Record<string, unknown>): string => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const auth = (subject: string, workspace: string, access = "access", refresh = "refresh") => ({
  auth_mode: "chatgpt", tokens: { account_id: workspace, id_token: jwt({ sub: subject, email: `${subject}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: workspace } }), access_token: access, refresh_token: refresh }, last_refresh: "2026-09-25T00:00:00.000Z",
});

describe("managed Codex OAuth accounts", () => {
  it("imports one native login, adopts a newer same-identity CLI rotation, and ignores another identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-oauth-"));
    try {
      const accounts = new CodexOAuthAccounts(join(root, "accounts.json"));
      const native = auth("user-a", "workspace-a", "access-a", "refresh-a");
      const id = await accounts.importNative(native);
      expect((await accounts.list())).toMatchObject([{ id, email: "user-a@example.test", workspace: "workspace-a", isDefault: true }]);
      const marker = managedAuthMarker(id, native);
      await accounts.adopt(marker, { ...auth("user-a", "workspace-a", "access-b", "refresh-b"), last_refresh: "2026-09-25T00:01:00.000Z" });
      const saved = JSON.parse(await readFile(join(root, "accounts.json"), "utf8"));
      expect(saved.accounts[0].refreshToken).toBe("refresh-b");
      await accounts.adopt(marker, { ...auth("user-b", "workspace-b", "access-other", "refresh-other"), last_refresh: "2026-09-25T00:02:00.000Z" });
      expect(JSON.parse(await readFile(join(root, "accounts.json"), "utf8")).accounts[0].refreshToken).toBe("refresh-b");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refreshes an expired managed account and persists a rotated refresh token", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-oauth-"));
    try {
      const responses = [new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", id_token: jwt({ sub: "user-a", "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a" } }), expires_in: 3600 }), { status: 200 })];
      const accounts = new CodexOAuthAccounts(join(root, "accounts.json"), async () => responses.shift()!);
      await accounts.importNative({ ...auth("user-a", "workspace-a", "access-old", "refresh-old"), tokens: { ...auth("user-a", "workspace-a").tokens, access_token: "access-old", refresh_token: "refresh-old" } });
      const result = await accounts.auth();
      expect(result.auth.tokens).toMatchObject({ access_token: "access-new", refresh_token: "refresh-new", account_id: "workspace-a" });
      expect(JSON.parse(await readFile(join(root, "accounts.json"), "utf8")).accounts[0].refreshToken).toBe("refresh-new");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
