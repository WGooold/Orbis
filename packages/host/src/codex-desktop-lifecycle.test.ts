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
