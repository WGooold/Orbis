import { describe, expect, it, vi } from "vitest";

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

describe("Codex desktop lifecycle", () => {
  it("attaches a proxy only after the GUI is present", async () => {
    let present = false;
    const createServer = vi.fn(async () => server());
    const lifecycle = new CodexDesktopLifecycle({
      presence: {
        platform: "win32",
        resolveExecutable: async () => "C:\\Codex\\ChatGPT.exe",
        listProcesses: async () => present ? [{ pid: 1, executable: "C:\\Codex\\ChatGPT.exe", mainWindowHandle: 1, title: "Codex" }] : [],
      },
      createServer,
      launchApp: async () => { present = true; },
      pollIntervalMs: 5,
    });

    expect(await lifecycle.probe()).toBeUndefined();
    expect(createServer).not.toHaveBeenCalled();
    await lifecycle.ensureReady();
    expect(createServer).toHaveBeenCalledOnce();
    expect(lifecycle.ready).toBe(true);
    await lifecycle.stop();
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
  });
});
