import { execFile, spawn } from "node:child_process";
import { readFile, mkdir, writeFile, rename, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDeviceStore, loadOrCreateHostIdentity, encodePairingQrText, resolveStateDir, revokeDeviceRecord, saveDeviceStore } from "@pi-remote/e2e";
import QRCode from "qrcode";
import { HostService } from "./host-service.js";
import { CodexAppServer, resolveCodexCommand } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { resolvePiCommand, defaultExtensionPath } from "./spawner.js";
import { defaultStunServers } from "./config.js";

const execute = promisify(execFile);
export type DesktopSettings = {
  relayUrl: string; credential: string; codexEnabled?: boolean; piEntry?: string; codexEntry?: string;
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
  #retry: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #desired: DesktopSettings | undefined;
  #attempt = 0;
  #starting = false;
  #lastStatus = "";
  #lastSeen = new Map<string, number>();
  #installation: AbortController | undefined;

  constructor(emit: (event: DesktopEvent) => void, stateDir?: string) {
    this.#emit = emit;
    this.#stateDir = resolveStateDir(stateDir);
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
    return Promise.all((["pi", "codex"] as const).map(async (kind) => {
      try {
        const cli = await (kind === "pi" ? resolvePiCommand() : resolveCodexCommand());
        const { stdout } = await execute(cli.command, [...cli.prefixArgs, "--version"], { timeout: 10_000, windowsHide: true, maxBuffer: 64_000 });
        return { kind, installed: true, version: stdout.trim(), path: cli.prefixArgs[0] ?? cli.command, connected: kind === "pi" ? (this.#service?.localRuntimes.length ?? 0) > 0 : this.#codexRuntime?.isReady() ?? false };
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
      const stunServers = settings.stunServers ?? defaultStunServers(settings.relayUrl);
      this.#service = await HostService.create({
        stateDir: this.#stateDir, relayUrl: settings.relayUrl, credential: settings.credential,
        ...(settings.lanPort === undefined ? {} : { lanPort: settings.lanPort }), stunServers,
        ...(this.#codexRuntime === undefined ? {} : { codexRuntime: this.#codexRuntime }),
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
    const status = { event: "status", devices, runtimeCount: service.localRuntimes.length + (this.#codexRuntime?.directoryEntries().length ?? 0), lan: service.lanEndpoints };
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

  async install(kind: string): Promise<void> {
    const packageName = kind === "pi" ? "@earendil-works/pi-coding-agent@0.84.4" : kind === "codex" ? "@openai/codex@0.154.0" : undefined;
    if (!packageName) throw new Error("未知 agent");
    const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    await access(npm);
    const managed = join(process.env.LOCALAPPDATA ?? homedir(), "Orbis", "agents");
    await mkdir(managed, { recursive: true });
    this.log(`正在安装 ${kind}，首次下载可能需要几分钟…`);
    this.#installation = new AbortController();
    try {
      await execute(process.execPath, [npm, "install", "--prefix", managed, "--no-audit", "--no-fund", packageName], { signal: this.#installation.signal, timeout: 600_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } finally { this.#installation = undefined; }
    this.log(`${kind} 安装完成`);
  }

  async openAgent(kind: string, mode = "setup"): Promise<void> {
    if (mode !== "setup" && mode !== "tui") throw new Error("未知打开方式");
    const cli = kind === "pi" ? await resolvePiCommand() : kind === "codex" ? await resolveCodexCommand() : undefined;
    if (!cli) throw new Error("未知 agent");
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const args = kind === "pi" ? [...cli.prefixArgs, "-e", defaultExtensionPath()] : mode === "setup" ? [...cli.prefixArgs, "login"] : cli.prefixArgs;
    const script = `& ${[cli.command, ...args].map(quote).join(" ")}`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NoExit", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { detached: true, stdio: "ignore", windowsHide: false, cwd: homedir() });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }

  async #dispose(): Promise<void> {
    const service = this.#service; this.#service = undefined;
    await service?.stop().catch(error => this.log(String(error)));
    const codex = this.#codex; this.#codex = undefined; this.#codexRuntime = undefined;
    await codex?.stop().catch(error => this.log(String(error)));
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
