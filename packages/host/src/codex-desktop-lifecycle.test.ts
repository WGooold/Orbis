import { describe, expect, it, vi } from "vitest";

import type { CodexDesktopAttach } from "@orbis/protocol";
import type { CodexAppServer } from "./codex-daemon.js";
import { CodexDesktopLifecycle } from "./codex-desktop-lifecycle.js";

function server() {
  const value = {
    mode: "desktop" as const,
    endpoint: undefined,
    request: vi.fn(async (method: string) => {
      if (method === "model/list" || method === "skills/list" || method === "mcpServerStatus/list" || method === "thread/loaded/list") return { data: [] };
      throw new Error(`unexpected request: ${method}`);
    }),
    notify: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as CodexAppServer;
  return value;
}

function gate<T>() {
  let release!: (value: T) => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<T>(resolve => { release = resolve; });
  return { entered, release, wait: () => { enter(); return pending; } };
}

describe("Codex desktop lifecycle", () => {
  // ADR-0096: an open request for a Codex already running unattached used to wait 45 s and then give a
  // generic reason. It waits only while a wrapper is still starting, then reports the precise cause.
  it("explains a running Desktop without endpoint without holding the request for the full wait", async () => {
    const present = [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }];
    let starting = true;
    const diagnoseNoEndpoint = vi.fn(async () => starting
      ? { status: { state: "closed" as const, reason: "wrapper starting" }, pending: true }
      : { status: { state: "error" as const, reason: "entry owned by another program" } });
    const launchApp = vi.fn(async () => {});
    const lifecycle = new CodexDesktopLifecycle({
      presence: { platform: "win32", resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe", listProcesses: async () => present },
      resolveEndpoint: async () => undefined, launchApp, diagnoseNoEndpoint,
      endpointWaitMs: 10_000, runningWaitMs: 50, pollIntervalMs: 60_000,
    });
    const started = Date.now();
    let settled = false;
    const request = lifecycle.ensureReady().catch((error: unknown) => error).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    starting = false;
    expect(await request).toMatchObject({ message: "entry owned by another program" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(launchApp).toHaveBeenCalledOnce();
    expect(lifecycle.status).toEqual({ state: "error", reason: "entry owned by another program" });
    await lifecycle.stop();
  });

  it("reports the diagnosis while probing a running Desktop without endpoint", async () => {
    const present = [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }];
    const lifecycle = new CodexDesktopLifecycle({
      presence: { platform: "win32", resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe", listProcesses: async () => present },
      resolveEndpoint: async () => undefined,
      diagnoseNoEndpoint: async () => ({ status: { state: "closed", reason: "opened before the entry existed" } }),
      pollIntervalMs: 60_000,
    });
    expect(await lifecycle.probe()).toBeUndefined();
    expect(lifecycle.status).toEqual({ state: "closed", reason: "opened before the entry existed" });
    await lifecycle.stop();
  });

  // ADR-0096: an orphaned backend holds thread writer locks; Host sweeps on its first probe, when the
  // endpoint changes or disappears, and otherwise at most once per interval, never concurrently.
  it("reaps orphaned backends on first probe and endpoint changes, single-flight and throttled", async () => {
    let endpoint: string | undefined = "ws://127.0.0.1:55384";
    let release!: () => void;
    const reapBackends = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const lifecycle = new CodexDesktopLifecycle({
      presence: { platform: "win32", resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe", listProcesses: async () => [] },
      resolveEndpoint: async () => endpoint,
      createExternal: async () => server(),
      reapBackends,
      reapIntervalMs: 60_000,
      pollIntervalMs: 5,
    });
    await lifecycle.probe();
    expect(lifecycle.ready).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    // Still running: polls join it instead of starting another sweep.
    expect(reapBackends).toHaveBeenCalledOnce();
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    // The endpoint is unchanged: the interval applies.
    expect(reapBackends).toHaveBeenCalledOnce();
    endpoint = "ws://127.0.0.1:55385";
    await vi.waitFor(() => expect(reapBackends).toHaveBeenCalledTimes(2), { timeout: 500 });
    release();
    await lifecycle.stop();
  });

  it("reports native recovery immediately instead of waiting or suggesting the same failed launch", async () => {
    const reason = "Orbis 已暂停桌面接入，请自行完全退出并重新打开 Codex";
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: async () => undefined,
      resolveStartupFailure: () => ({ state: "error", reason }), launchApp: async () => {}, endpointWaitMs: 45_000 });
    try {
      expect(await lifecycle.probe()).toBeUndefined();
      expect(lifecycle.status).toEqual({ state: "error", reason });
      await expect(lifecycle.ensureReady()).rejects.toThrow(reason);
      expect(lifecycle.status).toEqual({ state: "error", reason });
    } finally { await lifecycle.stop(); }
  });

  // CODEX-DESKTOP-MAC-RECOVERY-01: working native stdio is a degraded attachment, not a failed Codex launch.
  it("publishes the native fallback as closed, then publishes attached after a successful retry", async () => {
    let endpoint: string | undefined;
    let opened = false;
    const reason = "Codex 已改用原生连接，未接入 Orbis";
    const onStatusChange = vi.fn();
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: async () => endpoint,
      resolveStartupFailure: () => opened ? { state: "closed", reason } : undefined,
      launchApp: async () => { opened = true; }, createExternal: async () => server(), onStatusChange });
    try {
      await expect(lifecycle.ensureReady()).rejects.toThrow(reason);
      expect(lifecycle.status).toEqual({ state: "closed", reason });
      expect(onStatusChange).toHaveBeenLastCalledWith({ state: "closed", reason });
      endpoint = "ws://127.0.0.1:23457";
      await lifecycle.ensureReady();
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "attached" }));
    } finally { await lifecycle.stop(); }
  });

  it("opens Codex locally without making the Open button wait for a mobile attachment", async () => {
    const reason = "Codex 使用原生连接，未接入 Orbis";
    const launchApp = vi.fn(async () => {});
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: async () => undefined,
      resolveStartupFailure: () => ({ state: "closed", reason }), launchApp });
    try {
      await expect(lifecycle.openApp()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(lifecycle.status).toEqual({ state: "closed", reason }));
      expect(launchApp).toHaveBeenCalledOnce();
      expect(lifecycle.ready).toBe(false);
    } finally { await lifecycle.stop(); }
  });

  it("lets a validated retry attach and gives a live endpoint precedence over a recovery marker", async () => {
    let endpoint: string | undefined;
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: async () => endpoint,
      resolveStartupFailure: waiting => waiting ? undefined : { state: "error", reason: "请重新打开 Codex" },
      launchApp: async () => { endpoint = "ws://127.0.0.1:23456"; }, createExternal: async () => server() });
    try {
      expect(await lifecycle.probe()).toBeUndefined();
      await lifecycle.ensureReady();
      expect(lifecycle.status.state).toBe("attached");
    } finally { await lifecycle.stop(); }
  });
  // 端点模式（Orbis 包装器）：接入只看端点，不看守护进程控制套接字——后者在 Windows 上
  // 永远不成立。端点消失/换端口都必须把旧 runtime 摘掉，不能留一个连不上的会话目录。
  it("attaches through the wrapper endpoint and releases it when the endpoint goes away", async () => {
    let endpoint: string | undefined;
    let fail = false;
    const created: Array<{ endpoint: string; stopped: boolean }> = [];
    const present = [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }];
    const lifecycle = new CodexDesktopLifecycle({
      presence: { platform: "win32", resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe", listProcesses: async () => present },
      resolveEndpoint: async () => endpoint,
      createExternal: async (url: string) => {
        if (fail) throw new Error("endpoint refused");
        const record = { endpoint: url, stopped: false };
        created.push(record);
        return {
          mode: "external",
          endpoint: url,
          request: vi.fn(async (method: string) => {
            if (method === "model/list" || method === "skills/list" || method === "mcpServerStatus/list" || method === "thread/loaded/list") return { data: [] };
            throw new Error(`unexpected request: ${method}`);
          }),
          notify: vi.fn(),
          stop: vi.fn(async () => { record.stopped = true; }),
        } as unknown as CodexAppServer;
      },
      pollIntervalMs: 5,
    });

    // 窗口在跑、但没有端点：不是“未打开桌面版”，而是“不是经 Orbis 启动的”。
    expect(await lifecycle.probe()).toBeUndefined();
    expect(lifecycle.status.state).toBe("closed");
    expect(lifecycle.status.reason).toContain("没有可接入的 app-server 端点");

    endpoint = "ws://127.0.0.1:55384";
    await vi.waitFor(() => expect(lifecycle.ready).toBe(true), { timeout: 500 });
    expect(lifecycle.status).toMatchObject({ state: "attached" });
    expect(created.map(record => record.endpoint)).toEqual(["ws://127.0.0.1:55384"]);

    endpoint = undefined;
    await vi.waitFor(() => expect(lifecycle.runtime).toBeUndefined(), { timeout: 500 });
    expect(created[0]?.stopped).toBe(true);
    expect(lifecycle.status.state).toBe("closed");

    // 重连：端点回来（可能换了端口）就要接上新的那个。
    endpoint = "ws://127.0.0.1:55385";
    await vi.waitFor(() => expect(created.length).toBe(2), { timeout: 500 });
    expect(created[1]?.endpoint).toBe("ws://127.0.0.1:55385");

    // 接不上不报成“未接入”：分档必须是 error，并带上真实原因。
    endpoint = "ws://127.0.0.1:55386";
    fail = true;
    await vi.waitFor(() => expect(lifecycle.status.state).toBe("error"), { timeout: 1000 });
    expect(lifecycle.status.reason).toContain("endpoint refused");
    await lifecycle.stop();
  });

  it("attaches a proxy only after the GUI is present", async () => {
    let present = false;
    const createServer = vi.fn(async () => server());
    const statusChanges: CodexDesktopAttach[] = [];
    const lifecycle = new CodexDesktopLifecycle({
      presence: {
        platform: "win32",
        resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe",
        listProcesses: async () => present ? [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }] : [],
      },
      createServer,
      launchApp: async () => { present = true; },
      onStatusChange: status => statusChanges.push(status),
      pollIntervalMs: 5,
    });

    expect(await lifecycle.probe()).toBeUndefined();
    expect(createServer).not.toHaveBeenCalled();
    // 装了但没开窗：必须是 closed（可照做的下一步是“打开”），不是 notInstalled。
    expect(lifecycle.status).toMatchObject({ state: "closed" });
    await lifecycle.ensureReady();
    expect(createServer).toHaveBeenCalledOnce();
    expect(lifecycle.ready).toBe(true);
    expect(lifecycle.status).toMatchObject({ state: "attached" });
    expect(statusChanges.map(change => change.state)).toEqual(["closed", "attached"]);
    await lifecycle.stop();
  });

  it("reports a failed attach, then reports attached again once the daemon answers", async () => {
    const present = true;
    let failing = true;
    const createServer = vi.fn(async () => {
      if (failing) throw new Error("desktop daemon unreachable");
      return server();
    });
    const lifecycle = new CodexDesktopLifecycle({
      presence: {
        platform: "win32",
        resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe",
        listProcesses: async () => present ? [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }] : [],
      },
      createServer,
      pollIntervalMs: 5,
    });

    // GUI 开着但接不上：状态必须停在 error 并带上真实原因，不能报成“未打开桌面版”。
    await expect(lifecycle.probe()).rejects.toThrow("desktop daemon unreachable");
    expect(lifecycle.status.state).toBe("error");
    expect(lifecycle.status.reason).toContain("desktop daemon unreachable");

    // 重连由轮询负责：下一次探测成功就必须把分档改回 attached。
    failing = false;
    await vi.waitFor(() => expect(lifecycle.status.state).toBe("attached"), { timeout: 500 });
    expect(lifecycle.ready).toBe(true);
    await lifecycle.stop();
    expect(lifecycle.status).toMatchObject({ state: "closed" });
  });

  it("keeps probing after startup so a later GUI launch is attached", async () => {
    let present = false;
    const createServer = vi.fn(async () => server());
    const lifecycle = new CodexDesktopLifecycle({
      presence: {
        platform: "win32",
        resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe",
        listProcesses: async () => present ? [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }] : [],
      },
      createServer,
      pollIntervalMs: 5,
    });

    expect(await lifecycle.probe()).toBeUndefined();
    present = true;
    await vi.waitFor(() => expect(createServer).toHaveBeenCalledOnce(), { timeout: 500 });
    expect(lifecycle.ready).toBe(true);
    await lifecycle.stop();
  });

  it("releases the proxy and reports offline when the GUI closes", async () => {
    let present = true;
    const created = server();
    const onOffline = vi.fn();
    const lifecycle = new CodexDesktopLifecycle({
      presence: {
        platform: "win32",
        resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe",
        listProcesses: async () => present ? [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }] : [],
      },
      createServer: async () => created,
      onOffline,
      pollIntervalMs: 5,
    });

    await lifecycle.probe();
    present = false;
    await vi.waitFor(() => expect(onOffline).toHaveBeenCalledOnce(), { timeout: 500 });
    expect(created.stop).toHaveBeenCalledOnce();
    expect(lifecycle.runtime).toBeUndefined();
    // 桌面版关了：手机不能一直看到「已接入」。
    await vi.waitFor(() => expect(lifecycle.status.state).toBe("closed"), { timeout: 500 });
  });
  // HOST-DESKTOP-CANCEL-01: slow presence/endpoint reads and API handshakes
  // are owned by their lifecycle generation; stop stays responsive while they finish.
  it.each(["probe", "ensure"])("fences a late endpoint read from %s after stop", async mode => {
    const endpoint = gate<string | undefined>();
    const launchApp = vi.fn(async () => {}), createExternal = vi.fn(async () => server());
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: endpoint.wait, launchApp, createExternal, pollIntervalMs: 60_000 });
    const pending = mode === "probe" ? lifecycle.probe() : lifecycle.ensureReady();
    const result = pending.catch(error => error);
    await endpoint.entered;
    await lifecycle.stop();
    endpoint.release(mode === "probe" ? "ws://127.0.0.1:1" : undefined);
    if (mode === "probe") expect(await result).toBeUndefined();
    else expect(await result).toBeInstanceOf(Error);
    expect(launchApp).not.toHaveBeenCalled(); expect(createExternal).not.toHaveBeenCalled();
    expect(lifecycle.status.state).toBe("closed");
  });

  it("does not launch after a cancelled native presence scan", async () => {
    const path = gate<string | undefined>();
    const launchApp = vi.fn(async () => {});
    const lifecycle = new CodexDesktopLifecycle({ presence: { platform: "win32", resolveExecutable: path.wait,
      listProcesses: async () => [] }, launchApp, pollIntervalMs: 60_000 });
    const result = lifecycle.ensureReady().catch(error => error);
    await path.entered; await lifecycle.stop(); path.release("C:\\Codex\\ChatGPT.exe");
    expect(await result).toBeInstanceOf(Error);
    expect(launchApp).not.toHaveBeenCalled();
  });

  it("cleans a stale connection without disturbing a resumed generation", async () => {
    const handshake = gate<CodexAppServer>();
    const stale = server(), fresh = server();
    const createExternal = vi.fn().mockImplementationOnce(handshake.wait).mockResolvedValue(fresh);
    const statusChanges: CodexDesktopAttach[] = [];
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: async () => "ws://127.0.0.1:1",
      createExternal, onStatusChange: status => statusChanges.push(status), pollIntervalMs: 60_000 });
    const result = lifecycle.ensureReady().catch(error => error);
    await handshake.entered; await lifecycle.stop();
    const resumed = await lifecycle.ensureReady();
    handshake.release(stale); expect(await result).toBeInstanceOf(Error);
    expect(stale.stop).toHaveBeenCalledOnce(); expect(fresh.stop).not.toHaveBeenCalled();
    expect(lifecycle.runtime).toBe(resumed);
    expect(statusChanges.map(status => status.state)).toEqual(["closed", "attached"]);
    await lifecycle.stop();
  });

  it("releases a mount whose Host callback finishes after stop", async () => {
    const mounting = gate<void>();
    const created = server(), onOffline = vi.fn();
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: async () => "ws://127.0.0.1:1",
      createExternal: async () => created, onReady: mounting.wait, onOffline, pollIntervalMs: 60_000 });
    const result = lifecycle.ensureReady().catch(error => error);
    await mounting.entered; await lifecycle.stop(); mounting.release();
    expect(await result).toBeInstanceOf(Error);
    expect(created.stop).toHaveBeenCalledOnce(); expect(onOffline).toHaveBeenCalledOnce();
    expect(lifecycle.runtime).toBeUndefined(); expect(lifecycle.status.state).toBe("closed");
  });

  it("shares one connection across passive probes and an explicit request", async () => {
    const endpoint = gate<string | undefined>();
    const createExternal = vi.fn(async () => server());
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: endpoint.wait, createExternal, pollIntervalMs: 60_000 });
    const first = lifecycle.probe(), second = lifecycle.probe(), explicit = lifecycle.ensureReady();
    await endpoint.entered; endpoint.release("ws://127.0.0.1:1");
    const values = await Promise.all([first, second, explicit]);
    expect(values[1]).toBe(values[0]); expect(values[2]).toBe(values[0]);
    expect(createExternal).toHaveBeenCalledOnce(); await lifecycle.stop();
  });

  it("does not let an old missing-endpoint poll overwrite a fresh attachment", async () => {
    const presence = gate<string | undefined>();
    const resolveExecutable = vi.fn().mockResolvedValueOnce("C:\\Codex\\ChatGPT.exe").mockImplementation(presence.wait);
    let endpoint: string | undefined;
    const lifecycle = new CodexDesktopLifecycle({ resolveEndpoint: async () => endpoint,
      presence: { platform: "win32", resolveExecutable, listProcesses: async () => [] },
      createExternal: async () => server(), pollIntervalMs: 5 });
    try {
      await lifecycle.probe();
      await presence.entered;
      endpoint = "ws://127.0.0.1:1";
      await lifecycle.ensureReady();
      expect(lifecycle.status.state).toBe("attached");
      presence.release("C:\\Codex\\ChatGPT.exe");
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(lifecycle.ready).toBe(true);
      expect(lifecycle.status.state).toBe("attached");
    } finally { presence.release(undefined); await lifecycle.stop(); }
  });

});
