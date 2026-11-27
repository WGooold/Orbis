import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { agyAuthIssue, agyProfile, DEFAULT_AGY_AUTH, parseAgyAuthConfig } from "./agy-auth.js";
import { agyBrowserCommand, agyEnvironment } from "./agy-client.js";

const root = process.cwd();
const key = "valid-api-key-123456";
const gcp = { gcpProject: "fixture", gcpLocation: "us-central1" };

describe("AGY-16 Antigravity auth settings", () => {
  it("defaults to personal login, separates validation from saved configuration, and selects no fallback billing mode", () => {
    expect(DEFAULT_AGY_AUTH.authMethod).toBe("oauth-personal");
    expect(agyAuthIssue(parseAgyAuthConfig({ authMethod: "oauth-personal" })!)).toBeUndefined();
    expect(agyAuthIssue(parseAgyAuthConfig({ authMethod: "oauth-business", ...gcp })!)).toBeUndefined();
    expect(agyAuthIssue(parseAgyAuthConfig({ authMethod: "gemini-api-key", apiKey: key })!)).toBeUndefined();
    expect(agyAuthIssue(parseAgyAuthConfig({ authMethod: "agent-platform", ...gcp })!)).toBeUndefined();
    for (const method of ["oauth-business", "gemini-api-key", "agent-platform"]) {
      const parsed = parseAgyAuthConfig({ authMethod: method })!;
      expect(parsed.authMethod).toBe(method);
      expect(agyAuthIssue(parsed)).toBeDefined();
    }
    expect(parseAgyAuthConfig({ authMethod: "oauth-business", gcpProject: "a\na" })).toBeUndefined();
    expect(parseAgyAuthConfig({ authMethod: "gemini-api-key", apiKey: "bad\nkey" })).toBeUndefined();
  });

  it("preserves the legacy key profile and isolates the new native state by authentication mode", () => {
    const api = agyProfile(root, "gemini-api-key");
    const personal = agyProfile(root, "oauth-personal");
    const enterprise = agyProfile(root, "oauth-business");
    expect(api.geminiDir).toBe(join(root, "agy-acp", "home", ".gemini"));
    expect(api.appDataDir).toBe("orbis-agy");
    expect(personal.geminiDir).toContain(join("providers", "antigravity"));
    expect(personal.appDataDir).toBe("antigravity-acp");
    expect(enterprise.lock).toBe(personal.lock);
    expect(agyProfile(root, "oauth-personal", "second-instance").lock).not.toBe(personal.lock);
    expect(agyProfile(root, "oauth-personal").lock).toBe(personal.lock);
  });

  it("passes only the auth chosen by the operator; the ADC override is never inherited", () => {
    const ambient: NodeJS.ProcessEnv = { HOME: join(root, "user"), DISPLAY: ":0", GEMINI_API_KEY: "ambient-a", GOOGLE_API_KEY: "ambient-b",
      GOOGLE_APPLICATION_CREDENTIALS: "/ambient-c.json", google_application_credentials: "other", GOOGLE_CLOUD_PROJECT: "ambient-project" };
    function project(method: string, config: object, browser = false) {
      const auth = parseAgyAuthConfig({ authMethod: method, ...config })!;
      const profile = agyProfile(root, auth.authMethod);
      const env = agyEnvironment(ambient, profile, auth, browser);
      for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "google_application_credentials", "GOOGLE_CLOUD_PROJECT"]) expect(env).not.toHaveProperty(name);
      return env;
    }
    const personal = project("oauth-personal", { apiKey: key });
    expect(personal.SSH_CONNECTION).toBeTruthy();
    expect(personal).not.toHaveProperty("DISPLAY");
    expect(personal).not.toHaveProperty("GEMINI_API_KEY");
    expect(personal).not.toHaveProperty("GOOGLE_API_KEY");
    const business = project("oauth-business", gcp, true);
    expect(agyBrowserCommand("C:\\host runtime\\node.exe", "win32")).toContain("C:\\host runtime\\node.exe");
    expect(business.DISPLAY).toBe(":0");
    expect(business.BROWSER).toContain("__ORBIS_ANTIGRAVITY_AUTH_URL__");
    expect(business).not.toHaveProperty("SSH_CONNECTION");
    expect(project("gemini-api-key", { apiKey: key })).toMatchObject({ GEMINI_API_KEY: key });
    expect(project("agent-platform", { apiKey: key })).toMatchObject({ GOOGLE_API_KEY: key });
    const adc = project("agent-platform", gcp);
    expect(adc.HOME).toBe(ambient.HOME);
    expect(adc).not.toHaveProperty("GOOGLE_API_KEY");
  });
});

// AGY-16: ACP's standard browser flow must report only the URL through the private helper.
describe("AGY-16 Antigravity browser helper", () => {
  it("shell-quotes a local runtime path and returns the URL as one marker line", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const browser = agyBrowserCommand(process.execPath);
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=fixture";
    const invocation = browser.replace("'%s'", `'${url}'`);
    const { stderr } = await run("/bin/sh", ["-c", invocation], { timeout: 5_000, maxBuffer: 16_384 });
    expect(stderr.trim()).toBe(`__ORBIS_ANTIGRAVITY_AUTH_URL__${JSON.stringify(url)}`);
    expect(() => agyBrowserCommand("/tmp/node;evil", "win32")).toThrow("path is not supported");
  });
});
