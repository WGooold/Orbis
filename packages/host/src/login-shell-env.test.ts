import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mergeLoginEnvironment, parseLoginEnvironment, readLoginShellEnvironment } from "./login-shell-env.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("login shell environment", () => {
  it("ignores whatever the startup files print around the environment block", () => {
    const block = ["PATH=/opt/tools/bin:/usr/bin", "PI_CODING_AGENT_DIR=/Users/a/pi agent", "MULTI=a\nb"].join("\0");
    expect(parseLoginEnvironment(`Welcome!\n__ORBIS_LOGIN_ENV__${block}\0__ORBIS_LOGIN_ENV__bye`))
      .toEqual({ PATH: "/opt/tools/bin:/usr/bin", PI_CODING_AGENT_DIR: "/Users/a/pi agent", MULTI: "a\nb" });
    expect(parseLoginEnvironment("no markers")).toBeUndefined();
  });

  it("puts the user's PATH first, keeps Host entries, and never overrides explicit values", () => {
    const target: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/bin", "/host/only"].join(delimiter), PI_CODING_AGENT_DIR: "/explicit" };
    mergeLoginEnvironment(target, { PATH: ["/Users/a/.nvm/bin", "/usr/bin"].join(delimiter), PI_CODING_AGENT_DIR: "/from-shell", NVM_DIR: "/Users/a/.nvm", SECRET: "x" });
    expect(target).toEqual({ PATH: ["/Users/a/.nvm/bin", "/usr/bin", "/bin", "/host/only"].join(delimiter), PI_CODING_AGENT_DIR: "/explicit", NVM_DIR: "/Users/a/.nvm" });
  });

  it.runIf(process.platform !== "win32")("reads PATH that only the user's zsh startup files define", async () => {
    const home = await mkdtemp(join(tmpdir(), "orbis-login-env-")); dirs.push(home);
    await writeFile(join(home, ".zprofile"), "echo 'profile noise'\nexport PATH=\"/from/zprofile:$PATH\"\n");
    await writeFile(join(home, ".zshrc"), "echo 'rc noise'\nexport PI_CODING_AGENT_DIR=\"$HOME/custom pi\"\n");
    const env = await readLoginShellEnvironment({ shell: "/bin/zsh", env: { HOME: home, ZDOTDIR: home, PATH: "/usr/bin:/bin" } });
    expect(env?.PATH?.split(":")[0]).toBe("/from/zprofile");
    expect(env?.PI_CODING_AGENT_DIR).toBe(join(home, "custom pi"));
  });

  it.runIf(process.platform !== "win32")("gives up on a shell that hangs instead of blocking Host startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbis-login-hang-")); dirs.push(dir);
    const shell = join(dir, "hang.sh");
    await writeFile(shell, "#!/bin/sh\nsleep 30\n"); await chmod(shell, 0o755);
    const started = Date.now();
    await expect(readLoginShellEnvironment({ shell, timeoutMs: 300 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(readLoginShellEnvironment({ shell: join(dir, "missing-shell") })).resolves.toBeUndefined();
  });
});
