/**
 * 进程激活（spec §8.2 / §8.3 / §8.4）的单元验证。
 *
 * `buildSpawnPlan` 是纯函数，argv 在这里被逐字断言——「手机不能指定命令」这条边界
 * 的物理形态就是这些数组。真实 spawn 用 mock，不开真进程。
 */
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSpawnPlan, hasDesktopSession, resolvePiCommand, SessionSpawner } from "./spawner.js";

const PI = { command: "node", prefixArgs: ["/pi/cli.js"] };
const EXT = "/pi/ext/index.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-spawn-"));
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
      posix: false,
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
      posix: false,
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

  it("POSIX 没有「开终端」的通用入口，auto 直接 headless", () => {
    const plan = buildSpawnPlan({
      pi: { command: "pi", prefixArgs: [] },
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "/tmp/proj",
      spawnMode: "auto",
      desktop: true,
      posix: true,
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
      posix: false,
    });
    expect(plan.kind).toBe("tui");
    expect(plan.command).toBe("wt.exe");
  });

  it("显式 tui 但本机没有开窗入口 → 降级 headless，不假装开过窗", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: EXT,
      target: { type: "resume", sessionId: "abc", sessionFile: "f.jsonl" },
      cwd: "D:/proj",
      spawnMode: "tui",
      desktop: true,
      posix: false,
      terminal: false,
    });
    expect(plan.kind).toBe("headless");
    expect(plan.args).toContain("rpc");
  });

  it("tui 的命令行整体 base64 进 -EncodedCommand：wt 不再需要解析含空格的路径", () => {
    const plan = buildSpawnPlan({
      pi: PI,
      extensionPath: "C:/my ext/index.ts",
      target: { type: "new", sessionId: "new-uuid" },
      cwd: "D:/my project",
      spawnMode: "tui",
      desktop: true,
      posix: false,
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
});

describe("hasDesktopSession", () => {
  it("Windows：SESSIONNAME 存在即有桌面，SSH/服务里没有", () => {
    expect(hasDesktopSession({ SESSIONNAME: "Console" })).toBe(true);
    expect(hasDesktopSession({})).toBe(false);
  });
});

describe("resolvePiCommand", () => {
  it("Windows：APPDATA 下有 pi 的 JS 入口时用 node 直接拉（不经 shell）", async () => {
    const root = await tempDir();
    const cliJs = await fakePiPrefix(root, "npm");

    const command = await resolvePiCommand({ APPDATA: root });
    if (process.platform === "win32") {
      expect(command.command).toBe(process.execPath);
      expect(command.prefixArgs).toEqual([cliJs]);
    } else {
      // 非 Windows 上不走 .cmd 规避逻辑
      expect(command.command).toBe("pi");
    }
  });

  it("Windows：PATH 里更靠前的副本优先，与终端敲 `pi` 的解析一致", async () => {
    if (process.platform !== "win32") return;
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
    if (process.platform !== "win32") return;
    await expect(resolvePiCommand({ APPDATA: join(root, "empty") })).rejects.toThrow(/pi 的 JS 入口/u);
  });
});

/** 可编程的假 ChildProcess：记下监听器与 spawn 选项，测试里手动触发 exit。 */
function fakeSpawn(): {
  impl: ReturnType<typeof vi.fn>;
  emitExit: (pid: number) => void;
  pids: number[];
  options: unknown[];
} {
  const pids: number[] = [];
  const exits: (() => void)[] = [];
  const options: unknown[] = [];
  const impl = vi.fn((_command: unknown, _args: unknown, spawnOptions: unknown) => {
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
      env: { SESSIONNAME: "Console", APPDATA: join(tmpdir(), "pi-remote-spawn-nonexistent") },
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
      env: { SESSIONNAME: "Console", APPDATA: cliRoot },
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

  it("同一会话重复 resume 只拉起一次：先发现，再决定拉不拉", async () => {
    const dir = await tempDir();
    const fake = fakeSpawn();
    const cliRoot = await tempDir();
    const cliJs = join(cliRoot, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(cliJs, ".."), { recursive: true });
    await writeFile(cliJs, "// fake", "utf8");
    const spawner = new SessionSpawner({
      spawnImpl: fake.impl as never,
      env: { SESSIONNAME: "Console", APPDATA: cliRoot },
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
      env: { SESSIONNAME: "Console", APPDATA: cliRoot },
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
      env: { SESSIONNAME: "Console", APPDATA: cliRoot },
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
});
