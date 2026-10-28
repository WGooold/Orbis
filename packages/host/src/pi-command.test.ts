import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { PI_COMMAND_MARK, findForeignPi, renderMacPiCommand, renderWindowsPiCommand } from "./pi-command.js";
import { activePiEntry } from "./pi-shim.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function managedPi(root: string, versions: Array<{ id: string; active: boolean; output: string }>): Promise<void> {
  const installations = [];
  for (const version of versions) {
    const entry = join(root, "pi", version.id, "cli.js");
    await mkdir(join(root, "pi", version.id), { recursive: true });
    await writeFile(entry, `console.log(${JSON.stringify(version.output)}, JSON.stringify(process.argv.slice(2)));\n`);
    installations.push({ id: version.id, kind: "pi", version: "1.0.0", entry, installedAt: "2026-10-28T00:00:00.000Z", active: version.active });
  }
  await writeFile(join(root, "pi", "installations.json"), JSON.stringify({ version: 1, installations }));
}

describe("terminal pi command", () => {
  it.runIf(process.platform !== "win32")("always runs the currently active managed Pi with the original arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis pi's root-")); dirs.push(root);
    await managedPi(root, [{ id: "old", active: false, output: "old" }, { id: "new", active: true, output: "new" }]);
    const script = join(root, "pi-command");
    await writeFile(script, renderMacPiCommand(process.execPath, root), { mode: 0o755 });
    await expect(run(script, ["--print", "it's \"quoted\""])).resolves.toMatchObject({ stdout: `new ${JSON.stringify(["--print", "it's \"quoted\""])}\n` });
    // Pi 升级或回滚只改安装记录；命令不需要重新生成。
    await managedPi(root, [{ id: "old", active: true, output: "old" }, { id: "new", active: false, output: "new" }]);
    await expect(run(script, [])).resolves.toMatchObject({ stdout: "old []\n" });
  });

  it.runIf(process.platform !== "win32")("works without a node on PATH and explains a missing Host or Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-pi-missing-")); dirs.push(root);
    await managedPi(root, [{ id: "a", active: true, output: "ran" }]);
    const script = join(root, "pi-command");
    await writeFile(script, renderMacPiCommand(process.execPath, root), { mode: 0o755 });
    await expect(run(script, [], { env: { PATH: "/usr/bin:/bin" } })).resolves.toMatchObject({ stdout: "ran []\n" });

    await writeFile(script, renderMacPiCommand(join(root, "deleted", "node"), root), { mode: 0o755 });
    await expect(run(script, [], { env: { PATH: "/usr/bin:/bin" } })).rejects.toMatchObject({ code: 127, stderr: expect.stringContaining("Orbis Host 可能已被移动或删除") });

    await writeFile(join(root, "pi", "installations.json"), JSON.stringify({ version: 1, installations: [] }));
    await writeFile(script, renderMacPiCommand(process.execPath, root), { mode: 0o755 });
    await expect(run(script, [])).rejects.toMatchObject({ code: 127, stderr: expect.stringContaining("没有可用的 Pi") });
  });

  it("marks generated files so only Orbis's own command is ever replaced or removed", () => {
    expect(renderMacPiCommand("/n", "/r")).toContain(PI_COMMAND_MARK);
    const windows = renderWindowsPiCommand("C:\\Program Files\\Orbis Host\\runtime", "C:\\Users\\x\\AppData\\Local\\Orbis\\agents");
    expect(windows).toContain(PI_COMMAND_MARK);
    expect(windows).toContain('"C:\\Program Files\\Orbis Host\\runtime\\node\\node.exe" "C:\\Program Files\\Orbis Host\\runtime\\packages\\host\\dist\\pi-shim.js" %*');
  });

  it("reads the active entry the same way on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-pi-shim-")); dirs.push(root);
    await managedPi(root, [{ id: "a", active: false, output: "a" }, { id: "b", active: true, output: "b" }]);
    expect(activePiEntry(root)).toBe(join(root, "pi", "b", "cli.js"));
    await rm(join(root, "pi", "b", "cli.js"));
    expect(activePiEntry(root)).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("steps aside for any pi the user already has on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbis-foreign-pi-")); dirs.push(dir);
    const own = join(dir, "own"); const ours = join(dir, "ours");
    await mkdir(own); await mkdir(ours);
    await writeFile(join(ours, "pi"), renderMacPiCommand("/n", "/r")); await chmod(join(ours, "pi"), 0o755);
    expect(await findForeignPi({ PATH: ours }, "darwin")).toBeUndefined();
    await writeFile(join(own, "pi"), "#!/bin/sh\n"); await chmod(join(own, "pi"), 0o755);
    expect(await findForeignPi({ PATH: [ours, own].join(":") }, "darwin")).toBe(join(own, "pi"));
    // 不可执行的同名文件不算命令。
    await chmod(join(own, "pi"), 0o644);
    expect(await findForeignPi({ PATH: own }, "darwin")).toBeUndefined();
  });
});
