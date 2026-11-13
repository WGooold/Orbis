/**
 * DeepSeek Harness Desktop entry lifecycle (ADR-0076).
 *
 * Status is only `attached` after the native handshake completed. Installation,
 * a running Desktop without a connection Orbis can obtain, version
 * incompatibility and transient failures are reported separately
 * (DSH-DESKTOP-01). Orbis connects to the backend Desktop owns and never starts a
 * substitute Web service for it (DSH-DESKTOP-02). Closing Orbis's connection never
 * stops Desktop (DSH-DESKTOP-07).
 */
import type { DshDesktopAttach } from "@orbis/protocol";
import { join } from "node:path";
import { AsarFormatError } from "./asar-archive.js";
import {
  DshDesktopRunningElsewhereError, findDshDesktopInstallation, isDshDesktopRunning, launchDshDesktop, readDshDesktopEndpoint,
  supportsDshDesktop, type DshDesktopEndpoint, type DshDesktopInstallation,
} from "./dsh-desktop-app.js";
import { DshDesktopProtocolError, prepareDshDesktopProtocol, type DshDesktopProtocolLibrary } from "./dsh-desktop-protocol.js";
import { DshRuntime } from "./dsh-runtime.js";
import { DshWebIncompatibleError } from "./dsh-web-client.js";

const PRODUCT = "DeepSeek Harness Desktop";

export type DshDesktopLifecycleOptions = {
  stateDir: string;
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Explicit installation chosen by the user; it is never replaced by another discovered install. */
  explicitPath?: () => string | undefined;
  log?: (line: string) => void;
  onStatusChange?: (status: DshDesktopAttach) => void;
  pollIntervalMs?: number;
  launchTimeoutMs?: number;
  findInstallation?: () => Promise<DshDesktopInstallation | undefined>;
  isRunning?: (installation: DshDesktopInstallation) => Promise<boolean>;
  readEndpoint?: (installation: DshDesktopInstallation) => Promise<DshDesktopEndpoint | undefined>;
  launch?: (installation: DshDesktopInstallation) => Promise<DshDesktopEndpoint>;
  prepareProtocol?: (installation: DshDesktopInstallation) => Promise<DshDesktopProtocolLibrary>;
  connect?: (endpoint: { url: string; packageEntry: string }) => Promise<DshRuntime>;
};

const text = (error: unknown): string => error instanceof Error ? error.message : String(error);
const clip = (value: string): string => value.length > 256 ? `${value.slice(0, 255)}…` : value;
const incompatible = (error: unknown): boolean =>
  error instanceof DshWebIncompatibleError || error instanceof DshDesktopProtocolError || error instanceof AsarFormatError;

export class DshDesktopLifecycle {
  readonly #options: DshDesktopLifecycleOptions;
  #status: DshDesktopAttach = { state: "closed", reason: `正在检测 ${PRODUCT}`, version: null };
  #installation: DshDesktopInstallation | undefined;
  #ensuring: Promise<DshRuntime> | undefined;
  #attached = false;
  #watcher: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: DshDesktopLifecycleOptions) { this.#options = options; }

  get status(): DshDesktopAttach { return this.#status; }

  #set(state: DshDesktopAttach["state"], reason: string, version = this.#installation?.version ?? null): void {
    const next = { state, reason: clip(reason), version };
    if (this.#status.state === next.state && this.#status.reason === next.reason && this.#status.version === next.version) return;
    this.#status = next;
    this.#options.onStatusChange?.(next);
  }

  #env(): NodeJS.ProcessEnv { return this.#options.env?.() ?? process.env; }

  async #find(): Promise<DshDesktopInstallation | undefined> {
    const platform = this.#options.platform ?? process.platform;
    const explicitPath = this.#options.explicitPath?.();
    this.#installation = await (this.#options.findInstallation ?? (() => findDshDesktopInstallation({
      platform, env: this.#env(), ...(explicitPath === undefined ? {} : { explicitPath }) })))();
    return this.#installation;
  }

  /** Whether a usable Desktop install exists; this is what makes the entry launchable. */
  async isInstalled(): Promise<boolean> {
    if (!supportsDshDesktop(this.#options.platform ?? process.platform)) return false;
    return (await this.#find().catch(() => undefined)) !== undefined;
  }

  /** Refresh the user-visible tier without launching or connecting. */
  async probe(): Promise<void> {
    if (this.#attached) return;
    if (!supportsDshDesktop(this.#options.platform ?? process.platform)) { this.#set("unsupported", `${PRODUCT} 只支持 Windows 与 macOS`, null); return; }
    let installation: DshDesktopInstallation | undefined;
    try { installation = await this.#find(); }
    catch (error) { this.#set("error", `无法查询 ${PRODUCT} 安装位置：${text(error)}`, null); return; }
    if (installation === undefined) { this.#set("notInstalled", this.#options.explicitPath?.() ? `所选位置不是有效的 ${PRODUCT} 安装` : `未找到 ${PRODUCT} 安装`, null); return; }
    // A failed recovery or an incompatible version is more specific than the process tier.
    if (this.#status.state === "incompatible" && this.#status.version === installation.version) return;
    const endpoint = await (this.#options.readEndpoint ?? (value => readDshDesktopEndpoint(this.#options.stateDir, value)))(installation).catch(() => undefined);
    if (endpoint !== undefined) { if (this.#status.state !== "error") this.#set("closed", `${PRODUCT} 已打开，正在接入`); return; }
    let running = false;
    try { running = await (this.#options.isRunning ?? (value => isDshDesktopRunning(value, this.#options.platform ?? process.platform, this.#env())))(installation); }
    catch (error) { this.#set("error", `无法查询 ${PRODUCT} 进程：${text(error)}`); return; }
    if (running) this.#set("running", `${PRODUCT} 已在运行，但不是由 Orbis 打开，无法取得它的连接；请完全退出 Desktop 后由 Orbis 打开`);
    else this.#set("closed", `${PRODUCT} 未运行；新建或打开 Desktop 会话时 Orbis 会打开它`);
  }

  /** Periodic tier refresh while not attached; connection recovery is driven by the Host service. */
  watch(): void {
    if (this.#watcher !== undefined || this.#stopped) return;
    void this.probe().catch(() => {});
    this.#watcher = setInterval(() => { if (!this.#attached) void this.probe().catch(() => {}); }, this.#options.pollIntervalMs ?? 10_000);
    this.#watcher.unref();
  }

  async #connect(installation: DshDesktopInstallation, endpoint: DshDesktopEndpoint): Promise<DshRuntime> {
    try {
      const library = await (this.#options.prepareProtocol ?? (value => prepareDshDesktopProtocol(value.archive, join(this.#options.stateDir, "dsh-desktop-protocol"))))(installation);
      const runtime = await (this.#options.connect ?? (value => DshRuntime.connectDesktop(value)))({ url: endpoint.url, packageEntry: library.packageEntry });
      this.#attached = true;
      this.#set("attached", `已接入 ${PRODUCT}${installation.version ? ` ${installation.version}` : ""}`);
      return runtime;
    } catch (error) {
      if (incompatible(error)) this.#set("incompatible", `此 ${PRODUCT} 版本（${installation.version}）无法接入：${text(error)}`);
      else this.#set("error", `接入 ${PRODUCT} 失败：${text(error)}；Orbis 会自动重试`);
      throw error;
    }
  }

  /** Reconnect to the Desktop instance Orbis launched earlier. Never launches anything. */
  async connectExisting(): Promise<DshRuntime | undefined> {
    if (this.#stopped || !supportsDshDesktop(this.#options.platform ?? process.platform)) return undefined;
    if (this.#ensuring) return this.#ensuring.catch(() => undefined);
    const installation = this.#installation ?? await this.#find().catch(() => undefined);
    if (installation === undefined) return undefined;
    const endpoint = await (this.#options.readEndpoint ?? (value => readDshDesktopEndpoint(this.#options.stateDir, value)))(installation).catch(() => undefined);
    if (endpoint === undefined) return undefined;
    return this.#connect(installation, endpoint);
  }

  /** Attach for an explicit App request: reuse Orbis's Desktop, or open Desktop when it is closed. */
  ensure(): Promise<DshRuntime> {
    return this.#ensuring ??= this.#ensure().finally(() => { this.#ensuring = undefined; });
  }

  async #ensure(): Promise<DshRuntime> {
    if (this.#stopped) throw new Error("Orbis 正在退出");
    if (!supportsDshDesktop(this.#options.platform ?? process.platform)) { this.#set("unsupported", `${PRODUCT} 只支持 Windows 与 macOS`, null); throw new Error(this.#status.reason); }
    const installation = await this.#find();
    if (installation === undefined) { await this.probe(); throw new Error(this.#status.reason); }
    const existing = await (this.#options.readEndpoint ?? (value => readDshDesktopEndpoint(this.#options.stateDir, value)))(installation).catch(() => undefined);
    if (existing !== undefined) return this.#connect(installation, existing);
    // Never start a second instance against the single-instance lock, and never stop the user's instance.
    if (await (this.#options.isRunning ?? (value => isDshDesktopRunning(value, this.#options.platform ?? process.platform, this.#env())))(installation).catch(() => false)) {
      await this.probe(); throw new Error(this.#status.reason);
    }
    let endpoint: DshDesktopEndpoint;
    try {
      this.#set("closed", `正在打开 ${PRODUCT}`);
      endpoint = await (this.#options.launch ?? (value => launchDshDesktop(value, this.#options.stateDir, { env: this.#env(),
        ...(this.#options.launchTimeoutMs === undefined ? {} : { timeoutMs: this.#options.launchTimeoutMs }) })))(installation);
    } catch (error) {
      if (error instanceof DshDesktopRunningElsewhereError) this.#set("running", error.message);
      else this.#set("error", text(error));
      throw error;
    }
    return this.#connect(installation, endpoint);
  }

  /** Orbis's connection ended; Desktop itself may still be running. */
  noteOffline(reason: string): void {
    this.#attached = false;
    this.#set("error", `${PRODUCT} 连接已断开：${reason}；Orbis 会自动重试`);
    void this.probe().catch(() => {});
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#watcher);
    this.#watcher = undefined;
  }
}
