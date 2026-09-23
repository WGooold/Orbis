import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  E2eError,
  HOST_IDENTITY_FILE,
  emptyDeviceStore,
  findActiveDeviceRecord,
  loadDeviceStore,
  loadOrCreateHostIdentity,
  parseDeviceStore,
  parseHostIdentity,
  revokeDeviceRecord,
  saveDeviceStore,
  serializeDeviceStore,
  upsertDeviceRecord,
  type DeviceRecord,
} from "./index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-remote-e2e-"));
}

describe("Host 身份", () => {
  it("首次读取时生成并落盘，第二次读取拿到同一把密钥", async () => {
    const dir = await tempDir();

    const created = await loadOrCreateHostIdentity({ dir, hostName: "workstation" });
    const reloaded = await loadOrCreateHostIdentity({ dir });

    expect(reloaded.hostId).toBe(created.hostId);
    expect(reloaded.privateRaw.equals(created.privateRaw)).toBe(true);
    expect(reloaded.publicRaw.equals(created.publicRaw)).toBe(true);
  });

  it("公钥与私钥不匹配时直接失败，绝不静默挑一个用", async () => {
    const dir = await tempDir();
    const identity = await loadOrCreateHostIdentity({ dir });
    const stored = JSON.parse(await readFile(join(dir, HOST_IDENTITY_FILE), "utf8")) as Record<string, unknown>;
    stored.hostPub = Buffer.alloc(32, 5).toString("base64url");

    expect(() => parseHostIdentity(JSON.stringify(stored))).toThrowError(E2eError);
    expect(identity.publicRaw.length).toBe(32);
  });

  it("文件读不出来时抛错而不是重建身份（重建等于所有设备失效）", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, HOST_IDENTITY_FILE), "{ not json", "utf8");

    await expect(loadOrCreateHostIdentity({ dir })).rejects.toThrowError(E2eError);
  });
});

describe("设备记录", () => {
  const base: DeviceRecord = {
    deviceId: "device-1",
    devicePub: "pub-1",
    pskRoot: "root-1",
    label: "Pixel 8",
    createdAt: 1_736_745_600,
    revoked: false,
  };

  it("文件不存在时是空集合，不是错误", async () => {
    const store = await loadDeviceStore(await tempDir());
    expect(store.devices).toEqual([]);
  });

  it("写入后读回一致，upsert 不会产生重复条目", async () => {
    const dir = await tempDir();
    const store = emptyDeviceStore();
    upsertDeviceRecord(store, base);
    upsertDeviceRecord(store, { ...base, label: "Pixel 8 Pro" });
    await saveDeviceStore(dir, store);

    const reloaded = await loadDeviceStore(dir);
    expect(reloaded.devices).toHaveLength(1);
    expect(reloaded.devices[0]?.label).toBe("Pixel 8 Pro");
  });

  it("撤销是设备级的：只改那一条，其他设备不受影响", () => {
    const store = emptyDeviceStore();
    upsertDeviceRecord(store, base);
    upsertDeviceRecord(store, { ...base, deviceId: "device-2", pskRoot: "root-2" });

    expect(revokeDeviceRecord(store, "device-1")).toBe(true);
    expect(revokeDeviceRecord(store, "device-1")).toBe(true);
    expect(findActiveDeviceRecord(store, "device-1")).toBeUndefined();
    expect(findActiveDeviceRecord(store, "device-2")?.pskRoot).toBe("root-2");
    expect(store.devices.find((entry) => entry.deviceId === "device-2")?.revoked).toBe(false);
  });

  it("撤销不存在的设备返回 false", () => {
    expect(revokeDeviceRecord(emptyDeviceStore(), "nobody")).toBe(false);
  });

  it("结构坏掉的文件会被拒绝，而不是当成空集合", () => {
    expect(() => parseDeviceStore("{ bad")).toThrowError(E2eError);
    expect(() => parseDeviceStore(JSON.stringify({ version: 1 }))).toThrowError(E2eError);
    expect(parseDeviceStore(serializeDeviceStore(emptyDeviceStore())).devices).toEqual([]);
  });
});
