/**
 * 进程激活（spec §8 的 M3 / Node 侧）。
 *
 * 职责边界（§8.4 第 1 条）：Host 的职责是**起 agent**，不是执行命令——手机只递
 * `sessionId` 或 `{ agentKind, cwd }`，argv 由这里构造。spawn 一律 argv 数组 +
 * `shell: false`（§8.4 第 2 条），常驻进程数有上限（第 3 条），每次激活记一行日志。
 *
 * 被拉起的进程不需要 Host 任何后续管理：TUI 的输入输出归用户，headless / TUI 的
 * Pi 都会经 loopback 自己注册回来（`runtime.online`），Host 只跟踪 pid 用于上限，
 * 外加一条「同一会话不重复拉起」的去重（手机可能重复点同一个会话）。
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { AgentKind, SpawnMode } from "@orbis/protocol";
import { orbisEnvironment } from "@orbis/protocol";

/** 激活失败的原因码，一对一映射到 `protocol.error` 的 `code`。 */
export type ActivationErrorCode =
  | "session_not_found"
  | "cwd_missing"
  | "spawn_limit_reached"
  | "spawn_failed"
  | "agent_unsupported";

export class ActivationError extends Error {
  readonly code: ActivationErrorCode;
  constructor(code: ActivationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type PiCommand = {
  command: string;
  /** 前置参数：Windows 上用 node 直接跑 pi 的 JS 入口（见 `resolvePiCommand`）。 */
  prefixArgs: string[];
};

/**
 * PATH 里的目录，按出现顺序。Windows 上变量名可能是 `Path` 而不是 `PATH`，两种都收；
 * 条目本身偶尔带引号（用户手改过 PATH），去掉再拼。
 */
function pathDirs(env: Record<string, string | undefined>): string[] {
  const raw = env.PATH ?? env.Path ?? env.path;
  if (raw === undefined) return [];
  const dirs: string[] = [];
  for (const entry of raw.split(delimiter)) {
    const dir = entry.trim().replace(/^"|"$/gu, "");
    if (dir.length > 0) dirs.push(dir);
  }
  return dirs;
}

/**
 * 定位 npm 全局包的 JS 入口，**按 PATH 顺序**，与用户在终端敲同一个命令时的解析一致。
 *
 * 为什么不能只认 `%APPDATA%\npm`：那只是 npm 的**其中一个**全局前缀。用
 * nvm-windows 时 `C:\nvm4w\nodejs` 既是 node 安装根、也是 npm 的全局前缀，它通常
 * 在 PATH 里排在 `%APPDATA%\npm` 前面——终端敲 `codex` 命中的是它，而只认
 * `%APPDATA%\npm` 会让 Host 拉起另一个（往往是更旧的）副本。同一台机器上两个副本
 * 的内置模型表/行为不一致，现象就是「APP 里的 codex 能选的模型和终端不一样」。
 *
 * `%APPDATA%\npm` 仍然作为最后一个候选：没有 PATH 信息时（如测试注入的 env）它
 * 就是唯一的答案。
 */
export async function resolveNodePackageCli(
  env: Record<string, string | undefined>,
  /** 入口在 `node_modules` 下的相对段，如 `["@openai", "codex", "bin", "codex.js"]`。 */
  segments: readonly string[],
): Promise<string | undefined> {
  const roots = pathDirs(env);
  if (env.APPDATA !== undefined) roots.push(join(env.APPDATA, "npm"));
  for (const root of roots) {
    const candidate = join(root, "node_modules", ...segments);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 这一个前缀没装，看下一个。
    }
  }
  return undefined;
}

/**
 * 解析 `pi` 的启动命令。
 *
 * Windows 上 npm 全局装的是 `pi.cmd`，而 Node ≥ 18 spawn `.cmd` 必须经 shell——
 * 那会违反 §8.4 的「禁止 shell」。所以优先定位 pi 的 JS 入口用 node 直接拉；
 * 找不到入口就明确报错，不悄悄退回 shell。
 */
export async function resolvePiCommand(env: Record<string, string | undefined> = process.env): Promise<PiCommand> {
  if (env.ORBIS_PI_ENTRY) {
    await access(env.ORBIS_PI_ENTRY);
    return { command: process.execPath, prefixArgs: [env.ORBIS_PI_ENTRY] };
  }
  if (platform() !== "win32") return { command: "pi", prefixArgs: [] };
  const entry = await resolveNodePackageCli(env, [
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  ]);
  if (entry === undefined) {
    throw new ActivationError(
      "spawn_failed",
      "未找到 pi 的 JS 入口（PATH 与 %APPDATA%\\npm 下都没有 node_modules\\@earendil-works\\pi-coding-agent）。请确认已全局安装 pi。",
    );
  }
  return { command: process.execPath, prefixArgs: [entry] };
}

/**
 * 本机有没有可用的「开窗」入口：Windows Terminal（PATH 上的 `wt.exe`）。
 *
 * `buildSpawnPlan` 是纯函数，判不了文件是否存在，所以在 `activate` 里探一次再喂进去。
 * 显式 `tui` 找不到入口时报错；只有 `auto` 允许降级为 headless。
 */
export async function resolveTerminalCommand(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (platform() !== "win32") return undefined;
  for (const dir of pathDirs(env)) {
    const candidate = join(dir, "wt.exe");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续找。
    }
  }
  return undefined;
}

/**
 * 默认扩展路径：monorepo 里 host 包隔壁就是 pi-extension（可用 ORBIS_EXTENSION_PATH 覆盖）。
 *
 * 必须指向构建产物 `dist/index.js`：扩展包的 manifest（`pi.extensions`）注册的也是 dist，
 * spawn 的 `-e` 若指向 src，两条通道会在同一个 Pi 进程里求值出两个互不相识的实例——
 * 它们带着 `Symbol.for` 共享的同一个 runtimeId 各建一条 loopback 连接，在 Host 的
 * loopback `#register` 处互相踢掉对方，TUI 标题就永远停在 reconnecting。
 */
export function defaultExtensionPath(env: Record<string, string | undefined> = process.env): string {
  const override = orbisEnvironment(env, "EXTENSION_PATH");
  if (override !== undefined && override.length > 0) return override;
  return fileURLToPath(new URL("../../pi-extension/dist/index.js", import.meta.url));
}

/**
 * 有没有可交互桌面会话（§8.3）。
 *
 * Windows：SSH / 计划任务 / 服务里没有 `SESSIONNAME`；桌面与终端会话里有。
 * macOS：本地 Host 尝试 Terminal，SSH 会话不自动开窗。
 * 其他 POSIX：看 DISPLAY / WAYLAND_DISPLAY。
 */
export function hasDesktopSession(env: Record<string, string | undefined> = process.env): boolean {
  if (platform() === "win32") {
    const sessionName = env.SESSIONNAME;
    return sessionName !== undefined && sessionName.trim().length > 0;
  }
  if (platform() === "darwin") return env.SSH_CONNECTION === undefined && env.SSH_TTY === undefined;
  return env.DISPLAY !== undefined || env.WAYLAND_DISPLAY !== undefined;
}

export type SpawnPlan = {
  kind: "tui" | "headless";
  command: string;
  args: string[];
  cwd: string;
  /** macOS 的一次性 .command 文件，由 activate 在私有目录里创建。 */
  script?: string;
};

/**
 * 纯函数：给定目标与运行环境，算出要 spawn 的确切 argv。
 *
 * Windows 使用 Windows Terminal，macOS 使用 Terminal。显式 `tui` 无法开窗时报错；
 * `auto` 才允许在没有桌面或受支持的终端入口时使用 headless。
 */
export function buildSpawnPlan(input: {
  pi: PiCommand;
  extensionPath: string;
  /** L1 的会话文件绝对路径，或 L2 的新会话 id。 */
  target:
    | { type: "resume"; sessionId: string; sessionFile: string }
    | { type: "new"; sessionId: string };
  cwd: string;
  spawnMode: SpawnMode;
  desktop: boolean;
  platform?: NodeJS.Platform;
  /** 本机有没有可用的开窗入口。缺省 true；`activate` 探过后再传进来。 */
  terminal?: boolean;
  /** Terminal 不继承 Host 的环境，显式传递命令查找路径与本机连接配置。 */
  env?: Record<string, string | undefined>;
  /** macOS 启动握手；记录 exec 前的 PID，避免把短命的开窗进程当作 Pi。 */
  pidFile?: string;
  scriptFile?: string;
}): SpawnPlan {
  const piArgs: string[] = [...input.pi.prefixArgs];
  if (input.target.type === "resume") {
    piArgs.push("--session", input.target.sessionFile);
  } else {
    // 不传 `--name`：会话名留空，由用户在 pi 里自己 `/name` 命名。手机端标题本来就
    // 优先取首条消息，Host 造的 `remote <时间>` 只会盖住更贴切的信息。
    piArgs.push("--session-id", input.target.sessionId);
  }
  piArgs.push("-e", input.extensionPath);

  const hostPlatform = input.platform ?? platform();
  // 显式档优先：只有 `auto` 才依赖「有没有桌面会话」这条启发式。手机明确要窗口时
  // 不该被 `SESSIONNAME` 挡住——服务、计划任务、SSH、IDE 内部启动的 Host 都没有它。
  const wantTui =
    input.spawnMode === "tui" ? true : input.spawnMode === "headless" ? false : input.desktop;
  const canOpenWindow = (hostPlatform === "win32" || hostPlatform === "darwin") && (input.terminal ?? true);
  if (wantTui && !canOpenWindow && input.spawnMode === "tui") {
    throw new ActivationError("spawn_failed", "无法打开 Pi 终端窗口，请检查电脑上的终端配置");
  }
  if (!wantTui || !canOpenWindow) {
    piArgs.push("--mode", "rpc");
    return { kind: "headless", command: input.pi.command, args: piArgs, cwd: input.cwd };
  }
  if (hostPlatform === "darwin") {
    if (input.scriptFile === undefined) throw new ActivationError("spawn_failed", "缺少 Pi 终端启动文件");
    const environment = ["PATH", "ORBIS_STATE_DIR", "PI_REMOTE_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_OFFLINE"]
      .flatMap(key => input.env?.[key] === undefined ? [] : [`${key}=${input.env[key]}`]);
    const steps = [
      "#!/bin/sh",
      `cd -- ${quotePosix(input.cwd)} || exit 1`,
      ...(input.pidFile === undefined ? [] : [`printf '%s\\n' "$$" > ${quotePosix(input.pidFile)} || exit 1`]),
      `exec /usr/bin/env ${[...environment, input.pi.command, ...piArgs].map(quotePosix).join(" ")}`,
      "",
    ];
    // Terminal executes the private file with real terminal stdio. Unlike AppleScript
    // automation, opening a .command file does not require controlling another app.
    return { kind: "tui", command: "/usr/bin/open", args: ["-a", "Terminal", input.scriptFile],
      cwd: input.cwd, script: steps.join("\n") };
  }
  // `wt -d <dir> <commandline…>`。命令行走 `-EncodedCommand`：wt 会把命令行里的引号
  // 重新拼接，含空格的路径（cwd、会话文件）会被拆成多个 token，整条命令
  // 甚至会被当成一个可执行文件名（0x80070002，本仓 Codex 侧已实测）。base64 的
  // UTF-16LE 是单个 token，wt 原样透传；`-NoExit` 让窗口在 pi 退出后留着，报错不闪退。
  const script = ["&", quotePowerShell(input.pi.command), ...piArgs.map(quotePowerShell)].join(" ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return {
    kind: "tui",
    command: "wt.exe",
    args: ["-d", input.cwd, "powershell", "-NoProfile", "-NoExit", "-EncodedCommand", encoded],
    cwd: input.cwd,
  };
}

/** PowerShell 单引号字面量：内部的 `'` 双写。 */
function quotePowerShell(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export type SpawnedAgent = {
  pid: number;
  agentKind: AgentKind;
  cwd: string;
  sessionId: string | undefined;
  spawnMode: "tui" | "headless";
  startedAt: number;
};

export type ActivateInput = {
  deviceId: string;
  /** L1：继续已有会话。Host 从扫描结果里拿 cwd 与会话文件（§8.2）。 */
  target:
    | { type: "resume"; sessionId: string; cwd: string; sessionFile: string }
    | { type: "new"; agentKind: AgentKind; cwd: string };
  spawnMode?: SpawnMode;
};

export type SessionSpawnerOptions = {
  /** 常驻进程上限（§8.4 第 3 条：防手滑，不是防攻击）。 */
  maxRunning?: number;
  log?: (line: string) => void;
  spawnImpl?: typeof spawn;
  env?: Record<string, string | undefined>;
  /** 本 Host 的状态目录；拉起的 agent 靠它找到这个 Host 的 loopback 发现文件。 */
  stateDir?: string;
  now?: () => number;
};

export class SessionSpawner {
  readonly #maxRunning: number;
  readonly #log: (line: string) => void;
  readonly #spawn: typeof spawn;
  readonly #env: Record<string, string | undefined>;
  readonly #stateDir: string | undefined;
  readonly #now: () => number;
  readonly #running = new Map<number, SpawnedAgent>();
  readonly #terminalPids = new Set<number>();

  constructor(options: SessionSpawnerOptions = {}) {
    this.#maxRunning = options.maxRunning ?? 8;
    this.#log = options.log ?? (() => {});
    this.#spawn = options.spawnImpl ?? spawn;
    this.#env = options.env ?? process.env;
    this.#stateDir = options.stateDir;
    this.#now = options.now ?? Date.now;
  }

  get running(): readonly SpawnedAgent[] {
    for (const pid of this.#terminalPids) {
      if (isProcessAlive(pid)) continue;
      this.#terminalPids.delete(pid);
      this.#running.delete(pid);
    }
    return [...this.#running.values()];
  }

  /**
   * 拉起一个 Pi。cwd 不存在时报 `cwd_missing`（§8.2：不静默换目录）；
   * 上限到了报 `spawn_limit_reached`；spawn 本身失败报 `spawn_failed`。
   */
  async activate(input: ActivateInput): Promise<SpawnedAgent> {
    const cwd = input.target.cwd;
    await this.#requireDir(cwd);
    const running = this.running;

    // 先发现，再拉起（§8.4）：这个会话可能已经被本 Host 拉起来的一个进程持有。
    // 不看一眼就 spawn，重复点按会在电脑上堆出多个打开同一会话的 Pi 进程。
    // 只认 resume —— `new` 每次都是新会话，天然不会重复。
    if (input.target.type === "resume") {
      const sessionId = input.target.sessionId;
      const existing = running.find((agent) => agent.sessionId === sessionId);
      if (existing !== undefined) {
        this.#log(`[activate] 会话 ${sessionId} 已有存活进程 pid=${existing.pid}，复用而不重复拉起`);
        return existing;
      }
    }

    if (this.#running.size >= this.#maxRunning) {
      throw new ActivationError(
        "spawn_limit_reached",
        `常驻 agent 进程已达上限（${this.#maxRunning}）。请先结束不用的会话。`,
      );
    }

    const pi = await resolvePiCommand(this.#env);
    const extensionPath = defaultExtensionPath(this.#env);
    // 缺省按「要窗口」处理：手机端会明确发 `tui`，但更早的 APK 根本不发这个字段，
    // 把它当 `auto` 就会掉进 `SESSIONNAME` 那条启发式——那正是「手机要不到窗口」的
    // 成因，所以缺省不该再是无头。开不了窗就报告错误。
    const mode = input.spawnMode ?? "tui";
    const desktop = hasDesktopSession(this.#env);
    const terminal = platform() === "darwin"
      ? await access("/usr/bin/open").then(() => true, () => false)
      : (await resolveTerminalCommand(this.#env)) !== undefined;
    const env = this.#stateDir === undefined ? this.#env : {
      ...this.#env,
      ORBIS_STATE_DIR: this.#stateDir,
      PI_REMOTE_STATE_DIR: this.#stateDir,
    };
    // L2 的新会话 id 由 Host 生成（§8.2），要带回给手机对账 runtime.online。
    const newSessionId = input.target.type === "new" ? randomUUID() : undefined;
    const planInput: Parameters<typeof buildSpawnPlan>[0] = {
      pi,
      extensionPath,
      cwd,
      spawnMode: mode,
      desktop,
      terminal,
      env,
      target:
        input.target.type === "resume"
          ? { type: "resume", sessionId: input.target.sessionId, sessionFile: input.target.sessionFile }
          : { type: "new", sessionId: newSessionId ?? "" },
    };
    if (platform() === "darwin" && (mode === "tui" || mode === "auto" && desktop && terminal)) {
      return this.#activateMac(input, planInput);
    }
    const plan = buildSpawnPlan(planInput);

    const child = this.#spawn(plan.command, plan.args, {
      cwd,
      detached: true,
      shell: false,
      // The agent must find *this* Host's loopback descriptor when the Host does not use the
      // default state directory (several Hosts on one machine is supported).
      env,
      // stdin 必须是**保持打开**的管道，不能用 `"ignore"`：`"ignore"` 让子进程的
      // stdin 立刻读到 EOF，而 pi 的 rpc 模式把「输入结束」当成「该收工了」，会干净
      // 退出（实测 exit 0）。于是进程被记成「拉起成功」，几秒后自己消失——电脑上没
      // 窗口，APP 上也永远等不到这个会话（`runtime.online` 不会来）。这就是「点了
      // 激活却什么都没发生」的成因。
      // stderr 同时收进 Host 日志：原先是 `"ignore"`，这种秒退连一行痕迹都不留。
      // 代价是 Host 退出时管道关闭，被它拉起的 headless Pi 会跟着结束——TUI 走独立
      // 窗口不受影响，而用户自己终端里的 Pi 更与本管道无关。
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: false,
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) this.#log(`[agent pid=${child.pid ?? 0}] ${text.slice(0, 500)}`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
    } catch (cause) {
      throw new ActivationError("spawn_failed", `拉起 agent 失败（${plan.command}）：${describe(cause)}`);
    }

    const record: SpawnedAgent = {
      pid: child.pid ?? 0,
      agentKind: "pi",
      cwd,
      sessionId: input.target.type === "resume" ? input.target.sessionId : newSessionId,
      spawnMode: plan.kind,
      startedAt: this.#now(),
    };
    // detached + unref 的进程由它自己活；这里只在退出时清掉计数。
    child.once("exit", () => {
      this.#running.delete(record.pid);
    });
    child.unref();
    this.#running.set(record.pid, record);

    this.#log(
      `[activate] ${new Date(record.startedAt).toISOString()} 设备=${input.deviceId} 目标=${input.target.type}`
        + ` cwd=${cwd} pid=${record.pid} 模式=${record.spawnMode}`,
    );
    return record;
  }

  async #activateMac(input: ActivateInput, planInput: Parameters<typeof buildSpawnPlan>[0]): Promise<SpawnedAgent> {
    const handshake = await mkdtemp(join(tmpdir(), "orbis-pi-terminal-"));
    try {
      const pidFile = join(handshake, "pid");
      const scriptFile = join(handshake, "Pi.command");
      const plan = buildSpawnPlan({ ...planInput, pidFile, scriptFile });
      await writeFile(scriptFile, plan.script!, { mode: 0o700 });
      const child = this.#spawn(plan.command, plan.args, {
        cwd: plan.cwd, env: planInput.env, shell: false, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000,
      });
      // Wait for Launch Services, then Pi's handshake; spawning open alone proves neither.
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stderr?.resume();
        child.once("close", code => code === 0 ? resolve() : reject(new Error("无法打开 macOS 终端，请检查 Terminal 的安装和权限")));
      });
      let pid: number | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const text = await readFile(pidFile, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        if (/^[1-9]\d*\s*$/u.test(text)) {
          pid = Number(text.trim());
          break;
        }
        await delay(25);
      }
      if (pid === undefined || !Number.isSafeInteger(pid) || !isProcessAlive(pid)) {
        throw new Error("Pi 未在终端中启动，请检查终端窗口中的错误后重试");
      }
      const record: SpawnedAgent = {
        pid, agentKind: "pi", cwd: plan.cwd, sessionId: planInput.target.sessionId,
        spawnMode: "tui", startedAt: this.#now(),
      };
      this.#terminalPids.add(pid);
      this.#running.set(pid, record);
      this.#log(`[activate] ${new Date(record.startedAt).toISOString()} 设备=${input.deviceId} 目标=${input.target.type}`
        + ` cwd=${record.cwd} pid=${pid} 模式=tui`);
      return record;
    } catch (cause) {
      throw new ActivationError("spawn_failed", describe(cause));
    } finally {
      await rm(handshake, { recursive: true, force: true });
    }
  }

  async #requireDir(cwd: string): Promise<void> {
    let info;
    try {
      info = await stat(cwd);
    } catch {
      throw new ActivationError("cwd_missing", `目录不存在：${cwd}`);
    }
    if (!info.isDirectory()) {
      throw new ActivationError("cwd_missing", `不是目录：${cwd}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
