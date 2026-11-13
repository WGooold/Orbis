// ADR-0076 DSH-DESKTOP-01 / 02 / 07: user-visible tiers stay distinct (installed, running elsewhere, attached,
// incompatible, failed), recovery never opens Desktop, and only an explicit request may launch it.
import { describe, expect, it, vi } from "vitest";
import type { DshDesktopAttach } from "@orbis/protocol";
import { DshDesktopRunningElsewhereError, type DshDesktopInstallation } from "./dsh-desktop-app.js";
import { DshDesktopLifecycle, type DshDesktopLifecycleOptions } from "./dsh-desktop-lifecycle.js";
import { DshDesktopProtocolError } from "./dsh-desktop-protocol.js";
import type { DshRuntime } from "./dsh-runtime.js";

const installation: DshDesktopInstallation = { root: "/Applications/DeepSeek Harness.app", executable: "/x", archive: "/y", version: "0.2.2-rc.2" };
const endpoint = { url: "http://127.0.0.1:4000/?token=abcdefghijklmnopq", descriptor: {} as never };
const runtime = { kind: "dshDesktop" } as unknown as DshRuntime;

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
    expect(elsewhere.value.status.state).toBe("running");
    await expect(elsewhere.value.ensure()).rejects.toThrow("不是由 Orbis 打开");
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
});
