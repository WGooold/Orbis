import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDshWebService, restartDshWebServiceAfterUpdate, validateDshWebUrl } from "./dsh-web-service.js";

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

function cli(launchToken = token) {
  const script = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      if (request.url === "/?token=${launchToken}") {
        response.writeHead(303, { location: "./", "set-cookie": "dsh-auth-fixture=authenticated; Path=/; HttpOnly" });
        response.end();
      } else if (request.headers.cookie === "dsh-auth-fixture=authenticated") response.end("<script>window.__DSH_BOOT__={}</script>");
      else { response.writeHead(401); response.end(); }
    });
    const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
    server.listen(port, "127.0.0.1", () => console.log("dsh web: http://127.0.0.1:" + server.address().port + "/?token=${launchToken}"));
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

  it.runIf(process.platform === "win32")("restarts an owned service on its original port with the updated CLI and serializes concurrent reuse", async () => {
    const directory = await home();
    const env = { ...process.env, DSH_HOME: directory, ORBIS_DSH_WEB_URL: "" };
    const original = await ensureDshWebService(env, { cli: cli(), port: 0 });
    const path = join(directory, "cache", "orbis-web.json");
    const before = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    childPids.push(before.pid);
    await mkdir(join(directory, "sessions"));
    await writeFile(join(directory, "sessions", "retained.jsonl"), "existing history");
    const updatedCli = cli("updated-launch-token-with-enough-characters");
    const restarting = restartDshWebServiceAfterUpdate(env, updatedCli);
    // Attaching during restart must wait for the fresh descriptor, not return the soon-to-exit process.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(`${path}.lock`).then(() => true, () => false)) break;
      await delay(10);
    }
    const attaching = ensureDshWebService(env, { cli: cli(), port: 0 });
    const [restarted, attached] = await Promise.allSettled([restarting, attaching]);
    const after = JSON.parse(await readFile(path, "utf8")) as { pid: number; url: string; cli: unknown };
    childPids.push(after.pid);
    expect(restarted).toEqual({ status: "fulfilled", value: true });
    expect(after.pid).not.toBe(before.pid);
    expect(() => process.kill(before.pid, 0)).toThrow();
    expect(after.cli).toEqual(updatedCli);
    expect(new URL(after.url).origin).toBe(new URL(original.url).origin);
    expect(after.url).not.toBe(original.url);
    expect(attached).toMatchObject({ status: "fulfilled", value: { url: after.url } });
    expect((await fetch(after.url, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(original.url, { redirect: "manual" })).status).toBe(401);
    expect(await readFile(join(directory, "sessions", "retained.jsonl"), "utf8")).toBe("existing history");
    await expect(readFile(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not start unused services or restart explicitly configured endpoints", async () => {
    const directory = await home();
    expect(await restartDshWebServiceAfterUpdate({ DSH_HOME: directory }, cli())).toBe(false);
    await expect(readFile(join(directory, "cache", "orbis-web.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const url = await web();
    await expect(restartDshWebServiceAfterUpdate({ DSH_HOME: directory, ORBIS_DSH_WEB_URL: url }, cli())).rejects.toThrow("手动配置");
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
  });

  it("refuses an unauthenticated or mismatched live descriptor without terminating its process", async () => {
    const directory = await home();
    await mkdir(join(directory, "cache"));
    const url = await web();
    const path = join(directory, "cache", "orbis-web.json");
    const descriptor = { version: 1, owner: "orbis", home: directory, pid: process.pid, url, cli: cli() };
    await writeFile(path, JSON.stringify({ ...descriptor, url: url.replace(token, "incorrect-authentication-token") }));
    await expect(restartDshWebServiceAfterUpdate({ DSH_HOME: directory }, cli())).rejects.toThrow("无法验证");
    await writeFile(path, JSON.stringify(descriptor));
    await expect(restartDshWebServiceAfterUpdate({ DSH_HOME: directory }, cli())).rejects.toThrow("无法安全识别");
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(descriptor);
  });

  it.runIf(process.platform === "win32")("reports a failed replacement and releases the lock so a later launch can recover", async () => {
    const directory = await home();
    const env = { ...process.env, DSH_HOME: directory, ORBIS_DSH_WEB_URL: "" };
    const original = await ensureDshWebService(env, { cli: cli(), port: 0 });
    const path = join(directory, "cache", "orbis-web.json");
    childPids.push((JSON.parse(await readFile(path, "utf8")) as { pid: number }).pid);
    await expect(restartDshWebServiceAfterUpdate(env, { command: "missing-dsh-test-executable", prefixArgs: [] })).rejects.toThrow("启动失败");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = await ensureDshWebService(env, { cli: cli(), port: Number(new URL(original.url).port) });
    childPids.push((JSON.parse(await readFile(path, "utf8")) as { pid: number }).pid);
    expect((await fetch(recovered.url, { redirect: "manual" })).status).toBe(303);
  }, 30_000);
});
