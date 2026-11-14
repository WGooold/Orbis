// ADR-0076 DSH-DESKTOP-01 / 02 / 07: user-visible tiers stay distinct (installed, running elsewhere, attached,
// incompatible, failed), recovery never opens Desktop, and only an explicit request may launch it.
// DSH-DESKTOP-09: the Host UI open brings Orbis's Desktop forward, opens a closed one, and waits out one the
// user opened instead of starting a second owner or terminating it.
import { describe, expect, it, vi } from "vitest";
import type { DshDesktopAttach } from "@orbis/protocol";
import { DSH_DESKTOP_OPEN_FROM_ORBIS, DshDesktopRunningElsewhereError, type DshDesktopInstallation } from "./dsh-desktop-app.js";
import { DshDesktopLifecycle, openDshDesktopFromHost, type DshDesktopLifecycleOptions, type DshDesktopOpenOptions } from "./dsh-desktop-lifecycle.js";
import { DshDesktopProtocolError } from "./dsh-desktop-protocol.js";
import type { DshRuntime } from "./dsh-runtime.js";

const installation: DshDesktopInstallation = { root: "/Applications/DeepSeek Harness.app", executable: "/x", archive: "/y", version: "0.2.2-rc.2" };
const endpoint = { url: "http://127.0.0.1:4000/?token=abcdefghijklmnopq", descriptor: {} as never };
const runtime = { kind: "dshDesktop", isReady: () => true, stop: async () => {} } as unknown as DshRuntime;

function lifecycle(overrides: Partial<DshDesktopLifecycleOptions> = {}) {
  const statuses: DshDesktopAttach[] = [];
  const options: DshDesktopLifecycleOptions = {
    stateDir: "/state", platform: "darwin",
    findInstallation: async () => installation,
    isRunning: async () => false,
    readEndpoint: async () => undefined,
    launch: vi.fn(async () => endpoint),
    prepareProtocol: async () => ({ packageEntry: "/cache/dsh/package.json", dshVersion: "0.2.2-rc.2", fingerprint: "f", files: 1 }),
    connect: vi.fn(async () => runtime),
    onStatusChange: status => { statuses.push(status); },
    ...overrides,
  };
  return { value: new DshDesktopLifecycle(options), options, statuses };
}

function gate<T>() {
  let release!: (value: T) => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<T>(resolve => { release = resolve; });
  return { entered, release, wait: () => { enter(); return pending; } };
}

describe("Desktop lifecycle", () => {
  it("separates unsupported, not installed, closed and running-elsewhere without launching", async () => {
    const unsupported = lifecycle({ platform: "linux" });
    await unsupported.value.probe();
    expect(unsupported.value.status.state).toBe("unsupported");
    expect(await unsupported.value.isInstalled()).toBe(false);
    const missing = lifecycle({ findInstallation: async () => undefined });
    await missing.value.probe();
    expect(missing.value.status).toMatchObject({ state: "notInstalled", version: null });
    const closed = lifecycle();
    await closed.value.probe();
    expect(closed.value.status).toMatchObject({ state: "closed", version: "0.2.2-rc.2" });
    const elsewhere = lifecycle({ isRunning: async () => true });
    await elsewhere.value.probe();
    expect(elsewhere.value.status).toMatchObject({ state: "running", reason: DSH_DESKTOP_OPEN_FROM_ORBIS });
    // A phone request gets the same short state; nothing is launched beside the user's instance.
    await expect(elsewhere.value.ensure()).rejects.toThrow(DSH_DESKTOP_OPEN_FROM_ORBIS);
    expect(elsewhere.options.launch).not.toHaveBeenCalled();
  });

  it("recovers only an Orbis-launched instance and never launches during recovery", async () => {
    const idle = lifecycle();
    expect(await idle.value.connectExisting()).toBeUndefined();
    expect(idle.options.launch).not.toHaveBeenCalled();
    const recovering = lifecycle({ readEndpoint: async () => endpoint });
    expect(await recovering.value.connectExisting()).toBe(runtime);
    expect(recovering.value.status).toMatchObject({ state: "attached", version: "0.2.2-rc.2" });
    expect(recovering.options.launch).not.toHaveBeenCalled();
  });

  it("opens a closed Desktop for an explicit request, then attaches through its own protocol copy", async () => {
    const value = lifecycle();
    expect(await value.value.ensure()).toBe(runtime);
    expect(value.options.launch).toHaveBeenCalledOnce();
    expect(value.options.connect).toHaveBeenCalledWith({ url: endpoint.url, packageEntry: "/cache/dsh/package.json" });
    expect(value.statuses.map(status => status.state)).toEqual(["closed", "attached"]);
    // Concurrent explicit requests share one launch.
    const shared = lifecycle();
    await Promise.all([shared.value.ensure(), shared.value.ensure()]);
    expect(shared.options.launch).toHaveBeenCalledOnce();
  });

  it("reports an unloadable protocol as an incompatible version and a single-instance handoff as running", async () => {
    const incompatible = lifecycle({ prepareProtocol: async () => { throw new DshDesktopProtocolError("缺少协议模块"); } });
    await expect(incompatible.value.ensure()).rejects.toThrow();
    expect(incompatible.value.status).toMatchObject({ state: "incompatible", version: "0.2.2-rc.2" });
    // A later probe keeps the specific tier for the same version.
    await incompatible.value.probe();
    expect(incompatible.value.status.state).toBe("incompatible");
    const handoff = lifecycle({ launch: async () => { throw new DshDesktopRunningElsewhereError("已在运行"); } });
    await expect(handoff.value.ensure()).rejects.toThrow("已在运行");
    expect(handoff.value.status.state).toBe("running");
  });

  it("returns to the observed tier after Orbis's connection drops", async () => {
    const value = lifecycle({ readEndpoint: async () => endpoint });
    await value.value.connectExisting();
    value.options.readEndpoint = async () => undefined;
    value.value.noteOffline("Desktop 已退出");
    await vi.waitFor(() => expect(value.value.status.state).toBe("closed"));
    expect(value.statuses.map(status => status.state)).toEqual(["attached", "error", "closed"]);
  });
  // DSH-DESKTOP-10: stop fences every asynchronous discovery boundary, including
  // a native API connection that completes after its owner has been disposed.
  it.each(["installation", "endpoint", "process", "protocol"])("stops before a late %s result can launch or attach", async stage => {
    const paused = gate<never>();
    const value = lifecycle({
      ...(stage === "installation" ? { findInstallation: paused.wait } : {}),
      ...(stage === "endpoint" ? { readEndpoint: paused.wait } : {}),
      ...(stage === "process" ? { isRunning: paused.wait } : {}),
      ...(stage === "protocol" ? { prepareProtocol: paused.wait } : {}),
    });
    const rejected = expect(value.value.ensure()).rejects.toThrow("正在退出");
    await paused.entered;
    value.value.stop();
    const beforeStop = value.statuses.slice();
    const result = stage === "installation" ? installation : stage === "protocol"
      ? { packageEntry: "/cache", dshVersion: "test", fingerprint: "test", files: 1 } : stage === "process" ? false : undefined;
    paused.release(result as never);
    await rejected;
    if (stage !== "protocol") expect(value.options.launch).not.toHaveBeenCalled();
    expect(value.options.connect).not.toHaveBeenCalled();
    expect(value.statuses).toEqual(beforeStop);
  });

  it("releases a late connection and suppresses its attached status after stop", async () => {
    const paused = gate<DshRuntime>();
    const stop = vi.fn(async () => {});
    const value = lifecycle({ readEndpoint: async () => endpoint, connect: paused.wait });
    const rejected = expect(value.value.ensure()).rejects.toThrow("正在退出");
    await paused.entered; value.value.stop();
    paused.release({ ...runtime, stop } as unknown as DshRuntime);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(value.statuses).toEqual([]);
  });

  it("keeps a pending probe from overwriting an attached or stopped lifecycle", async () => {
    const paused = gate<boolean>();
    const value = lifecycle({ isRunning: paused.wait });
    const probe = value.value.probe();
    await paused.entered;
    value.options.readEndpoint = async () => endpoint;
    await value.value.ensure();
    paused.release(true); await probe;
    expect(value.value.status.state).toBe("attached");
    const finding = gate<typeof installation>();
    const stopped = lifecycle({ findInstallation: finding.wait });
    const pending = stopped.value.probe();
    await finding.entered; stopped.value.stop(); finding.release(installation); await pending;
    expect(stopped.statuses).toEqual([]);
  });

  it("shares an API connection between overlapping recovery and explicit requests", async () => {
    const paused = gate<DshRuntime>();
    const connect = vi.fn(paused.wait);
    const value = lifecycle({ readEndpoint: async () => endpoint, connect });
    const recovered = value.value.connectExisting();
    await paused.entered;
    const explicit = value.value.ensure();
    paused.release(runtime);
    expect(await recovered).toBe(runtime);
    expect(await explicit).toBe(runtime);
    expect(connect).toHaveBeenCalledOnce();
  });

});

describe("Host UI open", () => {
  function opener(overrides: Partial<DshDesktopOpenOptions> = {}) {
    const waiting: boolean[] = [];
    const options: DshDesktopOpenOptions = {
      stateDir: "/state-open", platform: "darwin",
      findInstallation: async () => installation,
      isRunning: async () => false,
      readEndpoint: async () => undefined,
      launch: vi.fn(async () => endpoint),
      reveal: vi.fn(async () => {}),
      onWaiting: value => { waiting.push(value); },
      exitPollMs: 1,
      ...overrides,
    };
    return { options, waiting };
  }

  it("brings Orbis's Desktop forward and opens a closed one", async () => {
    const own = opener({ readEndpoint: async () => endpoint });
    expect(await openDshDesktopFromHost(own.options)).toBe("revealed");
    expect(own.options.reveal).toHaveBeenCalledOnce();
    expect(own.options.launch).not.toHaveBeenCalled();
    const closed = opener();
    expect(await openDshDesktopFromHost(closed.options)).toBe("opened");
    expect(closed.options.launch).toHaveBeenCalledOnce();
    expect(closed.waiting).toEqual([]);
  });

  it("waits for the user to quit a Desktop Orbis did not open, then opens it", async () => {
    const answers = [true, true, true, false];
    const value = opener({ isRunning: vi.fn(async () => answers.shift() ?? false) });
    expect(await openDshDesktopFromHost(value.options)).toBe("opened");
    expect(value.waiting).toEqual([true, false]);
    expect(value.options.launch).toHaveBeenCalledOnce();
    expect(value.options.reveal).not.toHaveBeenCalled();
  });

  it("leaves the user's Desktop as it is when the wait ends or is cancelled", async () => {
    const timedOut = opener({ isRunning: async () => true, exitWaitMs: 5 });
    await expect(openDshDesktopFromHost(timedOut.options)).rejects.toThrow(DSH_DESKTOP_OPEN_FROM_ORBIS);
    expect(timedOut.waiting).toEqual([true, false]);
    expect(timedOut.options.launch).not.toHaveBeenCalled();
    const abort = new AbortController();
    const cancelled = opener({ isRunning: async () => { abort.abort(); return true; }, signal: abort.signal });
    await expect(openDshDesktopFromHost(cancelled.options)).rejects.toThrow();
    expect(cancelled.options.launch).not.toHaveBeenCalled();
  });

  it("reports a missing install without launching", async () => {
    const value = opener({ findInstallation: async () => undefined });
    await expect(openDshDesktopFromHost(value.options)).rejects.toThrow("未找到");
    expect(value.options.launch).not.toHaveBeenCalled();
  });
  // DSH-DESKTOP-10: abort during discovery or the final running→closed query
  // must not reveal or launch Desktop after the Host has already exited.
  it.each(["installation", "endpoint", "process", "exit"])("cancels opening during %s discovery", async stage => {
    const paused = gate<never>();
    const abort = new AbortController();
    let queries = 0;
    const value = opener({ signal: abort.signal,
      ...(stage === "installation" ? { findInstallation: paused.wait } : {}),
      ...(stage === "endpoint" ? { readEndpoint: paused.wait } : {}),
      ...(stage === "process" ? { isRunning: paused.wait } : {}),
      ...(stage === "exit" ? { isRunning: async () => ++queries === 1 ? true : paused.wait() } : {}),
    });
    const rejected = expect(openDshDesktopFromHost(value.options)).rejects.toThrow("已取消");
    await paused.entered; abort.abort();
    paused.release((stage === "installation" ? installation : stage === "endpoint" ? endpoint : false) as never);
    await rejected;
    expect(value.options.launch).not.toHaveBeenCalled();
    expect(value.options.reveal).not.toHaveBeenCalled();
    if (stage === "exit") expect(value.waiting).toEqual([true, false]);
  });

});
