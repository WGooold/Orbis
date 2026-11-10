import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "./codex-daemon.js";
import { codexTerminalEnvironment } from "./codex-terminal-environment.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("independent Codex terminal source environment", () => {
  it("removes only the inherited source override and never changes the parent or native home", () => {
    const parent = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop", PATH: "/tools", CODEX_HOME: "/user/codex", CUSTOM_PROVIDER: "kept" };
    expect(codexTerminalEnvironment(parent)).toEqual({ PATH: "/tools", CODEX_HOME: "/user/codex", CUSTOM_PROVIDER: "kept" });
    expect(parent.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe("Codex Desktop");
    expect(codexTerminalEnvironment({ codex_internal_originator_override: "Codex Desktop" })).toEqual({});
  });

  it("passes the clean environment at the actual owned app-server spawn boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-codex-source-env-"));
    try {
      const entry = join(root, "codex.js"); await writeFile(entry, "");
      vi.stubEnv("ORBIS_CODEX_ENTRY", entry);
      vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "Codex Desktop");
      let childEnv: NodeJS.ProcessEnv | undefined;
      await expect(CodexAppServer.create({ resolveTerminalServer: async () => ({ command: "codex-app-server", prefixArgs: [] }),
        spawnImpl: (command, args, options) => {
          expect(command).toBe("codex-app-server");
          expect(args.slice(0, 4)).toEqual(["--session-source", "cli", "-c", "thread_unload_delay_secs=0"]);
          childEnv = options!.env;
          throw new Error("stop before starting fixture");
        } })).rejects.toThrow("stop before starting fixture");
      expect(childEnv).toBeDefined();
      expect(childEnv!.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
      expect(childEnv!.PATH).toBe(process.env.PATH);
      expect(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe("Codex Desktop");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
