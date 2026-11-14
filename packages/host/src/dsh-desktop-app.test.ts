// ADR-0076 DSH-DESKTOP-01 / 02 / 07: Desktop is discovered independently of any CLI on PATH, Orbis reads
// the endpoint only of a Desktop it launched itself, a Desktop opened elsewhere is reported as such, and
// nothing here terminates Desktop. The fake executable stands in for Electron forwarding Host stdout.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DshDesktopRunningElsewhereError, findDshDesktopInstallation, inspectDshDesktopInstallation, latestDshDesktopUrl, launchDshDesktop,
  pendingDshDesktopLaunch, readDshDesktopEndpoint, revealDshDesktop, dshDesktopLaunchEnvironment,
} from "./dsh-desktop-app.js";
import { writeAsarFixture } from "./fixtures/asar-fixture.js";

const roots: string[] = [];
const pids: number[] = [];
const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  for (const close of servers.splice(0)) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const temp = async () => { const root = await mkdtemp(join(tmpdir(), "orbis-dsh-desktop-app-")); roots.push(root); return root; };

const archiveFiles = (version = "0.2.2-rc.2") => ({
  "dsh/node_modules/@deepseek-ai/dsh/package.json": JSON.stringify({ name: "@deepseek-ai/dsh", version }),
  "dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json": JSON.stringify({ name: "@deepseek-ai/dsh-desktop-host", version }),
});

async function install(root: string, platform: "darwin" | "win32", executable = "#!/bin/sh\nexit 0\n", files: Parameters<typeof writeAsarFixture>[1] = archiveFiles()) {
  const paths = platform === "darwin"
    ? { executable: join(root, "Contents", "MacOS", "DeepSeek Harness"), archive: join(root, "Contents", "Resources", "app.asar") }
    : { executable: join(root, "DeepSeek Harness.exe"), archive: join(root, "resources", "app.asar") };
  await mkdir(join(paths.executable, ".."), { recursive: true });
  await writeFile(paths.executable, executable);
  await chmod(paths.executable, 0o755);
  await writeAsarFixture(paths.archive, files);
  return paths;
}

/** Answers the root launch-token exchange like DSH: 303 plus a `dsh-auth-*` cookie only for the current token. */
async function tokenEndpoint(tokens: Set<string>) {
  const server = createServer((request, response) => {
    const token = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token");
    if (token && tokens.has(token)) response.writeHead(303, { Location: "./", "Set-Cookie": "dsh-auth-abc=v1.x.y; Path=/; HttpOnly" });
    else response.writeHead(401);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as AddressInfo).port;
}

describe("Desktop installation discovery", () => {
  it("accepts only an executable plus an archive that carries dsh and the Desktop Host, including spaced CJK paths", async () => {
    const root = join(await temp(), "程序 目录", "DeepSeek Harness.app");
    await install(root, "darwin");
    expect(await inspectDshDesktopInstallation(root, "darwin")).toMatchObject({ root, version: "0.2.2-rc.2" });
    const npmOnly = join(await temp(), "npm-only.app");
    await install(npmOnly, "darwin", undefined, { "dsh/node_modules/@deepseek-ai/dsh/package.json": "{\"version\":\"1.0.0\"}" });
    expect(await inspectDshDesktopInstallation(npmOnly, "darwin")).toBeUndefined();
  });

  it("finds Windows installs from the uninstall registry and the per-user Programs folder, never from PATH", async () => {
    const local = await temp();
    const registered = join(await temp(), "自定义 位置");
    await install(registered, "win32");
    const programs = join(local, "Programs", "deepseek-harness");
    await install(programs, "win32", undefined, archiveFiles("0.2.3"));
    const env = { LOCALAPPDATA: local, PATH: "" };
    expect((await findDshDesktopInstallation({ platform: "win32", env, registryInstallLocations: async () => [registered] }))?.root).toBe(registered);
    expect((await findDshDesktopInstallation({ platform: "win32", env, registryInstallLocations: async () => { throw new Error("denied"); } }))?.version).toBe("0.2.3");
    // An explicit choice never falls back to another install.
    expect(await findDshDesktopInstallation({ platform: "win32", env, explicitPath: join(local, "missing"), registryInstallLocations: async () => [registered] })).toBeUndefined();
    expect(await findDshDesktopInstallation({ platform: "linux", env })).toBeUndefined();
  });

  // A Desktop on an external volume used to be reported as not installed (only the two Applications folders were read).
  it("finds a macOS bundle anywhere by bundle ID, skipping trashed copies and preferring a writable one", async () => {
    const applications = await temp();
    const external = join(await temp(), "外置 盘", "Applications", "DeepSeek Harness.app");
    await install(external, "darwin");
    const trashed = join(await temp(), ".Trash", "DeepSeek Harness.app");
    await install(trashed, "darwin", undefined, archiveFiles("0.2.1"));
    const image = join(await temp(), "DeepSeek Harness.app");
    await install(image, "darwin", undefined, archiveFiles("0.2.0"));
    await chmod(image, 0o555);
    try {
      const bundleLocations = vi.fn(async () => [trashed, image, external]);
      const options = { platform: "darwin" as const, env: {}, applicationFolders: [applications], bundleLocations };
      expect(await findDshDesktopInstallation(options)).toMatchObject({ root: external, version: "0.2.2-rc.2" });
      expect(await findDshDesktopInstallation({ ...options, bundleLocations: async () => { throw new Error("osascript"); } })).toBeUndefined();
      // The usual folders are used without starting a LaunchServices / Spotlight query.
      const standard = join(applications, "DeepSeek Harness.app");
      await install(standard, "darwin", undefined, archiveFiles("0.2.3"));
      bundleLocations.mockClear();
      expect((await findDshDesktopInstallation(options))?.root).toBe(standard);
      expect(bundleLocations).not.toHaveBeenCalled();
    } finally { await chmod(image, 0o755); }
  });
});

describe.skipIf(process.platform === "win32")("Orbis-owned Desktop launch", () => {
  // DSH-DESKTOP-10: the public open call returns before mkdir/open finish;
  // cancellation in that gap must reach the actual process-spawn boundary.
  it("does not spawn when its owner cancels during launch preparation", async () => {
    const abort = new AbortController();
    const state = await temp();
    const spawnDesktop = vi.fn(() => { throw new Error("unexpected Desktop launch"); }) as unknown as typeof spawn;
    const pending = launchDshDesktop({ root: "/test", executable: "/test/app", archive: "/test/archive", version: "test" },
      state, { signal: abort.signal, spawnDesktop });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnDesktop).not.toHaveBeenCalled();
    expect(pendingDshDesktopLaunch(state)).toBeUndefined();
  });

  it.each([false, true])("keeps an independent shared-launch caller valid when its owner cancels (caller cancelled=%s)", async cancelled => {
    const port = await tokenEndpoint(new Set(["retry-token-abcdefghijkl"]));
    const root = join(await temp(), "DeepSeek Harness.app");
    const state = await temp();
    await install(root, "darwin", `#!/bin/sh\necho "dsh web: http://127.0.0.1:${port}/?token=retry-token-abcdefghijkl"\nexec sleep 30\n`);
    const installation = (await inspectDshDesktopInstallation(root, "darwin"))!;
    const owner = new AbortController(), caller = new AbortController();
    const counting = vi.fn((...args: Parameters<typeof spawn>) => spawn(...args)) as unknown as typeof spawn;
    const original = launchDshDesktop(installation, state, { signal: owner.signal, spawnDesktop: counting }).catch(error => error);
    const joined = launchDshDesktop(installation, state, { signal: caller.signal, spawnDesktop: counting }).catch(error => error);
    owner.abort(); if (cancelled) caller.abort();
    expect(await original).toBe(owner.signal.reason);
    const result = await joined;
    if (cancelled) {
      expect(result).toBe(caller.signal.reason); expect(counting).not.toHaveBeenCalled();
    } else {
      expect(result).not.toBeInstanceOf(Error);
      pids.push(result.descriptor.pid);
      expect(counting).toHaveBeenCalledOnce();
      expect(result.url).toContain("retry-token");
    }
    expect(pendingDshDesktopLaunch(state)).toBeUndefined();
  });

  it("captures the forwarded URL in a private log, records only Orbis's instance and keeps Node switches out of Desktop", async () => {
    const tokens = new Set(["first-token-abcdefghijkl"]);
    const port = await tokenEndpoint(tokens);
    const root = join(await temp(), "DeepSeek Harness.app");
    const state = await temp();
    // Electron main forwards Host stdout; the fake also proves which environment Desktop received.
    const { executable } = await install(root, "darwin", `#!/bin/sh\necho "node-mode=\${ELECTRON_RUN_AS_NODE:-unset}"\necho "dsh web: http://127.0.0.1:${port}/?token=first-token-abcdefghijkl"\nexec sleep 30\n`);
    const installation = (await inspectDshDesktopInstallation(root, "darwin"))!;
    const endpoint = await launchDshDesktop(installation, state, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect" }, timeoutMs: 10_000 });
    pids.push(endpoint.descriptor.pid);
    expect(endpoint.url).toBe(`http://127.0.0.1:${port}/?token=first-token-abcdefghijkl`);
    expect(endpoint.descriptor.executable).toBe(executable);
    expect(await readFile(endpoint.descriptor.logPath, "utf8")).toContain("node-mode=unset");
    expect((await stat(endpoint.descriptor.logPath)).mode & 0o077).toBe(0);
    expect((await stat(join(state, "dsh-desktop", "endpoint.json"))).mode & 0o077).toBe(0);
    // A Host restart reuses the descriptor; a Desktop Host restart is followed through its newest URL.
    expect((await readDshDesktopEndpoint(state, installation))?.url).toBe(endpoint.url);
    tokens.clear(); tokens.add("second-token-abcdefghijk");
    await writeFile(endpoint.descriptor.logPath, `dsh web: http://127.0.0.1:${port}/?token=second-token-abcdefghijk\n`, { flag: "a" });
    expect((await readDshDesktopEndpoint(state, installation))?.url).toContain("second-token");
    // Another install of Desktop is a different instance.
    const other = join(await temp(), "Other.app");
    await install(other, "darwin");
    expect(await readDshDesktopEndpoint(state, (await inspectDshDesktopInstallation(other, "darwin"))!)).toBeUndefined();
  });

  it("reports a Desktop already running elsewhere instead of starting a second owner", async () => {
    const root = join(await temp(), "DeepSeek Harness.app");
    await install(root, "darwin", "#!/bin/sh\nexit 0\n");
    const installation = (await inspectDshDesktopInstallation(root, "darwin"))!;
    await expect(launchDshDesktop(installation, await temp(), { timeoutMs: 10_000 })).rejects.toBeInstanceOf(DshDesktopRunningElsewhereError);
  });

  // DSH-DESKTOP-09: the Host UI and an App request may open Desktop at the same moment; a second spawn would
  // replace the shared log and endpoint record with a single-instance handoff process.
  it("shares one Orbis launch per state directory", async () => {
    const port = await tokenEndpoint(new Set(["shared-token-abcdefghijk"]));
    const root = join(await temp(), "DeepSeek Harness.app");
    const state = await temp();
    await install(root, "darwin", `#!/bin/sh\nsleep 0.3\necho "dsh web: http://127.0.0.1:${port}/?token=shared-token-abcdefghijk"\nexec sleep 30\n`);
    const installation = (await inspectDshDesktopInstallation(root, "darwin"))!;
    let spawned = 0;
    const counting = ((...args: Parameters<typeof spawn>) => { spawned += 1; return spawn(...args); }) as typeof spawn;
    const first = launchDshDesktop(installation, state, { timeoutMs: 10_000, spawnDesktop: counting });
    expect(pendingDshDesktopLaunch(state)).toBe(first);
    const [a, b] = await Promise.all([first, launchDshDesktop(installation, state, { timeoutMs: 10_000, spawnDesktop: counting })]);
    pids.push(a.descriptor.pid);
    expect(spawned).toBe(1);
    expect(b.descriptor.pid).toBe(a.descriptor.pid);
    expect(pendingDshDesktopLaunch(state)).toBeUndefined();
  });

  it("brings Desktop forward through a detached handoff launch that writes no endpoint record", async () => {
    const root = join(await temp(), "DeepSeek Harness.app");
    const marker = join(await temp(), "handoff");
    await install(root, "darwin", `#!/bin/sh\necho "\${ELECTRON_RUN_AS_NODE:-unset}" > "${marker}"\n`);
    const installation = (await inspectDshDesktopInstallation(root, "darwin"))!;
    const state = await temp();
    await revealDshDesktop(installation, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("unset\n"));
    expect(await readDshDesktopEndpoint(state, installation)).toBeUndefined();
  });

  it("returns the newest URL in the log and never a malformed one", async () => {
    const root = await temp();
    const log = join(root, "out.log");
    await writeFile(log, "noise\ndsh web: http://127.0.0.1:1/?token=aaaaaaaaaaaaaaaaaa\nlater\ndsh web: http://127.0.0.1:2/?token=bbbbbbbbbbbbbbbbbb\ndsh web: http://example.com/?token=cccccccccccccccccc\n");
    expect(await latestDshDesktopUrl(log)).toBe("http://127.0.0.1:2/?token=bbbbbbbbbbbbbbbbbb");
    expect(await latestDshDesktopUrl(join(root, "missing.log"))).toBeUndefined();
    expect(dshDesktopLaunchEnvironment({ A: "1", ORBIS_DSH_PROVIDER_ENV: "{}", ORBIS_DSH_WEB_URL: "x" })).toEqual({ A: "1" });
  });
});
