import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayServer, type RelayServer } from "@orbis/relay";
import { HostService, type HostServiceOptions } from "./host-service.js";
import { DshRuntime } from "./dsh-runtime.js";
import type { DshConnection } from "./dsh-client.js";

const roots: string[] = [];
const hosts: HostService[] = [];
const relays: RelayServer[] = [];
const runtimes: DshRuntime[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const relay of relays.splice(0)) await relay.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function runtime() {
  const client: DshConnection = {
    onNotification: undefined, onRequest: undefined, onExit: undefined,
    request: vi.fn(async () => ({ sessions: [] })), notify: vi.fn(), stop: vi.fn(async () => {}),
  };
  const value = new DshRuntime(client, {
    list: async () => [], read: async id => ({ header: { id, cwd: tmpdir(), createdAt: 1 }, events: [] }), close: async () => {},
  });
  runtimes.push(value);
  const start = vi.spyOn(value, "start");
  const stop = vi.spyOn(value, "stop");
  return { value, client, start, stop };
}

async function host(options: Pick<HostServiceOptions, "recoverDshRuntime" | "ensureDshRuntime" | "log">) {
  const root = await mkdtemp(join(tmpdir(), "orbis-dsh-recovery-")); roots.push(root);
  const relay = await createRelayServer({ runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret" }); relays.push(relay);
  const value = await HostService.create({ ...options, stateDir: root, sessionsRoot: join(root, "sessions"),
    relayUrl: relay.url, credential: "runtime-secret", reconnect: false, lan: false });
  hosts.push(value);
  return value;
}

describe("automatic DSH bridge recovery", () => {
  it.each(["absent", "failure"])("retries an initially %s service and stops probing once the bridge is ready", async initial => {
    const f = runtime();
    const recover = vi.fn<() => Promise<DshRuntime | undefined>>()
      .mockImplementationOnce(async () => { if (initial === "failure") throw new Error("temporary authentication failure"); return undefined; })
      .mockResolvedValue(f.value);
    const launch = vi.fn(async () => { throw new Error("passive recovery cannot launch a backend"); });
    const value = await host({ recoverDshRuntime: recover, ensureDshRuntime: launch });
    await value.start();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    expect(f.start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(await value.recoverDshRuntime()).toBe(f.value);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it("shares an in-flight recovery across callers and attaches exactly once", async () => {
    const f = runtime(), opening = deferred<DshRuntime | undefined>();
    const recover = vi.fn(() => opening.promise);
    const value = await host({ recoverDshRuntime: recover });
    const requests = Array.from({ length: 8 }, () => value.recoverDshRuntime());
    expect(recover).toHaveBeenCalledTimes(1);
    opening.resolve(f.value);
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 8 }, () => f.value));
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("replaces a terminally disconnected client through the fresh service descriptor path", async () => {
    const first = runtime(), next = runtime();
    const recover = vi.fn<() => Promise<DshRuntime | undefined>>()
      .mockResolvedValueOnce(first.value).mockResolvedValueOnce(next.value);
    const value = await host({ recoverDshRuntime: recover });
    expect(await value.recoverDshRuntime()).toBe(first.value);
    first.client.onExit?.("authentication token replaced");
    expect(first.value.isReady()).toBe(false);
    expect(await value.recoverDshRuntime()).toBe(next.value);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(next.start).toHaveBeenCalledTimes(1);
    expect(next.client.request).not.toHaveBeenCalled();
  });

  it("waits for and closes a late connection when the Host is paused during recovery", async () => {
    const f = runtime(), opening = deferred<DshRuntime | undefined>();
    const recover = vi.fn(() => opening.promise);
    const value = await host({ recoverDshRuntime: recover });
    const pending = value.recoverDshRuntime();
    const stopping = value.stop();
    opening.resolve(f.value);
    expect(await pending).toBeUndefined();
    await stopping;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(await value.recoverDshRuntime()).toBeUndefined();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("closes a bridge whose discovery finishes after the Host is paused", async () => {
    const f = runtime(), discovery = deferred<void>();
    f.start.mockImplementation(() => discovery.promise);
    const value = await host({ recoverDshRuntime: async () => f.value });
    const pending = value.recoverDshRuntime();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    const stopping = value.stop();
    discovery.resolve();
    expect(await pending).toBeUndefined();
    await stopping;
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
});
