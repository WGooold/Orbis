/**
 * Host 的配置来源（spec §9 的兼容条）。
 *
 * Relay URL 与 runtime credential 优先读取 Orbis 状态目录下的 config.json。
 * 旧安装仍可回落到 Pi 扩展的 `~/.pi/agent/remote-control.json`。
 * `adminToken` 另算——它只在配对时用来签发设备管道凭据，不进 runtime 通道。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { orbisEnvironment } from "@orbis/protocol";

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
};

export type LoadHostConfigOptions = {
  stateDir: string;
  agentConfigPath?: string;
  env?: Record<string, string | undefined>;
};

export async function loadHostConfig(options: LoadHostConfigOptions): Promise<HostConfig> {
  const env = options.env ?? process.env;
  const hostConfigPath = join(options.stateDir, HOST_CONFIG_FILE);
  const hostConfig = await readJsonFile(hostConfigPath);
  const configuredRelayUrl = orbisEnvironment(env, "RELAY_URL") ?? stringField(hostConfig, "relayUrl");
  const configuredCredential = orbisEnvironment(env, "RUNTIME_CREDENTIAL") ?? stringField(hostConfig, "runtimeCredential");
  const agentConfig = configuredRelayUrl === undefined || configuredCredential === undefined
    ? await readJsonFile(options.agentConfigPath ?? defaultAgentConfigPath())
    : undefined;

  const relayUrl = configuredRelayUrl ?? stringField(agentConfig, "relayUrl");
  const runtimeCredential = configuredCredential ?? stringField(agentConfig, "runtimeCredential");
  const adminToken = orbisEnvironment(env, "ADMIN_TOKEN") ?? stringField(hostConfig, "adminToken");
  const lanPort = numberField(orbisEnvironment(env, "LAN_PORT")) ?? numberField(hostConfig?.["lanPort"]);

  if (relayUrl === undefined) {
    throw new Error(
      `未找到 Relay 地址。请在 ${hostConfigPath} 里配置 relayUrl，或设置 ORBIS_RELAY_URL`,
    );
  }
  if (runtimeCredential === undefined) {
    throw new Error(
      `未找到 runtime credential。请在 ${hostConfigPath} 里配置 runtimeCredential，或设置 ORBIS_RUNTIME_CREDENTIAL`,
    );
  }
  assertRelayUrl(relayUrl);

  return { relayUrl: relayUrl.replace(/\/$/, ""), runtimeCredential, adminToken, lanPort };
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
