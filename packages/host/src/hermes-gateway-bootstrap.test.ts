import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer, type Server } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectHermesGateway,
  hermesGatewayPipeName,
  hermesGatewayUnixControlPath,
  hermesGatewayWebSocketTarget,
  parseHermesGatewayEnsureResult,
  parseHermesGatewayRuntimeDescriptor,
  requestHermesGatewayTicket,
  resolveHermesGatewayCommand,
  type HermesGatewayEndpoint,
} from "./hermes-gateway-bootstrap.js";
import { HERMES_GATEWAY_WS_PROTOCOL } from "./hermes-gateway-rpc.js";

const tempDirectories: string[] = [];
const controlServers: Server[] = [];
const wsServers: WebSocketServer[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "orbis-hermes-bootstrap-"));
  tempDirectories.push(path);
  await chmod(path, 0o700);
  return path;
}
async function controlSocket(path: string, ticket: string, onRequest?: (frame: Record<string, unknown>) => void): Promise<void> {
  const server = createServer(socket => {
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString("utf8");
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(data.slice(0, newline)) as Record<string, unknown>;
      onRequest?.(frame);
      const params = frame.params as Record<string, unknown>;
      socket.end(JSON.stringify({ ok: true, protocol: 1, id: frame.id, result: {
        ticket, profile_id: params.profile_id, instance_id: params.instance_id, runtime_protocol: 1,
      } }) + "\n");
    });
  });
  controlServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
}

async function closeResources(): Promise<void> {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
  await Promise.all(wsServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(controlServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
}

afterEach(closeResources);

function endpoint(home: string, apiOrigin = "http://127.0.0.1:43121"): HermesGatewayEndpoint {
  return { profile_id: home, instance_id: "instance-1", authority_epoch: 7, runtime_protocol: 1,
    api_origin: apiOrigin, supervisor: "none", capabilities: ["session-authority-v1"], control_home: home,
    code_sha: "code-1" };
}

describe("Hermes Gateway bootstrap", () => {
  it("discovers an explicit Hermes entry before PATH and resolves normal Hermes launchers", async () => {
    const home = await temporaryDirectory();
    const bin = join(home, "bin");
    const commandPath = join(bin, process.platform === "win32" ? "hermes.exe" : "hermes");
    await mkdir(bin);
    await writeFile(commandPath, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
    await chmod(commandPath, 0o755);
    expect(await resolveHermesGatewayCommand({ HOME: home, PATH: bin }, process.platform))
      .toEqual({ command: commandPath, prefixArgs: [] });
    expect(await resolveHermesGatewayCommand({ HOME: home, PATH: "", ORBIS_HERMES_ENTRY: commandPath }, process.platform))
      .toEqual({ command: commandPath, prefixArgs: [] });
  });

  it("accepts only a ready credential-free ensure response and session authority", () => {
    const home = "/tmp/hermes-home";
    const parsed = parseHermesGatewayEnsureResult(JSON.stringify({ state: "ready", endpoint: endpoint(home), client_code_sha: "code-1" }), "", 0);
    expect(parsed.endpoint.profile_id).toBe(home);
    expect(() => parseHermesGatewayEnsureResult(JSON.stringify({ state: "starting" }), "", 5)).toThrow(/尚未就绪/u);
    expect(() => parseHermesGatewayEnsureResult(JSON.stringify({ state: "ready", endpoint: { ...endpoint(home), capabilities: [] } }), "", 0)).toThrow(/会话能力/u);
  });

  it("parses only the Gateway's runtime identity and session creation capability", () => {
    expect(parseHermesGatewayRuntimeDescriptor({ profile_id: "/home/.hermes", instance_id: "i", authority_epoch: 2,
      capabilities: ["session-authority-v1"], session_create: { sources: ["tui"], parameters: ["cwd"] } }))
      .toMatchObject({ profile_id: "/home/.hermes", session_create: { sources: ["tui"], parameters: ["cwd"] } });
    expect(() => parseHermesGatewayRuntimeDescriptor({ profile_id: "x", instance_id: "i", authority_epoch: 2,
      capabilities: [], session_create: { sources: "tui", parameters: [] } })).toThrow(/无效/u);
  });

  it("builds the local WebSocket route and binds the ticket as a subprotocol", () => {
    const target = hermesGatewayWebSocketTarget(endpoint("/home/.hermes", "https://127.0.0.1:4567"), "opaque_ticket-1");
    expect(target.url).toBe("wss://127.0.0.1:4567/api/ws");
    expect(target.protocols).toEqual([HERMES_GATEWAY_WS_PROTOCOL, "hermes-gateway-ticket.opaque_ticket-1"]);
    expect(() => hermesGatewayWebSocketTarget(endpoint("/home/.hermes", "https://example.com:4567"), "x"))
      .toThrow(/本机/u);
  });

  it("uses the endpoint-bound ticket over a private Unix control socket", async () => {
    if (process.platform === "win32") return;
    const home = await temporaryDirectory();
    const path = join(home, "gateway.sock");
    let observed: Record<string, unknown> | undefined;
    await controlSocket(path, "ticket-1", frame => { observed = frame; });
    expect(await hermesGatewayUnixControlPath(home)).toBe(await realpath(path));
    expect(await requestHermesGatewayTicket(endpoint(home), { timeoutMs: 1_000 })).toBe("ticket-1");
    expect(observed).toMatchObject({ protocol: 1, id: 1, verb: "session-ticket",
      params: { profile_id: home, instance_id: "instance-1", purpose: "interactive" } });
  });

  it("resolves Hermes' bounded short-path pointer for long home paths", async () => {
    if (process.platform === "win32") return;
    const home = await temporaryDirectory();
    const canonicalHome = await realpath(home);
    const targetDirName = `hermes-gw-${createHash("sha256").update(canonicalHome, "utf8").digest("hex").slice(0, 16)}`;
    const targetDir = join(await realpath(tmpdir()), targetDirName);
    const target = join(targetDir, "control.sock");
    // Use a uniquely named directory under the temp root to keep the target path short.
    await mkdir(targetDir, { mode: 0o700 });
    tempDirectories.push(targetDir);
    await controlSocket(target, "ticket-2");
    await writeFile(join(home, "gateway.sock.path"), target, { mode: 0o600 });
    await chmod(join(home, "gateway.sock.path"), 0o600);
    expect(await hermesGatewayUnixControlPath(home)).toBe(target);
    expect(basename(targetDir)).toBe(targetDirName);
    expect(await readFile(join(home, "gateway.sock.path"), "utf8")).toBe(target);
  });

  it("uses Hermes' Windows control-pipe identity formula", () => {
    expect(hermesGatewayPipeName("C:\\Users\\Example\\.hermes")).toMatch(/^\\\\\.\\pipe\\hermes-gateway-[a-f0-9]{16}$/u);
  });

  it("ensures, authenticates, capability-checks, and verifies one Gateway before returning", async () => {
    if (process.platform === "win32") return;
    const home = await temporaryDirectory();
    const controlPath = join(home, "gateway.sock");
    await controlSocket(controlPath, "ticket-3");
    const ws = new WebSocketServer({
      port: 0,
      handleProtocols: protocols => protocols.has(HERMES_GATEWAY_WS_PROTOCOL) ? HERMES_GATEWAY_WS_PROTOCOL : false,
    });
    wsServers.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("listening", resolve); ws.once("error", reject); });
    const address = ws.address();
    if (!address || typeof address === "string") throw new Error("expected TCP test listener");
    const apiOrigin = `http://127.0.0.1:${address.port}`;
    ws.on("connection", socket => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
      socket.on("message", raw => {
        const call = JSON.parse(raw.toString()) as { id: string; method: string; params: Record<string, unknown> };
        const result = call.method === "client.capabilities"
          ? { server_requests: ["approval", "clarify"] }
          : { profile_id: home, instance_id: "instance-1", authority_epoch: 7,
            capabilities: ["session-authority-v1"], session_create: { sources: ["tui"], parameters: ["cwd"] } };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      });
    });

    const attachment = await connectHermesGateway({
      command: { command: "hermes", prefixArgs: [] },
      runEnsure: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ state: "ready", client_code_sha: "code-1",
        endpoint: endpoint(home, apiOrigin) }) }),
      onServerRequest: request => request.method === "approval" ? { choice: "deny" } : {},
    });
    clients.push(attachment.client);
    expect(attachment.runtime.instance_id).toBe("instance-1");
    expect(attachment.serverRequests).toEqual(["approval", "clarify"]);
    expect(attachment.runtime.session_create.sources).toEqual(["tui"]);
  });
});
