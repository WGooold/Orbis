import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayServer, type RelayServer } from "@orbis/relay";
import { HostService, type HostServiceOptions } from "./host-service.js";
import { DshRuntime } from "./dsh-runtime.js";
import type { DshConnection } from "./dsh-client.js";
import { DshDesktopLifecycle } from "./dsh-desktop-lifecycle.js";
import type { DshWebConnection } from "./dsh-web-client.js";
import { DSH_DESKTOP_FLAVOR } from "./dsh-web-runtime.js";

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

async function host(options: Pick<HostServiceOptions, "recoverDshRuntime" | "ensureDshRuntime" | "recoverDshDesktopRuntime" | "dshDesktopStatus" | "onDshDesktopOffline" | "log">) {
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

// ADR-0076 DSH-DESKTOP-01: `onOffline` reports both a single Session leaving and the whole connection ending.
// Only the latter ends the Desktop attachment; a Session leaving used to pin the tier at `error` for good,
// because the still-ready backend short-circuits every recovery path.
describe("Desktop attachment tier", () => {
  function desktop(root: string) {
    let workspace: (value: unknown) => void = () => {};
    const row = (sessionId: string) => ({ sessionId, cwd: root, agentAvailable: true, running: true, updatedAt: 1000 });
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: (async (method: string) => method === "session/list" ? { items: [row("first"), row("second")] } : {}) as DshWebConnection["request"],
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      subscribe(method, _args, frame) {
        if (method === "workspace/follow") { workspace = frame; queueMicrotask(() => frame({ type: "baseline", value: { archivedSessionIds: [] } })); }
        if (method === "session/follow") queueMicrotask(() => frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: -1, records: [], assistantStream: { revision: 0 } }));
        return () => {};
      },
    };
    const value = new DshRuntime(client, undefined, { flavor: DSH_DESKTOP_FLAVOR });
    runtimes.push(value);
    return { value, client, archive: (...ids: string[]) => workspace({ type: "archived", archivedSessionIds: ids }),
      ids: () => value.directoryEntries().map(item => item.runtimeId).sort() };
  }

  async function attached() {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-desktop-tier-")); roots.push(root);
    const first = desktop(root), next = desktop(root);
    const connect = vi.fn<() => Promise<DshRuntime>>().mockResolvedValueOnce(first.value).mockResolvedValueOnce(next.value);
    const states: string[] = [];
    const lifecycle = new DshDesktopLifecycle({ stateDir: root, platform: "darwin", connect,
      findInstallation: async () => ({ root: "/x", executable: "/x", archive: "/y", version: "0.2.2-rc.2" }),
      isRunning: async () => true, readEndpoint: async () => ({ url: "http://127.0.0.1:4000/", descriptor: {} as never }),
      prepareProtocol: async () => ({ packageEntry: "/p", dshVersion: "0.2.2-rc.2", fingerprint: "f", files: 1 }),
      onStatusChange: status => { states.push(status.state); } });
    const value = await host({ recoverDshDesktopRuntime: () => lifecycle.connectExisting(),
      dshDesktopStatus: () => lifecycle.status, onDshDesktopOffline: reason => lifecycle.noteOffline(reason) });
    expect(await value.recoverDshRuntime("dshDesktop")).toBe(first.value);
    await vi.waitFor(() => expect(first.ids()).toEqual(["dsh-desktop:first", "dsh-desktop:second"]));
    expect(lifecycle.status.state).toBe("attached");
    return { value, first, next, connect, lifecycle, states };
  }

  it.each(["archived in Desktop", "removed from Desktop", "closed from the App"])("stays attached when one Session is %s", async how => {
    const f = await attached();
    if (how === "archived in Desktop") f.first.archive("first");
    else if (how === "removed from Desktop") f.first.client.onEvent?.({ type: "emit", event: "api-session/removed", args: ["first"] });
    else f.first.value.dispatchCommand("dsh-desktop:first", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(f.first.ids()).toEqual(["dsh-desktop:second"]));
    await f.lifecycle.probe();
    expect(f.first.value.isReady()).toBe(true);
    expect(f.states).toEqual(["attached"]);
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it("reports a lost connection and attaches again through recovery", async () => {
    const f = await attached();
    f.first.client.onExit?.("Desktop 已退出");
    expect(f.lifecycle.status).toMatchObject({ state: "error", reason: expect.stringContaining("Desktop 已退出") });
    expect(await f.value.recoverDshRuntime("dshDesktop")).toBe(f.next.value);
    expect(f.lifecycle.status.state).toBe("attached");
    expect(f.connect).toHaveBeenCalledTimes(2);
  });
});
