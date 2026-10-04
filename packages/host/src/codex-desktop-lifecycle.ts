import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { CodexAppServer, resolveCodexCommand } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { detectCodexDesktopPresence, waitForCodexDesktop, type CodexDesktopPresenceOptions } from "./codex-desktop-presence.js";

export type CodexDesktopLifecycleOptions = {
  log?: (line: string) => void;
  presence?: CodexDesktopPresenceOptions;
  launchApp?: () => Promise<void>;
  createServer?: () => Promise<CodexAppServer>;
  onReady?: (runtime: CodexRuntime) => Promise<void> | void;
  onOffline?: (runtime: CodexRuntime) => Promise<void> | void;
  pollIntervalMs?: number;
};

/** Owns the GUI presence, proxy connection and desktop Codex runtime as one unit. */
export class CodexDesktopLifecycle {
  #runtime: CodexRuntime | undefined;
  #watcher: NodeJS.Timeout | undefined;
  #starting: Promise<CodexRuntime> | undefined;
  #stopping = false;
  readonly #options: CodexDesktopLifecycleOptions;

  constructor(options: CodexDesktopLifecycleOptions = {}) {
    this.#options = options;
  }

  get runtime(): CodexRuntime | undefined { return this.#runtime; }
  get ready(): boolean { return this.#runtime?.isReady() === true; }

  /** Whether the official Windows desktop package is installed and can be launched. */
  async isInstalled(): Promise<boolean> {
    try {
      const presence = await detectCodexDesktopPresence(this.#options.presence);
      if (presence.executable === undefined) return false;
      await resolveCodexCommand();
      return true;
    } catch {
      return false;
    }
  }

  /** Attach only when the GUI is already running; used during Host startup. */
  async probe(): Promise<CodexRuntime | undefined> {
    if (this.#stopping) return undefined;
    this.#startWatcher();
    if (this.ready) return this.#runtime;
    if (this.#starting !== undefined) return this.#starting;
    const presence = await detectCodexDesktopPresence(this.#options.presence);
    if (!presence.ready) return undefined;
    this.#starting = this.#ensureProxy().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  /** Launch the official GUI when needed, wait for a visible window, then attach its proxy. */
  async ensureReady(): Promise<CodexRuntime> {
    if (this.#stopping) throw new Error("Codex 桌面版正在关闭");
    this.#startWatcher();
    if (this.ready) return this.#runtime!;
    if (this.#starting !== undefined) return this.#starting;
    this.#starting = this.#ensureReadyInner().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#watcher !== undefined) clearInterval(this.#watcher);
    this.#watcher = undefined;
    await this.#starting?.catch(() => undefined);
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime !== undefined) await runtime.stop().catch(error => this.#options.log?.(`关闭 Codex 桌面代理失败：${error instanceof Error ? error.message : String(error)}`));
    this.#stopping = false;
  }

  async #ensureReadyInner(): Promise<CodexRuntime> {
    let presence = await detectCodexDesktopPresence(this.#options.presence);
    if (!presence.ready) {
      await (this.#options.launchApp ?? launchCodexDesktopApp)();
      presence = await waitForCodexDesktop(this.#options.presence);
    }
    if (this.#stopping) throw new Error("Codex 桌面版正在关闭");
    return this.#ensureProxy(presence);
  }

  async #ensureProxy(_presence?: unknown): Promise<CodexRuntime> {
    if (this.ready) return this.#runtime!;
    const server = await (this.#options.createServer ?? (() => CodexAppServer.createDesktop(this.#options.log === undefined ? {} : { log: this.#options.log })) )();
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
      this.#options.log?.("Codex 桌面版 GUI 已就绪，已连接 app-server proxy");
      return runtime;
    } catch (error) {
      await runtime.stop().catch(stopError => this.#options.log?.(`关闭未挂载的 Codex 桌面代理失败：${stopError instanceof Error ? stopError.message : String(stopError)}`));
      const offline = this.#options.onOffline?.(runtime);
      if (offline instanceof Promise) await offline.catch(() => undefined);
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
    const runtime = this.#runtime;
    if (this.#stopping) return;
    if (runtime === undefined) {
      if (this.#starting === undefined) await this.probe();
      return;
    }
    if (!runtime.isReady()) {
      this.#runtime = undefined;
      await this.#options.onOffline?.(runtime);
      await runtime.stop();
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
