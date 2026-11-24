/** Establish an authenticated connection to Hermes' existing local Gateway owner. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, normalize, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { agentCommandForEntry, agentInvocation, findExternalAgentEntries, type AgentCommand } from "./agent-command.js";
import { HERMES_GATEWAY_WS_PROTOCOL, HermesGatewayRpcClient, type HermesGatewayEvent, type HermesJsonObject, type HermesServerRequestHandler } from "./hermes-gateway-rpc.js";
import { attachRemoteHermesGateway, parseHermesRemoteAttachResult, type HermesRemoteGatewayConfig } from "./hermes-remote-gateway.js";

const execFileAsync = promisify(execFile);
const MAX_CONTROL_BYTES = 512 * 1024;
const CONTROL_TIMEOUT_MS = 5_000;
const ENSURE_TIMEOUT_SECONDS = 60;
const TICKET_PREFIX = "hermes-gateway-ticket.";

export type HermesGatewayEndpoint = {
  profile_id: string;
  instance_id: string;
  authority_epoch: number;
  runtime_protocol: number;
  api_origin: string;
  supervisor: string;
  capabilities: string[];
  control_home?: string | null;
  code_sha?: string | null;
};
export type HermesGatewayRuntimeDescriptor = {
  profile_id: string;
  instance_id: string;
  authority_epoch: number;
  capabilities: string[];
  session_create: { sources: string[]; parameters: string[] };
};
export type HermesGatewayAttachment = {
  client: HermesGatewayRpcClient;
  endpoint: HermesGatewayEndpoint;
  runtime: HermesGatewayRuntimeDescriptor;
  serverRequests: string[];
  /** Releases only an Orbis-owned transport resource (currently an SSH forward). */
  close?: () => Promise<void>;
};
export type HermesGatewayCliCommand = AgentCommand;
export type HermesEnsureRunner = (command: HermesGatewayCliCommand, timeoutMs: number, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export class HermesGatewayBootstrapError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HermesGatewayBootstrapError";
  }
}

export type HermesGatewayBootstrapOptions = {
  command?: HermesGatewayCliCommand;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutSeconds?: number;
  expectedProfileId?: string;
  remoteGateway?: HermesRemoteGatewayConfig;
  existingOnly?: boolean;
  requireCurrent?: () => void;
  runAttach?: typeof runHermesGatewayAttach;
  runEnsure?: HermesEnsureRunner;
  requestTicket?: typeof requestHermesGatewayTicket;
  connect?: typeof HermesGatewayRpcClient.connect;
  attachRemote?: typeof attachRemoteHermesGateway;
  onEvent?: (event: HermesGatewayEvent) => void;
  onServerRequest?: HermesServerRequestHandler;
  onTransportError?: (error: Error) => void;
};

/** Read the supported Hermes CLI from the explicit override or normal PATH/user bin locations. */
export async function resolveHermesGatewayCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<HermesGatewayCliCommand> {
  const explicit = env.ORBIS_HERMES_ENTRY?.trim().replace(/^"(.*)"$/u, "$1");
  const entry = explicit || (await findExternalAgentEntries("hermes", env, platform))[0]?.entry;
  if (!entry) throw new HermesGatewayBootstrapError("hermes_not_found", "未找到 Hermes Agent CLI");
  try { return await agentCommandForEntry(entry, env, platform); }
  catch { throw new HermesGatewayBootstrapError("hermes_command_unavailable", "Hermes CLI 启动入口不可用"); }
}

/** Connect to the current local profile, or to a remote profile over an SSH-forwarded attach ticket. */
export async function connectHermesGateway(options: HermesGatewayBootstrapOptions = {}): Promise<HermesGatewayAttachment> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let endpoint: HermesGatewayEndpoint;
  let url: string;
  let protocols: string[];
  let closeRemote: (() => Promise<void>) | undefined;
  if (options.remoteGateway) {
    options.requireCurrent?.();
    const remote = await (options.attachRemote ?? attachRemoteHermesGateway)(options.remoteGateway);
    endpoint = remote.endpoint;
    url = remote.url;
    protocols = remote.protocols;
    closeRemote = remote.close;
  } else if (options.existingOnly) {
    const command = options.command ?? await resolveHermesGatewayCommand(env, platform);
    options.requireCurrent?.();
    const attached = parseHermesRemoteAttachResult(await (options.runAttach ?? runHermesGatewayAttach)(command, env, platform));
    ({ endpoint, url, protocols } = attached);
  } else {
    const command = options.command ?? await resolveHermesGatewayCommand(env, platform);
    const timeoutSeconds = options.timeoutSeconds ?? ENSURE_TIMEOUT_SECONDS;
    const runEnsure = options.runEnsure ?? runHermesGatewayEnsure;
    options.requireCurrent?.();
    const result = await runEnsure(command, timeoutSeconds * 1000, env, platform);
    const ensured = parseHermesGatewayEnsureResult(result.stdout, result.stderr, result.exitCode);
    endpoint = ensured.endpoint;
    if (ensured.clientCodeSha && endpoint.code_sha && ensured.clientCodeSha !== endpoint.code_sha)
      throw new HermesGatewayBootstrapError("gateway_code_mismatch", "Hermes Gateway 版本与当前 CLI 不一致");
    const requestTicket = options.requestTicket ?? requestHermesGatewayTicket;
    const ticket = await requestTicket(endpoint, { platform, timeoutMs: CONTROL_TIMEOUT_MS });
    const target = hermesGatewayWebSocketTarget(endpoint, ticket);
    url = target.url;
    protocols = target.protocols;
  }
  if (options.expectedProfileId !== undefined && endpoint.profile_id !== options.expectedProfileId) {
    await closeRemote?.();
    throw new HermesGatewayBootstrapError("gateway_identity_changed", "Hermes Gateway profile 已变化");
  }
  const connect = options.connect ?? HermesGatewayRpcClient.connect;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let sawReady = false;
  const ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  let client: HermesGatewayRpcClient | undefined;
  let readyTimer: NodeJS.Timeout | undefined;
  try {
    client = await connect(url, protocols, {
      requestTimeoutMs: 30_000,
      onEvent: event => {
        if (event.type === "gateway.ready" && !sawReady) { sawReady = true; readyResolve(); }
        options.onEvent?.(event);
      },
      ...(options.onServerRequest ? { onServerRequest: options.onServerRequest } : {}),
      onTransportError: error => options.onTransportError?.(error),
    });
    readyTimer = setTimeout(() => readyReject(new HermesGatewayBootstrapError("gateway_handshake_timeout", "Hermes Gateway 握手超时")), 10_000);
    readyTimer.unref?.();
    await ready;
    const advertised = await client.request<unknown>("client.capabilities", { server_requests: Boolean(options.onServerRequest) });
    const serverRequests = stringArray(asRecord(advertised).server_requests, "server_requests");
    const rawRuntime = await client.request<unknown>("runtime.describe", {});
    const runtime = parseHermesGatewayRuntimeDescriptor(rawRuntime);
    if (runtime.profile_id !== endpoint.profile_id || runtime.instance_id !== endpoint.instance_id ||
      runtime.authority_epoch !== endpoint.authority_epoch)
      throw new HermesGatewayBootstrapError("gateway_identity_changed", "Hermes Gateway 身份在连接期间发生变化");
    return { client, endpoint, runtime, serverRequests, ...(closeRemote ? { close: closeRemote } : {}) };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await closeRemote?.().catch(() => undefined);
    if (error instanceof HermesGatewayBootstrapError) throw error;
    throw new HermesGatewayBootstrapError("gateway_handshake_failed", "Hermes Gateway 能力协商失败");
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
  }
}

export function parseHermesGatewayEnsureResult(stdout: string, stderr: string, exitCode: number): {
  endpoint: HermesGatewayEndpoint; clientCodeSha?: string;
} {
  let raw: unknown;
  try { raw = JSON.parse(stdout.trim()) as unknown; }
  catch { throw new HermesGatewayBootstrapError("gateway_ensure_invalid", "Hermes Gateway ensure 未返回有效 JSON"); }
  const result = asRecord(raw);
  if (result.state !== "ready" || exitCode !== 0)
    throw new HermesGatewayBootstrapError(`gateway_${safeCode(result.reason_code)}`,
      result.state === "starting" ? "Hermes Gateway 尚未就绪" : "Hermes Gateway 当前不可用");
  const endpoint = parseHermesGatewayEndpoint(result.endpoint);
  const clientCodeSha = typeof result.client_code_sha === "string" ? result.client_code_sha : undefined;
  // stderr is intentionally not returned: Hermes diagnostics can include private local paths.
  void stderr;
  return { endpoint, ...(clientCodeSha ? { clientCodeSha } : {}) };
}

export function parseHermesGatewayEndpoint(value: unknown): HermesGatewayEndpoint {
  const row = asRecord(value);
  const strings = ["profile_id", "instance_id", "api_origin", "supervisor"] as const;
  for (const key of strings) if (typeof row[key] !== "string" || !row[key])
    throw new HermesGatewayBootstrapError("gateway_endpoint_invalid", "Hermes Gateway endpoint 不完整");
  if (typeof row.authority_epoch !== "number" || !Number.isInteger(row.authority_epoch) || row.authority_epoch < 1 ||
    row.runtime_protocol !== 1 || !Array.isArray(row.capabilities) || row.capabilities.some(item => typeof item !== "string") ||
    (row.control_home !== undefined && row.control_home !== null && typeof row.control_home !== "string") ||
    (row.code_sha !== undefined && row.code_sha !== null && typeof row.code_sha !== "string"))
    throw new HermesGatewayBootstrapError("gateway_endpoint_invalid", "Hermes Gateway endpoint 不完整");
  if (!row.capabilities.includes("session-authority-v1"))
    throw new HermesGatewayBootstrapError("gateway_incompatible", "Hermes Gateway 缺少会话能力");
  validateLoopbackOrigin(row.api_origin as string);
  return row as HermesGatewayEndpoint;
}

export function parseHermesGatewayRuntimeDescriptor(value: unknown): HermesGatewayRuntimeDescriptor {
  const row = asRecord(value);
  if (typeof row.profile_id !== "string" || typeof row.instance_id !== "string" ||
    typeof row.authority_epoch !== "number" || !Number.isInteger(row.authority_epoch) ||
    !Array.isArray(row.capabilities) || row.capabilities.some(item => typeof item !== "string"))
    throw new HermesGatewayBootstrapError("gateway_runtime_invalid", "Hermes Gateway runtime 描述不完整");
  const sessionCreate = asRecord(row.session_create);
  const sources = stringArray(sessionCreate.sources, "session_create.sources");
  const parameters = stringArray(sessionCreate.parameters, "session_create.parameters");
  return { profile_id: row.profile_id, instance_id: row.instance_id, authority_epoch: row.authority_epoch,
    capabilities: row.capabilities as string[], session_create: { sources, parameters } };
}

export function hermesGatewayWebSocketTarget(endpoint: HermesGatewayEndpoint, ticket: string): { url: string; protocols: string[] } {
  if (!ticket || ticket.length > 512 || /[^A-Za-z0-9._~-]/u.test(ticket))
    throw new HermesGatewayBootstrapError("gateway_ticket_invalid", "Hermes Gateway ticket 格式无效");
  const parsed = validateLoopbackOrigin(endpoint.api_origin);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/api/ws";
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString(), protocols: [HERMES_GATEWAY_WS_PROTOCOL, `${TICKET_PREFIX}${ticket}`] };
}

export async function requestHermesGatewayTicket(endpoint: HermesGatewayEndpoint, options: {
  platform?: NodeJS.Platform; timeoutMs?: number;
} = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
  const controlHome = endpoint.control_home || endpoint.profile_id;
  if (!isAbsolute(controlHome)) throw new HermesGatewayBootstrapError("gateway_control_home_invalid", "Hermes Gateway control home 无效");
  const request = JSON.stringify({ protocol: 1, id: 1, verb: "session-ticket", params: {
    profile_id: endpoint.profile_id, instance_id: endpoint.instance_id, purpose: "interactive",
  } }) + "\n";
  const resolvedControlHome = await realpath(controlHome).catch(() => resolve(controlHome));
  const response = platform === "win32"
    ? await queryControlPipe(hermesGatewayPipeName(resolvedControlHome), request, timeoutMs)
    : await queryUnixControlSocket(resolvedControlHome, request, timeoutMs);
  const frame = asRecord(response);
  const grant = asRecord(frame.result);
  if (frame.ok !== true || frame.protocol !== 1 || frame.id !== 1 ||
    grant.profile_id !== endpoint.profile_id || grant.instance_id !== endpoint.instance_id || grant.runtime_protocol !== 1 ||
    typeof grant.ticket !== "string" || !grant.ticket)
    throw new HermesGatewayBootstrapError("gateway_ticket_denied", "Hermes Gateway 拒绝了本机连接授权");
  return grant.ticket;
}

export function hermesGatewayPipeName(controlHome: string): string {
  const canonical = win32.normalize(win32.resolve(controlHome)).toLowerCase();
  const suffix = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\hermes-gateway-${suffix}`;
}

export async function hermesGatewayUnixControlPath(controlHome: string): Promise<string> {
  const home = await realpath(controlHome).catch(() => resolve(controlHome));
  await assertPrivateNode(home, "directory", true);
  const direct = join(home, "gateway.sock");
  let directInfo;
  try { directInfo = await lstat(direct); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new HermesGatewayBootstrapError("gateway_control_unavailable", "Hermes Gateway 本机控制通道不可用");
  }
  if (directInfo) {
    await assertPrivateNode(direct, "socket");
    return direct;
  }
  const pointer = join(home, "gateway.sock.path");
  let handle;
  try { handle = await open(pointer, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch { throw new HermesGatewayBootstrapError("gateway_control_unavailable", "Hermes Gateway 本机控制通道不可用"); }
  let data: Buffer;
  try {
    const info = await handle.stat();
    assertStat(info, "file", false);
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new HermesGatewayBootstrapError("gateway_control_pointer_invalid", "Hermes Gateway 控制路径无效");
    data = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const targetText = data.toString("utf8").trim();
  if (!isAbsolute(targetText)) throw new HermesGatewayBootstrapError("gateway_control_pointer_invalid", "Hermes Gateway 控制路径无效");
  const target = normalize(targetText);
  const expected = `hermes-gw-${createHash("sha256").update(home, "utf8").digest("hex").slice(0, 16)}`;
  if (target.split(/[\\/]/u).at(-1) !== "control.sock" || target.split(/[\\/]/u).at(-2) !== expected)
    throw new HermesGatewayBootstrapError("gateway_control_pointer_invalid", "Hermes Gateway 控制路径无效");
  await assertPrivateNode(dirname(target), "directory");
  await assertPrivateNode(target, "socket");
  return target;
}

async function queryUnixControlSocket(home: string, request: string, timeoutMs: number): Promise<unknown> {
  const socketPath = await hermesGatewayUnixControlPath(home);
  return queryControlStream(socketPath, request, timeoutMs);
}
async function queryControlPipe(pipePath: string, request: string, timeoutMs: number): Promise<unknown> {
  return queryControlStream(pipePath, request, timeoutMs);
}
async function queryControlStream(path: string, request: string, timeoutMs: number): Promise<unknown> {
  const socket = createConnection(path);
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new HermesGatewayBootstrapError("gateway_control_timeout", "Hermes Gateway 本机授权超时")), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(request));
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_CONTROL_BYTES) return finish(new HermesGatewayBootstrapError("gateway_control_invalid", "Hermes Gateway 本机授权响应过大"));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(buffer.subarray(0, newline).toString("utf8")) as unknown); }
      catch { finish(new HermesGatewayBootstrapError("gateway_control_invalid", "Hermes Gateway 本机授权响应无效")); }
    });
    socket.once("error", () => finish(new HermesGatewayBootstrapError("gateway_control_unavailable", "Hermes Gateway 本机控制通道不可用")));
    socket.once("end", () => { if (!settled) finish(new HermesGatewayBootstrapError("gateway_control_incomplete", "Hermes Gateway 本机授权响应不完整")); });
    socket.once("close", () => { if (!settled) finish(new HermesGatewayBootstrapError("gateway_control_incomplete", "Hermes Gateway 本机授权响应不完整")); });
  });
}

async function assertPrivateNode(path: string, kind: "directory" | "file" | "socket", home = false): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info || (kind === "directory" && !info.isDirectory()) || (kind === "file" && !info.isFile()) ||
    (kind === "socket" && !info.isSocket()) || info.isSymbolicLink())
    throw new HermesGatewayBootstrapError("gateway_control_path_unsafe", "Hermes Gateway 控制路径不安全");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new HermesGatewayBootstrapError("gateway_control_path_unsafe", "Hermes Gateway 控制路径不属于当前用户");
  const disallowed = home ? 0o022 : 0o077;
  if ((info.mode & disallowed) !== 0)
    throw new HermesGatewayBootstrapError("gateway_control_path_unsafe", "Hermes Gateway 控制路径权限不安全");
}
function assertStat(info: Stats, kind: "directory" | "file", home: boolean): void {
  if ((kind === "directory" && !info.isDirectory()) || (kind === "file" && !info.isFile()) ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) || (Number(info.mode) & (home ? 0o022 : 0o077)) !== 0)
    throw new HermesGatewayBootstrapError("gateway_control_pointer_invalid", "Hermes Gateway 控制路径无效");
}

function validateLoopbackOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HermesGatewayBootstrapError("gateway_origin_invalid", "Hermes Gateway 本机地址无效"); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const ipv4Loopback = hostname.startsWith("127.") && hostname.split(".").every(part => /^\d+$/u.test(part) && Number(part) <= 255);
  const ipv6Loopback = hostname === "::1";
  if (!(["http:", "https:"].includes(url.protocol) && (ipv4Loopback || ipv6Loopback) && url.port &&
    !url.username && !url.password && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash))
    throw new HermesGatewayBootstrapError("gateway_origin_not_local", "Hermes Gateway 仅支持本机 profile");
  return url;
}

async function runHermesGatewayAttach(command: HermesGatewayCliCommand, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string> {
  const invocation = agentInvocation(command, ["gateway", "attach", "--json"], env, platform);
  try {
    return (await execFileAsync(invocation.command, invocation.args, { env, timeout: CONTROL_TIMEOUT_MS,
      maxBuffer: MAX_CONTROL_BYTES, windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) })).stdout;
  } catch {
    throw new HermesGatewayBootstrapError("gateway_attach_failed", "未连接到现有 Hermes Gateway");
  }
}

async function runHermesGatewayEnsure(command: HermesGatewayCliCommand, timeoutMs: number, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const invocation = agentInvocation(command, ["gateway", "ensure", "--json", "--timeout", String(Math.ceil(timeoutMs / 1000))], env, platform);
  try {
    const result = await execFileAsync(invocation.command, invocation.args, { env, timeout: timeoutMs + 5_000,
      maxBuffer: MAX_CONTROL_BYTES, windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const item = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (typeof item.stdout === "string" && item.stdout.trim().startsWith("{"))
      return { stdout: item.stdout, stderr: typeof item.stderr === "string" ? item.stderr : "", exitCode: typeof item.code === "number" ? item.code : 1 };
    if (item.code === "ENOENT") throw new HermesGatewayBootstrapError("hermes_command_unavailable", "Hermes Gateway ensure 命令不可用");
    if (item.code === "ETIMEDOUT") throw new HermesGatewayBootstrapError("gateway_start_timeout", "Hermes Gateway 启动超时");
    throw new HermesGatewayBootstrapError("gateway_ensure_failed", "Hermes Gateway ensure 失败");
  }
}

function asRecord(value: unknown): HermesJsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as HermesJsonObject : {}; }
function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== "string" || item.length > 128))
    throw new HermesGatewayBootstrapError("gateway_runtime_invalid", `Hermes Gateway ${field} 无效`);
  return value as string[];
}
function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/iu.test(value) ? value.toLowerCase() : "unavailable";
}
