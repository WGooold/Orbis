/**
 * Host 的配置来源（spec §9 的兼容条）。
 *
 * Relay URL 与 runtime credential **复用 v1 的** `~/.pi/agent/remote-control.json`：
 * Host 在 Relay 眼里就是一个普通 runtime，接管一个 runtimeId 即可，Relay 侧零改动。
 * `adminToken` 另算——它只在配对时用来签发设备管道凭据，不进 runtime 通道。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOST_CONFIG_FILE = "config.json";

export function defaultAgentConfigPath(): string {
  return join(homedir(), ".pi", "agent", "remote-control.json");
}

export type HostConfig = {
  relayUrl: string;
  runtimeCredential: string;
  /** 缺省时 `pair` 会明确报错，`host` 仍然可用（它不需要签发设备凭据）。 */
  adminToken: string | undefined;
  /**
   * LAN 监听端口。缺省时用 `DEFAULT_LAN_PORT`（见 `lan-server.ts` 为什么要固定）。
   */
  lanPort: number | undefined;
  /**
   * P2P 打洞用的 STUN 服务器（spec §6.1 M5，如 "stun://stun.example.com:3478"）。
   * 缺省从 relayUrl 的主机名推（同一个部署自带的 stun 端口），也可以显式覆盖。
   */
  stunServers: readonly string[];
};

export type LoadHostConfigOptions = {
  stateDir: string;
  agentConfigPath?: string;
  env?: Record<string, string | undefined>;
};

export async function loadHostConfig(options: LoadHostConfigOptions): Promise<HostConfig> {
  const env = options.env ?? process.env;
  const agentConfig = await readJsonFile(options.agentConfigPath ?? defaultAgentConfigPath());
  const hostConfig = await readJsonFile(join(options.stateDir, HOST_CONFIG_FILE));

  const relayUrl = env.PI_REMOTE_RELAY_URL ?? stringField(agentConfig, "relayUrl");
  const runtimeCredential = env.PI_REMOTE_RUNTIME_CREDENTIAL ?? stringField(agentConfig, "runtimeCredential");
  const adminToken = env.PI_REMOTE_ADMIN_TOKEN ?? stringField(hostConfig, "adminToken");
  const lanPort = numberField(env.PI_REMOTE_LAN_PORT) ?? numberField(hostConfig?.["lanPort"]);
  const stunServers =
    env.PI_REMOTE_STUN_SERVERS?.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0) ??
    stringArrayField(hostConfig, "stunServers") ??
    defaultStunServers(relayUrl);

  if (relayUrl === undefined) {
    throw new Error(
      `未找到 Relay 地址。请在 ${options.agentConfigPath ?? defaultAgentConfigPath()} 里配置 relayUrl，或设置 PI_REMOTE_RELAY_URL`,
    );
  }
  if (runtimeCredential === undefined) {
    throw new Error(
      `未找到 runtime credential。请在 ${options.agentConfigPath ?? defaultAgentConfigPath()} 里配置 runtimeCredential，或设置 PI_REMOTE_RUNTIME_CREDENTIAL`,
    );
  }
  assertRelayUrl(relayUrl);

  return { relayUrl: relayUrl.replace(/\/$/, ""), runtimeCredential, adminToken, lanPort, stunServers };
}

/**
 * 默认 STUN：与 Relay 同主机的 3478 端口（部署侧随 relay 一起跑 stun 容器）。
 * 本地/内网 relay 没有公网地址，打洞没有意义，返回空表——P2P 自动不启用。
 */
export function defaultStunServers(relayUrl: string | undefined): readonly string[] {
  if (relayUrl === undefined) return [];
  try {
    const url = new URL(relayUrl);
    if (url.protocol !== "wss:" && url.protocol !== "https:") return [];
    // The official HTTPS hostname is proxied; STUN uses the UDP origin directly.
    const host = url.hostname === "orbising.com" ? "74.81.55.191" : url.hostname;
    return [`stun://${host}:3478`];
  } catch {
    return [];
  }
}

function stringArrayField(source: Record<string, unknown> | undefined, key: string): readonly string[] | undefined {
  const value = source?.[key];
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * 把 Relay 的 WebSocket 地址换成同一个服务的 HTTP 基址。
 *
 * 只有配对码那两个端点是 HTTP，其余全部走 WS；两者必须指向同一个部署，
 * 所以从 relayUrl 推而不是再配一份。
 */
export function relayHttpBase(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString().replace(/\/$/, "");
}

function assertRelayUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`relayUrl 不是合法 URL：${value}`);
  }
  if (url.protocol === "wss:") return;
  if (url.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return;
  throw new Error("公网 Relay 必须使用 wss:// 加密传输");
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 环境变量传进来的一律是字符串，配置文件里的才是数字，两种都收。 */
function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0 && parsed <= 65_535) return parsed;
  }
  return undefined;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
  } catch (cause) {
    throw new Error(`${path} 不是合法 JSON`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} 的内容不是对象`);
  }
  return parsed as Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
