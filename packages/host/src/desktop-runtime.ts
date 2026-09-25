import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDeviceStore, loadOrCreateHostIdentity, encodePairingQrText, resolveStateDir, revokeDeviceRecord, saveDeviceStore } from "@pi-remote/e2e";
import QRCode from "qrcode";
import { HostService } from "./host-service.js";
import { CodexAppServer, resolveCodexCommand } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { DshRuntime } from "./dsh-runtime.js";
import { resolveDshCommand, DSH_VERSION } from "./dsh-client.js";
import { ensureDshWebService, validateDshWebUrl } from "./dsh-web-service.js";
import { resolvePiCommand, defaultExtensionPath } from "./spawner.js";
import { defaultStunServers } from "./config.js";
import { ProviderManager, ProviderError, agentKind, providerMetadata, type ProviderPaths, type ProviderProfile, type ProviderSummary } from "./provider-manager.js";
import { installAgentPackage, activateManagedAgent, activeManagedEntry, findAgentCopies, queryAgentStatus, recommendedAgentVersion, extractAgentVersion, compareAgentVersions, installationSource, type AgentInstallProgress, type AgentInstallStatus, type LocalAgent } from "./agent-installation.js";
import { randomUUID } from "node:crypto";
import { newProviderConfig, providerFields, applyProviderFields, type ProviderFields } from "./provider-form.js";
import { providerPresets } from "./provider-presets.js";
import type { CodexPreferences } from "./provider-codex.js";
import { checkProviderEndpoint, fetchProviderModels } from "./provider-network.js";
import { ProviderUsageCache, type UsageSnapshot } from "./provider-usage-cache.js";
import { usageTemplate } from "./provider-usage-templates.js";

const execute = promisify(execFile);
export type DesktopSettings = {
  relayUrl: string; credential: string; codexEnabled?: boolean; piEntry?: string; codexEntry?: string;
  dshEnabled?: boolean; dshEntry?: string; dshWebUrl?: string;
  lanPort?: number; stunServers?: string[];
};
export type DesktopEvent = { event: string; [key: string]: unknown };

export function validateDesktopRelay(value: unknown): string {
  if (typeof value !== "string") throw new Error("请填写中继服务器地址");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("服务器地址不能包含凭据、查询参数或片段");
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("公网中继必须使用 wss://");
  return url.toString().replace(/\/$/, "");
}

/** Owns only the Host process started by the desktop app. No TCP management endpoint is exposed. */
export class DesktopRuntime {
  readonly #stateDir: string;
  readonly #emit: (event: DesktopEvent) => void;
  #service: HostService | undefined;
  #codex: CodexAppServer | undefined;
  #codexRuntime: CodexRuntime | undefined;
  #dshRuntime: DshRuntime | undefined;
  #retry: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #desired: DesktopSettings | undefined;
  #attempt = 0;
  #starting = false;
  #lastStatus = "";
  #lastSeen = new Map<string, number>();
  #installation: AbortController | undefined;
  #installationTask: Promise<{ entry: string; version: string }> | undefined;
  #batchCancelled = false;
  #detected = new Map<string, AgentInstallStatus>();
  readonly #providers: ProviderManager;
  readonly #usage: ProviderUsageCache;

  constructor(emit: (event: DesktopEvent) => void, stateDir?: string, providerPaths?: ProviderPaths) {
    this.#emit = emit;
    this.#stateDir = resolveStateDir(stateDir);
    this.#providers = new ProviderManager(this.#stateDir, providerPaths, {
      beforeApply: async (kind, hotSwitch) => { if (!hotSwitch) this.#service?.assertProviderSwitchReady(kind); },
      afterApply: async (kind, hotSwitch) => {
        if (!hotSwitch) await this.#service?.reloadProviderConfiguration(kind, await this.#providers.environment(kind));
        this.#emit({ event: "providersChanged", kind });
      },
      proxyStatus: () => this.#emit({ event: "proxyStatusChanged" }),
    });
    this.#usage = new ProviderUsageCache(() => this.#providers.usageProfiles(), (profile, usage) => this.#emit({ event: "providerUsageChanged", kind: profile.kind, providerId: profile.id, usage }));
  }

  async initialize(): Promise<unknown> {
    const identity = await loadOrCreateHostIdentity({ dir: this.#stateDir });
    try { await this.#providers.startRouting(); }
    catch (error) { this.log(error instanceof ProviderError ? error.message : "Codex local routing could not start; check its port and settings"); }
    this.#poll = setInterval(() => this.status(), 2_000);
    this.#poll.unref();
    this.#usage.start();
    const devices = (await loadDeviceStore(this.#stateDir)).devices.filter(d => !d.revoked).map(d => ({ deviceId: d.deviceId, label: d.label, createdAt: d.createdAt }));
    return { hostId: identity.hostId, hostName: identity.hostName, stateDir: this.#stateDir, devices, nodeVersion: process.version };
  }

  #managedRoot(): string { return process.env.ORBIS_AGENT_INSTALL_ROOT ?? join(process.env.LOCALAPPDATA ?? homedir(), "Orbis", "agents"); }
  async #environment(settings?: Partial<DesktopSettings>): Promise<void> {
    if (settings?.dshWebUrl?.trim()) process.env.ORBIS_DSH_WEB_URL = validateDshWebUrl(settings.dshWebUrl.trim()); else delete process.env.ORBIS_DSH_WEB_URL;
    const managed = this.#managedRoot();
    for (const kind of ["pi", "codex", "dsh"] as const) {
      const configured = settings?.[`${kind}Entry`];
      let active: string | undefined;
      try { active = await activeManagedEntry(kind, managed); }
      catch { this.log(`${kind} 安装记录不可读，请检查文件权限和 installations.json`); }
      // The manifest survives a UI crash between installation and saving QSettings.
      const entry = configured && installationSource(configured, managed) !== "managed" ? configured : active ?? configured;
      const key = `ORBIS_${kind.toUpperCase()}_ENTRY`;
      if (entry) process.env[key] = entry; else delete process.env[key];
    }
    const searchPath = process.env.PATH ?? process.env.Path ?? "";
    const legacyNpm = process.env.APPDATA ? join(process.env.APPDATA, "npm") : "";
    const roots = searchPath.split(delimiter);
    if (legacyNpm && !roots.includes(legacyNpm)) roots.push(legacyNpm);
    if (!roots.includes(managed)) roots.push(managed);
    process.env.PATH = roots.join(delimiter);
    const bundled = fileURLToPath(new URL("../../../", import.meta.url));
    if (!(process.env.PATH ?? "").split(delimiter).includes(bundled)) process.env.PATH = `${process.env.PATH}${delimiter}${bundled}`;
    // Detection, updates and session startup must target the same copy, including a broken default.
    for (const kind of ["pi", "codex", "dsh"] as const) {
      const key = `ORBIS_${kind.toUpperCase()}_ENTRY`;
      if (!process.env[key]) {
        const entry = (await findAgentCopies(kind, process.env))[0]?.entry;
        if (entry) process.env[key] = entry;
      }
    }
    process.env.PI_REMOTE_ENABLED = "true";
    process.env.PI_REMOTE_RELAY_URL = "ws://127.0.0.1";
    process.env.PI_REMOTE_RUNTIME_CREDENTIAL = "loopback-only";
  }

  async detect(settings?: Partial<DesktopSettings>, checkLatest = false): Promise<AgentInstallStatus[]> {
    await this.#environment(settings);
    const managed = this.#managedRoot();
    return Promise.all((["pi", "codex", "dsh"] as const).map(async (kind) => {
      const copies = await findAgentCopies(kind, process.env);
      const entry = process.env[`ORBIS_${kind.toUpperCase()}_ENTRY`] ?? copies[0]?.entry;
      const local: LocalAgent = { installed: false, installedButBroken: false, ...(entry ? { entry } : {}) };
      try {
        if (entry) {
          const { stdout, stderr } = await execute(process.execPath, [entry, "--version"], { timeout: 10_000, windowsHide: true, maxBuffer: 64_000 });
          const version = extractAgentVersion(stdout + "\n" + stderr);
          if (!version) throw new Error("no version");
          local.installed = true; local.version = version;
        }
      } catch {
        local.installedButBroken = true;
        local.error = "发现安装但无法运行，请检查 Node 版本，或重新安装修复";
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
      this.#detected.set(kind, status);
      return { ...status, path: local.entry, connected: kind === "pi" ? (this.#service?.localRuntimes.length ?? 0) > 0 : kind === "dsh" ? this.#dshRuntime?.isReady() ?? false : this.#codexRuntime?.isReady() ?? false };
    }));
  }

  async start(settings: DesktopSettings): Promise<void> {
    settings.relayUrl = validateDesktopRelay(settings.relayUrl);
    if (!/^orbis_host_[\w-]{43}$/.test(settings.credential)) throw new Error("请先通过 QQ 邮箱注册并激活这台电脑");
    if (this.#desired || this.#starting) throw new Error("Host 已在运行，请先暂停连接");
    await this.#checkExistingHost();
    if (this.#installation) throw new Error("请等待 Agent 安装完成或取消后再启动 Host");
    await this.#environment(settings);
    this.#desired = settings;
    this.#attempt = 0;
    await this.#connect();
  }

  async #checkExistingHost(): Promise<void> {
    let descriptor: { pid?: number };
    try { descriptor = JSON.parse(await readFile(join(this.#stateDir, "loopback.json"), "utf8")) as { pid?: number }; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    if (descriptor.pid && descriptor.pid !== process.pid) {
      let alive = true;
      try { process.kill(descriptor.pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false; }
      if (alive) throw new Error("已有另一个 Host 正在运行。请先在原窗口退出，再从客户端启动。");
    }
  }

  async #connect(): Promise<void> {
    const settings = this.#desired;
    if (!settings || this.#starting) return;
    this.#starting = true;
    this.#emit({ event: "state", state: "connecting" });
    try {
      await this.#checkExistingHost();
      if (settings.codexEnabled) {
        try {
          this.#codex = await CodexAppServer.create({ log: line => this.log(line), onExit: () => this.log("Codex 后端已退出，可暂停后重新启动 Host") });
          this.#codexRuntime = new CodexRuntime({ server: this.#codex, log: line => this.log(line), onEvent: () => {} });
        } catch (error) { this.log(`Codex 暂不可用：${error instanceof Error ? error.message : String(error)}`); }
      }
      if (settings.dshEnabled) {
        try { this.#dshRuntime = await DshRuntime.create(await this.#providers.environment("dsh")); }
        catch (error) { this.log(`DeepSeek Harness 暂不可用：${error instanceof Error ? error.message : String(error)}`); }
      }
      const stunServers = settings.stunServers ?? defaultStunServers(settings.relayUrl);
      this.#service = await HostService.create({
        providers: this.#providers,
        stateDir: this.#stateDir, relayUrl: settings.relayUrl, credential: settings.credential,
        ...(settings.lanPort === undefined ? {} : { lanPort: settings.lanPort }), stunServers,
        ...(this.#codexRuntime === undefined ? {} : { codexRuntime: this.#codexRuntime }),
        ...(this.#dshRuntime === undefined ? {} : { dshRuntime: this.#dshRuntime }),
        log: line => this.log(line),
        onStateChange: state => this.#emit({ event: "state", state }),
        onPaired: device => { this.#emit({ event: "paired", deviceId: device.deviceId }); this.status(); },
        onPathChange: () => this.status(),
      });
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.#service.start(), new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("连接中继超时")), 25_000);
        })]);
      } finally { if (deadline) clearTimeout(deadline); }
      this.#attempt = 0;
      this.status();
    } catch (error) {
      await this.#dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Host 启动失败：${message}`);
      if (/unauthorized|credential|已有另一个 Host/i.test(message)) {
        this.#desired = undefined;
        this.#emit({ event: "state", state: "error", message });
      } else if (this.#desired) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#attempt++, 5));
        this.#emit({ event: "state", state: "reconnecting", message });
        this.#retry = setTimeout(() => { void this.#connect(); }, delay);
      }
    } finally { this.#starting = false; }
  }

  status(): void {
    const service = this.#service;
    if (!service) return;
    const devices = service.devices.filter(d => !d.revoked).map(d => {
      const path = service.activePathOf(d.deviceId);
      if (path) this.#lastSeen.set(d.deviceId, Date.now());
      return { deviceId: d.deviceId, label: d.label, createdAt: d.createdAt, path: path ?? "offline", lastSeen: this.#lastSeen.get(d.deviceId) ?? 0 };
    });
    const status = { event: "status", devices, runtimeCount: service.localRuntimes.length + (this.#codexRuntime?.directoryEntries().length ?? 0) + (this.#dshRuntime?.directoryEntries().length ?? 0), lan: service.lanEndpoints };
    const text = JSON.stringify(status);
    if (text !== this.#lastStatus) { this.#lastStatus = text; this.#emit(status); }
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

  async install(kind: string, version = "latest", mode = "current"): Promise<{ entry: string; version: string }> {
    const selected = agentKind(kind);
    if (!["current", "managed"].includes(mode)) throw new Error("未知安装方式");
    if (selected === "dsh") {
      if (version === "latest") version = this.#detected.get(selected)?.recommendedVersion ?? DSH_VERSION;
      if (compareAgentVersions(version, DSH_VERSION) === -1) throw new Error(`Orbis 手机接入需要 DeepSeek Harness ${DSH_VERSION} 或兼容版本`);
    }
    if (this.#desired || this.#starting) throw new Error("请先暂停 Host，再安装或更新 Agent");
    if (this.#installation) throw new Error("另一个安装正在进行");
    const managed = this.#managedRoot();
    this.log(`正在安装 ${kind} ${version}，下载可能需要几分钟…`);
    this.#installation = new AbortController();
    const signal = this.#installation.signal;
    this.#installationTask = (async () => {
      await this.#checkExistingHost();
      const current = this.#detected.get(kind);
      const entry = process.env[`ORBIS_${selected.toUpperCase()}_ENTRY`] ?? current?.entry;
      const result = await installAgentPackage(selected, version, managed, signal, progress => this.#agentInstallProgress(progress),
        mode === "current" && entry && installationSource(entry, managed) !== "managed" ? { existingEntry: entry } : {});
      process.env[`ORBIS_${selected.toUpperCase()}_ENTRY`] = result.entry;
      this.#emit({ event: "agentInstalled", kind: selected, entry: result.entry, version: result.version });
      this.log(`${kind} ${result.version} 安装完成，已选中新版本`);
      return result;
    })();
    try { return await this.#installationTask; }
    finally { this.#installation = undefined; this.#installationTask = undefined; }
  }

  async activateInstallation(kind: string, id: string): Promise<{ entry: string; version: string }> {
    const selected = agentKind(kind);
    if (this.#desired || this.#starting || this.#installation) throw new Error("请先暂停 Host，并等待当前安装完成");
    this.#installation = new AbortController();
    const signal = this.#installation.signal;
    this.#installationTask = (async () => {
      await this.#checkExistingHost();
      const result = await activateManagedAgent(selected, id, this.#managedRoot(), signal);
      process.env[`ORBIS_${selected.toUpperCase()}_ENTRY`] = result.entry;
      this.#emit({ event: "agentInstalled", kind: selected, entry: result.entry, version: result.version });
      return result;
    })();
    try { return await this.#installationTask; }
    finally { this.#installation = undefined; this.#installationTask = undefined; }
  }

  async installAll(action: string): Promise<{ succeeded: number; failures: string[]; cancelled: boolean }> {
    if (!["install", "update"].includes(action)) throw new Error("未知安装操作");
    if (this.#desired || this.#starting) throw new Error("请先暂停 Host，再安装或更新 Agent");
    this.#batchCancelled = false;
    const targets = (["pi", "codex", "dsh"] as const).flatMap(kind => {
      const status = this.#detected.get(kind);
      return status && (action === "update" ? status.updateAvailable : !status.installed) ? [status] : [];
    });
    const failures: string[] = []; let succeeded = 0;
    for (const target of targets) {
      if (this.#batchCancelled) break;
      try { await this.install(target.kind, target.recommendedVersion ?? target.latestVersion ?? "latest", target.installationSource === "custom" ? "managed" : "current"); succeeded += 1; }
      catch (error) { failures.push(`${target.kind}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { succeeded, failures, cancelled: this.#batchCancelled };
  }

  #agentInstallProgress(progress: AgentInstallProgress): void {
    this.#emit({ event: "agentInstall", kind: progress.kind, stage: progress.stage, ...(progress.version === undefined ? {} : { version: progress.version }) });
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
    return providerPresets.filter(p => p.kind === agentKind(kind)).map(p => ({ id: p.id, name: p.name, requiresOAuth: p.requiresOAuth === true, requiresProxy: p.apiFormat !== undefined && !["responses", "openai_responses"].includes(p.apiFormat) }));
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
    return { ...profile, fields: providerFields(profile), create: !id, accounts: selected === "codex" ? await this.#providers.oauth("list") : [] };
  }
  providerPreview(params: Record<string, unknown>): unknown {
    const kind = agentKind(params.kind);
    let config: unknown;
    try { config = typeof params.config === "string" ? JSON.parse(params.config) : params.config; } catch { throw new ProviderError("原生 JSON 格式无效"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new ProviderError("配置必须是对象");
    if (params.fields) config = applyProviderFields(kind, config as Record<string, unknown>, params.fields as ProviderFields, params.create === true);
    return { config, fields: providerFields({ kind, id: String(params.id ?? ""), name: String(params.name ?? ""), config: config as Record<string, unknown> }) };
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
    return this.#service ? this.#service.changeProvider(selected, work) : work();
  }

  async openAgent(kind: string, mode = "setup"): Promise<void> {
    if (mode !== "setup" && mode !== "tui") throw new Error("未知打开方式");
    if (kind === "dsh") {
      const service = await ensureDshWebService(await this.#providers.environment("dsh"));
      const script = `Start-Process -FilePath '${service.url.replaceAll("'", "''")}' -ErrorAction Stop`;
      try {
        await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15_000 });
      } catch { throw new Error("无法打开 DeepSeek 网页工作台，请检查默认浏览器"); }
      finally { await service.stop(); }
      return;
    }
    const cli = kind === "pi" ? await resolvePiCommand() : kind === "codex" ? await resolveCodexCommand() : undefined;
    if (!cli) throw new Error("未知 agent");
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const args = kind === "pi" ? [...cli.prefixArgs, "-e", defaultExtensionPath()] : mode === "setup" ? [...cli.prefixArgs, "login"] : cli.prefixArgs;
    const script = `& ${[cli.command, ...args].map(quote).join(" ")}`;
    // A detached Node child with ignored stdio has no usable console on some
    // Windows hosts. Let Windows create the visible terminal with its own input.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const launcher = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NoExit','-EncodedCommand',${quote(encoded)} -WorkingDirectory ${quote(homedir())} -WindowStyle Normal -ErrorAction Stop`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")], { stdio: "ignore", windowsHide: true, cwd: homedir(), timeout: 15_000 });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开终端界面，请重试")));
    });
  }
  async openProvider(kind: string, id: string): Promise<void> {
    await this.mutateProvider(kind, "switch", { id, enabled: true });
    await this.openAgent(kind, "tui");
  }

  async #dispose(): Promise<void> {
    const service = this.#service; this.#service = undefined;
    await service?.stop().catch(error => this.log(String(error)));
    const codex = this.#codex; const codexRuntime = this.#codexRuntime; this.#codex = undefined; this.#codexRuntime = undefined;
    await (codexRuntime ? codexRuntime.stop() : codex?.stop())?.catch(error => this.log(String(error)));
    const dsh = this.#dshRuntime; this.#dshRuntime = undefined;
    await dsh?.stop().catch(error => this.log(String(error)));
  }
  async stop(): Promise<void> {
    this.#desired = undefined;
    if (this.#retry) clearTimeout(this.#retry);
    await this.#dispose();
    this.#emit({ event: "state", state: "stopped" });
  }
  async close(): Promise<void> {
    this.cancelInstall();
    await this.#installationTask?.catch(() => {});
    if (this.#poll) clearInterval(this.#poll);
    await Promise.all([this.#usage.close(), this.stop()]);
    await this.#providers.closeRouting();
  }
  cancelInstall(): void { this.#batchCancelled = true; this.#installation?.abort(); }
  log(message: string): void { this.#emit({ event: "log", message: message.replace(/orbis_host_[\w-]+/g, "[redacted]").slice(0, 1500) }); }
}
