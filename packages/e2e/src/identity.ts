/**
 * Host 身份与配对记录的落盘（spec §4.4）。
 *
 * 文件放在 `~/.pi-remote/`，与既有的 `~/.pi/agent/remote-control.json`（Relay URL +
 * runtime credential）分开：那一个是 v1 遗留下来的配置源，这里放的是本次新增的
 * Host 私钥与设备记录。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { E2eError } from "./error.js";
import {
  X25519_KEY_BYTES,
  fromBase64UrlFixed,
  generateX25519KeyPair,
  publicRawFromPrivateRaw,
  toBase64Url,
} from "./primitives.js";

export const STATE_DIR_NAME = ".pi-remote";
export const HOST_IDENTITY_FILE = "host.json";
export const DEVICE_STORE_FILE = "devices.json";

export function resolveStateDir(dir?: string): string {
  return dir ?? join(homedir(), STATE_DIR_NAME);
}

export type HostIdentity = {
  /** 随机生成，不带 hostname。 */
  hostId: string;
  /** 仅供显示。 */
  hostName: string;
  privateRaw: Buffer;
  publicRaw: Buffer;
  createdAt: number;
};

type StoredHostIdentity = {
  version: 1;
  hostId: string;
  hostName: string;
  hostPrivate: string;
  hostPub: string;
  createdAt: number;
};

export function serializeHostIdentity(identity: HostIdentity): string {
  const stored: StoredHostIdentity = {
    version: 1,
    hostId: identity.hostId,
    hostName: identity.hostName,
    hostPrivate: toBase64Url(identity.privateRaw),
    hostPub: toBase64Url(identity.publicRaw),
    createdAt: identity.createdAt,
  };
  return `${JSON.stringify(stored, null, 2)}\n`;
}

export function parseHostIdentity(text: string): HostIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new E2eError("malformed", `${HOST_IDENTITY_FILE} 不是合法 JSON`, { cause });
  }
  const stored = raw as Partial<StoredHostIdentity> | null;
  if (stored === null || typeof stored !== "object") {
    throw new E2eError("malformed", `${HOST_IDENTITY_FILE} 内容不是对象`);
  }
  if (stored.version !== 1) {
    throw new E2eError("unsupported_version", `${HOST_IDENTITY_FILE} 版本不受支持：${String(stored.version)}`);
  }
  if (typeof stored.hostId !== "string" || typeof stored.hostName !== "string") {
    throw new E2eError("malformed", `${HOST_IDENTITY_FILE} 缺少 hostId 或 hostName`);
  }
  if (typeof stored.hostPrivate !== "string" || typeof stored.hostPub !== "string") {
    throw new E2eError("malformed", `${HOST_IDENTITY_FILE} 缺少密钥字段`);
  }

  const privateRaw = fromBase64UrlFixed(stored.hostPrivate, X25519_KEY_BYTES, "hostPrivate");
  const publicRaw = fromBase64UrlFixed(stored.hostPub, X25519_KEY_BYTES, "hostPub");

  // 公钥必须与私钥一致。不一致说明文件被改过或写坏了 —— 此时绝不能挑一个继续用，
  // 静默挑错会让整条信任链建立在一个假的 hostPub 上。
  if (!publicRawFromPrivateRaw(privateRaw).equals(publicRaw)) {
    throw new E2eError("malformed", `${HOST_IDENTITY_FILE} 里的 hostPub 与 hostPrivate 不匹配`);
  }

  return {
    hostId: stored.hostId,
    hostName: stored.hostName,
    privateRaw,
    publicRaw,
    createdAt: typeof stored.createdAt === "number" ? stored.createdAt : 0,
  };
}

/**
 * 读 Host 身份；文件不存在则生成一对长期密钥并落盘。
 *
 * 文件存在但读不出来时**直接失败**，绝不静默重建：换了身份等于所有已配对设备全部
 * 失效，那种事必须让用户看到，而不是悄悄换掉。
 */
export async function loadOrCreateHostIdentity(input?: {
  dir?: string;
  hostName?: string;
  now?: number;
}): Promise<HostIdentity> {
  const dir = resolveStateDir(input?.dir);
  const path = join(dir, HOST_IDENTITY_FILE);

  let text: string | null = null;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  if (text !== null) {
    return parseHostIdentity(text);
  }

  const keyPair = generateX25519KeyPair();
  const identity: HostIdentity = {
    hostId: randomUUID(),
    hostName: input?.hostName ?? defaultHostName(),
    privateRaw: keyPair.privateRaw,
    publicRaw: keyPair.publicRaw,
    createdAt: Math.floor((input?.now ?? Date.now()) / 1_000),
  };
  await writePrivateFile(dir, path, serializeHostIdentity(identity));
  return identity;
}

// ───────────────────────────────────────────────────────────────────────────────
// 设备记录
// ───────────────────────────────────────────────────────────────────────────────

export type DeviceRecord = {
  deviceId: string;
  devicePub: string;
  /** 每设备一份，base64url。撤销一台不会牵动其他设备的这一列。 */
  pskRoot: string;
  label: string;
  createdAt: number;
  revoked: boolean;
};

export type DeviceStore = {
  version: 1;
  devices: DeviceRecord[];
};

export function emptyDeviceStore(): DeviceStore {
  return { version: 1, devices: [] };
}

export function parseDeviceStore(text: string): DeviceStore {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new E2eError("malformed", `${DEVICE_STORE_FILE} 不是合法 JSON`, { cause });
  }
  const stored = raw as Partial<DeviceStore> | null;
  if (stored === null || typeof stored !== "object" || !Array.isArray(stored.devices)) {
    throw new E2eError("malformed", `${DEVICE_STORE_FILE} 结构不对`);
  }
  return { version: 1, devices: stored.devices.map(parseDeviceRecord) };
}

function parseDeviceRecord(raw: unknown): DeviceRecord {
  const record = raw as Partial<DeviceRecord> | null;
  if (record === null || typeof record !== "object") {
    throw new E2eError("malformed", "设备记录不是对象");
  }
  if (
    typeof record.deviceId !== "string"
    || typeof record.devicePub !== "string"
    || typeof record.pskRoot !== "string"
  ) {
    throw new E2eError("malformed", "设备记录缺少 deviceId / devicePub / pskRoot");
  }
  return {
    deviceId: record.deviceId,
    devicePub: record.devicePub,
    pskRoot: record.pskRoot,
    label: typeof record.label === "string" ? record.label : "",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    revoked: record.revoked === true,
  };
}

export function serializeDeviceStore(store: DeviceStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

export async function loadDeviceStore(dir?: string): Promise<DeviceStore> {
  const path = join(resolveStateDir(dir), DEVICE_STORE_FILE);
  try {
    return parseDeviceStore(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) {
      return emptyDeviceStore();
    }
    throw error;
  }
}

export async function saveDeviceStore(dir: string, store: DeviceStore): Promise<void> {
  await writePrivateFile(dir, join(dir, DEVICE_STORE_FILE), serializeDeviceStore(store));
}

export function upsertDeviceRecord(store: DeviceStore, record: DeviceRecord): void {
  const index = store.devices.findIndex((entry) => entry.deviceId === record.deviceId);
  const existing = store.devices[index];
  if (existing === undefined) {
    store.devices.push(record);
    return;
  }
  store.devices[index] = record;
}

export function revokeDeviceRecord(store: DeviceStore, deviceId: string): boolean {
  const record = store.devices.find((entry) => entry.deviceId === deviceId);
  if (record === undefined) {
    return false;
  }
  record.revoked = true;
  return true;
}

export function findActiveDeviceRecord(store: DeviceStore, deviceId: string): DeviceRecord | undefined {
  const record = store.devices.find((entry) => entry.deviceId === deviceId);
  if (record === undefined || record.revoked) {
    return undefined;
  }
  return record;
}

// ───────────────────────────────────────────────────────────────────────────────

function defaultHostName(): string {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "workstation";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** 0600 文件 + 0700 目录，并先写临时文件再 rename，避免留下半截文件。 */
async function writePrivateFile(dir: string, path: string, contents: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}
