import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureOpenCodeTuiTabs, openCodeTuiTabsInstalled } from "./opencode-tui-tabs-install.js";

let root: string;
beforeEach(async () => {
  const temp = resolve(tmpdir());
  const directory = await mkdtemp(join(temp, "orbis-opencode-tabs-install-"));
  if (dirname(resolve(directory)) !== temp) throw new Error("Unexpected fixture directory");
  root = directory;
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it("does not write on status checks or when disabling an absent plugin", async () => {
  const env = { XDG_CONFIG_HOME: join(root, "xdg"), OPENCODE_CONFIG_DIR: join(root, "custom") };
  expect(await openCodeTuiTabsInstalled(env)).toBe(false);
  await configureOpenCodeTuiTabs(false, vi.fn(), env);
  await expect(readFile(join(env.OPENCODE_CONFIG_DIR, "plugins", "orbis-opencode-tabs", "package.json")))
    .rejects.toHaveProperty("code", "ENOENT");
});

it("uses the OpenCode config override and never replaces or removes foreign plugin content", async () => {
  const env = { XDG_CONFIG_HOME: join(root, "xdg"), OPENCODE_CONFIG_DIR: join(root, "custom") };
  const foreign = join(env.OPENCODE_CONFIG_DIR, "plugins", "orbis-opencode-tabs");
  await mkdir(foreign, { recursive: true });
  const file = join(foreign, "tui.js");
  await writeFile(file, "export default { id: 'different-plugin' };\n");
  for (const enabled of [true, false]) {
    await expect(configureOpenCodeTuiTabs(enabled, () => {}, env)).rejects.toThrow("非 Orbis 内容");
    expect(await readFile(file, "utf8")).toBe("export default { id: 'different-plugin' };\n");
  }
});

it("does not attempt installation after the local enablement guard is revoked", async () => {
  const env = { XDG_CONFIG_HOME: root };
  const revoked = new Error("revoked");
  await expect(configureOpenCodeTuiTabs(true, () => { throw revoked; }, env)).rejects.toThrow(revoked);
  expect(await openCodeTuiTabsInstalled(env)).toBe(false);
});
