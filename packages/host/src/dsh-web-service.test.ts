import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDshWebService, validateDshWebUrl } from "./dsh-web-service.js";

const token = "test-launch-token-with-enough-characters";
const directories: string[] = [];
const servers: Server[] = [];
const childPids: number[] = [];

afterEach(async () => {
  for (const pid of childPids.splice(0)) {
    try { process.kill(pid); } catch { /* A failed startup may have exited already. */ }
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch { break; }
      await delay(100);
    }
  }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orbis-dsh-web-test-"));
  directories.push(directory);
  return directory;
}

async function web(real = true): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === `/?token=${token}`) {
      response.writeHead(303, { location: "./", "set-cookie": "dsh-auth-test=authenticated; Path=/; HttpOnly; SameSite=Strict" });
      response.end();
    } else if (request.headers.cookie === "dsh-auth-test=authenticated") response.end(real ? "<script>window.__DSH_BOOT__={}</script>" : "<html>unrelated service</html>");
    else { response.writeHead(401); response.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("invalid fixture address");
  return `http://127.0.0.1:${address.port}/?token=${token}`;
}

function cli() {
  const script = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      if (request.url === "/?token=${token}") {
        response.writeHead(303, { location: "./", "set-cookie": "dsh-auth-fixture=authenticated; Path=/; HttpOnly" });
        response.end();
      } else if (request.headers.cookie === "dsh-auth-fixture=authenticated") response.end("<script>window.__DSH_BOOT__={}</script>");
      else { response.writeHead(401); response.end(); }
    });
    server.listen(0, "127.0.0.1", () => console.log("dsh web: http://127.0.0.1:" + server.address().port + "/?token=${token}"));
  `;
  return { command: process.execPath, prefixArgs: ["-e", script, "--"] };
}

describe("shared DSH Web lifecycle", () => {
  it("accepts only authenticated loopback launch URLs without leaking supplied values in errors", () => {
    expect(validateDshWebUrl(`http://127.0.0.1:3080/?token=${token}`)).toContain(token);
    for (const value of ["https://example.com/?token=secret", "http://127.0.0.1:3080", `http://127.0.0.1:3080/?token=${token}&token=${token}`, `http://user:pass@localhost/?token=${token}`, `http://localhost/api?token=${token}`, `http://localhost/?token=${token}#secret`]) {
      expect(() => validateDshWebUrl(value)).toThrow();
      try { validateDshWebUrl(value); } catch (error) { expect(String(error)).not.toContain(value); }
    }
  });

  it("attaches to an explicitly selected browser server and leaves it running after disconnect", async () => {
    const url = await web();
    const service = await ensureDshWebService({ ORBIS_DSH_WEB_URL: url, DSH_HOME: await home() });
    expect(service.url).toBe(url);
    await service.stop();
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
  });

  it("rejects stale credentials and unrelated servers instead of creating another Web instance", async () => {
    const url = await web();
    await expect(ensureDshWebService({ ORBIS_DSH_WEB_URL: url.replace(token, "wrong-authentication-token"), DSH_HOME: await home() })).rejects.toThrow("更新启动");
    await expect(ensureDshWebService({ ORBIS_DSH_WEB_URL: await web(false), DSH_HOME: await home() })).rejects.toThrow("无法连接");
  });

  it("shares one owned browser process across concurrent callers and subsequent Host connections", async () => {
    const directory = await home();
    const env = { ...process.env, DSH_HOME: directory, ORBIS_DSH_WEB_URL: "" };
    const services = await Promise.all([ensureDshWebService(env, { cli: cli(), port: 0 }), ensureDshWebService(env, { cli: cli(), port: 0 })]);
    const descriptor = JSON.parse(await readFile(join(directory, "cache", "orbis-web.json"), "utf8")) as { pid: number; owner: string; home: string };
    childPids.push(descriptor.pid);
    expect(descriptor).toMatchObject({ owner: "orbis", home: directory });
    expect(services[0]?.url).toBe(services[1]?.url);
    for (const service of services) await service.stop();
    const next = await ensureDshWebService(env, { cli: { command: "missing-executable", prefixArgs: [] } });
    expect(next.url).toBe(services[0]?.url);
    expect(() => process.kill(descriptor.pid, 0)).not.toThrow();
  });

  it("refuses to spawn beside an occupied Web port without a valid owned descriptor", async () => {
    const directory = await home();
    const url = await web();
    await mkdir(join(directory, "cache"));
    await writeFile(join(directory, "cache", "orbis-web.json"), JSON.stringify({ version: 1, owner: "another-app", home: directory, pid: process.pid, url, cli: cli() }));
    await expect(ensureDshWebService({ DSH_HOME: directory }, { port: Number(new URL(url).port), cli: cli() })).rejects.toThrow("现有 DeepSeek Web");
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
  });

  it("cleans up only its unpublished child when Web startup times out", async () => {
    const directory = await home();
    await expect(ensureDshWebService({ ...process.env, DSH_HOME: directory, ORBIS_DSH_WEB_URL: "" }, {
      cli: { command: process.execPath, prefixArgs: ["-e", "console.log(process.pid); setInterval(() => {}, 1000)", "--"] }, port: 0, timeoutMs: 500,
    })).rejects.toThrow("启动超时");
    const pid = Number((await readFile(join(directory, "cache", "orbis-web-output.log"), "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(readFile(join(directory, "cache", "orbis-web.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
