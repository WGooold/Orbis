/** Secure remote Hermes Gateway configuration and SSH transport.
 *
 * The Hermes TUI Gateway intentionally grants its interactive WebSocket ticket
 * over a same-machine control channel. For a remote owner, ask its own Hermes
 * CLI for a single-use ticket over SSH, then tunnel only that Gateway's loopback
 * WebSocket. Neither the ticket nor the remote control socket is exposed on the
 * network. The Gateway remains owned by Hermes and is never started/stopped here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HermesGatewayBootstrapError, parseHermesGatewayEndpoint, type HermesGatewayEndpoint } from "./hermes-gateway-bootstrap.js";
import { HERMES_GATEWAY_WS_PROTOCOL } from "./hermes-gateway-rpc.js";

const CONFIG_FILE = "hermes-remote-gateway.json";
const MAX_CONFIG_BYTES = 16_384;
const ATTACH_TIMEOUT_MS = 20_000;
const SSH_HOST_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|\[[0-9A-Fa-f:]{2,45}\])$/u;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export type HermesRemoteGatewayConfig = Readonly<{
  host: string;
  port: number;
  profile?: string;
}>;

export type HermesRemoteGatewaySettings = Readonly<{
  source: "file" | "environment";
  host: string;
  port: number;
  profile: string;
  invalid: boolean;
}>;

export type HermesRemoteGatewayAttachment = {
  endpoint: HermesGatewayEndpoint;
  url: string;
  protocols: string[];
  close: () => Promise<void>;
};

type Child = Pick<ChildProcess, "exitCode" | "signalCode" | "kill" | "once" | "off">;
export type HermesRemoteGatewayDependencies = {
  runAttach?: (config: HermesRemoteGatewayConfig) => Promise<string>;
  spawnTunnel?: (args: string[]) => Child;
  allocatePort?: () => Promise<number>;
  connect?: (url: string) => Promise<void>;
};

export function validateHermesRemoteGatewayConfig(value: unknown): HermesRemoteGatewayConfig {
  const row = record(value);
  if (typeof row.host !== "string" || !SSH_HOST_PATTERN.test(row.host) || row.host.startsWith("-")) {
    throw new Error("SSH 主机请填写 user@host 或 SSH 配置别名");
  }
  const port = row.port === undefined ? 22 : row.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SSH 端口须为 1–65535 的整数");
  }
  const profile = row.profile === undefined || row.profile === "" ? undefined : row.profile;
  if (profile !== undefined && (typeof profile !== "string" || !PROFILE_PATTERN.test(profile))) {
    throw new Error("Hermes profile 名称格式无效");
  }
  return { host: row.host, port, ...(profile === undefined ? {} : { profile }) };
}

export async function loadHermesRemoteGatewayConfig(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesRemoteGatewayConfig | undefined> {
  if (hasRemoteEnvironment(env)) {
    if (env.ORBIS_HERMES_SSH_HOST === undefined) {
      if (env.ORBIS_HERMES_SSH_PORT || env.ORBIS_HERMES_PROFILE) throw new Error("ORBIS_HERMES_SSH_HOST is required");
      return undefined;
    }
    if (!env.ORBIS_HERMES_SSH_HOST.trim()) {
      if (env.ORBIS_HERMES_SSH_PORT || env.ORBIS_HERMES_PROFILE) throw new Error("Empty ORBIS_HERMES_SSH_HOST conflicts with remote settings");
      return undefined;
    }
    return validateHermesRemoteGatewayConfig({
      host: env.ORBIS_HERMES_SSH_HOST.trim(),
      port: env.ORBIS_HERMES_SSH_PORT === undefined || env.ORBIS_HERMES_SSH_PORT === ""
        ? 22 : Number(env.ORBIS_HERMES_SSH_PORT),
      ...(env.ORBIS_HERMES_PROFILE ? { profile: env.ORBIS_HERMES_PROFILE } : {}),
    });
  }
  const text = await readPrivate(join(stateDir, CONFIG_FILE));
  if (text === undefined) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { throw new Error("Invalid hermes-remote-gateway.json"); }
  return validateHermesRemoteGatewayConfig(raw);
}

export async function readHermesRemoteGatewaySettings(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesRemoteGatewaySettings> {
  const source = hasRemoteEnvironment(env)
    ? "environment" : "file";
  try {
    const config = await loadHermesRemoteGatewayConfig(stateDir, env);
    return { source, host: config?.host ?? "", port: config?.port ?? 22, profile: config?.profile ?? "", invalid: false };
  } catch {
    return { source, host: "", port: 22, profile: "", invalid: true };
  }
}

export async function saveHermesRemoteGatewaySettings(
  stateDir: string,
  host: unknown,
  port: unknown,
  profile: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesRemoteGatewaySettings> {
  if (hasRemoteEnvironment(env)) {
    throw new Error("Hermes SSH 连接由环境变量配置");
  }
  if (typeof host !== "string" || host.length > 260 || typeof profile !== "string" || profile.length > 64) {
    throw new Error("Hermes SSH 配置无效");
  }
  const path = join(stateDir, CONFIG_FILE);
  if (!host.trim()) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  } else {
    const config = validateHermesRemoteGatewayConfig({ host: host.trim(), port, profile: profile.trim() });
    const body = JSON.stringify(config);
    if (Buffer.byteLength(body) > MAX_CONFIG_BYTES) throw new Error("Hermes SSH 配置过长");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const file = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try { await file.writeFile(body, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  }
  return readHermesRemoteGatewaySettings(stateDir, env);
}

export function hermesRemoteAttachSshArgs(configInput: HermesRemoteGatewayConfig): string[] {
  const config = validateHermesRemoteGatewayConfig(configInput);
  return [
    "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
    "-p", String(config.port), config.host,
    ...(config.profile ? [`hermes --profile=${config.profile} gateway attach --json`] : ["hermes gateway attach --json"]),
  ];
}

export function hermesRemoteTunnelSshArgs(
  configInput: HermesRemoteGatewayConfig,
  localPort: number,
  remoteHostname: string,
  remotePort: number,
): string[] {
  const config = validateHermesRemoteGatewayConfig(configInput);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535 ||
      !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535 ||
      !["127.0.0.1", "localhost", "::1"].includes(remoteHostname.replace(/^\[|\]$/gu, ""))) {
    throw new HermesGatewayBootstrapError("remote_endpoint_invalid", "远程 Hermes Gateway 地址无效");
  }
  const destination = remoteHostname === "::1" || remoteHostname === "[::1]" ? "[::1]" : remoteHostname;
  return [
    "-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${localPort}:${destination}:${remotePort}`,
    "-p", String(config.port), config.host,
  ];
}

export async function attachRemoteHermesGateway(
  config: HermesRemoteGatewayConfig,
  dependencies: HermesRemoteGatewayDependencies = {},
): Promise<HermesRemoteGatewayAttachment> {
  const safeConfig = validateHermesRemoteGatewayConfig(config);
  const runAttach = dependencies.runAttach ?? runRemoteAttach;
  const raw = await runAttach(safeConfig);
  const attach = parseHermesRemoteAttachResult(raw);
  const remote = new URL(attach.url);
  const remoteHostname = remote.hostname.replace(/^\[|\]$/gu, "");
  const remotePort = Number(remote.port);
  const localPort = await (dependencies.allocatePort ?? allocateLoopbackPort)();
  const spawnTunnel = dependencies.spawnTunnel ?? (args => spawn("ssh", args, { stdio: "ignore", windowsHide: true }));
  const child = spawnTunnel(hermesRemoteTunnelSshArgs(safeConfig, localPort, remoteHostname, remotePort));
  const close = () => closeChild(child);
  try {
    await waitForChildReady(child);
    const localUrl = new URL(remote.toString());
    localUrl.protocol = "ws:";
    localUrl.hostname = "127.0.0.1";
    localUrl.port = String(localPort);
    if (dependencies.connect) await dependencies.connect(localUrl.toString());
    return { endpoint: attach.endpoint, url: localUrl.toString(), protocols: attach.protocols, close };
  } catch (error) {
    await close();
    if (error instanceof HermesGatewayBootstrapError) throw error;
    throw new HermesGatewayBootstrapError("remote_tunnel_failed", "无法建立 Hermes SSH 隧道");
  }
}

export function parseHermesRemoteAttachResult(text: string): {
  endpoint: HermesGatewayEndpoint; url: string; protocols: string[];
} {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()) as unknown; }
  catch { throw new HermesGatewayBootstrapError("remote_attach_invalid", "远程 Hermes 未返回有效的 attach JSON"); }
  const row = record(raw);
  if (row.state !== "ready") throw new HermesGatewayBootstrapError("remote_gateway_unavailable", "远程 Hermes Gateway 未就绪或尚未启动");
  const endpoint = parseHermesGatewayEndpoint(row.endpoint);
  if (row.protocol !== HERMES_GATEWAY_WS_PROTOCOL || typeof row.url !== "string" || !Array.isArray(row.protocols) ||
      row.protocols.length !== 2 || row.protocols[0] !== HERMES_GATEWAY_WS_PROTOCOL || typeof row.protocols[1] !== "string" ||
      !/^hermes-gateway-ticket\.[A-Za-z0-9._~-]{1,512}$/u.test(row.protocols[1])) {
    throw new HermesGatewayBootstrapError("remote_attach_invalid", "远程 Hermes attach 凭据或协议无效");
  }
  let url: URL;
  try { url = new URL(row.url); }
  catch { throw new HermesGatewayBootstrapError("remote_endpoint_invalid", "远程 Hermes Gateway 地址无效"); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) && hostname.split(".").slice(1).every(part => Number(part) <= 255);
  if (!(url.protocol === "ws:" || url.protocol === "wss:") || !loopback || !url.port || url.pathname !== "/api/ws" ||
      url.username || url.password || url.search || url.hash) {
    throw new HermesGatewayBootstrapError("remote_endpoint_invalid", "远程 Hermes attach 必须返回本机 Gateway WebSocket");
  }
  const apiOrigin = new URL(endpoint.api_origin);
  if (Number(url.port) !== Number(apiOrigin.port) || hostname !== apiOrigin.hostname.replace(/^\[|\]$/gu, "").toLowerCase()) {
    throw new HermesGatewayBootstrapError("remote_endpoint_invalid", "远程 Hermes attach 地址与 owner 身份不匹配");
  }
  return { endpoint, url: url.toString(), protocols: row.protocols as string[] };
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("No TCP port allocated")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function runRemoteAttach(config: HermesRemoteGatewayConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", hermesRemoteAttachSshArgs(config), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new HermesGatewayBootstrapError("remote_attach_timeout", "远程 Hermes attach 超时")); }
    }, ATTACH_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_CONFIG_BYTES) {
        if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(new HermesGatewayBootstrapError("remote_attach_invalid", "远程 Hermes attach 输出过长")); }
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new HermesGatewayBootstrapError("ssh_unavailable", "无法启动 SSH 客户端"));
    });
    child.once("close", code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) { reject(new HermesGatewayBootstrapError("remote_attach_failed", "SSH 登录失败或远程 Hermes 不支持 gateway attach")); return; }
      resolve(stdout);
    });
  });
}

async function waitForChildReady(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("SSH tunnel exited");
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => { child.off("error", onError); resolve(); };
    const onError = () => { child.off("spawn", onSpawn); reject(new Error("SSH tunnel could not start")); };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  await delay(120);
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("SSH tunnel exited");
}

async function closeChild(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(1_500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(500)]);
  }
}

async function readPrivate(path: string): Promise<string | undefined> {
  const file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES || process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("Hermes Host state must be a private regular file (chmod 600)");
    }
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasRemoteEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.ORBIS_HERMES_SSH_HOST !== undefined || env.ORBIS_HERMES_SSH_PORT !== undefined || env.ORBIS_HERMES_PROFILE !== undefined;
}
