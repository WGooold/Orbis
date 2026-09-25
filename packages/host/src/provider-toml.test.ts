import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { mergeToml, removeToml, setToml } from "./provider-toml.js";
import { backfillCodex, defaultCodexPreferences, extractCodexCommon, prepareCodex } from "./provider-codex.js";

describe("Codex source-preserving configuration", () => {
  it("adopts official CLI rotations only for the same account and user identity", () => {
    const auth = (sub: string, refresh: string) => ({ tokens: { account_id: "workspace", id_token: `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`, refresh_token: refresh } });
    const saved = { auth: auth("user", "old"), config: 'model = "example"\n' };
    const live = { auth: auth("user", "rotated"), config: "" };
    expect(prepareCodex(saved, "official", defaultCodexPreferences(), false, live)).not.toHaveProperty("auth");
    const different = { ...saved, auth: auth("another-user", "another-token") };
    expect(prepareCodex(different, "official", defaultCodexPreferences(), false, live).auth).toEqual(different.auth);
    expect(prepareCodex({ ...saved, auth: {} }, "official", defaultCodexPreferences(), false, live)).not.toHaveProperty("auth");
  });
  it("never captures a preserved official login in a keyless third-party card", () => {
    const config = 'model_provider = "env"\n[model_providers.env]\nname = "Env"\nenv_key = "MY_API_KEY"\n';
    const template = { config, auth: {} };
    const live = { config, auth: { tokens: { refresh_token: "official-secret" } } };
    expect(backfillCodex(live, template, "", false)).toEqual(template);
  });
  it("edits quoted, dotted and inline routing keys without changing unrelated text", () => {
    const input = '# my preferences\nmodel = "old" # model note\n[features]\nfoo = true # keep\n[model_providers."my.provider"]\nname = "Provider"\nhttp_headers = {"X-Key" = "one", "X-Other" = "two"}\n';
    let result = setToml(input, ["model"], "new");
    result = setToml(result, ["model_providers", "my.provider", "http_headers", "X-Key"], "new-key");
    result = setToml(result, ["model_providers", "my.provider", "experimental_bearer_token"], "secret");
    expect(result).toContain('# my preferences\nmodel = "new" # model note');
    expect(result).toContain('[features]\nfoo = true # keep');
    expect((parse(result).model_providers as Record<string, unknown>)["my.provider"]).toMatchObject({ http_headers: { "X-Key": "new-key", "X-Other": "two" }, experimental_bearer_token: "secret" });
  });
  it("merges and strips common settings by value, preserving provider overrides", () => {
    const input = 'model = "example"\n[tui]\nnotifications = false # mine\n';
    const snippet = '[tui]\nnotifications = true\n[features]\na = true\n';
    const merged = mergeToml(input, snippet);
    expect(parse(merged)).toMatchObject({ tui: { notifications: true }, features: { a: true } });
    const removed = removeToml(merged, snippet);
    expect(parse(removed)).toEqual({ model: "example" });
    expect(parse(removeToml(input, snippet))).toMatchObject({ tui: { notifications: false } });
  });
  it("keeps MCP and common preferences when switching a third-party route, without sharing credentials", () => {
    const config = 'model_provider = "custom"\nmodel = "example"\n[model_providers.custom]\nname = "Custom"\nbase_url = "https://example.test/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n';
    const live = { auth: { tokens: { refresh_token: "official" } }, config: '# keep\n[features]\na = true\n[mcp_servers.local]\ncommand = "server"\n' };
    const commonConfig = extractCodexCommon(live.config);
    expect(commonConfig).not.toContain("mcp_servers");
    const next = prepareCodex({ auth: { OPENAI_API_KEY: "custom-secret" }, config }, "custom", { commonConfig, commonCleared: false, preserveOfficialLogin: true }, true, live);
    expect(next).not.toHaveProperty("auth");
    expect(parse(next.config)).toMatchObject({ features: { a: true }, mcp_servers: { local: { command: "server" } }, model_providers: { custom: { experimental_bearer_token: "custom-secret", requires_openai_auth: true } } });
    const clean = prepareCodex({ auth: { OPENAI_API_KEY: "custom-secret" }, config }, "custom", { commonConfig: "", commonCleared: false, preserveOfficialLogin: false }, false, live);
    expect(clean.auth).toBeNull();
    expect(parse(clean.config)).toMatchObject({ model_providers: { custom: { requires_openai_auth: false } } });
  });
});
