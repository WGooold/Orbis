import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { DesktopBridgeSetupError, requestsCodeModeHost, isAppServerInvocation, resolveRealCodex, runBridge } from "./codex-desktop-wrapper.js";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";

describe("Codex desktop wrapper CLI selection", () => {
  it("waits for a failed bridge child to close before allowing stdio fallback", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-bridge-cleanup-"));
    const script = join(root, "server.cjs"), pidFile = join(root, "child.pid");
    await writeFile(script, "require('node:fs').writeFileSync(process.env.TEST_CHILD_PID, String(process.pid)); process.exit(2);");
    await expect(runBridge({ codex: { command: process.execPath, prefixArgs: [script] }, args: ["app-server"],
      endpointFile: join(root, "endpoint.json"), env: { ...process.env, TEST_CHILD_PID: pidFile } })).rejects.toBeInstanceOf(DesktopBridgeSetupError);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("only bridges a real app-server start, not the one-shot startup queries", () => {
    expect(requestsCodeModeHost(["-c", "features.code_mode_host=true", "app-server"])).toBe(true);
    expect(requestsCodeModeHost(["app-server"])).toBe(false);
    expect(requestsCodeModeHost(["--version"])).toBe(false);
    expect(isAppServerInvocation(["app-server"])).toBe(true);
    expect(isAppServerInvocation(["app-server", "--print-startup-config", "--startup-client-info", "{}"])).toBe(false);
  });
});

describe("Codex desktop wrapper CLI selection on macOS", () => {
  it("uses the CLI bundled with the desktop app that launched the wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-codex-mac-"));
    const app = posix.join(root.split(sep).join("/"), "Codex Beta.app");
    const cli = posix.join(app, "Contents", "Resources", "codex-cli", "bin", "codex");
    try {
      await mkdir(join(cli, ".."), { recursive: true });
      await writeFile(cli, "#!/bin/sh\n");
      await expect(resolveRealCodex({}, { platform: "darwin", parentExecutable: async () => posix.join(app, "Contents", "MacOS", "ChatGPT") }))
        .resolves.toEqual({ command: cli, prefixArgs: [] });
      // 显式指定的真实 CLI 仍然优先。
      await expect(resolveRealCodex({ ORBIS_CODEX_REAL: cli }, { platform: "darwin", parentExecutable: async () => undefined }))
        .resolves.toEqual({ command: cli, prefixArgs: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
