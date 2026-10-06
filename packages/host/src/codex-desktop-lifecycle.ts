import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import type { CodexDesktopAttach } from "@pi-remote/protocol";
import { CodexAppServer, resolveCodexCommand } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { detectCodexDesktopPresence, waitForCodexDesktop, type CodexDesktopPresence, type CodexDesktopPresenceOptions } from "./codex-desktop-presence.js";

export type CodexDesktopLifecycleOptions = {
  log?: (line: string) => void;
  presence?: CodexDesktopPresenceOptions;
  /**
   * 桌面版走包装器时用它发现可接入的 app-server 端点（Orbis 包装器写在 Host 状态目录里）。
   *
   * 提供了它就进入「端点模式」：接入靠端点存在与否，不再依赖 `codex app-server proxy`
   * 的守护进程控制套接字——后者在 Windows 上永远不成立（见 ADR-0022 的 Known limitation）。
   */
  resolveEndpoint?: () => Promise<string | undefined>;
  launchApp?: () => Promise<void>;
  createServer?: () => Promise<CodexAppServer>;
  createExternal?: (endpoint: string) => Promise<CodexAppServer>;
  onReady?: (runtime: CodexRuntime) => Promise<void> | void;
  onOffline?: (runtime: CodexRuntime) => Promise<void> | void;
  /** 接入分档真的变了才回调（每 2s 的探测不会重复触发）。 */
  onStatusChange?: (status: CodexDesktopAttach) => void;
  pollIntervalMs?: number;
  /** 端点模式下等桌面版把端点交出来的时长（手机按需拉起时会打开 GUI）。 */
  endpointWaitMs?: number;
};

/**
 * 接入失败的原因不加“请保持桌面版运行”这类归因：探测已经证明窗口在跑，失败的是
 * Host 到 app-server 的那一跳，重试也由每 2s 的探测自己负责。
 */
function describeAttachFailure(error: unknown): string {
  return `接入 Codex 桌面版失败：${error instanceof Error ? error.message : String(error)}；Orbis 会自动重试，无需重启 Host`;
}

const NO_ENDPOINT_REASON = "桌面版没有可接入的 app-server 端点：它可能不是由 Orbis 启动的（请先关闭 Codex 桌面版，再从 Orbis 打开它），也可能 Orbis 包装器没有随本次安装一起就位";

/** Owns the GUI presence, proxy connection and desktop Codex runtime as one unit. */
export class CodexDesktopLifecycle {
  #runtime: CodexRuntime | undefined;
  #watcher: NodeJS.Timeout | undefined;
  #starting: Promise<CodexRuntime> | undefined;
  #stopping = false;
  /** 端点模式下当前接上的端点；端点变了就必须重接。 */
  #endpoint: string | undefined;
  #status: CodexDesktopAttach = { state: "closed", reason: "正在检测 Codex 桌面版" };
  readonly #options: CodexDesktopLifecycleOptions;

  constructor(options: CodexDesktopLifecycleOptions = {}) {
    this.#options = options;
  }

  get runtime(): CodexRuntime | undefined { return this.#runtime; }
  get ready(): boolean { return this.#runtime?.isReady() === true; }
  get endpointMode(): boolean { return this.#options.resolveEndpoint !== undefined; }

  /**
   * 用户可见的接入分档。它不猜：`attached` 只在握手成功后才成立，
   * 其余分档都带着探测到的原因。
   */
  get status(): CodexDesktopAttach { return this.#status; }

  /** 只在分档真的变了时回调，避免 2s 探测把 device.ready 变成心跳。 */
  #setStatus(state: CodexDesktopAttach["state"], reason: string): void {
    // 协议把 reason 限到 256 字：底层错误消息可能很长，截断在这里做一次，
    // 不要给两端各留一个“可能超长”的字段。
    const text = reason.length > 256 ? `${reason.slice(0, 255)}…` : reason;
    if (this.#status.state === state && this.#status.reason === text) return;
    this.#status = { state, reason: text };
    this.#options.onStatusChange?.(this.#status);
  }

  /** 未就绪的探测结果落到哪一档：查询失败、平台不支持、没装、还是装了但没开窗。 */
  #presenceStatus(presence: CodexDesktopPresence): void {
    // 查询本身坏了不能报成「未打开桌面版」：那会让人去重开一个本来就开着的应用。
    if (presence.scanError !== undefined) {
      this.#setStatus("error", `无法确认 Codex 桌面版状态：${presence.scanError}`);
      return;
    }
    if (presence.ready && this.endpointMode) {
      // 窗口在跑但没端点：说明这个桌面版不是经包装器起来的，重开才能接入。
      this.#setStatus("closed", NO_ENDPOINT_REASON);
      return;
    }
    if (presence.executable !== undefined) {
      this.#setStatus("closed", `${presence.reason}；打开 Codex 桌面版后会自动接入`);
      return;
    }
    const target = this.#options.presence?.platform ?? platform();
    this.#setStatus(target === "win32" ? "notInstalled" : "unsupported", presence.reason);
  }

  /** Whether the official Windows desktop package is installed and can be launched. */
  async isInstalled(): Promise<boolean> {
    try {
      const presence = await detectCodexDesktopPresence(this.#options.presence);
      if (presence.executable === undefined) { this.#presenceStatus(presence); return false; }
      await resolveCodexCommand();
      return true;
    } catch (error) {
      this.#setStatus("notInstalled", `未找到可用的 Codex CLI：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Attach only when the desktop side is already reachable; used during Host startup. */
  async probe(): Promise<CodexRuntime | undefined> {
    if (this.#stopping) return undefined;
    this.#startWatcher();
    if (this.ready) return this.#runtime;
    if (this.#starting !== undefined) return this.#starting;
    if (this.endpointMode) {
      const endpoint = await this.#readEndpoint();
      if (endpoint === undefined) { await this.#reportNoEndpoint(); return undefined; }
      this.#starting = this.#attachEndpoint(endpoint).finally(() => { this.#starting = undefined; });
      return this.#starting;
    }
    const presence = await detectCodexDesktopPresence(this.#options.presence);
    if (!presence.ready) { this.#presenceStatus(presence); return undefined; }
    this.#starting = this.#attach(presence).finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  /** Launch the desktop app when needed, then attach its app-server. */
  async ensureReady(): Promise<CodexRuntime> {
    if (this.#stopping) throw new Error("Codex 桌面版正在关闭");
    this.#startWatcher();
    if (this.ready) return this.#runtime!;
    if (this.#starting !== undefined) return this.#starting;
    this.#starting = (this.endpointMode ? this.#ensureEndpointReady() : this.#ensureReadyInner())
      .finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#watcher !== undefined) clearInterval(this.#watcher);
    this.#watcher = undefined;
    await this.#starting?.catch(() => undefined);
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#endpoint = undefined;
    if (runtime !== undefined) await runtime.stop().catch(error => this.#options.log?.(`关闭 Codex 桌面连接失败：${error instanceof Error ? error.message : String(error)}`));
    this.#stopping = false;
    this.#setStatus("closed", "Host 已暂停，Codex 桌面版接入已释放；重新连接后会再次接入");
  }

  /** 端点模式下的按需拉起：打开 GUI 只是手段，真正等的是它把端点交出来。 */
  async #ensureEndpointReady(): Promise<CodexRuntime> {
    const existing = await this.#readEndpoint();
    if (existing !== undefined) return this.#attachEndpoint(existing);
    await (this.#options.launchApp ?? launchCodexDesktopApp)();
    const deadline = Date.now() + (this.#options.endpointWaitMs ?? 45_000);
    while (!this.#stopping && Date.now() < deadline) {
      const endpoint = await this.#readEndpoint();
      if (endpoint !== undefined) return this.#attachEndpoint(endpoint);
      await delay(250);
    }
    if (this.#stopping) throw new Error("Codex 桌面版正在关闭");
    const reason = "Codex 桌面版没有交出可接入的 app-server 端点";
    this.#setStatus("error", `${reason}；请手动打开 Codex 桌面版，或检查 Orbis 包装器是否随 Host 一起安装`);
    throw new Error(reason);
  }

  async #ensureReadyInner(): Promise<CodexRuntime> {
    let presence = await detectCodexDesktopPresence(this.#options.presence);
    if (!presence.ready) {
      this.#presenceStatus(presence);
      await (this.#options.launchApp ?? launchCodexDesktopApp)();
      try {
        presence = await waitForCodexDesktop(this.#options.presence);
      } catch (error) {
        this.#setStatus("error", `${error instanceof Error ? error.message : String(error)}；请手动打开 Codex 桌面版，Host 会自动接入`);
        throw error;
      }
    }
    if (this.#stopping) throw new Error("Codex 桌面版正在关闭");
    return this.#attach(presence);
  }

  async #readEndpoint(): Promise<string | undefined> {
    const resolve = this.#options.resolveEndpoint;
    if (resolve === undefined) return undefined;
    try { return await resolve(); }
    catch (error) {
      this.#options.log?.(`读取 Codex 桌面版端点失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async #reportNoEndpoint(): Promise<void> {
    let presence: CodexDesktopPresence;
    try { presence = await detectCodexDesktopPresence(this.#options.presence); }
    catch (error) {
      this.#options.log?.(`Codex 桌面版探测失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#presenceStatus(presence);
  }

  /** 端点模式：接别人已经在跑的 app-server，自己不拥有任何进程。 */
  #attachEndpoint(endpoint: string): Promise<CodexRuntime> {
    if (this.ready && this.#endpoint === endpoint) return Promise.resolve(this.#runtime!);
    const attach = (async () => {
      const server = await (this.#options.createExternal ?? ((url: string) => CodexAppServer.createExternal(
        this.#options.log === undefined ? { endpoint: url } : { endpoint: url, log: this.#options.log },
      )))(endpoint);
      this.#endpoint = endpoint;
      return this.#mount(server, "已接入 Codex 桌面版 app-server（Orbis 包装器）");
    })();
    return attach.catch(error => {
      if (!this.#stopping) this.#setStatus("error", describeAttachFailure(error));
      throw error;
    });
  }

  /** 兼容路径：用官方 proxy 接桌面版守护进程（Windows 上不成立，见 ADR-0022）。 */
  async #attach(presence?: CodexDesktopPresence): Promise<CodexRuntime> {
    if (this.ready) return this.#runtime!;
    let server: CodexAppServer;
    try {
      server = await (this.#options.createServer ?? (() => CodexAppServer.createDesktop(this.#options.log === undefined ? {} : { log: this.#options.log })))();
    } catch (error) {
      this.#setStatus("error", describeAttachFailure(error));
      throw error;
    }
    return this.#mount(server, presence?.title === undefined
      ? "已接入 Codex 桌面版 app-server"
      : `已接入 Codex 桌面版 app-server（${presence.title}）`);
  }

  /** 挂载一条已握手的 app-server 连接：Host 先装事件出口，再标记就绪。 */
  async #mount(server: CodexAppServer, reason: string): Promise<CodexRuntime> {
    const runtime = new CodexRuntime({ server, ...(this.#options.log === undefined ? {} : { log: this.#options.log }), onEvent: () => {} });
    try {
      if (this.#stopping) throw new Error("Codex 桌面版正在关闭");
      // HostService attaches the runtime and its event handlers in onReady. Marking it
      // before that callback can start desktop thread discovery before the Host can
      // publish the resulting metadata.
      await this.#options.onReady?.(runtime);
      if (!runtime.isReady()) runtime.markStarted();
      this.#runtime = runtime;
      this.#startWatcher();
      this.#setStatus("attached", reason);
      this.#options.log?.(`Codex 桌面版已就绪：${reason}`);
      return runtime;
    } catch (error) {
      await runtime.stop().catch(stopError => this.#options.log?.(`关闭未挂载的 Codex 桌面连接失败：${stopError instanceof Error ? stopError.message : String(stopError)}`));
      const offline = this.#options.onOffline?.(runtime);
      if (offline instanceof Promise) await offline.catch(() => undefined);
      if (!this.#stopping) this.#setStatus("error", describeAttachFailure(error));
      throw error;
    }
  }

  #startWatcher(): void {
    if (this.#watcher !== undefined) return;
    this.#watcher = setInterval(() => {
      void this.#checkPresence().catch(error => this.#options.log?.(`Codex 桌面版生命周期检查失败：${error instanceof Error ? error.message : String(error)}`));
    }, this.#options.pollIntervalMs ?? 2_000);
    this.#watcher.unref();
  }

  async #checkPresence(): Promise<void> {
    if (this.#stopping) return;
    if (this.endpointMode) { await this.#checkEndpoint(); return; }
    const runtime = this.#runtime;
    if (runtime === undefined) {
      // 接入失败的原因已经在分档里（诊断页/状态页都看得到），每次探测再往日志里刷一条
      // 只会把真正的日志冲掉。这里只吞掉“已经在 status 里说清楚”的失败。
      if (this.#starting === undefined) await this.probe().catch(() => undefined);
      return;
    }
    if (!runtime.isReady()) {
      this.#runtime = undefined;
      await this.#options.onOffline?.(runtime);
      await runtime.stop();
      this.#setStatus("error", "Codex 桌面版 app-server 连接已断开；Host 会自动重试接入");
      return;
    }
    let presence;
    try {
      presence = await detectCodexDesktopPresence(this.#options.presence);
    } catch (error) {
      this.#options.log?.(`Codex 桌面版探测失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (presence.ready) return;
    this.#runtime = undefined;
    this.#options.log?.(`Codex 桌面版 GUI 已退出，释放 proxy：${presence.reason}`);
    await this.#options.onOffline?.(runtime);
    await runtime.stop();
    this.#presenceStatus(presence);
  }

  /**
   * 端点模式的巡检：端点出现就接、变了就重接、没了就释放。
   *
   * 端点由包装器发布，所以「GUI 还在但端点没了」只可能是包装器退出或桌面版被非包装器
   * 方式重启——两种情况都必须先把旧的 runtime 摘掉，不能留着一个连不上的会话目录。
   */
  async #checkEndpoint(): Promise<void> {
    const runtime = this.#runtime;
    const endpoint = await this.#readEndpoint();
    if (runtime !== undefined && (!runtime.isReady() || endpoint === undefined || endpoint !== this.#endpoint)) {
      this.#runtime = undefined;
      this.#endpoint = undefined;
      await this.#options.onOffline?.(runtime);
      await runtime.stop().catch(() => undefined);
      if (endpoint !== undefined) this.#options.log?.("Codex 桌面版端点已变化，重新接入");
    }
    if (this.#runtime !== undefined) return;
    if (this.#starting !== undefined) return;
    if (endpoint !== undefined) await this.probe().catch(() => undefined);
    else await this.#reportNoEndpoint();
  }
}

export async function launchCodexDesktopApp(): Promise<void> {
  const cli = await resolveCodexCommand();
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${quote(cli.command)} -ArgumentList @(${[...cli.prefixArgs, "app"].map(quote).join(",")}) -WorkingDirectory ${quote(homedir())} -WindowStyle Hidden -ErrorAction Stop`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    stdio: "ignore", windowsHide: true, cwd: homedir(), timeout: 15_000,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开 Codex 桌面版，请重试")));
  });
}
