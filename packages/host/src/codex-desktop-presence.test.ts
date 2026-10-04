import { describe, expect, it } from "vitest";

import { detectCodexDesktopPresence, type CodexDesktopProcess } from "./codex-desktop-presence.js";

const executable = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe";
const process = (overrides: Partial<CodexDesktopProcess> = {}): CodexDesktopProcess => ({
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
      process({ executable: "C:\\Program Files\\node.exe", mainWindowHandle: 0 }),
      process({ executable: "C:\\Program Files\\codex.exe", mainWindowHandle: 0 }),
    ])).resolves.toMatchObject({ ready: false });
  });

  it("requires the installed ChatGPT executable and a visible main window", async () => {
    await expect(detect([process({ executable: "C:\\Other\\ChatGPT.exe" })])).resolves.toMatchObject({ ready: false });
    await expect(detect([process({ mainWindowHandle: 0 })])).resolves.toMatchObject({ ready: false });
    await expect(detect([process()])).resolves.toMatchObject({ ready: true, pid: 42 });
  });

  it("reports unsupported platforms as offline", async () => {
    await expect(detectCodexDesktopPresence({ platform: "linux" })).resolves.toMatchObject({ ready: false });
  });
});
