/**
 * CODEX-DESKTOP-SUPERVISION-01 (ADR-0096): every way a bridge session ends stops its backend.
 *
 * The fake backend behaves like `codex app-server --listen ws://…`: it ignores stdin, answers JSON-RPC on
 * its WebSocket, and exits only when signalled. The process-level suite runs the built wrapper as Codex
 * would and kills it from outside, including with SIGKILL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { backendLeaseDirectory, reapOrphanedDesktopBackends } from "./codex-desktop-backends.js";
import { DesktopBridgeSetupError, runBridge } from "./codex-desktop-bridge.js";
import { processAlive, publishEndpoint, readCodexDesktopEndpoint, readEndpointRecord } from "./codex-desktop-endpoint.js";

const WS = createRequire(import.meta.url).resolve("ws");
const FAKE_APP_SERVER = `
const { WebSocketServer } = require(${JSON.stringify(WS)});
const argv = process.argv.slice(2);
const exitEarly = argv.find(arg => arg.startsWith("--exit-before-listen="));
if (exitEarly) process.exit(Number(exitEarly.split("=")[1]));
if (argv.includes("--ignore-term")) process.on("SIGTERM", () => {});
const url = new URL(argv[argv.indexOf("--listen") + 1]);
const delay = Number((argv.find(arg => arg.startsWith("--delay-listen=")) ?? "=0").split("=")[1]);
setTimeout(() => new WebSocketServer({ host: "127.0.0.1", port: Number(url.port) }).on("connection", socket => socket.on("message", data => {
  const message = JSON.parse(String(data));
  if (message.id === undefined) return;
  if (message.method === "exit") process.exit(message.params.code);
  const result = message.method === "thread/loaded/list" ? { data: [] } : message.method === "echo" ? message.params : {};
  socket.send(JSON.stringify({ id: message.id, result }));
})), delay);
`;

async function fixture() {
  const root = await testDirectory(join(tmpdir(), "orbis-desktop-bridge-"));
  const server = join(root, "fake-app-server.cjs");
  await writeFile(server, FAKE_APP_SERVER);
  const cli = join(root, "fake-codex");
  await writeFile(cli, `#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`, { mode: 0o755 });
  const endpoint = join(root, "state", "codex-desktop-endpoint.json");
  const pids: number[] = [];
  onTestFinished(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  return { root, server, cli, endpoint, pids };
}

function lines(stream: PassThrough): () => Promise<string> {
  let buffer = "";
  const waiting: Array<(line: string) => void> = [];
  stream.on("data", chunk => {
    buffer += String(chunk);
    for (let index = buffer.indexOf("\n"); index >= 0 && waiting.length > 0; index = buffer.indexOf("\n")) {
      waiting.shift()!(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  return () => new Promise(resolve => waiting.push(resolve));
}

describe.runIf(process.platform !== "win32")("bridge session", () => {
  function session(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = [], output: NodeJS.WritableStream = new PassThrough()) {
    const input = new PassThrough();
    const done = runBridge({ codex: { command: process.execPath, prefixArgs: [f.server] }, args: ["app-server", ...flags], endpointFile: f.endpoint,
      input, output, processEvents: false, stopGraceMs: 300, republishIntervalMs: 50, log: () => {} });
    return { input, output, done };
  }
  async function ready(f: Awaited<ReturnType<typeof fixture>>): Promise<number> {
    await vi.waitFor(() => expect(readCodexDesktopEndpoint(f.endpoint)).toBeDefined(), { timeout: 10_000 });
    const pid = readEndpointRecord(f.endpoint)!.codexPid!;
    f.pids.push(pid);
    return pid;
  }

  it("bridges GUI lines, publishes a live endpoint with a lease, and cleans up when the GUI closes stdio", async () => {
    const f = await fixture();
    const s = session(f);
    const next = lines(s.output as PassThrough);
    const backend = await ready(f);
    expect(readEndpointRecord(f.endpoint)?.instanceId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(readdirSync(backendLeaseDirectory(f.endpoint))).toHaveLength(1);
    s.input.write('{"id":1,"method":"echo","params":{"x":1}}\n');
    expect(JSON.parse(await next())).toEqual({ id: 1, result: { x: 1 } });
    s.input.end();
    await expect(s.done).resolves.toBe(0);
    expect(processAlive(backend)).toBe(false);
    expect(existsSync(f.endpoint)).toBe(false);
    expect(readdirSync(backendLeaseDirectory(f.endpoint))).toEqual([]);
  });

  // The 0.1.24 wrapper crashed on an unhandled EPIPE and left its backend running.
  it("stops the backend when writing to the GUI fails", async () => {
    const f = await fixture();
    const broken = new Writable({ write: (_chunk, _encoding, callback) => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })) });
    const s = session(f, [], broken);
    const backend = await ready(f);
    s.input.write('{"id":1,"method":"echo","params":{}}\n');
    await expect(s.done).resolves.toBe(0);
    expect(processAlive(backend)).toBe(false);
  });

  it("reports the backend's own exit status and withdraws its endpoint", async () => {
    const f = await fixture();
    const s = session(f);
    await ready(f);
    s.input.write('{"id":2,"method":"exit","params":{"code":3}}\n');
    await expect(s.done).resolves.toBe(3);
    expect(existsSync(f.endpoint)).toBe(false);
  });

  it("escalates to SIGKILL for a backend that ignores SIGTERM", async () => {
    const f = await fixture();
    const s = session(f, ["--ignore-term"]);
    const backend = await ready(f);
    s.input.end();
    await expect(s.done).resolves.toBe(0);
    expect(processAlive(backend)).toBe(false);
  });

  it("restores its removed endpoint but never replaces or removes a newer live bridge's", async () => {
    const f = await fixture();
    const s = session(f);
    const backend = await ready(f);
    const own = readEndpointRecord(f.endpoint)!;
    await rm(f.endpoint);
    await vi.waitFor(() => expect(readEndpointRecord(f.endpoint)).toEqual(own));
    const newer = { ...own, url: "ws://127.0.0.1:1", codexPid: process.pid, bridgePid: process.pid, startedAt: new Date().toISOString() };
    publishEndpoint(f.endpoint, newer);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(readEndpointRecord(f.endpoint)?.url).toBe(newer.url);
    s.input.end();
    await s.done;
    expect(processAlive(backend)).toBe(false);
    expect(readEndpointRecord(f.endpoint)?.url).toBe(newer.url);
  });

  it("stops the child before reporting a setup failure and separates exec failures", async () => {
    for (const [code, cliUnavailable] of [[127, true], [2, false]] as const) {
      const f = await fixture();
      const error = await session(f, [`--exit-before-listen=${code}`]).done.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(DesktopBridgeSetupError);
      expect((error as DesktopBridgeSetupError).cliUnavailable).toBe(cliUnavailable);
      expect(existsSync(f.endpoint)).toBe(false);
      expect(readdirSync(backendLeaseDirectory(f.endpoint))).toEqual([]);
    }
  });
});

const wrapperEntry = fileURLToPath(new URL("../dist/codex-desktop-wrapper.js", import.meta.url));

// The wrapper process as Codex runs it. Requires the built Host (`npm run build`).
describe.runIf(process.platform !== "win32" && existsSync(wrapperEntry))("wrapper process exit paths", () => {
  function start(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = []): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env, ORBIS_CODEX_REAL: f.cli, ORBIS_CODEX_DESKTOP_ENDPOINT: f.endpoint };
    delete env.CODEX_CLI_PATH;
    const child = spawn(process.execPath, [wrapperEntry, "app-server", "--analytics-default-enabled", ...flags], { env, stdio: ["pipe", "pipe", "pipe"] });
    f.pids.push(child.pid!);
    return child;
  }
  async function backendOf(f: Awaited<ReturnType<typeof fixture>>, bridgePid: number): Promise<number> {
    await vi.waitFor(() => expect(readCodexDesktopEndpoint(f.endpoint)?.bridgePid).toBe(bridgePid), { timeout: 15_000 });
    const pid = readEndpointRecord(f.endpoint)!.codexPid!;
    f.pids.push(pid);
    return pid;
  }
  const exited = (child: ChildProcess) => new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));

  it("stops the backend when Codex sends SIGTERM", async () => {
    const f = await fixture();
    const wrapper = start(f);
    const backend = await backendOf(f, wrapper.pid!);
    const status = exited(wrapper);
    wrapper.kill("SIGTERM");
    expect(await status).toBe(143);
    expect(processAlive(backend)).toBe(false);
    expect(existsSync(f.endpoint)).toBe(false);
  });

  // The default signal action skips every exit hook; Codex can stop a transport that is still starting.
  it("stops the backend when Codex sends SIGTERM before the bridge is ready", async () => {
    const f = await fixture();
    const wrapper = start(f, ["--delay-listen=5000"]);
    let backend: number | undefined;
    await vi.waitFor(() => {
      const leases = existsSync(backendLeaseDirectory(f.endpoint)) ? readdirSync(backendLeaseDirectory(f.endpoint)) : [];
      expect(leases).toHaveLength(1);
      backend = (JSON.parse(readFileSync(join(backendLeaseDirectory(f.endpoint), leases[0]!), "utf8")) as { codexPid: number }).codexPid;
    }, { timeout: 15_000 });
    f.pids.push(backend!);
    const status = exited(wrapper);
    wrapper.kill("SIGTERM");
    expect(await status).toBe(143);
    expect(processAlive(backend!)).toBe(false);
    expect(readdirSync(backendLeaseDirectory(f.endpoint))).toEqual([]);
    expect(existsSync(f.endpoint)).toBe(false);
  });

  it("stops the backend when Codex closes stdio", async () => {
    const f = await fixture();
    const wrapper = start(f);
    const backend = await backendOf(f, wrapper.pid!);
    const status = exited(wrapper);
    wrapper.stdin!.end();
    expect(await status).toBe(0);
    expect(processAlive(backend)).toBe(false);
  });

  it("survives a closed GUI pipe instead of crashing past its cleanup", async () => {
    const f = await fixture();
    const wrapper = start(f);
    const backend = await backendOf(f, wrapper.pid!);
    const status = exited(wrapper);
    wrapper.stdout!.destroy();
    wrapper.stdin!.write('{"id":1,"method":"echo","params":{}}\n');
    expect(await status).toBe(0);
    expect(processAlive(backend)).toBe(false);
  });

  // SIGKILL skips every handler; the next wrapper start must clear the orphan before serving.
  it("clears the backend of a killed wrapper before the next Desktop backend starts", async () => {
    const f = await fixture();
    const first = start(f);
    const orphan = await backendOf(f, first.pid!);
    const killed = exited(first);
    first.kill("SIGKILL");
    await killed;
    expect(processAlive(orphan)).toBe(true);
    const second = start(f);
    await backendOf(f, second.pid!);
    expect(processAlive(orphan)).toBe(false);
    const status = exited(second);
    second.kill("SIGTERM");
    await status;
    // Host's sweep finds nothing left to stop.
    expect(await reapOrphanedDesktopBackends(f.endpoint)).toEqual({ stopped: [], remaining: [] });
  });
});
