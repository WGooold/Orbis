/**
 * 进程激活（spec §8.2 / §8.3 / §8.4）的单元验证。
 *
 * `buildSpawnPlan` 是纯函数，argv 在这里被逐字断言——「手机不能指定命令」这条边界
 * 的物理形态就是这些数组。终端开窗用 mock，macOS 启动脚本用隔离子进程验证。
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hostPlatform = vi.hoisted(() => ({ value: "win32" as NodeJS.Platform }));
vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(), platform: () => hostPlatform.value,
}));

import { buildSpawnPlan, hasDesktopSession, resolvePiCommand, SessionSpawner } from "./spawner.js";

const PI = { command: "node", prefixArgs: ["/pi/cli.js"] };
const EXT = "/pi/ext/index.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  hostPlatform.value = "win32";
  vi.restoreAllMocks();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orbis-spawn-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一份假的 pi JS 入口，返回 `node_modules` 的父目录（即 npm 前缀）。 */
async function fakePiPrefix(root: string, layout: "npm" | "node"): Promise<string> {
  const prefix = layout === "npm" ? join(root, "npm") : root;
  const cliJs = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  await mkdir(join(cliJs, ".."), { recursive: true });
  await writeFile(cliJs, "// fake", "utf8");
  return cliJs;
}

/** 造一个含 `wt.exe` 的目录并在 PATH 里带上它——开窗入口是按 PATH 探的。 */
async function fakeTerminalPath(): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "wt.exe"), "", "utf8");
  return dir;
}

describe("buildSpawnPlan", () => {
  it("L1 继续会话：--session 指向会话文件，-e 显式加载扩展", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "D:/proj/.jsonl" },
      cwd: "D:/proj",
      spawnMode: "headless",
      desktop: true,
    });
    expect(plan.kind).toBe("headless");
    expect(plan.command).toBe("node");
    expect(plan.args).toEqual(["/pi/cli.js", "--session", "D:/proj/.jsonl", "-e", EXT, "--mode", "rpc"]);
    expect(plan.cwd).toBe("D:/proj");
  });

  it("L2 新建：只带 --session-id，不替会话起名", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "new", sessionId: "new-uuid" },
      cwd: "D:/other",
      spawnMode: "headless",
      desktop: false,
    });
    expect(plan.args).toContain("new-uuid");
    expect(plan.args).not.toContain("--name");
    expect(plan.args).toEqual(["/pi/cli.js", "--session-id", "new-uuid", "-e", EXT, "--mode", "rpc"]);
  });

  it("auto + 桌面会话 → wt.exe 的 TUI，不带 --mode rpc", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "D:/proj",
      spawnMode: "auto",
      desktop: true,
      platform: "win32",
    });
    expect(plan.kind).toBe("tui");
    expect(plan.command).toBe("wt.exe");
    expect(plan.args[0]).toBe("-d");
    expect(plan.args).not.toContain("rpc");
  });

  it("auto + 无桌面会话 → 降级 headless（§8.3）", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "D:/proj",
      spawnMode: "auto",
      desktop: false,
      platform: "win32",
    });
    expect(plan.kind).toBe("headless");
    expect(plan.args).toContain("rpc");
  });

  it("headless 是强制档：即使有桌面也不开窗口", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "D:/proj",
      spawnMode: "headless",
      desktop: true,
    });
    expect(plan.kind).toBe("headless");
  });

  it("Linux 未配置终端入口时，auto 使用 headless", () => {
    const plan = buildSpawnPlan({
      pi: { command: "pi", prefixArgs: [] },
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "/tmp/proj",
      spawnMode: "auto",
      desktop: true,
      platform: "linux",
    });
    expect(plan.kind).toBe("headless");
    expect(plan.command).toBe("pi");
  });

  it("显式 tui：没有桌面会话也开窗，不再被 SESSIONNAME 启发式挡住", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "D:/proj",
      spawnMode: "tui",
      desktop: false,
      platform: "win32",
    });
    expect(plan.kind).toBe("tui");
    expect(plan.command).toBe("wt.exe");
  });

  it("显式 tui 但本机没有开窗入口时报错", () => {
    expect(() => buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "D:/proj",
      spawnMode: "tui",
      desktop: true,
      platform: "win32",
      terminal: false,
    })).toThrow(/终端窗口/u);
  });

  it("tui 的命令行整体 base64 进 -EncodedCommand：wt 不再需要解析含空格的路径", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: "C:/my ext/index.ts",
      target: { type: "new", sessionId: "new-uuid" },
      cwd: "D:/my project",
      spawnMode: "tui",
      desktop: true,
      platform: "win32",
      terminal: true,
    });
    expect(plan.args.slice(0, 3)).toEqual(["-d", "D:/my project", "powershell"]);
    expect(plan.args.slice(3, 6)).toEqual(["-NoProfile", "-NoExit", "-EncodedCommand"]);
    const script = Buffer.from(plan.args[6] ?? "", "base64").toString("utf16le");
    // 含空格的部分必须各自还是一个单一 token，靠单引号包住（cwd 走 wt 的 `-d`，不在脚本里）。
    expect(script).toContain(`'${"C:/my ext/index.ts"}'`);
    expect(script).toContain("--session-id");
    expect(script).not.toContain("rpc");
  });

  it("macOS 的显式 tui 使用 Terminal，与 DISPLAY 和 SESSIONNAME 无关", () => {
    const plan = buildSpawnPlan({
      pi: PI, extensionPath: EXT, target: { type: "new", sessionId: "new-uuid" },
      cwd: "/tmp/workspace", spawnMode: "tui", desktop: false, platform: "darwin", scriptFile: "/tmp/Pi launch.command",
    });
    expect(plan.kind).toBe("tui");
    expect(plan.command).toBe("/usr/bin/open");
    expect(plan.args).toEqual(["-a", "Terminal", "/tmp/Pi launch.command"]);
    expect(plan.script).toContain("#!/bin/sh\ncd -- '/tmp/workspace' || exit 1");
    expect(plan.script).toContain("exec /usr/bin/env 'node' '/pi/cli.js'");
    expect(plan.script).not.toContain("--mode");
  });

  it("只有 auto 在没有开窗入口时允许使用 headless", () => {
    const plan = buildSpawnPlan({
      pi: PI, extensionPath: EXT, target: { type: "new", sessionId: "new-uuid" },
      cwd: "/tmp/workspace", spawnMode: "auto", desktop: true, platform: "darwin", terminal: false,
    });
    expect(plan.kind).toBe("headless");
    expect(plan.args).toContain("rpc");
  });

  it("不支持开窗的系统拒绝显式 tui", () => {
    expect(() => buildSpawnPlan({
      pi: PI, extensionPath: EXT, target: { type: "new", sessionId: "new-uuid" },
      cwd: "/tmp/workspace", spawnMode: "tui", desktop: true, platform: "linux",
    })).toThrow(/终端窗口/u);
  });
});

describe("hasDesktopSession", () => {
  it("Windows：SESSIONNAME 存在即有桌面，SSH/服务里没有", () => {
    expect(hasDesktopSession({ SESSIONNAME: "Console" })).toBe(true);
    expect(hasDesktopSession({})).toBe(false);
  });

  it("macOS 本地 Host 不要求 DISPLAY，SSH 不自动开窗", () => {
    hostPlatform.value = "darwin";
    expect(hasDesktopSession({})).toBe(true);
    expect(hasDesktopSession({ SSH_CONNECTION: "remote" })).toBe(false);
    expect(hasDesktopSession({ SSH_TTY: "/dev/ttys1" })).toBe(false);
  });
});

describe("resolvePiCommand", () => {
  it("Windows：APPDATA 下有 pi 的 JS 入口时用 node 直接拉（不经 shell）", async () => {
    const root = await tempDir();
    const cliJs = await fakePiPrefix(root, "npm");

    const command = await resolvePiCommand({ APPDATA: root });
    expect(command.command).toBe(process.execPath);
    expect(command.prefixArgs).toEqual([cliJs]);
  });

  it("Windows：PATH 里更靠前的副本优先，与终端敲 `pi` 的解析一致", async () => {
    // 模拟 nvm-windows 与 npm 全局前缀并存的机器：PATH 里 node 安装根排在前面。
    const nodeRoot = await tempDir();
    const appData = await tempDir();
    const inPath = await fakePiPrefix(nodeRoot, "node");
    const inAppData = await fakePiPrefix(appData, "npm");
    expect(inPath).not.toBe(inAppData);

    const command = await resolvePiCommand({
      PATH: [nodeRoot, join(appData, "npm")].join(delimiter),
      APPDATA: appData,
    });
    expect(command.prefixArgs).toEqual([inPath]);
  });

  it("找不到入口时明确报错，不悄悄退回 shell", async () => {
    const root = await tempDir();
    await expect(resolvePiCommand({ APPDATA: join(root, "empty") })).rejects.toThrow(/pi 的 JS 入口/u);
  });
});

/** 可编程的假 ChildProcess：记下监听器与 spawn 选项，测试里手动触发 exit。 */
function fakeSpawn(): {
  impl: ReturnType<typeof vi.fn>;
  emitExit: (pid: number) => void;
  pids: number[];
  options: Array<{ env?: Record<string, string | undefined> } | undefined>;
} {
  const pids: number[] = [];
  const exits: (() => void)[] = [];
  const options: Array<{ env?: Record<string, string | undefined> } | undefined> = [];
  const impl = vi.fn((_command: unknown, _args: unknown, spawnOptions: { env?: Record<string, string | undefined> } | undefined) => {
    const pid = 1000 + pids.length;
    pids.push(pid);
    options.push(spawnOptions);
    const child = {
      pid,
      stderr: null,
      once: (event: string, listener: () => void) => {
        if (event === "spawn") queueMicrotask(listener);
        if (event === "exit") exits.push(listener);
      },
      unref: () => {},
    } as unknown as ChildProcess;
    return child;
  }) as unknown as ReturnType<typeof vi.fn>;
  return { impl, pids, options, emitExit: (index: number) => exits[index]?.() };
}

describe("SessionSpawner", () => {
  const makeSpawner = (overrides?: { maxRunning?: number; spawnImpl?: unknown }) =>
    new SessionSpawner({
      spawnImpl: overrides?.spawnImpl as never,
      ...(overrides?.maxRunning === undefined ? {} : { maxRunning: overrides.maxRunning }),
      env: { SESSIONNAME: "Console", APPDATA: join(tmpdir(), "orbis-spawn-nonexistent") },
    });

  it("spawn 失败（找不到 pi 入口）报 spawn_failed，并回 protocol.error 的 code", async () => {
    const dir = await tempDir();
    // APPDATA 指向不存在的位置 → resolvePiCommand 抛错
    await expect(
      makeSpawner().activate({ deviceId: "d1", target: { type: "new", agentKind: "pi", cwd: dir } }),
    ).rejects.toMatchObject({ code: "spawn_failed" });
  });

  it("cwd 不存在时报 cwd_missing，不静默换目录（§8.2）", async () => {
    const dir = await tempDir();
    const spawner = new SessionSpawner({ env: {} });
    await expect(
      spawner.activate({
        deviceId: "d1",
        target: { type: "resume", sessionId: "s", cwd: join(dir, "gone"), sessionFile: "f.jsonl" },
      }),
    ).rejects.toMatchObject({ code: "cwd_missing" });
  });

  it("上限到达时报 spawn_limit_reached（§8.4 第 3 条）", async () => {
    const dir = await tempDir();
    const fake = fakeSpawn();

    // resolvePiCommand 会因为 APPDATA 假目录先抛错，所以这里注入一次能用的 pi 入口：
    const cliRoot = await tempDir();
    const cliJs = join(cliRoot, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(cliJs, ".."), { recursive: true });
    await writeFile(cliJs, "// fake", "utf8");
    const spawner2 = new SessionSpawner({
      maxRunning: 1,
      spawnImpl: fake.impl as never,
      env: { SESSIONNAME: "Console", APPDATA: cliRoot, PATH: await fakeTerminalPath() },
    });

    await spawner2.activate({ deviceId: "d1", target: { type: "new", agentKind: "pi", cwd: dir } });
    await expect(
      spawner2.activate({ deviceId: "d1", target: { type: "new", agentKind: "pi", cwd: dir } }),
    ).rejects.toMatchObject({ code: "spawn_limit_reached" });

    // 进程退出后计数释放，又能拉起。
    fake.emitExit(0);
    await vi.waitFor(() => expect(spawner2.running).toHaveLength(0));
    await spawner2.activate({ deviceId: "d1", target: { type: "new", agentKind: "pi", cwd: dir } });
    expect(spawner2.running).toHaveLength(1);
  });

  it("拉起的 agent 带上本 Host 的状态目录：多开的 Host 靠它找到自己的 loopback", async () => {
    const dir = await tempDir();
    const fake = fakeSpawn();
    const cliRoot = await tempDir();
    const cliJs = join(cliRoot, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(cliJs, ".."), { recursive: true });
    await writeFile(cliJs, "// fake", "utf8");
    const stateDir = join(dir, "rig-state");
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { SESSIONNAME: "Console", APPDATA: cliRoot, PATH: await fakeTerminalPath() },
      stateDir,
    });
    await spawner.activate({ deviceId: "d1", target: { type: "new", agentKind: "pi", cwd: dir } });
    expect(fake.options[0]?.env).toMatchObject({ ORBIS_STATE_DIR: stateDir, APPDATA: cliRoot });
  });

  it("同一会话重复 resume 只拉起一次：先发现，再决定拉不拉", async () => {
    const dir = await tempDir();
    const fake = fakeSpawn();
    const cliRoot = await tempDir();
    const cliJs = join(cliRoot, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(cliJs, ".."), { recursive: true });
    await writeFile(cliJs, "// fake", "utf8");
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { SESSIONNAME: "Console", APPDATA: cliRoot, PATH: await fakeTerminalPath() },
    });
    const target = { type: "resume" as const, sessionId: "s-1", cwd: dir, sessionFile: join(dir, "s.jsonl") };

    const first = await spawner.activate({ deviceId: "d1", target });
    const second = await spawner.activate({ deviceId: "d1", target });

    // 手机重复点同一个会话，不该在电脑上堆出第二个打开同一会话的进程。
    expect(fake.pids).toHaveLength(1);
    expect(second.pid).toBe(first.pid);
    expect(spawner.running).toHaveLength(1);
  });

  it("`new` 不去重：每次都是新会话，各自一个进程", async () => {
    const dir = await tempDir();
    const fake = fakeSpawn();
    const cliRoot = await tempDir();
    const cliJs = join(cliRoot, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(cliJs, ".."), { recursive: true });
    await writeFile(cliJs, "// fake", "utf8");
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { SESSIONNAME: "Console", APPDATA: cliRoot, PATH: await fakeTerminalPath() },
    });

    const a = await spawner.activate({ deviceId: "d1", target: { type: "new", agentKind: "pi", cwd: dir } });
    const b = await spawner.activate({ deviceId: "d1", target: { type: "new", agentKind: "pi", cwd: dir } });

    expect(fake.pids).toHaveLength(2);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("进程退出后，同一会话可以重新拉起", async () => {
    const dir = await tempDir();
    const fake = fakeSpawn();
    const cliRoot = await tempDir();
    const cliJs = join(cliRoot, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(cliJs, ".."), { recursive: true });
    await writeFile(cliJs, "// fake", "utf8");
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { SESSIONNAME: "Console", APPDATA: cliRoot, PATH: await fakeTerminalPath() },
    });
    const target = { type: "resume" as const, sessionId: "s-1", cwd: dir, sessionFile: join(dir, "s.jsonl") };

    await spawner.activate({ deviceId: "d1", target });
    fake.emitExit(0);
    await vi.waitFor(() => expect(spawner.running).toHaveLength(0));

    await spawner.activate({ deviceId: "d1", target });
    expect(fake.pids).toHaveLength(2);
  });

  it("spawn 出来的 argv 是数组且不经 shell（§8.4 第 2 条）", async () => {
    const dir = await tempDir();
    const cliRoot = await tempDir();
    const cliJs = await fakePiPrefix(cliRoot, "npm");
    const terminal = await fakeTerminalPath();
    const fake = fakeSpawn();
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { SESSIONNAME: "Console", APPDATA: cliRoot, PATH: terminal },
    });

    const record = await spawner.activate({
      deviceId: "d1",
      target: { type: "new", agentKind: "pi", cwd: dir },
    });
    expect(record.sessionId).toBeDefined();
    expect(record.spawnMode).toBe("tui");
    const call = (fake.impl as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(call[0]).toBe("wt.exe");
    const args = call[1] as string[];
    expect(Array.isArray(args)).toBe(true);
    // pi 的入口与全部参数都在 base64 token 里：wt 一个含空格的路径都不用解析。
    const encoded = args[args.indexOf("-EncodedCommand") + 1] ?? "";
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain(`'${cliJs}'`);
    expect(script).toContain("-e");
    // 计数与退出监听
    expect(spawner.running).toHaveLength(1);
    fake.emitExit(0);
    await vi.waitFor(() => expect(spawner.running).toHaveLength(0));
  });

  it("显式 tui：Host 在没有 SESSIONNAME 的会话里照样开窗", async () => {
    const dir = await tempDir();
    const cliRoot = await tempDir();
    await fakePiPrefix(cliRoot, "npm");
    const terminal = await fakeTerminalPath();
    const fake = fakeSpawn();
    // 从服务 / 计划任务 / IDE 内部启动的 Host 没有 SESSIONNAME——`auto` 会在这里
    // 误判成无头，而手机明确要窗口时不该受影响。
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { APPDATA: cliRoot, PATH: terminal },
    });

    const record = await spawner.activate({
      deviceId: "d1",
      target: { type: "new", agentKind: "pi", cwd: dir },
      spawnMode: "tui",
    });
    expect(record.spawnMode).toBe("tui");
    expect((fake.impl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("wt.exe");
  });

  it("缺省（旧 APK 不发 spawnMode）也开窗：无头不该是默认", async () => {
    const dir = await tempDir();
    const cliRoot = await tempDir();
    await fakePiPrefix(cliRoot, "npm");
    const terminal = await fakeTerminalPath();
    const fake = fakeSpawn();
    // 旧 APK 根本不发 spawnMode，且 Host 从 IDE 内部启动、没有 SESSIONNAME。
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { APPDATA: cliRoot, PATH: terminal },
    });

    const record = await spawner.activate({
      deviceId: "d1",
      target: { type: "new", agentKind: "pi", cwd: dir },
    });
    expect(record.spawnMode).toBe("tui");
  });

  it("stdin 必须保持打开：pi 的 rpc 模式读到 EOF 会干净退出", async () => {
    const dir = await tempDir();
    const cliRoot = await tempDir();
    await fakePiPrefix(cliRoot, "npm");
    const fake = fakeSpawn();
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { APPDATA: cliRoot },
    });

    await spawner.activate({
      deviceId: "d1",
      target: { type: "new", agentKind: "pi", cwd: dir },
      spawnMode: "headless",
    });
    // `"ignore"` 会让子进程的 stdin 立刻 EOF，pi 随后自己退出（exit 0）：
    // 进程被记成「拉起成功」却永远不会注册回来，手机上表现为「点了没反应」。
    expect((fake.options[0] as { stdio?: unknown }).stdio).toEqual(["pipe", "ignore", "pipe"]);
  });

  it("缺少终端时拒绝默认有头启动，不创建 RPC 进程", async () => {
    const dir = await tempDir();
    const cliRoot = await tempDir();
    await fakePiPrefix(cliRoot, "npm");
    const fake = fakeSpawn();
    const spawner = new SessionSpawner({ spawnImpl: fake.impl as never, env: { APPDATA: cliRoot, PATH: "" } });
    await expect(spawner.activate({ deviceId: "phone", target: { type: "new", agentKind: "pi", cwd: dir } }))
      .rejects.toMatchObject({ code: "spawn_failed" });
    expect(fake.impl).not.toHaveBeenCalled();
    expect(spawner.running).toHaveLength(0);
  });
});

describe.runIf(process.platform === "darwin")("macOS phone activation", () => {
  it.each(["new", "resume"] as const)("%s opens the requested session with the Host routing and tracks Pi's PID", async type => {
    hostPlatform.value = "darwin";
    const root = await tempDir();
    const cwd = join(root, "工作区's $HOME; project");
    await mkdir(cwd);
    const entry = join(root, "Pi tools's.js");
    const capture = join(root, "capture.json");
    await writeFile(entry, `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
        cwd: process.cwd(), args: process.argv.slice(2), pid: process.pid,
        stateDir: process.env.ORBIS_STATE_DIR, legacyStateDir: process.env.PI_REMOTE_STATE_DIR,
        configDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH,
        hostOnly: process.env.ORBIS_HOST_ONLY_TEST,
      }));
      setInterval(() => {}, 1000);
    `);
    const processes: ChildProcess[] = [];
    const launcher = vi.fn((_command: string, args: readonly string[], options: SpawnOptions) => {
      // Emulate Terminal executing the supplied script. This exercises real exec,
      // quoting, argv, environment and PID handoff without automating the user's desktop.
      const pi = spawn("/bin/sh", [args[2]!], { cwd: options.cwd, env: {}, stdio: "ignore" });
      processes.push(pi);
      cleanups.push(async () => {
        if (pi.exitCode !== null || pi.signalCode !== null) return;
        const exited = new Promise<void>(resolve => pi.once("exit", () => resolve()));
        pi.kill();
        await exited;
      });
      const child = Object.assign(new EventEmitter(), { pid: 999_999, stderr: null });
      pi.once("spawn", () => child.emit("close", 0));
      pi.once("error", error => child.emit("error", error));
      return child;
    });
    const stateDir = join(root, "Host's state");
    const configDir = join(root, "Pi config");
    const extension = join(root, "extension's $HOME; index.js");
    const spawner = new SessionSpawner({
      spawnImpl: launcher as never, stateDir,
      env: { ORBIS_PI_ENTRY: entry, ORBIS_EXTENSION_PATH: extension,
        PI_CODING_AGENT_DIR: configDir, PATH: "/usr/bin:/bin", ORBIS_HOST_ONLY_TEST: "private" },
    });
    const target = type === "new"
      ? { type: "new" as const, agentKind: "pi" as const, cwd }
      : { type: "resume" as const, sessionId: "existing-session", cwd, sessionFile: join(root, "session's $HOME.jsonl") };
    const input = { deviceId: "phone", target, spawnMode: "tui" as const };
    const record = await spawner.activate(input);
    const realCwd = await realpath(cwd);
    expect(record.spawnMode).toBe("tui");
    expect(record.pid).toBe(processes[0]!.pid);
    expect(record.pid).not.toBe(999_999);
    expect(launcher.mock.calls[0]![0]).toBe("/usr/bin/open");
    expect(launcher.mock.calls[0]![2]).toMatchObject({ shell: false, timeout: 15_000 });
    await vi.waitFor(async () => {
      const captured = JSON.parse(await readFile(capture, "utf8"));
      expect(captured).toMatchObject({ cwd: realCwd, pid: record.pid, stateDir, legacyStateDir: stateDir, configDir, path: "/usr/bin:/bin" });
      expect(captured.hostOnly).toBeUndefined();
      expect(captured.args).toEqual(type === "new"
        ? ["--session-id", record.sessionId, "-e", extension]
        : ["--session", target.type === "resume" ? target.sessionFile : "", "-e", extension]);
    });
    expect(spawner.running).toHaveLength(1);
    if (type === "resume") {
      expect(await spawner.activate(input)).toEqual(record);
      expect(launcher).toHaveBeenCalledTimes(1);
    }
    const handshakeName = launcher.mock.calls[0]![1][2]!.match(/orbis-pi-terminal-[A-Za-z0-9]+/u)?.[0];
    expect(handshakeName).toBeDefined();
    await expect(stat(join(tmpdir(), handshakeName!))).rejects.toMatchObject({ code: "ENOENT" });
    processes[0]!.kill();
    await vi.waitFor(() => expect(spawner.running).toHaveLength(0));
  });

  it("a failed Terminal launch reports spawn_failed without a headless retry", async () => {
    hostPlatform.value = "darwin";
    const dir = await tempDir();
    const launcher = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { stderr: null });
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });
    const spawner = new SessionSpawner({ spawnImpl: launcher as never, env: {} });
    await expect(spawner.activate({ deviceId: "phone", target: { type: "new", agentKind: "pi", cwd: dir } }))
      .rejects.toMatchObject({ code: "spawn_failed", message: expect.stringContaining("终端") });
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(spawner.running).toHaveLength(0);
  });
});
