import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { requestsCodeModeHost, resolveRealCodex } from "./codex-desktop-wrapper.js";

describe("Codex desktop wrapper CLI selection", () => {
  it("waits for a code-mode-capable runtime when installation races app-server startup", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "orbis-codex-runtime-"));
    const oldRelease = join(localAppData, "OpenAI", "Codex", "bin", "old");
    const newRelease = join(localAppData, "OpenAI", "Codex", "bin", "new");
    try {
      await mkdir(oldRelease, { recursive: true });
      await writeFile(join(oldRelease, "codex.exe"), "old");

      const resolution = resolveRealCodex(
        { LOCALAPPDATA: localAppData },
        { requireCodeModeHost: true, waitMs: 1_000, pollMs: 5, platform: "win32" },
      );
      const installation = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          void (async () => {
            await mkdir(newRelease, { recursive: true });
            await writeFile(join(newRelease, "codex.exe"), "new");
            await writeFile(join(newRelease, "codex-code-mode-host.exe"), "host");
          })().then(resolve, reject);
        }, 20);
      });

      await expect(Promise.all([resolution, installation]).then(([result]) => result)).resolves.toEqual({ command: join(newRelease, "codex.exe"), prefixArgs: [] });
    } finally {
      await rm(localAppData, { recursive: true, force: true });
    }
  });

  it("only requires the helper for app-server invocations that enable code mode", () => {
    expect(requestsCodeModeHost(["-c", "features.code_mode_host=true", "app-server"])).toBe(true);
    expect(requestsCodeModeHost(["app-server"])).toBe(false);
    expect(requestsCodeModeHost(["--version"])).toBe(false);
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
