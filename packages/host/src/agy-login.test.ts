import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agyProfile, DEFAULT_AGY_AUTH } from "./agy-auth.js";
import { parseAgyAuthorizationUrl, signInAgyEnterprise, startAgyPersonalLogin } from "./agy-login.js";
import { AGY_VERSION } from "./agy-client.js";

const cli = (source: string) => ({ command: process.execPath, prefixArgs: ["-e", source, "--"] });
const validLink = "https://accounts.google.com/o/oauth2/auth?state=fixture&response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback";
const enterprise = { ...DEFAULT_AGY_AUTH, authMethod: "oauth-business" as const, gcpProject: "fixture-gcp", gcpLocation: "global" };
const enterpriseUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=fixture&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2F";

describe("AGY-16 private CLI sign-in", () => {
  it("uses the official standalone login invocation and releases the writer lock on invalid URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-agy-invalid-link-"));
    try {
      for (const invalid of [validLink.replace("accounts.google.com", "accounts.google.com.example.test"), `${validLink}&state=second`]) {
        await expect(startAgyPersonalLogin(root, DEFAULT_AGY_AUTH, { cli: cli(`console.log(${JSON.stringify(invalid)});`) })).rejects.toThrow("输出链接前结束");
        await expect(stat(agyProfile(root, "oauth-personal").lock)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("cancels an abandoned personal login and rejects multi-line input without writing it to the child", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-agy-cancel-login-"));
    const recorded = join(root, "input.txt");
    const lock = agyProfile(root, "oauth-personal").lock;
    const options = { cli: cli(`console.log(${JSON.stringify(validLink)});
      process.stdin.on('data', chunk => require('node:fs').writeFileSync(${JSON.stringify(recorded)}, chunk));`) };
    try {
      const first = await startAgyPersonalLogin(root, DEFAULT_AGY_AUTH, options);
      await expect(stat(lock)).resolves.toBeDefined();
      await expect(startAgyPersonalLogin(root, DEFAULT_AGY_AUTH, options)).rejects.toThrow("目录已被占用");
      await first.cancel();
      await expect(first.complete("unused-code")).rejects.toThrow("流程已结束");
      const second = await startAgyPersonalLogin(root, DEFAULT_AGY_AUTH, options);
      await expect(second.complete("second-code\r\ninjected")).rejects.toThrow("代码格式无效");
      await expect(stat(recorded)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("validates the Enterprise loopback authorization URL without accepting a foreign callback", () => {
    expect(parseAgyAuthorizationUrl(enterpriseUrl, "browser")).toBe(enterpriseUrl);
    expect(parseAgyAuthorizationUrl(enterpriseUrl.replace("127.0.0.1", "localhost"), "browser")).toBeUndefined();
    expect(parseAgyAuthorizationUrl(enterpriseUrl.replace("49152", "80"), "browser")).toBeUndefined();
    expect(parseAgyAuthorizationUrl(validLink, "browser")).toBeUndefined();
  });

  it("drives the native Enterprise ACP browser flow using the selected project and not a personal sign-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-agy-enterprise-"));
    const profile = agyProfile(root, enterprise.authMethod);
    const fixture = cli(`
      if (process.argv.includes('--login') || !process.argv.includes('antigravity-acp') || !process.argv.includes(process.env.GEMINI_HOME)
        || process.env.SSH_CONNECTION || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS) process.exit(4);
      const stdin = require('node:readline').createInterface({input:process.stdin});
      let signedIn = false;
      stdin.on('line', line => {
        const { id, method, params } = JSON.parse(line);
        let result;
        if (method === 'initialize') result = { protocolVersion:1, agentInfo:{version:${JSON.stringify(AGY_VERSION)}},
          agentCapabilities:{loadSession:true, sessionCapabilities:{list:{}}}, authMethods:[{id:'oauth-business'}] };
        if (method === 'authenticate' && params.methodId === 'oauth-business') {
          process.stderr.write('__ORBIS_ANTIGRAVITY_AUTH_URL__'+JSON.stringify(${JSON.stringify(enterpriseUrl)})+'\\n');
          signedIn = true; result = {};
        }
        if (method === 'session/list' && signedIn) result = { sessions: [] };
        if (!result) process.exit(5);
        console.log(JSON.stringify({ jsonrpc:'2.0', id, result }));
      });`);
    try {
      const authorizationUrls: string[] = [];
      await signInAgyEnterprise(root, enterprise, { cli: fixture, onAuthorizationUrl: url => authorizationUrls.push(url), env: { GOOGLE_API_KEY: "ambient", GEMINI_API_KEY: "ambient",
        GOOGLE_APPLICATION_CREDENTIALS: "/ambient", SSH_CONNECTION: "ambient", DISPLAY: ":0" } });
      expect(authorizationUrls).toEqual([enterpriseUrl]);
      expect(JSON.parse(await readFile(join(profile.geminiDir, profile.appDataDir, "settings.json"), "utf8"))).toEqual({
        auth: { type: "oauth-business" }, gcp: { project: "fixture-gcp", location: "global" },
      });
      await expect(stat(profile.lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
