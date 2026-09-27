import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { saveCodexSelection } from "./codex-selection.js";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: childProcess.spawn }));
import { runCodexShim, usesHostLaunch } from "./codex-shim.js";
import { renderCodexShim } from "./codex-shim-install.js";

describe("Codex Windows shim", () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); childProcess.spawn.mockReset();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("uses the persisted selection for offline and parameterized launches", async () => {
    root = await mkdtemp(join(tmpdir(), "orbis-shim-choice-"));
    vi.stubEnv("ORBIS_AGENT_INSTALL_ROOT", root);
    vi.stubEnv("ORBIS_CODEX_ENTRY", join(root, "stale.js"));
    const entry = join(root, "codex", "bin", "codex.js");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "");
    await saveCodexSelection(entry);
    expect(JSON.parse(await readFile(join(root, "codex-selection.json"), "utf8")).entry).toBe(entry);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Host offline")));
    childProcess.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    await runCodexShim(["login"]);
    await runCodexShim([]);
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    for (const args of [[entry, "login"], [entry]]) {
      expect(childProcess.spawn.mock.calls.shift()?.slice(0, 2)).toEqual([process.execPath, args]);
    }
  });
  it("only routes an argument-free invocation to Host", () => {
    expect(usesHostLaunch([])).toBe(true);
    expect(usesHostLaunch(["login"])).toBe(false);
    expect(usesHostLaunch(["exec", "echo hi"])).toBe(false);
    expect(usesHostLaunch(["--help"])).toBe(false);
  });

  it("keeps a runtime path with spaces quoted and forwards original arguments", () => {
    const script = renderCodexShim("C:\\Program Files\\Orbis Host\\runtime");
    expect(script).toContain('set "ORBIS_CODEX_RUNTIME=C:\\Program Files\\Orbis Host\\runtime"');
    expect(script).toContain('"%ORBIS_CODEX_RUNTIME%\\packages\\host\\dist\\codex-shim.js" %*');
  });
});
