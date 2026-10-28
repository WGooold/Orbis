import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeIntegrationError, findClaudeExecutable, updateClaudeIntegration, type ClaudeCommandRunner } from "./claude-integration-install.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function recorder(codes: Record<string, number> = {}) {
  const calls: string[][] = [];
  const run: ClaudeCommandRunner = async (_file, args) => {
    calls.push([...args]);
    const key = args.slice(0, 3).join(" ");
    return { code: codes[key] ?? 0, stdout: "", stderr: codes[key] ? "✘ marketplace source is not a directory" : "" };
  };
  return { calls, run };
}

describe("updateClaudeIntegration", () => {
  it("registers the plugin directory as a marketplace and installs at user scope", async () => {
    const { calls, run } = recorder();
    await expect(updateClaudeIntegration({ pluginDir: "/app/runtime/packages/claude-mod", uninstall: false, claude: "/bin/claude", run })).resolves.toBe("installed");
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", "/app/runtime/packages/claude-mod"],
      ["plugin", "install", "orbis-host-session-link@orbis-host", "--scope", "user"],
    ]);
  });

  it("reports Claude's own failure instead of claiming the plugin is installed", async () => {
    const { calls, run } = recorder({ "plugin marketplace add": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/missing", uninstall: false, claude: "/bin/claude", run }))
      .rejects.toThrow(ClaudeIntegrationError);
    expect(calls).toHaveLength(1);
  });

  it("removes plugin and marketplace, tolerating either being absent", async () => {
    const { calls, run } = recorder({ "plugin uninstall orbis-host-session-link@orbis-host": 1, "plugin marketplace remove": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/x", uninstall: true, claude: "/bin/claude", run })).resolves.toBe("removed");
    expect(calls.map(call => call.slice(0, 2).join(" "))).toEqual(["plugin uninstall", "plugin marketplace"]);
  });
});

describe("findClaudeExecutable", () => {
  it("finds claude on PATH and in the native installer's default location", async () => {
    const home = await mkdtemp(join(tmpdir(), "orbis-claude-home-"));
    roots.push(home);
    const local = join(home, ".local", "bin");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "claude"), "#!/bin/sh\n");
    await chmod(join(local, "claude"), 0o755);
    await expect(findClaudeExecutable({ PATH: "/nonexistent" }, "darwin", home)).resolves.toBe(join(local, "claude"));
  });

  it("reports nothing when Claude Code is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "orbis-claude-home-"));
    roots.push(home);
    await expect(findClaudeExecutable({ PATH: home }, "darwin", home)).resolves.toBeUndefined();
  });
});
