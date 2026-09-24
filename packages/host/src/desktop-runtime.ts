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
import { resolveDshCommand } from "./dsh-client.js";
import { resolvePiCommand, defaultExtensionPath } from "./spawner.js";
import { defaultStunServers } from "./config.js";
import { ProviderManager, ProviderError, agentKind, type ProviderSummary } from "./provider-manager.js";
import { installAgentPackage } from "./agent-installation.js";
import { randomUUID } from "node:crypto";
import { newProviderConfig, providerFields, applyProviderFields, type ProviderFields } from "./provider-form.js";

const execute = promisify(execFile);
export type DesktopSettings = {
  relayUrl: string; credential: string; codexEnabled?: boolean; piEntry?: string; codexEntry?: string;
  dshEnabled?: boolean; dshEntry?: string;
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
  readonly #providers: ProviderManager;

  constructor(emit: (event: DesktopEvent) => void, stateDir?: string) {
    this.#emit = emit;
    this.#stateDir = resolveStateDir(stateDir);
    this.#providers = new ProviderManager(this.#stateDir, undefined, {
      beforeApply: async kind => { this.#service?.assertProviderSwitchReady(kind); },
      afterApply: async kind => {
        await this.#service?.reloadProviderConfiguration(kind, await this.#providers.environment(kind));
        this.#emit({ event: "providersChanged", kind });
      },
    });
  }

  async initialize(): Promise<unknown> {
    const identity = await loadOrCreateHostIdentity({ dir: this.#stateDir });
    this.#poll = setInterval(() => this.status(), 2_000);
    this.#poll.unref();
    const devices = (await loadDeviceStore(this.#stateDir)).devices.filter(d => !d.revoked).map(d => ({ deviceId: d.deviceId, label: d.label, createdAt: d.createdAt }));
    return { hostId: identity.hostId, hostName: identity.hostName, stateDir: this.#stateDir, devices, nodeVersion: process.version };
  }

  #environment(settings?: Partial<DesktopSettings>): void {
    if (settings?.piEntry) process.env.ORBIS_PI_ENTRY = settings.piEntry; else delete process.env.ORBIS_PI_ENTRY;
    if (settings?.codexEntry) process.env.ORBIS_CODEX_ENTRY = settings.codexEntry; else delete process.env.ORBIS_CODEX_ENTRY;
    if (settings?.dshEntry) process.env.ORBIS_DSH_ENTRY = settings.dshEntry; else delete process.env.ORBIS_DSH_ENTRY;
    // Existing installations win. Managed installations are a fallback and never replace global npm packages.
    const managed = join(process.env.LOCALAPPDATA ?? homedir(), "Orbis", "agents");
    const searchPath = process.env.PATH ?? process.env.Path ?? "";
    const legacyNpm = process.env.APPDATA ? join(process.env.APPDATA, "npm") : "";
    const roots = searchPath.split(delimiter);
    if (legacyNpm && !roots.includes(legacyNpm)) roots.push(legacyNpm);
    if (!roots.includes(managed)) roots.push(managed);
    process.env.PATH = roots.join(delimiter);
    const bundled = fileURLToPath(new URL("../../../", import.meta.url));
    if (!(process.env.PATH ?? "").split(delimiter).includes(bundled)) process.env.PATH = `${process.env.PATH}${delimiter}${bundled}`;
    process.env.PI_REMOTE_ENABLED = "true";
    process.env.PI_REMOTE_RELAY_URL = "ws://127.0.0.1";
    process.env.PI_REMOTE_RUNTIME_CREDENTIAL = "loopback-only";
  }

  async detect(settings?: Partial<DesktopSettings>): Promise<unknown[]> {
    this.#environment(settings);
    return Promise.all((["pi", "codex", "dsh"] as const).map(async (kind) => {
      try {
        const cli = await (kind === "pi" ? resolvePiCommand() : kind === "dsh" ? resolveDshCommand() : resolveCodexCommand());
        const { stdout } = await execute(cli.command, [...cli.prefixArgs, "--version"], { timeout: 10_000, windowsHide: true, maxBuffer: 64_000 });
        return { kind, installed: true, version: stdout.trim(), path: cli.prefixArgs[0] ?? cli.command, connected: kind === "pi" ? (this.#service?.localRuntimes.length ?? 0) > 0 : kind === "dsh" ? this.#dshRuntime?.isReady() ?? false : this.#codexRuntime?.isReady() ?? false };
      } catch (error) { return { kind, installed: false, error: error instanceof Error ? error.message : String(error) }; }
    }));
  }

  async start(settings: DesktopSettings): Promise<void> {
    settings.relayUrl = validateDesktopRelay(settings.relayUrl);
    if (!/^orbis_host_[\w-]{43}$/.test(settings.credential)) throw new Error("请先通过 QQ 邮箱注册并激活这台电脑");
    if (this.#desired || this.#starting) throw new Error("Host 已在运行，请先暂停连接");
    await this.#checkExistingHost();
    this.#environment(settings);
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

  async install(kind: string, version = "latest"): Promise<{ entry: string; version: string }> {
    const selected = agentKind(kind);
    if (this.#desired || this.#starting) throw new Error("请先暂停 Host，再安装或更新 Agent");
    if (this.#installation) throw new Error("另一个安装正在进行");
    const managed = join(process.env.LOCALAPPDATA ?? homedir(), "Orbis", "agents");
    this.log(`正在安装 ${kind} ${version}，下载可能需要几分钟…`);
    this.#installation = new AbortController();
    try {
      const result = await installAgentPackage(selected, version, managed, this.#installation.signal);
      process.env[`ORBIS_${selected.toUpperCase()}_ENTRY`] = result.entry;
      this.log(`${kind} ${result.version} 安装完成，已选中新版本`);
      return result;
    } finally { this.#installation = undefined; }
  }

  listProviders(kind: string): Promise<ProviderSummary[]> { return this.#providers.list(agentKind(kind)); }
  getProvider(kind: string, id: string): ReturnType<ProviderManager["get"]> { return this.#providers.get(agentKind(kind), id); }
  async providerDraft(kind: string, id?: string): Promise<unknown> {
    const selected = agentKind(kind);
    const profile = id ? await this.#providers.get(selected, id) : { kind: selected, id: selected === "pi" ? "" : randomUUID(), name: "", config: newProviderConfig(selected) };
    return { ...profile, fields: providerFields(profile), create: !id };
  }
  async mutateProvider(kind: string, operation: "save" | "switch" | "remove", params: Record<string, unknown>): Promise<ProviderSummary[]> {
    const selected = agentKind(kind);
    if (this.#starting) throw new ProviderError("Host 正在启动，请稍后重试");
    const work = async (): Promise<ProviderSummary[]> => {
      let result: ProviderSummary[];
      if (operation === "save") {
        let config: unknown;
        try { config = typeof params.config === "string" ? JSON.parse(params.config) : params.config; }
        catch { throw new ProviderError("高级配置 JSON 格式无效"); }
        if (params.fields) config = applyProviderFields(selected, config as Record<string, unknown>, params.fields as ProviderFields);
        result = await this.#providers.save(selected, String(params.id ?? ""), String(params.name ?? ""), config, params.create === true);
      }
      else if (operation === "switch") result = await this.#providers.switch(selected, String(params.id), params.enabled !== false);
      else result = await this.#providers.remove(selected, String(params.id));
      this.#service?.announceProviderChange(selected);
      return result;
    };
    return this.#service ? this.#service.changeProvider(selected, work) : work();
  }

  async openAgent(kind: string, mode = "setup"): Promise<void> {
    if (mode !== "setup" && mode !== "tui") throw new Error("未知打开方式");
    const cli = kind === "pi" ? await resolvePiCommand() : kind === "codex" ? await resolveCodexCommand() : kind === "dsh" ? await resolveDshCommand() : undefined;
    if (!cli) throw new Error("未知 agent");
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const args = kind === "pi" ? [...cli.prefixArgs, "-e", defaultExtensionPath()] : kind === "dsh" ? [...cli.prefixArgs, "web"] : mode === "setup" ? [...cli.prefixArgs, "login"] : cli.prefixArgs;
    const script = `& ${[cli.command, ...args].map(quote).join(" ")}`;
    // A detached Node child with ignored stdio has no usable console on some
    // Windows hosts. Let Windows create the visible terminal with its own input.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const launcher = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NoExit','-EncodedCommand',${quote(encoded)} -WorkingDirectory ${quote(homedir())} -WindowStyle Normal -ErrorAction Stop`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")], { stdio: "ignore", windowsHide: true, cwd: homedir(), timeout: 15_000, ...(kind === "dsh" ? { env: await this.#providers.environment("dsh") } : {}) });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开终端界面，请重试")));
    });
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
  async close(): Promise<void> { if (this.#poll) clearInterval(this.#poll); await this.stop(); }
  cancelInstall(): void { this.#installation?.abort(); }
  log(message: string): void { this.#emit({ event: "log", message: message.replace(/orbis_host_[\w-]+/g, "[redacted]").slice(0, 1500) }); }
}
