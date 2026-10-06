import { describe, expect, it } from "vitest";

import { detectCodexDesktopPresence, listCodexDesktopProcesses, type CodexDesktopProcess } from "./codex-desktop-presence.js";

const executable = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe";
// 不叫 `process`：那会遮住 Node 的全局 process，`process.platform` 会被读成一个函数。
const desktopProcess = (overrides: Partial<CodexDesktopProcess> = {}): CodexDesktopProcess => ({
  pid: 42,
  executable,
  mainWindowHandle: 123,
  title: "Codex",
  ...overrides,
});

describe("Codex desktop presence", () => {
  const detect = (processes: readonly CodexDesktopProcess[]) => detectCodexDesktopPresence({
    platform: "win32",
    resolveExecutable: async () => executable,
    listProcesses: async () => processes,
  });

  it("does not treat the daemon or proxy as the desktop app", async () => {
    await expect(detect([
      desktopProcess({ executable: "C:\\Program Files\\node.exe", mainWindowHandle: 0 }),
      desktopProcess({ executable: "C:\\Program Files\\codex.exe", mainWindowHandle: 0 }),
    ])).resolves.toMatchObject({ ready: false });
  });

  it("requires the installed ChatGPT executable and a visible main window", async () => {
    await expect(detect([desktopProcess({ executable: "C:\\Other\\ChatGPT.exe" })])).resolves.toMatchObject({ ready: false });
    await expect(detect([desktopProcess({ mainWindowHandle: 0 })])).resolves.toMatchObject({ ready: false });
    await expect(detect([desktopProcess()])).resolves.toMatchObject({ ready: true, pid: 42 });
  });

  it("reports unsupported platforms as offline", async () => {
    await expect(detectCodexDesktopPresence({ platform: "linux" })).resolves.toMatchObject({ ready: false });
  });

  // 真实回归：这条查询脚本曾经用空格拼接多语句，PowerShell 会把语句边界吃掉，
  // 报错进 stderr、stdout 为空、退出码 0——结果被当成「没有这个进程」，
  // 桌面版开着一律显示未接入。查询失败必须从 stderr 冒出来。
  it.runIf(process.platform === "win32")("runs the real process query without a PowerShell error", async () => {
    const processes = await listCodexDesktopProcesses();
    expect(Array.isArray(processes)).toBe(true);
    for (const found of processes) {
      expect(found.executable.toLowerCase()).toContain("chatgpt.exe");
      expect(Number.isFinite(found.mainWindowHandle)).toBe(true);
    }
  });
});
