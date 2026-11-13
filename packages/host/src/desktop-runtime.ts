import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { join, delimiter, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEVICE_STORE_FILE, HOST_IDENTITY_FILE, X25519_KEY_BYTES, deriveSharedSecret, fromBase64UrlFixed, loadDeviceStore, loadOrCreateHostIdentity, encodePairingQrText, privateKeyFromRaw, resolveStateDir, revokeDeviceRecord, saveDeviceStore, toBase64Url } from "@orbis/e2e";
import QRCode from "qrcode";
import { hostRecoveryProof, type AgentStateRangeRequest } from "@orbis/protocol";
import { HostService } from "./host-service.js";
import { RelayAuthenticationError } from "./relay-client.js";
import { CodexAppServer, codexCommandForEntry, resolveCodexCommand } from "./codex-daemon.js";
import { resolveCodexTerminalServer } from "./codex-terminal-server.js";
import { readCodexSelection, saveCodexSelection } from "./codex-selection.js";
import { CodexDesktopLifecycle, launchCodexDesktopApp } from "./codex-desktop-lifecycle.js";
import { codexDesktopEndpointPath, launchCodexDesktopThroughWrapper, readCodexDesktopEndpoint, resolveCodexWrapper } from "./codex-desktop-launcher.js";
import { codexShimStatus, ensureCodexShimWinsPath, installCodexShim, type CodexTerminalIntegration } from "./codex-shim-install.js";
import { CODEX_SOURCE_COALESCE_MS, CodexRuntime } from "./codex-runtime.js";
import { DshRuntime } from "./dsh-runtime.js";
import { DshDesktopLifecycle, openDshDesktopFromHost } from "./dsh-desktop-lifecycle.js";
import { DSH_VERSION, resolveDshCommand } from "./dsh-client.js";
import { ensureDshWebService, restartDshWebServiceAfterUpdate, validateDshWebUrl, type DshWebServiceStage } from "./dsh-web-service.js";
import { DshWebClient } from "./dsh-web-client.js";
import { applyDshWebProvider } from "./dsh-web-provider.js";
import { resolvePiCommand, defaultExtensionPath } from "./spawner.js";
import { openWindowsConsole, WindowsConsoleLaunchError } from "./windows-console.js";
import { updatePiIntegration } from "./pi-integration-install.js";
import { findClaudeExecutable, updateClaudeIntegration } from "./claude-integration-install.js";
import { TerminalClaudeLauncher, type ClaudeLauncher } from "./claude-launcher.js";
import { CLAUDE_MIN_VERSION, claudeVersionRequirement, readClaudeVersion } from "./claude-version.js";
import { CODEX_STARTUP_ARGS, PI_STARTUP_ENV, PI_WORKSPACE_APPROVAL_ARGS, codexWorkspaceApprovalArgs } from "./agent-startup.js";
import { openMacAgentTerminal } from "./macos-agent-terminal.js";
import { claudeConfigDir } from "./claude-transcript.js";
import { adoptLoginShellEnvironment, adoptWindowsEnvironment } from "./login-shell-env.js";
import { agentInstallRoot } from "./agent-root.js";
import { PiCommandCancelledError, installMacPiCommand, piCommandStatus, refreshMacPiCommand, removeMacPiCommand, syncWindowsPiCommand } from "./pi-command.js";
import { existsSync } from "node:fs";
import { ProviderManager, ProviderError, agentKind, providerMetadata, type ProviderPaths, type ProviderProfile, type ProviderSummary } from "./provider-manager.js";
import { installAgentPackage, activateManagedAgent, activeManagedEntry, findAgentCopies, fetchNpmLatestVersion, agentPackages, queryAgentStatus, recommendedAgentVersion, extractAgentVersion, compareAgentVersions, installationSource, type AgentInstallProgress, type AgentInstallStatus, type LocalAgent } from "./agent-installation.js";
import { randomUUID } from "node:crypto";
import { newProviderConfig, providerFields, applyProviderFields, type ProviderFields } from "./provider-form.js";
import { providerPresets as existingProviderPresets } from "./provider-presets.js";
import { claudeProviderPresets } from "./claude-provider-presets.js";
import { claudeOfficial, claudeProtocolSelectors } from "./provider-claude.js";
import { codexOfficial, type CodexPreferences } from "./provider-codex.js";
import { checkProviderEndpoint, fetchProviderModels } from "./provider-network.js";
import { ProviderUsageCache, type UsageSnapshot } from "./provider-usage-cache.js";
import { usageTemplate } from "./provider-usage-templates.js";
import { agentCommandForEntry, agentInvocation, agentPowerShellScript, resolveAgentPackage } from "./agent-command.js";

const execute = promisify(execFile);

const APP_DOWNLOAD_URL = "https://orbising.com/downloads/orbis.apk";
async function loopbackPortAlive(value: unknown): Promise<boolean> {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port.length === 0) return false;
  return await new Promise(resolve => {
    const socket = new Socket();
    const finish = (alive: boolean) => { socket.destroy(); resolve(alive); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.connect(Number(url.port), url.hostname);
  });
}

const providerPresets = [...existingProviderPresets, ...claudeProviderPresets];

export type DesktopSettings = {
  relayUrl: string; credential: string; codexEnabled?: boolean; piEntry?: string; codexEntry?: string;
  dshEnabled?: boolean; dshEntry?: string; dshWebUrl?: string;
  /** macOS：让用户自己在终端里运行的 Pi 也加载 Orbis 扩展（缺省开启）。 */
  piIntegrationEnabled?: boolean;
  /** 安装 / 首次打开 Host 时自动登记 Claude Code 插件；保留用户明确关闭的设置。 */
  claudeIntegrationEnabled?: boolean;
  lanPort?: number;
};
export type DesktopEvent = { event: string; [key: string]: unknown };
type AgentInstallResult = { entry: string; version: string; restarted?: boolean; restartWarning?: string };

export function validateDesktopRelay(value: unknown): string {
  if (typeof value !== "string") throw new Error("请填写中继服务器地址");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("服务器地址不能包含凭据、查询参数或片段");
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("公网中继必须使用 wss://");
  return url.toString().replace(/\/$/, "");
}

async function firstExisting(candidates: readonly (string | undefined)[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate && await stat(candidate).then(value => value.isFile()).catch(() => false)) return candidate;
  }
  return undefined;
}

/**
 * 终端接入默认启用，但只在 Host 真的在跑、Codex 已安装且兼容、且不缺提权时动手。
 * 检测会被界面、诊断和测试调用，没有用户意图时绝不能改写用户 PATH；提权也永不自动。
 */
export function shouldAutoEnableCodexTerminal(input: {
  platform: NodeJS.Platform;
  hostRunning: boolean;
  installed: boolean;
  compatible: boolean | undefined;
  state: CodexTerminalIntegration["state"];
  needsElevation: boolean | undefined;
}): boolean {
  return input.platform === "win32" && input.hostRunning && input.installed && input.compatible === true
    && input.needsElevation !== true && (input.state === "disabled" || input.state === "repair");
}

async function terminalWorkspace(cwd: string | undefined): Promise<string> {
  if (!cwd || !isAbsolute(cwd)) throw new Error("请先选择工作区目录");
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) throw new Error("工作区目录不存在或无法访问，请重新选择");
  return cwd;
}

/** Owns only the Host process started by the desktop app. No TCP management endpoint is exposed. */
export class DesktopRuntime {
  readonly #stateDir: string;
  #claudeIntegrationInstalled = false;
  /**
   * HOST-PREP-04：自动登记 Claude Code 插件（最多 4 个 `claude` 子命令，每个 60 s）在后台进行，
   * 不再挡 Host 核心就绪与中继连接。任务本身从不 reject。
   */
  #claudeIntegrationTask: Promise<void> | undefined;
  #claudeIntegrationAbort: AbortController | undefined;
  /** HOST-PREP-06：本地路由在后台启动；会读取 Codex 配置的入口先等它。从不 reject。 */
  #routing: Promise<void> = Promise.resolve();
  /** HOST-LANE-01：每次暂停加一。暂停可以越过在途的 start，start 在挂上 #desired 之前据此放弃。 */
  #lifecycleGeneration = 0;
  #claudeDetection: Promise<void> | undefined;
  readonly #emit: (event: DesktopEvent) => void;
  #service: HostService | undefined;
  #codex: CodexAppServer | undefined;
  #codexRuntime: CodexRuntime | undefined;
  /** 终端接入的准备（可能是一次上百 MB 的下载）：与中继连接和手机可用性无关，可随时取消。 */
  #codexPrepare: AbortController | undefined;
  #codexDesktopLifecycle: CodexDesktopLifecycle | undefined;
  #dshRuntime: DshRuntime | undefined;
  /** DeepSeek Harness Desktop entry (ADR-0076); its app and backend stay owned by Desktop. */
  #dshDesktopLifecycle: DshDesktopLifecycle | undefined;
  #dshDesktopRuntime: DshRuntime | undefined;
  /** Host UI open of DeepSeek Desktop (DSH-DESKTOP-09); independent of the Relay connection. */
  #dshDesktopOpening: Promise<void> | undefined;
  #dshDesktopOpenAbort: AbortController | undefined;
  #retry: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  /** 终端 shim 自动启用的在途守卫，避免并发 detect 重复写 PATH。 */
  #terminalSetup: Promise<void> | undefined;
  #desired: DesktopSettings | undefined;
  #attempt = 0;
  #starting = false;
  /** Settles when the current connection attempt has finished unwinding, including one a pause already abandoned. */
  #attemptSettled: Promise<void> = Promise.resolve();
  #lastStatus = "";
  #lastSeen = new Map<string, number>();
  #installation: AbortController | undefined;
  #installationTask: Promise<AgentInstallResult> | undefined;
  #installationCommitted = false;
  #batchCancelled = false;
  #selectionError = false;
  #detected = new Map<string, AgentInstallStatus>();
  readonly #providers: ProviderManager;
  readonly #usage: ProviderUsageCache;

  constructor(emit: (event: DesktopEvent) => void, stateDir?: string, providerPaths?: ProviderPaths) {
    this.#emit = emit;
    this.#stateDir = resolveStateDir(stateDir);
    // DeepSeek Web 热加载配置文件，只有它能在有会话运行时应用配置变更；
    // 其他 Agent 的 apply 会重载自己的运行时，所以仍然要求空闲。
    const liveApply = (kind: string, liveEdit: boolean): boolean => liveEdit && kind === "dsh";
    this.#providers = new ProviderManager(this.#stateDir, providerPaths, {
      beforeApply: async (kind, hotSwitch, liveEdit) => {
        if ((!hotSwitch && !liveApply(kind, liveEdit)) || (kind === "codex" && this.#codexDesktopLifecycle?.runtime !== undefined)) {
          await this.#service?.assertProviderSwitchReady(kind);
        }
      },
      afterApply: async (kind, hotSwitch, liveEdit) => {
        if (!hotSwitch) await this.#service?.reloadProviderConfiguration(kind, await this.#providers.environment(kind), liveApply(kind, liveEdit));
        this.#emit({ event: "providersChanged", kind });
      },
      proxyStatus: () => { this.#emit({ event: "proxyStatusChanged" }); void this.#service?.refreshProviderFacts(); },
    });
    this.#usage = new ProviderUsageCache(() => this.#providers.usageProfiles(), (profile, usage) => {
      this.#emit({ event: "providerUsageChanged", kind: profile.kind, providerId: profile.id, usage });
      void this.#service?.refreshProviderFacts();
    });
  }

  async initialize(settings: Pick<DesktopSettings, "claudeIntegrationEnabled"> = {}): Promise<unknown> {
    // 先于一切 Agent 检测：从程序坞打开的 Host 只有 launchd 的最小 PATH。
    // 登录环境是例外：之后的每一次 Agent 检测和启动都依赖它，必须先就位。
    await adoptLoginShellEnvironment(line => this.log(line));
    await adoptWindowsEnvironment();
    // DMG / portable installs have no installer hook. Registration runs in the background (HOST-PREP-04):
    // it may run four `claude` commands, and the desktop must not look frozen meanwhile.
    this.#ensureClaudeIntegration(settings);
    this.#scheduleClaudeDetection();
    const identity = await loadOrCreateHostIdentity({ dir: this.#stateDir });
    // HOST-PREP-06: routing binds a port and rewrites Codex configuration; it has no time limit, so it
    // no longer holds initialization. Codex launches wait for it; a failure stays visible in the log.
    this.#routing = this.#providers.startRouting()
      .catch(error => { this.log(error instanceof ProviderError ? error.message : "Codex local routing could not start; check its port and settings"); });
    this.#poll = setInterval(() => this.status(), 2_000);
    this.#poll.unref();
    this.#usage.start();
    const devices = (await loadDeviceStore(this.#stateDir)).devices.filter(d => !d.revoked).map(d => ({ deviceId: d.deviceId, label: d.label, createdAt: d.createdAt }));
    return { hostId: identity.hostId, hostName: identity.hostName, hostPub: toBase64Url(identity.publicRaw), stateDir: this.#stateDir, devices, nodeVersion: process.version,
      appDownloadQr: await QRCode.toDataURL(APP_DOWNLOAD_URL, { width: 320, margin: 2 }) };
  }

  #managedRoot(): string { return agentInstallRoot(); }
  async #environment(settings?: Partial<DesktopSettings>): Promise<void> {
    if (settings?.dshWebUrl?.trim()) process.env.ORBIS_DSH_WEB_URL = validateDshWebUrl(settings.dshWebUrl.trim()); else delete process.env.ORBIS_DSH_WEB_URL;
    const managed = this.#managedRoot();
    let selectedCodex: string | undefined;
    try { selectedCodex = await readCodexSelection(); this.#selectionError = false; }
    catch { this.#selectionError = true; this.log("Codex 版本选择记录不可读，请在 Agent 页修复终端接入"); }
    for (const kind of ["pi", "codex", "dsh"] as const) {
      const configured = settings?.[`${kind}Entry`];
      let active: string | undefined;
      try { active = await activeManagedEntry(kind, managed); }
      catch { this.log(`${kind} 安装记录不可读，请检查文件权限和 installations.json`); }
      // 入口由 Orbis 自己维护（安装、激活和终端共享记录写回），不再由用户指定；
      // 记录随时可能先于目录失效，所以按优先级挑第一个仍然存在的入口，
      // 全部失效时交给下面的自动检测，而不是把一个死路径当成“已安装但无法运行”。
      const shared = kind === "codex" ? selectedCodex : undefined;
      const ordered = configured && installationSource(configured, managed) !== "managed"
        ? [configured, active, shared]
        : [active, shared, configured];
      // 用户自己装的 Pi 优先：终端里敲 `pi` 跑的是它，扩展登记的也是它的配置，Host 不能另用一份。
      // Host 自己的安装只在用户没有 Pi 时才派上用场。
      if (kind === "pi") {
        const userEntry = (await findAgentCopies("pi", process.env))[0]?.entry;
        if (configured && installationSource(configured, managed) !== "managed") ordered.splice(1, 0, userEntry);
        else ordered.unshift(userEntry);
      }
      // An explicit external choice must report its own failure, not silently
      // select another installation. Managed records may still expire after cleanup.
      const entry = kind !== "codex" && configured && installationSource(configured, managed) !== "managed" ? configured : await firstExisting(ordered);
      const key = `ORBIS_${kind.toUpperCase()}_ENTRY`;
      if (entry) process.env[key] = entry; else delete process.env[key];
      if (kind === "codex" && entry && entry !== selectedCodex) await this.#syncCodexSelection(entry);
    }
    const searchPath = process.env.PATH ?? process.env.Path ?? "";
    const legacyNpm = process.env.APPDATA ? join(process.env.APPDATA, "npm") : "";
    const roots = searchPath.split(delimiter);
    if (legacyNpm && !roots.includes(legacyNpm)) roots.push(legacyNpm);
    if (!roots.includes(managed)) roots.push(managed);
    // Host 的运行时目录不是 Agent 安装位置：只认用户自己装的和用户在 Host 里主动安装的副本。
    process.env.PATH = roots.join(delimiter);
    // Detection, updates and session startup must target the same copy, including a broken default.
    for (const kind of ["pi", "codex", "dsh"] as const) {
      const key = `ORBIS_${kind.toUpperCase()}_ENTRY`;
      if (!process.env[key]) {
        const entry = (await findAgentCopies(kind, process.env))[0]?.entry;
        if (entry) process.env[key] = entry;
      }
    }
    if (process.env.ORBIS_CODEX_ENTRY && !selectedCodex && !this.#selectionError) await this.#syncCodexSelection(process.env.ORBIS_CODEX_ENTRY);
    process.env.ORBIS_ENABLED = "true";
    process.env.ORBIS_RELAY_URL = "ws://127.0.0.1";
    process.env.ORBIS_RUNTIME_CREDENTIAL = "loopback-only";
  }

  async #syncCodexSelection(entry: string): Promise<void> {
    try { await saveCodexSelection(entry); this.#selectionError = false; }
    catch { this.#selectionError = true; this.log("Codex 已安装，但终端版本选择未同步"); }
  }

  /** 静默装好终端 shim；失败只记日志（终端仍可手动用独立 codex）。 */
  async #autoEnableCodexTerminal(runtimeRoot: string, entry: string): Promise<void> {
    if (this.#terminalSetup !== undefined) return;
    this.#terminalSetup = (async () => {
      await this.#syncCodexSelection(entry);
      await installCodexShim(runtimeRoot);
      this.log("Codex 终端接入已自动启用");
    })().catch(error => { this.log(`Codex 终端接入自动启用失败：${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { this.#terminalSetup = undefined; });
    await this.#terminalSetup;
  }

  async detect(settings?: Partial<DesktopSettings>, checkLatest = false): Promise<AgentInstallStatus[]> {
    await adoptWindowsEnvironment();
    await this.#environment(settings);
    this.#scheduleClaudeDetection();
    const managed = this.#managedRoot();
    return Promise.all((["pi", "codex", "dsh"] as const).map(async (kind) => {
      const copies = await findAgentCopies(kind, process.env);
      const entry = process.env[`ORBIS_${kind.toUpperCase()}_ENTRY`] ?? copies[0]?.entry;
      const local: LocalAgent = { installed: false, installedButBroken: false, ...(entry ? { entry } : {}) };
      try {
        if (entry) {
          const cli = kind === "codex" ? codexCommandForEntry(entry) : await agentCommandForEntry(entry);
          const invocation = agentInvocation(cli, ["--version"]);
          const { stdout, stderr } = await execute(invocation.command, invocation.args, { timeout: 10_000, windowsHide: true, maxBuffer: 64_000,
            ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
          const version = extractAgentVersion(stdout + "\n" + stderr);
          if (!version) throw new Error("no version");
          local.installed = true; local.version = version;
        }
      } catch {
        local.installedButBroken = true;
        local.error = "发现安装但无法运行，请检查原有启动命令及其运行环境，或重新安装修复";
      }
      let status: AgentInstallStatus;
      try { status = await queryAgentStatus(kind, managed, local, checkLatest); }
      catch { status = { ...local, kind, package: "", installationSource: installationSource(entry, managed), updateAvailable: false, installations: [], copies: [], error: "Agent 安装记录不可读，请检查文件权限和 installations.json" }; }
      if (!checkLatest) {
        const previous = this.#detected.get(kind);
        if (previous?.latestVersion) {
          status.latestVersion = previous.latestVersion;
          const recommended = recommendedAgentVersion(kind, previous.latestVersion)!;
          status.recommendedVersion = recommended;
          status.updateAvailable = compareAgentVersions(recommended, local.version ?? "") === 1;
          if (recommended === previous.latestVersion) delete status.compatibilityNote;
        }
      }
      status.copies = copies;
      if (kind === "pi") {
        let managedEntry: string | undefined;
        try { managedEntry = await activeManagedEntry("pi", managed); } catch { managedEntry = undefined; }
        const context = { managedEntry, usingManaged: entry !== undefined && installationSource(entry, managed) === "managed" };
        const runtime = this.#packagedRuntime();
        try {
          if (runtime !== undefined && process.platform === "win32") await syncWindowsPiCommand({ ...context, runtimeRoot: runtime.root, managedRoot: managed });
          if (runtime !== undefined && process.platform === "darwin") await refreshMacPiCommand(runtime.node, managed);
        } catch (error) { this.log(`维护终端 pi 命令失败：${error instanceof Error ? error.message : String(error)}`); }
        const command = await piCommandStatus(context);
        status.terminalCommand = runtime === undefined && command.state === "available" ? "unavailable" : command.state;
        status.terminalCommandDetail = command.detail;
      }
      if (kind === "dsh") {
        // DeepSeek Desktop is its own entry: installing it registers no dsh command (ADR-0076 F01).
        status.desktopInstalled = await new DshDesktopLifecycle({ stateDir: this.#stateDir }).isInstalled();
      }
      if (kind === "codex") {
        // 桌面版自带 CLI，是否装了 npm 版 codex 与能否接入桌面版无关。
        status.desktopInstalled = await new CodexDesktopLifecycle().isInstalled();
        const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
        const shim = await codexShimStatus(runtimeRoot);
        status = { ...status, terminalIntegration: this.#selectionError ? "repair" : shim.state,
          terminalIntegrationDetail: this.#selectionError ? "版本选择未同步" : shim.detail,
          terminalNeedsElevation: shim.needsElevation === true };
        if (local.installed && entry) {
          try {
            const command = codexCommandForEntry(entry);
            const [cli, server] = await Promise.all([
              execute(command.command, [...command.prefixArgs, "--help"], { timeout: 10_000, windowsHide: true, maxBuffer: 64_000 }),
              execute(command.command, [...command.prefixArgs, "app-server", "--help"], { timeout: 10_000, windowsHide: true, maxBuffer: 64_000 }),
            ]);
            status.terminalCompatible = /--remote\b/u.test(cli.stdout + cli.stderr) && /--listen\b/u.test(server.stdout + server.stderr);
          } catch { status.terminalCompatible = false; }
        }
        // 终端接入默认启用：Host 真的在跑（用户在用它）且 Codex 兼容时静默装好 shim，
        // 不再让普通用户看到“终端接入”这个概念。需要提权的系统 PATH 冲突不在这里弹 UAC。
        if (entry !== undefined && shouldAutoEnableCodexTerminal({ platform: process.platform, hostRunning: this.#desired !== undefined,
          installed: local.installed, compatible: status.terminalCompatible, state: shim.state, needsElevation: shim.needsElevation })) {
          await this.#autoEnableCodexTerminal(runtimeRoot, entry);
        }
      }
      this.#detected.set(kind, status);
      this.#service?.refreshHostFacts();
      return { ...status, path: local.entry, connected: kind === "pi" ? (this.#service?.localRuntimes.length ?? 0) > 0 : kind === "dsh" ? this.#dshRuntime?.isReady() ?? false : this.#codexRuntime?.isReady() ?? false };
    }));
  }

  #scheduleClaudeDetection(): void {
    // CLAUDE-MODS-MIN-03: optional native version I/O must not delay unrelated
    // Host initialization or Agent discovery. Concurrent refreshes share one read.
    this.#claudeDetection ??= this.#detectClaude()
      .catch(error => this.log(`检测 Claude Code 失败：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.#claudeDetection = undefined; });
  }

  async #detectClaude(): Promise<void> {
    // 先声明“还在测”，否则 Host 界面会把尚未测完的版本当成“未安装”，
    // 用户看到的是“Claude Code 不能用”，而实际只是检测还没回来。
    this.#emit({ event: "claudeStatus", detecting: true });
    // Claude uses its native installer and settings, outside the managed npm Agents.
    const cli = await findClaudeExecutable(process.env);
    const status = { event: "claudeStatus", installed: cli !== undefined, minimumVersion: CLAUDE_MIN_VERSION };
    if (!cli) { this.#emit({ ...status, compatible: false }); return; }
    // 已找到可执行文件，但版本还没读回来：仍是“检测中”，不能先报一个“不兼容”。
    this.#emit({ ...status, compatible: false, detecting: true });
    try {
      const version = await readClaudeVersion(cli, process.env);
      const error = claudeVersionRequirement(version);
      this.#emit({ ...status, version, compatible: error === undefined, ...(error ? { error } : {}) });
    } catch (error) {
      this.#emit({ ...status, compatible: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * macOS 的 Pi 集成：把安装包里的 Orbis 扩展登记进用户自己的 `~/.pi/agent/settings.json`。
   *
   * Windows 由安装器做这一步；macOS 是拖拽安装，没有安装脚本，所以由 Host 自己维护，并给用户
   * 一个开关在删除应用前撤掉它。登记只追加 Orbis 这一项、替换旧位置的 Orbis 副本，用户自己的
   * 扩展原样保留。开发检出不登记：那会把仓库里的构建产物写进开发者真实的 Pi 配置。
   */
  /** 打包后的运行时（自带 node）；开发检出返回 undefined，不往用户系统里写指向仓库的命令。 */
  #packagedRuntime(): { root: string; node: string } | undefined {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const node = join(root, "node", process.platform === "win32" ? "node.exe" : "node");
    return existsSync(node) ? { root, node } : undefined;
  }

  #piCommandDeclinedPath(): string { return join(this.#stateDir, "pi-command-declined"); }

  /**
   * macOS：用户刚在 Host 里装好 Pi，顺势请求一次管理员授权，让终端里也能直接运行 `pi`。
   * 授权框紧跟着用户自己的安装操作出现，不是凭空弹出；用户取消就记住，之后升级不再打扰，
   * 设置页的按钮随时可以再装。授权失败或无人响应都不影响这次 Pi 安装的结果。
   */
  async #offerPiCommand(): Promise<void> {
    if (process.platform !== "darwin" || existsSync(this.#piCommandDeclinedPath())) return;
    const runtime = this.#packagedRuntime();
    if (runtime === undefined) return;
    const managed = this.#managedRoot();
    let managedEntry: string | undefined;
    try { managedEntry = await activeManagedEntry("pi", managed); } catch { return; }
    const current = process.env.ORBIS_PI_ENTRY;
    const status = await piCommandStatus({ managedEntry, usingManaged: current !== undefined && installationSource(current, managed) === "managed" });
    if (status.state !== "available") return;
    try {
      await installMacPiCommand(runtime.node, managed);
      this.log("已安装终端命令 pi；新开的终端窗口里即可使用");
    } catch (error) {
      if (error instanceof PiCommandCancelledError) {
        await writeFile(this.#piCommandDeclinedPath(), `${new Date().toISOString()}\n`).catch(() => {});
        this.log("未安装终端命令 pi；需要时可在设置页安装");
      } else this.log(`安装终端命令 pi 失败：${error instanceof Error ? error.message : String(error)}；可在设置页重试`);
    }
  }

  /** macOS 的 `pi` 命令要一次管理员授权：装 Pi 时顺势请求一次，之后由设置页按钮安装或移除；Windows 自动维护。 */
  async piCommand(action: string): Promise<AgentInstallStatus[]> {
    if (process.platform !== "darwin") throw new Error("Windows 会自动维护 pi 命令");
    if (action === "install") {
      const runtime = this.#packagedRuntime();
      if (runtime === undefined) throw new Error("开发运行时不安装 pi 命令");
      await installMacPiCommand(runtime.node, this.#managedRoot());
      await rm(this.#piCommandDeclinedPath(), { force: true });
      this.log("已安装终端命令 pi；新开的终端窗口里即可使用");
    } else if (action === "remove") {
      await removeMacPiCommand();
      this.log("已移除终端命令 pi");
    } else throw new Error("未知操作");
    return this.detect();
  }

  async setPiIntegration(enabled: boolean): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Pi 集成开关仅用于 macOS；Windows 由安装器维护");
    const extensionDir = fileURLToPath(new URL("../../pi-extension/", import.meta.url));
    if (!extensionDir.includes(".app/Contents/Resources/runtime/")) {
      this.log("开发运行时不改动 Pi 配置；打包后的 Orbis Host 才会登记 Pi 扩展");
      return;
    }
    await updatePiIntegration({ extensionDir, uninstall: !enabled });
    this.log(enabled ? "已为本机 Pi 登记 Orbis 扩展；新启动的 Pi 会连接 Host，已在运行的 Pi 需重启" : "已从本机 Pi 配置中移除 Orbis 扩展");
    // 关闭集成是「删除 Orbis Host 之前的收尾」：终端命令也一起撤掉（可能需要管理员授权）。
    if (!enabled) await removeMacPiCommand();
  }

  async setClaudeIntegration(enabled: boolean, allowMissing = false, signal?: AbortSignal): Promise<void> {
    const pluginDir = fileURLToPath(new URL("../../claude-mod/", import.meta.url));
    if (!/[\\/]runtime[\\/]packages[\\/]claude-mod[\\/]?$/u.test(pluginDir)) {
      this.log("开发运行时不改动 Claude Code 配置；打包后的 Orbis Host 才会登记 Claude Code 插件");
      return;
    }
    const result = await updateClaudeIntegration({ pluginDir, uninstall: !enabled, ...(signal === undefined ? {} : { signal }) });
    if (result === "claude_not_found") {
      if (enabled && !allowMissing) throw new Error("没有找到 Claude Code（claude 命令）；请先安装 Claude Code 再开启");
      return;
    }
    this.#claudeIntegrationInstalled = enabled;
    this.log(enabled ? "已为本机 Claude Code 安装 Orbis 插件；新启动的 Claude Code 会连接 Host，已在运行的请执行 /reload-plugins 或重启"
      : "已从本机 Claude Code 卸载 Orbis 插件");
  }

  /**
   * The settings switch. A user choice supersedes automatic registration still in flight: both
   * run the same `claude plugin` commands, which must not interleave.
   */
  async configureClaudeIntegration(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.#claudeIntegrationTask;
      if (this.#claudeIntegrationInstalled) return;
    } else {
      this.#claudeIntegrationAbort?.abort();
      await this.#claudeIntegrationTask;
    }
    await this.setClaudeIntegration(enabled);
    // An explicit choice that succeeded replaces whatever the automatic run last reported (such as a failure).
    this.#emit({ event: "preparation", kind: "claude", state: "idle" });
  }

  /**
   * HOST-PREP-04: automatic registration runs beside the Host. Missing Claude Code or a failed plugin
   * command must not prevent the Host from opening or connecting; the result is reported as an event.
   */
  #ensureClaudeIntegration(settings: Pick<DesktopSettings, "claudeIntegrationEnabled">): void {
    if (settings.claudeIntegrationEnabled === false || this.#claudeIntegrationInstalled || this.#claudeIntegrationTask !== undefined) return;
    const abort = this.#claudeIntegrationAbort = new AbortController();
    this.#emit({ event: "preparation", kind: "claude", state: "preparing" });
    const task: Promise<void> = this.setClaudeIntegration(true, true, abort.signal).then(() => {
      this.#emit({ event: "preparation", kind: "claude", state: this.#claudeIntegrationInstalled ? "ready" : "idle" });
    }, (error: unknown) => {
      if (abort.signal.aborted) { this.#emit({ event: "preparation", kind: "claude", state: "idle" }); return; }
      const message = error instanceof Error ? error.message : String(error);
      this.log(`登记 Claude Code 插件失败：${message}`);
      this.#emit({ event: "preparation", kind: "claude", state: "error", message });
    }).finally(() => {
      if (this.#claudeIntegrationTask === task) this.#claudeIntegrationTask = undefined;
      if (this.#claudeIntegrationAbort === abort) this.#claudeIntegrationAbort = undefined;
    });
    this.#claudeIntegrationTask = task;
  }

  /**
   * Host-opened Claude Code waits for registration still in flight. Without it, the launcher would add
   * a one-off `--plugin-dir` while the installed plugin appears underneath: one TUI, two bridges.
   */
  async #claudeIntegrationSettled(): Promise<void> { await this.#claudeIntegrationTask; }

  #claudeLauncher(): ClaudeLauncher {
    const terminal = new TerminalClaudeLauncher({ stateDir: this.#stateDir, configDir: claudeConfigDir(process.env.CLAUDE_CONFIG_DIR) });
    return {
      unavailable: () => terminal.unavailable(),
      launch: async request => { await this.#claudeIntegrationSettled(); await terminal.launch(request); },
      sessionConfiguration: cwd => terminal.sessionConfiguration(cwd),
    };
  }

  async start(settings: DesktopSettings): Promise<void> {
    // HOST-LANE-01: a pause no longer queues behind this start. One that lands before the Host is
    // marked running cancels it here; one that lands later abandons the attempt through #desired.
    const generation = this.#lifecycleGeneration;
    settings.relayUrl = validateDesktopRelay(settings.relayUrl);
    if (!/^orbis_host_[\w-]{43}$/.test(settings.credential)) throw new Error("请先通过 QQ 邮箱注册并激活这台电脑");
    if (this.#desired) throw new Error("Host 已在运行，请先暂停连接");
    // HOST-LIVE-01: the desktop resumes right after a change it paused for. An attempt that the
    // pause abandoned mid-handshake still disposes what it created, so wait for it instead of failing.
    while (this.#starting) await this.#attemptSettled;
    if (this.#desired) throw new Error("Host 已在运行，请先暂停连接");
    await this.#checkExistingHost();
    if (this.#installation) throw new Error("请等待 Agent 安装完成或取消后再启动 Host");
    await this.#environment(settings);
    if (process.platform === "darwin" && settings.piIntegrationEnabled !== false) {
      // 失败不阻止 Host 启动：最坏只是终端里的 Pi 连不上，Host 打开的 Pi 仍带着扩展。
      await this.setPiIntegration(true).catch(error => this.log(`登记 Pi 扩展失败：${error instanceof Error ? error.message : String(error)}`));
    }
    this.#ensureClaudeIntegration(settings);
    if (generation !== this.#lifecycleGeneration) return;
    this.#desired = settings;
    this.#attempt = 0;
    await this.#connect();
  }

  async #checkExistingHost(): Promise<void> {
    let descriptor: { pid?: number; url?: string };
    try { descriptor = JSON.parse(await readFile(join(this.#stateDir, "loopback.json"), "utf8")) as { pid?: number }; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    if (descriptor.pid && descriptor.pid !== process.pid) {
      let alive = true;
      try { process.kill(descriptor.pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false; }
      if (alive && await loopbackPortAlive(descriptor.url)) throw new Error("已有另一个 Host 正在运行。请先在原窗口退出，再从客户端启动。");
      await rm(join(this.#stateDir, "loopback.json"), { force: true });
    }
  }

  async #connect(): Promise<void> {
    const settings = this.#desired;
    if (!settings || this.#starting) return;
    this.#starting = true;
    let settleAttempt = (): void => {};
    this.#attemptSettled = new Promise(resolve => { settleAttempt = resolve; });
    this.#emit({ event: "state", state: "connecting" });
    try {
      await this.#checkExistingHost();

      // Codex Desktop is independent of the optional terminal backend. The Host only opens
      // it after an App session request; an already attached instance is reused by the lifecycle.
      const wrapper = resolveCodexWrapper();
      const endpointPath = codexDesktopEndpointPath(this.#stateDir);
      if (wrapper === undefined) this.log("未找到 Orbis 包装器（codex-launcher 或 codex-desktop-wrapper.js），本轮无法接入 Codex 桌面版");
      // Closures below stay bound to this attempt's lifecycle: a pause clears the field while a
      // service built by the abandoned attempt can still read its status.
      const desktopLifecycle = this.#codexDesktopLifecycle = new CodexDesktopLifecycle({
        log: line => this.log(line),
        onReady: runtime => this.#service?.attachCodexDesktopRuntime(runtime),
        onOffline: runtime => this.#service?.detachCodexDesktopRuntime(runtime),
        resolveEndpoint: async () => readCodexDesktopEndpoint(endpointPath)?.url,
        desktopRefresh: { journalDirectory: join(this.#stateDir, "codex-desktop-refresh"), resolveBridge: () => readCodexDesktopEndpoint(endpointPath)?.refresh },
        launchApp: async () => {
          if (wrapper !== undefined && await launchCodexDesktopThroughWrapper(wrapper, endpointPath)) return;
          await launchCodexDesktopApp();
        },
        // 分档变了才回调（探测每 2s 一次，不能把它变成心跳）：一条给 Host 界面，
        // 一条给已配对的手机，否则手机上只能靠 device.ready 的偶然重播。
        onStatusChange: status => {
          this.log(`Codex 桌面版接入：${status.state} · ${status.reason}`);
          this.#emit({ event: "codexDesktop", status });
          this.#service?.announceCodexDesktopStatus();
        },
      });

      // HOST-PREP-05: the DeepSeek Web backend (local service lock up to 60 s, Web handshake 15 s)
      // is attached after the Relay is online, like the terminal Codex backend; see #prepareDsh.
      let dshLaunchable = false;
      try { await resolveDshCommand(await this.#providers.environment("dsh")); dshLaunchable = true; }
      catch { /* DSH stays unavailable when its CLI or native provider configuration is missing. */ }
      const codexDesktopLaunchable = await desktopLifecycle.isInstalled();
      const connectDshRuntime = async (existingOnly = false): Promise<DshRuntime | undefined> => {
        if (this.#dshRuntime?.isReady()) return this.#dshRuntime;
        const env = await this.#providers.environment("dsh");
        const runtime = existingOnly ? await DshRuntime.connectExisting(env) : await DshRuntime.create(env);
        if (this.#desired !== settings) {
          await runtime?.stop().catch(() => {});
          if (!existingOnly) throw new Error("Host 正在暂停，已取消 DeepSeek 启动");
          return undefined;
        }
        if (runtime) this.#dshRuntime = runtime;
        return runtime;
      };
      const dshDesktopLifecycle = this.#dshDesktopLifecycle = new DshDesktopLifecycle({
        stateDir: this.#stateDir,
        log: line => this.log(line),
        onStatusChange: status => {
          this.log(`DeepSeek Desktop 接入：${status.state} · ${status.reason}`);
          this.#emit({ event: "dshDesktop", status });
          this.#service?.announceDshDesktopStatus();
        },
      });
      const dshDesktopLaunchable = await dshDesktopLifecycle.isInstalled();
      const connectDshDesktop = async (existingOnly = false): Promise<DshRuntime | undefined> => {
        if (this.#dshDesktopRuntime?.isReady()) return this.#dshDesktopRuntime;
        const runtime = existingOnly ? await dshDesktopLifecycle.connectExisting() : await dshDesktopLifecycle.ensure();
        if (this.#desired !== settings) {
          // Release only Orbis's connection; Desktop keeps running (DSH-DESKTOP-07).
          await runtime?.stop().catch(() => {});
          if (!existingOnly) throw new Error("Host 正在暂停，已取消 DeepSeek Desktop 接入");
          return undefined;
        }
        if (runtime) this.#dshDesktopRuntime = runtime;
        return runtime;
      };
      let relayAuthenticated = false;
      const service = await HostService.create({
        providers: this.#providers,
        providerUsage: (kind, id) => this.#usage.get(kind, id),
        managementBackends: () => (["pi", "codex", "dsh"] as const).map(kind => {
          const status = this.#detected.get(kind);
          return { kind, installed: status?.installed ?? null, version: status?.version ?? null };
        }),
        stateDir: this.#stateDir, relayUrl: settings.relayUrl, credential: settings.credential,
        ...(settings.lanPort === undefined ? {} : { lanPort: settings.lanPort }),
        // 终端 Codex 后端在后台接入（见 #prepareCodex）。启动时它可能还没就绪：
        // 这里只给接入点，不等待它，否则一次下载就能把手机挡在中继外面。
        codexLaunch: (request: { cwd: string }) => {
          const runtime = this.#codexRuntime;
          // The terminal shim falls back to the standalone CLI either way; the log should still say why.
          if (runtime === undefined) throw new Error(!settings.codexEnabled ? "Codex 终端接入未启用"
            : this.#codexPrepare !== undefined ? "Codex 后端正在准备，请稍后重试" : "Codex 终端接入未就绪");
          return runtime.prepareTerminalLaunch(request.cwd);
        },
        ensureCodexDesktop: () => desktopLifecycle.ensureReady(),
        codexDesktopLaunchable,
        codexDesktopStatus: () => desktopLifecycle.status,
        ensureDshRuntime: () => connectDshRuntime(),
        recoverDshRuntime: () => connectDshRuntime(true),
        dshLaunchable,
        dshDesktopLaunchable,
        dshDesktopStatus: () => dshDesktopLifecycle.status,
        ensureDshDesktopRuntime: () => connectDshDesktop(),
        recoverDshDesktopRuntime: () => connectDshDesktop(true),
        onDshDesktopOffline: reason => dshDesktopLifecycle.noteOffline(reason),
        claude: { launcher: this.#claudeLauncher() },
        log: line => this.log(line),
        // 只有“当前这次连接”的链路状态才会到界面：暂停或重启后被作废的尝试还在收尾巴，
        // 它事后发出的 closed/reconnecting 会盖掉“已暂停”，把界面卡在“连接已断开”。
        onStateChange: state => {
          if (state === "connected") relayAuthenticated = true;
          if (this.#desired === settings) this.#emit({ event: "state", state });
        },
        onRelayAuthenticationError: error => {
          // Startup rejects through the catch below; reconnects have no start() caller.
          if (relayAuthenticated && error.code === "unauthorized") void this.#requireActivation(settings);
        },
        onPaired: device => { this.#emit({ event: "paired", deviceId: device.deviceId }); this.status(); },
        onPathChange: () => this.status(),
      });
      // 建服务可能跨越一次 stop()：这时它已经不属于任何一次运行，起它只会留下一个没人管的
      // 后台（并接着把状态捅给界面）。自己收掉，然后让 #connect 的 finally 放掉 #starting。
      // 这次尝试在 stop() 之后建出的 Codex / DSH 后端也只属于它：下一次 start 会等它收完再开始。
      if (this.#desired !== settings) { await service.stop().catch(error => this.log(String(error))); await this.#dispose(); return; }
      this.#service = service;
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.#service.start(), new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("连接中继超时")), 25_000);
        })]);
      } finally { if (deadline) clearTimeout(deadline); }
      this.#attempt = 0;
      if (this.#codexDesktopLifecycle !== undefined) {
        await this.#codexDesktopLifecycle.probe().catch(error => this.log(`Codex 桌面版探测失败：${error instanceof Error ? error.message : String(error)}`));
      }
      this.#dshDesktopLifecycle?.watch();
      this.status();
      // 中继已经连上、手机已经可用；Codex 后端（可能要先下载配套包）与 DeepSeek Web 后端在后台接。
      if (settings.codexEnabled) void this.#prepareCodex(settings);
      if (settings.dshEnabled) void this.#prepareDsh(settings, service);
      // Host 跑起来后跑一次检测：既把 Agent 状态推给界面，也顺便静默修复终端接入。
      void this.detect(settings).catch(error => this.log(`Agent 检测失败：${error instanceof Error ? error.message : String(error)}`));
    } catch (error) {
      await this.#dispose();
      if (this.#desired !== settings) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Host 启动失败：${message}`);
      if (error instanceof RelayAuthenticationError && error.code === "unauthorized") {
        await this.#requireActivation(settings);
        return;
      }
      if (/unauthorized|credential|已有另一个 Host/i.test(message)) {
        this.#desired = undefined;
        this.#emit({ event: "state", state: "error", message });
      } else if (this.#desired) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#attempt++, 5));
        this.#emit({ event: "state", state: "reconnecting", message });
        this.#retry = setTimeout(() => { void this.#connect(); }, delay);
      }
    } finally { this.#starting = false; settleAttempt(); }
  }

  /**
   * 后台准备终端 Codex 后端：先验证 / 必要时下载与所选 CLI 版本匹配的官方服务端包，
   * 再拉起 app-server 并挂到已经在跑的服务上。
   *
   * 这一段永远不挡中继连接：首次安装或 CLI 升级后它可能要下上百 MB，
   * 但它只影响 Codex 会话何时出现，不影响手机连得上、连得快。
   */
  async #prepareCodex(settings: DesktopSettings): Promise<void> {
    const controller = new AbortController();
    this.#codexPrepare = controller;
    const report = (download?: { receivedBytes: number; totalBytes: number }): void => {
      this.#emit({ event: "preparation", kind: "codex", state: "preparing", ...(download === undefined ? {} : { download }) });
    };
    report();
    try {
      // The app-server reads Codex configuration that local routing may still be rewriting.
      await this.#routing;
      if (this.#desired !== settings || controller.signal.aborted) return;
      const server = await CodexAppServer.create({
        log: line => this.log(line),
        onExit: () => this.log("Codex 终端后端已断开，可暂停后重新启动 Host"),
        resolveTerminalServer: (cli, options = {}) => resolveCodexTerminalServer(cli, {
          ...options, signal: controller.signal,
          onProgress: (receivedBytes, totalBytes) => report({ receivedBytes, totalBytes }),
        }),
      });
      // 这次接入可能已经因为暂停或改设置而作废：不留没人要的后台进程。
      if (this.#desired !== settings || controller.signal.aborted) { await server.stop().catch(() => undefined); return; }
      const runtime = new CodexRuntime({ server, sourceCoalesceMs: CODEX_SOURCE_COALESCE_MS, log: line => this.log(line), onEvent: () => {} });
      this.#codex = server;
      this.#codexRuntime = runtime;
      // 服务可能已经停掉（暂停正在收尾），那就只收自己的进程。
      const service = this.#service;
      if (service === undefined) { await this.#stopCodex(); return; }
      service.attachCodexRuntime(runtime);
      this.#emit({ event: "preparation", kind: "codex", state: "ready" });
    } catch (error) {
      if (controller.signal.aborted || this.#desired !== settings) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Codex 暂不可用：${message}`);
      this.#emit({ event: "preparation", kind: "codex", state: "error", message });
    } finally {
      if (this.#codexPrepare === controller) this.#codexPrepare = undefined;
    }
  }

  /**
   * HOST-PREP-05: start or reuse the DeepSeek Web backend after the Relay is online. The service's own
   * DSH slot deduplicates this with the automatic recovery and with a phone that opens DeepSeek first.
   */
  async #prepareDsh(settings: DesktopSettings, service: HostService): Promise<void> {
    this.#emit({ event: "preparation", kind: "dsh", state: "preparing" });
    try {
      const runtime = await service.prepareDshRuntime();
      if (this.#desired !== settings) return;
      this.#emit({ event: "preparation", kind: "dsh", state: runtime?.isReady() ? "ready" : "idle" });
    } catch (error) {
      if (this.#desired !== settings) return;
      const message = error instanceof Error ? error.message : String(error);
      // A phone that opens DeepSeek later starts it on demand, so this is not the last chance.
      this.log(`DeepSeek Harness 暂不可用：${message}`);
      this.#emit({ event: "preparation", kind: "dsh", state: "error", message });
    }
  }

  /** 停止终端 Codex 后端（app-server 子进程与它的 runtime）。 */
  async #stopCodex(): Promise<void> {
    const codex = this.#codex; const codexRuntime = this.#codexRuntime;
    this.#codex = undefined; this.#codexRuntime = undefined;
    const service = this.#service;
    if (service !== undefined && codexRuntime !== undefined) service.detachCodexRuntime(codexRuntime);
    await (codexRuntime ? codexRuntime.stop() : codex?.stop())?.catch(error => this.log(String(error)));
  }

  async #requireActivation(settings: DesktopSettings): Promise<void> {
    if (this.#desired !== settings) return;
    if (this.#retry) clearTimeout(this.#retry);
    await this.#dispose();
    if (this.#desired !== settings) return;
    this.#desired = undefined;
    this.#emit({ event: "state", state: "error", activationRequired: true,
      message: "激活凭据已失效，请重新激活" });
  }

  status(): void {
    const service = this.#service;
    if (!service) return;
    const devices = service.devices.filter(d => !d.revoked).map(d => {
      const path = service.activePathOf(d.deviceId);
      if (path) this.#lastSeen.set(d.deviceId, Date.now());
      return {
        deviceId: d.deviceId,
        label: d.label,
        createdAt: d.createdAt,
        path: path ?? "offline",
        lastSeen: this.#lastSeen.get(d.deviceId) ?? 0,
        ...(d.appVersion === undefined ? {} : { appVersion: d.appVersion }),
        ...(d.appVersionCode === undefined ? {} : { appVersionCode: d.appVersionCode }),
      };
    });
    const model = service.readHostState(["backends", "connections", "management", "operations"]);
    const backends = model.domains.find(domain => domain.domain === "backends")?.value as { backends?: { runtimeCount: number }[] } | undefined;
    const status = { event: "status", devices, runtimeCount: backends?.backends?.reduce((sum, backend) => sum + backend.runtimeCount, 0) ?? 0,
      lan: service.lanEndpoints, model };
    const text = JSON.stringify({ ...status, model: { ...model, domains: model.domains.map(domain => ({ ...domain, checkedAt: 0 })) } });
    if (text !== this.#lastStatus) { this.#lastStatus = text; this.#emit(status); }
  }

  async readState(domains?: readonly string[]): Promise<ReturnType<HostService["readHostState"]> | null> {
    const service = this.#service;
    if (!service) return null;
    if (domains === undefined || domains.includes("providers")) await service.refreshProviderFacts();
    if (domains === undefined || domains.includes("catalog")) await service.readHostRange();
    return service.readHostState(domains);
  }

  async readRange(request: Pick<AgentStateRangeRequest, "cursor" | "limit"> = {}): Promise<Awaited<ReturnType<HostService["readHostRange"]>> | null> {
    return await this.#service?.readHostRange(request) ?? null;
  }

  async pair(): Promise<unknown> {
    if (!this.#service || this.#service.relayState !== "connected") throw new Error("请先连接 Host，再添加手机");
    const opened = await this.#service.openPairingWindow({ ttlSeconds: 120 });
    return { qr: await QRCode.toDataURL(encodePairingQrText(opened.payload), { width: 480, margin: 2 }), expiresAt: opened.expiresAtMs };
  }
  cancelPair(): void { this.#service?.pairing.close(); }
  async revoke(deviceId: string): Promise<void> {
    if (this.#service) {
      if (!this.#service.revokeDevice(deviceId)) throw new Error("设备不存在，或已被撤销");
      this.status();
    } else {
      await this.#checkExistingHost();
      const store = await loadDeviceStore(this.#stateDir);
      if (!revokeDeviceRecord(store, deviceId)) throw new Error("设备不存在，或已被撤销");
      await saveDeviceStore(this.#stateDir, store);
      this.#emit({ event: "status", devices: store.devices.filter(d => !d.revoked).map(d => ({ deviceId: d.deviceId, label: d.label, createdAt: d.createdAt, path: "offline" })), runtimeCount: 0 });
    }
  }
  async renameDevice(deviceId: string, label: string): Promise<void> {
    if (!label.trim() || label.length > 80) throw new Error("设备名称应为 1–80 个字符");
    if (this.#service) {
      if (!this.#service.renameDevice(deviceId, label.trim())) throw new Error("设备不存在");
      this.status();
    } else {
      await this.#checkExistingHost();
      const store = await loadDeviceStore(this.#stateDir);
      const device = store.devices.find(d => d.deviceId === deviceId && !d.revoked);
      if (!device) throw new Error("设备不存在");
      device.label = label.trim();
      await saveDeviceStore(this.#stateDir, store);
      this.#emit({ event: "status", devices: store.devices.filter(d => !d.revoked).map(d => ({ deviceId: d.deviceId, label: d.label, createdAt: d.createdAt, path: "offline" })), runtimeCount: 0 });
    }
  }

  async renameHost(name: string): Promise<void> {
    if (this.#desired) throw new Error("修改电脑名称前请先暂停连接");
    await this.#checkExistingHost();
    if (!name.trim() || name.length > 80) throw new Error("电脑名称应为 1–80 个字符");
    const path = join(this.#stateDir, "host.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    stored.hostName = name.trim();
    await writeFile(`${path}.tmp`, JSON.stringify(stored, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  /**
   * HOST-ACT-15: answers one Relay recovery challenge with this Host's long-term key. The private key
   * never leaves this process; the desktop only relays the challenge and the proof.
   */
  async hostRecoveryProof(request: { hostId: string; challengeId: string; relayPub: string }): Promise<{ proof: string }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.challengeId)) throw new Error("恢复请求无效");
    const identity = await loadOrCreateHostIdentity({ dir: this.#stateDir });
    if (identity.hostId !== request.hostId) throw new Error("电脑身份已变化，请重新激活");
    const shared = deriveSharedSecret(privateKeyFromRaw(identity.privateRaw), fromBase64UrlFixed(request.relayPub, X25519_KEY_BYTES, "relayPub"));
    return { proof: hostRecoveryProof(shared, identity.hostId, request.challengeId) };
  }

  /**
   * HOST-ACT-16: the last-resort activation when a Relay refuses to restore this Host ID. The current
   * identity and its phone pairings move to `retired-identities/`; a new identity keeps the computer name.
   */
  async replaceIdentity(): Promise<unknown> {
    if (this.#desired || this.#starting || this.#service) throw new Error("请先暂停连接，再作为新电脑激活");
    await this.#checkExistingHost();
    const previous = await loadOrCreateHostIdentity({ dir: this.#stateDir });
    const archive = join(this.#stateDir, "retired-identities", `${previous.hostId}-${Date.now()}`);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    // Pairings move first: an interruption leaves the old identity without phones, never new keys with old phones.
    for (const name of [DEVICE_STORE_FILE, HOST_IDENTITY_FILE]) {
      await rename(join(this.#stateDir, name), join(archive, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    const identity = await loadOrCreateHostIdentity({ dir: this.#stateDir, hostName: previous.hostName });
    this.log(`已作为新电脑：原身份与手机配对记录保存在 ${archive}`);
    return { hostId: identity.hostId, hostName: identity.hostName, hostPub: toBase64Url(identity.publicRaw), devices: [] };
  }

  async install(kind: string, version = "latest", mode = "current"): Promise<AgentInstallResult> {
    const selected = agentKind(kind);
    if (selected === "claude") throw new Error("Claude Code 请使用官方安装程序");
    if (!["current", "managed"].includes(mode)) throw new Error("未知安装方式");
    if (selected === "dsh" && version !== "latest" && compareAgentVersions(version, DSH_VERSION) === -1) throw new Error(`Orbis 手机接入需要 DeepSeek Harness ${DSH_VERSION} 或兼容版本`);
    if (this.#desired) throw new Error("请先暂停 Host，再安装或更新 Agent");
    if (this.#installation) throw new Error("另一个安装正在进行");
    const managed = this.#managedRoot();
    this.log(`正在安装 ${kind} ${version}，下载可能需要几分钟…`);
    this.#installation = new AbortController();
    this.#installationCommitted = false;
    const signal = this.#installation.signal;
    this.#installationTask = (async () => {
      await this.#checkExistingHost();
      if (selected === "dsh" && version === "latest") {
        const latest = await fetchNpmLatestVersion(agentPackages.dsh, signal);
        signal.throwIfAborted();
        if (!latest) throw new Error("最新版本查询失败，请检查网络后重试");
        version = recommendedAgentVersion(selected, latest)!;
      }
      const current = this.#detected.get(kind);
      const entry = process.env[`ORBIS_${selected.toUpperCase()}_ENTRY`] || current?.entry;
      const packageEntry = entry && (selected === "pi" || selected === "dsh")
        ? (await resolveAgentPackage(selected, entry))?.entry ?? entry : entry;
      const result: AgentInstallResult = await installAgentPackage(selected, version, managed, signal, progress => {
        // The desktop operation completes only after the persistent backend has adopted the new version.
        if (progress.stage !== "done") this.#agentInstallProgress(progress);
      },
        mode === "current" && packageEntry && installationSource(packageEntry, managed) !== "managed" ? { existingEntry: packageEntry } : {});
      // npm updated the selected installation in place; retain the user's stable launcher.
      if (mode === "current" && entry && packageEntry !== entry) result.entry = entry;
      this.#installationCommitted = true;
      if (selected === "codex") await this.#syncCodexSelection(result.entry);
      process.env[`ORBIS_${selected.toUpperCase()}_ENTRY`] = result.entry;
      this.#emit({ event: "agentInstalled", kind: selected, entry: result.entry, version: result.version });
      if (selected === "dsh") {
        this.#agentInstallProgress({ kind: selected, stage: "restarting", version: result.version });
        try {
          const env = await this.#providers.environment("dsh");
          result.restarted = await restartDshWebServiceAfterUpdate(env, await resolveDshCommand({ ...env, ORBIS_DSH_ENTRY: result.entry }));
          if (result.restarted) {
            const service = await ensureDshWebService(env);
            const client = await DshWebClient.connect({ url: service.url, env, ...(service.cli ? { cli: service.cli } : {}) });
            try { await applyDshWebProvider(client, env); } finally { await client.stop(); }
            this.log("DeepSeek Web 已使用新版本自动重启，请从 Host 重新打开网页");
          }
        } catch {
          // Installation has committed. Keep its selected entry and distinguish a restart failure from a failed download.
          result.restartWarning = "DeepSeek 已更新，但后台未能自动就绪。请手动重启 DeepSeek Web，再从 Host 重新打开网页；手动配置的服务需更新启动链接。";
          this.log(result.restartWarning);
        }
      }
      this.#agentInstallProgress({ kind: selected, stage: result.restartWarning ? "restartFailed" : "done", version: result.version });
      this.log(`${kind} ${result.version} 安装完成，已选中新版本`);
      if (selected === "pi" && installationSource(result.entry, managed) === "managed") await this.#offerPiCommand();
      return result;
    })();
    try { return await this.#installationTask; }
    finally { this.#installation = undefined; this.#installationTask = undefined; this.#installationCommitted = false; }
  }

  async updateAgent(kind: string): Promise<AgentInstallResult> {
    const selected = agentKind(kind);
    let status = this.#detected.get(selected);
    if (!status) status = (await this.detect()).find(candidate => candidate.kind === selected);
    const mode = status?.installationSource === "npm" ? "current" : "managed";
    // Native installers and package managers own their launchers and update channels.
    if ((selected === "pi" || selected === "dsh") && status?.installed && status.installationSource === "custom") {
      throw new Error("这份 Agent 使用外部安装入口，请通过原安装器或包管理器更新");
    }
    return this.install(selected, "latest", mode);
  }

  async activateInstallation(kind: string, id: string): Promise<{ entry: string; version: string }> {
    const selected = agentKind(kind);
    if (selected === "claude") throw new Error("Claude Code 请使用官方安装程序");
    if (this.#desired || this.#installation) throw new Error("请先暂停 Host，并等待当前安装完成");
    this.#installation = new AbortController();
    const signal = this.#installation.signal;
    this.#installationTask = (async () => {
      await this.#checkExistingHost();
      const result = await activateManagedAgent(selected, id, this.#managedRoot(), signal);
      if (selected === "codex") await this.#syncCodexSelection(result.entry);
      process.env[`ORBIS_${selected.toUpperCase()}_ENTRY`] = result.entry;
      this.#emit({ event: "agentInstalled", kind: selected, entry: result.entry, version: result.version });
      return result;
    })();
    try { return await this.#installationTask; }
    finally { this.#installation = undefined; this.#installationTask = undefined; }
  }

  async selectCodexEntry(entry: string): Promise<{ entry: string; version: string }> {
    if (this.#desired || this.#installation) throw new Error("请先暂停 Host，再切换 Codex 版本");
    await this.#checkExistingHost();
    const copies = await findAgentCopies("codex", process.env);
    if (!copies.some(copy => copy.entry === entry)) throw new Error("Codex 入口未在当前安装中找到");
    const cli = codexCommandForEntry(entry);
    const { stdout, stderr } = await execute(cli.command, [...cli.prefixArgs, "--version"], { timeout: 10_000, windowsHide: true, maxBuffer: 64_000 });
    const version = extractAgentVersion(stdout + "\n" + stderr);
    if (!version) throw new Error("Codex 入口无法运行");
    await saveCodexSelection(entry);
    process.env.ORBIS_CODEX_ENTRY = entry;
    this.#emit({ event: "agentInstalled", kind: "codex", entry, version });
    return { entry, version };
  }

  async enableCodexTerminal(runtimeRoot: string): Promise<AgentInstallStatus[]> {
    if (process.platform !== "win32") throw new Error("终端接入仅支持 Windows");
    const codex = this.#detected.get("codex");
    if (!codex?.installed || !codex.entry) throw new Error("请先检测并安装可运行的 Codex");
    if (!codex.terminalCompatible) throw new Error("此 Codex 版本不支持 Host 终端接入，请先更新到最新版本");
    await this.#syncCodexSelection(codex.entry);
    if (this.#selectionError) throw new Error("无法写入 Codex 版本选择，请检查 Orbis agents 目录权限");
    await installCodexShim(runtimeRoot);
    await ensureCodexShimWinsPath();
    return this.detect();
  }

  async installAll(action: string): Promise<{ succeeded: number; failures: string[]; warnings: string[]; cancelled: boolean }> {
    if (!["install", "update"].includes(action)) throw new Error("未知安装操作");
    if (this.#desired) throw new Error("请先暂停 Host，再安装或更新 Agent");
    this.#batchCancelled = false;
    const targets = (["pi", "codex", "dsh"] as const).flatMap(kind => {
      const status = this.#detected.get(kind);
      return status && (action === "update" ? !status.installed || status.updateAvailable || status.installedButBroken : !status.installed) ? [status] : [];
    });
    const failures: string[] = []; const warnings: string[] = []; let succeeded = 0;
    for (const target of targets) {
      if (this.#batchCancelled) break;
      try {
        const result = await this.updateAgent(target.kind);
        succeeded += 1;
        if (result.restartWarning) warnings.push(result.restartWarning);
      }
      catch (error) { failures.push(`${target.kind}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { succeeded, failures, warnings, cancelled: this.#batchCancelled };
  }

  #agentInstallProgress(progress: AgentInstallProgress): void {
    this.#emit({
      event: "agentInstall", kind: progress.kind, stage: progress.stage,
      ...(progress.version === undefined ? {} : { version: progress.version }),
      ...(progress.download === undefined ? {} : { download: progress.download }),
    });
  }

  async listProviders(kind: string): Promise<(ProviderSummary & { usage?: UsageSnapshot | undefined })[]> {
    return (await this.#providers.list(agentKind(kind))).map(profile => ({ ...profile, usage: this.#usage.get(kind, profile.id) }));
  }
  piDefaultProvider(): Promise<string> { return this.#providers.piDefaultProvider(); }
  async checkProvider(kind: string, id: string): Promise<unknown> {
    return checkProviderEndpoint(providerFields(await this.#providers.get(agentKind(kind), id)).baseUrl);
  }
  async fetchProviderModels(params: Record<string, unknown>): Promise<unknown> {
    if (params.fields && typeof params.fields === "object") {
      const fields = params.fields as ProviderFields;
      if ([fields.baseUrl, fields.apiKey, fields.api].some(value => typeof value !== "string")) throw new ProviderError("模型查询配置无效");
      return fetchProviderModels(fields);
    }
    const preview = this.providerPreview(params) as { fields: ProviderFields };
    return fetchProviderModels(preview.fields);
  }
  querySubscription(kind: string, id: string): ReturnType<ProviderManager["querySubscription"]> {
    return this.#providers.querySubscription(agentKind(kind), id);
  }
  async queryProviderUsage(kind: string, id: string): Promise<unknown> {
    const profile = await this.#providers.get(agentKind(kind), id);
    if (!profile.usageScript) throw new ProviderError("请先配置用量查询脚本");
    return this.#usage.refresh(profile);
  }
  async saveProviderUsage(kind: string, id: string, script: unknown): Promise<void> {
    await this.#providers.updateMetadata(agentKind(kind), id, { usageScript: script });
    this.#usage.invalidate(kind, id);
    this.#emit({ event: "providerUsageChanged", kind, providerId: id, usage: {} });
    void this.#usage.tick().catch(() => {});
  }
  async providerUsageTemplate(kind: string, id: string, template: string, baseUrl: string): Promise<unknown> {
    const profile = await this.#providers.get(agentKind(kind), id);
    return usageTemplate(template, baseUrl || providerFields(profile).baseUrl);
  }
  getProvider(kind: string, id: string): ReturnType<ProviderManager["get"]> { return this.#providers.get(agentKind(kind), id); }
  oauth(operation: string, id: string): Promise<unknown> { return this.#providers.oauth(operation, id); }
  providerPresets(kind: string): unknown {
    return providerPresets.filter(p => p.kind === agentKind(kind)).map(p => ({ id: p.id, name: p.name, category: p.category, websiteUrl: p.websiteUrl, requiresOAuth: p.requiresOAuth === true, requiresProxy: p.apiFormat !== undefined && !["responses", "openai_responses"].includes(p.apiFormat) }));
  }
  async providerDraft(kind: string, id?: string, presetId?: string): Promise<unknown> {
    const selected = agentKind(kind);
    const profile: ProviderProfile = id ? await this.#providers.get(selected, id) : { kind: selected, id: selected === "pi" ? "" : randomUUID(), name: "", config: newProviderConfig(selected) };
    if (presetId && !id) {
      const preset = providerPresets.find(p => p.id === presetId && p.kind === selected);
      if (!preset) throw new ProviderError("供应商预设不存在");
      if (preset.requiresOAuth) throw new ProviderError("此预设依赖其他托管 OAuth 账号，尚未接入");
      Object.assign(profile, { config: structuredClone(preset.config), name: preset.name, category: preset.category, websiteUrl: preset.websiteUrl, ...(preset.icon ? { icon: preset.icon } : {}) });
      if (selected === "codex") profile.config.apiFormat = preset.apiFormat === "openai_chat" ? "openai_chat" : "responses";
      if (selected === "pi") profile.id = preset.providerKey ?? "";
    }
    const fields = providerFields(profile);
    const official = selected === "codex" ? codexOfficial(profile.config) : selected === "claude" && claudeOfficial(profile.config);
    const nativeOnly = selected === "codex" ? !official && ["openai", "ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"].includes(fields.providerKey) : selected === "claude" ? Object.entries(profile.config.env ?? {}).some(([key, value]) => claudeProtocolSelectors.includes(key) && ["1", "true"].includes(String(value).toLowerCase())) : selected === "dsh" && fields.providerKey === "";
    return { ...profile, fields, official, nativeOnly, presetId: presetId ?? "custom", create: !id, accounts: selected === "codex" ? await this.#providers.oauth("list") : [] };
  }
  providerPreview(params: Record<string, unknown>): unknown {
    const kind = agentKind(params.kind);
    let config: unknown;
    try { config = typeof params.config === "string" ? JSON.parse(params.config) : params.config; } catch { throw new ProviderError("原生 JSON 格式无效"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new ProviderError("配置必须是对象");
    if (params.fields) config = applyProviderFields(kind, config as Record<string, unknown>, params.fields as ProviderFields, params.create === true, false);
    return { config, official: kind === "codex" ? codexOfficial(config as Record<string, unknown>) : kind === "claude" && claudeOfficial(config as Record<string, unknown>), fields: providerFields({ kind, id: String(params.id ?? ""), name: String(params.name ?? ""), config: config as Record<string, unknown> }, true) };
  }
  codexPreferences(): Promise<CodexPreferences> { return this.#providers.codexPreferences(); }
  proxyStatus(): Promise<object> { return this.#providers.proxyStatus(); }
  async resetProxyHealth(id: string): Promise<object> { this.#providers.resetProxyHealth(id); return this.proxyStatus(); }
  async saveProxyPreferences(params: Record<string, unknown>): Promise<object> {
    if (this.#starting) throw new ProviderError("Host 正在启动，请稍后重试");
    if (!this.#service) await this.#checkExistingHost();
    const work = () => this.#providers.saveProxyPreferences(params);
    const result = await (this.#service ? this.#service.changeProvider("codex", work) : work());
    this.#service?.announceProviderChange("codex");
    return result;
  }
  async saveCodexPreferences(params: Record<string, unknown>): Promise<CodexPreferences> {
    if (this.#starting) throw new ProviderError("Host 正在启动，请稍后重试");
    const work = async (): Promise<CodexPreferences> => {
      const result = await this.#providers.saveCodexPreferences(params as CodexPreferences);
      this.#service?.announceProviderChange("codex");
      return result;
    };
    return this.#service ? this.#service.changeProvider("codex", work) : work();
  }
  async reorderProviders(kind: string, ids: unknown): Promise<ProviderSummary[]> {
    const result = await this.#providers.reorder(agentKind(kind), ids);
    this.#service?.announceProviderChange(agentKind(kind));
    return result;
  }
  async mutateProvider(kind: string, operation: "save" | "switch" | "remove" | "copy", params: Record<string, unknown>): Promise<ProviderSummary[]> {
    const selected = agentKind(kind);
    if (this.#starting) throw new ProviderError("Host 正在启动，请稍后重试");
    const work = async (): Promise<ProviderSummary[]> => {
      let result: ProviderSummary[];
      if (operation === "save") {
        let config: unknown;
        try { config = typeof params.config === "string" ? JSON.parse(params.config) : params.config; }
        catch { throw new ProviderError("高级配置 JSON 格式无效"); }
        if (params.fields) config = applyProviderFields(selected, config as Record<string, unknown>, params.fields as ProviderFields, params.create === true);
        result = await this.#providers.save(selected, String(params.id ?? ""), String(params.name ?? ""), config, params.create === true, params.addToLive !== false, providerMetadata(params.metadata ?? {}));
      }
      else if (operation === "switch") result = await this.#providers.switch(selected, String(params.id), params.enabled !== false);
      else if (operation === "copy") result = await this.#providers.copy(selected, String(params.id));
      else result = await this.#providers.remove(selected, String(params.id));
      if (operation === "save" || operation === "remove") this.#usage.invalidate(selected, String(params.id));
      this.#service?.announceProviderChange(selected);
      return result;
    };
    return this.#service ? this.#service.changeProvider(selected, work, operation === "save" ? "save" : "switch") : work();
  }

  async restartDshServer(): Promise<void> {
    if (this.#desired) throw new Error("请先在概览中暂停 Host 连接，再重启 DSH Server");
    if (this.#installation) throw new Error("请等待 Agent 安装完成后再重启 DSH Server");
    await this.#checkExistingHost();
    const env = await this.#providers.environment("dsh");
    if (env.ORBIS_DSH_WEB_URL?.trim()) throw new Error("当前使用手动配置的 DeepSeek Web 服务，请在其启动位置重启，并更新启动链接");
    const cli = await resolveDshCommand(env);
    // HOST-ACTIVITY-04: a restart can wait a minute for another starter's lock. Each stage is reported
    // so the desktop names what it is waiting for instead of one unchanging line.
    const stage = (value: DshWebServiceStage | "connecting" | "applying"): void => { this.#emit({ event: "dshServer", stage: value }); };
    const restarted = await restartDshWebServiceAfterUpdate(env, cli, stage);
    const service = await ensureDshWebService(env, { cli, onStage: stage });
    stage("connecting");
    const client = await DshWebClient.connect({ url: service.url, env, ...(service.cli ? { cli: service.cli } : {}) });
    stage("applying");
    try { await applyDshWebProvider(client, env); } finally { await client.stop(); }
    this.log(restarted ? "DSH Server 已重启，请从 Host 重新打开网页工作台" : "DSH Server 未运行，已启动，请从 Host 打开网页工作台");
  }

  async openAgent(kind: string, mode = "setup", cwd?: string): Promise<void> {
    if (mode !== "setup" && mode !== "tui") throw new Error("未知打开方式");
    if (kind === "dsh") {
      const env = await this.#providers.environment("dsh");
      const service = await ensureDshWebService(env);
      const client = await DshWebClient.connect({ url: service.url, env, ...(service.cli ? { cli: service.cli } : {}) });
      try { await applyDshWebProvider(client, env); } finally { await client.stop(); }
      const script = `Start-Process -FilePath '${service.url.replaceAll("'", "''")}' -ErrorAction Stop`;
      try {
        if (process.platform === "darwin") await execute("open", [service.url], { timeout: 15_000 });
        else await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15_000 });
      } catch { throw new Error("无法打开 DeepSeek 网页工作台，请检查默认浏览器"); }
      finally { await service.stop(); }
      return;
    }
    if (kind === "codexDesktop") {
      if (mode !== "setup") throw new Error("未知打开方式");
      if (this.#codexDesktopLifecycle !== undefined) await this.#codexDesktopLifecycle.ensureReady();
      else await launchCodexDesktopApp();
      return;
    }
    if (kind === "dshDesktop") {
      if (mode !== "setup") throw new Error("未知打开方式");
      this.#openDshDesktop();
      return;
    }
    if (kind === "claude") {
      const workingDirectory = await terminalWorkspace(cwd);
      await this.#claudeLauncher().launch({ cwd: workingDirectory, launchId: randomUUID(), setup: mode === "setup" });
      return;
    }
    if (kind !== "pi" && kind !== "codex") throw new Error("未知 agent");
    if (kind === "codex") await this.#routing;
    const workingDirectory = kind === "pi" || mode === "tui" ? await terminalWorkspace(cwd) : homedir();
    const cli = kind === "pi" ? await resolvePiCommand() : await resolveCodexCommand();
    const remote = kind === "codex" && mode === "tui" && this.#codexRuntime?.isReady()
      ? await this.#codexRuntime.prepareTerminalLaunch(workingDirectory) : undefined;
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const args = kind === "pi" ? [...cli.prefixArgs, ...PI_WORKSPACE_APPROVAL_ARGS, "-e", defaultExtensionPath()] : mode === "setup" ? [...cli.prefixArgs, "login"] : remote ? [...remote.prefixArgs, ...CODEX_STARTUP_ARGS, "--remote", remote.endpoint] : [...cli.prefixArgs, ...CODEX_STARTUP_ARGS, ...codexWorkspaceApprovalArgs(workingDirectory)];
    const command = remote?.command ?? cli.command;
    if (process.platform === "darwin") {
      await openMacAgentTerminal({ stateDir: this.#stateDir, cwd: workingDirectory, command, args,
        env: { ...process.env, ORBIS_STATE_DIR: this.#stateDir, ...(kind === "pi" ? PI_STARTUP_ENV : {}) }, ...(kind === "codex" ? { unsetEnv: ["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"] } : {}) });
      return;
    }
    const startup = kind === "codex" ? "$env:CODEX_INTERNAL_ORIGINATOR_OVERRIDE = $null; "
      : Object.entries(PI_STARTUP_ENV).map(([key, value]) => `$env:${key} = ${quote(value)}; `).join("");
    const script = startup + agentPowerShellScript({ command, prefixArgs: [] }, args);
    // A detached Node child with ignored stdio has no usable console on some
    // Windows hosts. Let Windows create the visible terminal with its own input.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try { await openWindowsConsole({ file: "powershell.exe", argumentLine: `-NoProfile -NoExit -EncodedCommand ${encoded}`, cwd: workingDirectory }); }
    catch (error) {
      if (!(error instanceof WindowsConsoleLaunchError)) throw error;
      this.log(`无法打开终端界面：${error.message}`);
      throw new Error("无法打开终端界面，请重试");
    }
  }
  async openProvider(kind: string, id: string, cwd?: string): Promise<void> {
    // Validate before switching providers: a cancelled or stale workspace must not change configuration.
    if (kind === "pi" || kind === "codex") await terminalWorkspace(cwd);
    await this.mutateProvider(kind, "switch", { id, enabled: true });
    await this.openAgent(kind, "tui", cwd);
  }

  async #dispose(): Promise<void> {
    // 取消在途的终端接入准备：先放掉订阅，下载和 app-server 拉起都会自己收尾。
    const prepare = this.#codexPrepare; this.#codexPrepare = undefined; prepare?.abort();
    const service = this.#service; this.#service = undefined;
    // The desktop drops running facts when paused; the next service must announce its status again.
    this.#lastStatus = "";
    await service?.stop().catch(error => this.log(String(error)));
    await this.#stopCodex();
    const desktopLifecycle = this.#codexDesktopLifecycle;
    this.#codexDesktopLifecycle = undefined;
    await desktopLifecycle?.stop().catch(error => this.log(String(error)));
    const dsh = this.#dshRuntime; this.#dshRuntime = undefined;
    await dsh?.stop().catch(error => this.log(String(error)));
    // Stopping closes only Orbis's API Peer; DeepSeek Harness Desktop is never terminated here.
    this.#dshDesktopLifecycle?.stop(); this.#dshDesktopLifecycle = undefined;
    const dshDesktop = this.#dshDesktopRuntime; this.#dshDesktopRuntime = undefined;
    await dshDesktop?.stop().catch(error => this.log(String(error)));
  }
  async stop(): Promise<void> {
    this.#lifecycleGeneration += 1;
    this.#desired = undefined;
    if (this.#retry) clearTimeout(this.#retry);
    await this.#dispose();
    this.#emit({ event: "state", state: "stopped" });
  }
  /**
   * Host UI open of DeepSeek Desktop (DSH-DESKTOP-09). It may wait for the user to quit a Desktop Orbis did not
   * open, so it runs beside the serialized command queue and reports through `dshDesktopOpen` events. A second
   * click while it runs keeps the same open.
   */
  #openDshDesktop(): void {
    if (this.#dshDesktopOpening !== undefined) return;
    const abort = this.#dshDesktopOpenAbort = new AbortController();
    this.#emit({ event: "dshDesktopOpen", state: "opening" });
    this.#dshDesktopOpening = openDshDesktopFromHost({
      stateDir: this.#stateDir, signal: abort.signal,
      onWaiting: waiting => { if (!abort.signal.aborted) this.#emit({ event: "dshDesktopOpen", state: waiting ? "waiting" : "opening" }); },
    }).then(
      // Attach now rather than at the next recovery tick; a paused Host attaches when it starts.
      async () => { await this.#service?.recoverDshRuntime("dshDesktop").catch(() => undefined); return undefined; },
      (error: unknown) => error instanceof Error ? error.message : String(error),
    ).then(error => {
      this.#dshDesktopOpening = undefined;
      if (this.#dshDesktopOpenAbort === abort) this.#dshDesktopOpenAbort = undefined;
      if (abort.signal.aborted) return;
      if (error !== undefined) this.log(`打开 DeepSeek 桌面版失败：${error}`);
      this.#emit({ event: "dshDesktopOpen", state: "idle", ...(error === undefined ? {} : { error }) });
    });
  }

  async close(): Promise<void> {
    this.#dshDesktopOpenAbort?.abort();
    this.#claudeIntegrationAbort?.abort();
    this.cancelInstall();
    await this.#installationTask?.catch(() => {});
    if (this.#poll) clearInterval(this.#poll);
    await Promise.all([this.#usage.close(), this.stop(), this.#claudeDetection, this.#claudeIntegrationTask, this.#routing]);
    await this.#providers.closeRouting();
  }
  cancelInstall(): void {
    this.#batchCancelled = true;
    // Once the verified installation is selected, finish adopting it before shutting down or cancelling the rest of a batch.
    if (!this.#installationCommitted) this.#installation?.abort();
  }
  log(message: string): void { this.#emit({ event: "log", message: message.replace(/orbis_host_[\w-]+/g, "[redacted]").slice(0, 1500) }); }
}
