#!/usr/bin/env node
/**
 * `orbis` 命令行（spec §4.1 / §4.4）。
 *
 *   orbis pair              打开 120 秒配对窗口，终端打印二维码
 *   orbis host              常驻，维持 Relay 通道与设备会话
 *   orbis devices           列出已配对设备
 *   orbis devices revoke ID 撤销一台设备
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  encodePairingQrText,
  loadDeviceStore,
  resolveStateDir,
  revokeDeviceRecord,
  saveDeviceStore,
  type DeviceRecord,
} from "@orbis/e2e";
import { LoopbackDescriptorSchema, type AgentKind } from "@orbis/protocol";

import { loadHostConfig } from "./config.js";
import { CodexAppServer, resolveCodexCommand } from "./codex-daemon.js";
import { CODEX_SOURCE_COALESCE_MS, CodexRuntime } from "./codex-runtime.js";
import type { CodexDesktopLifecycle } from "./codex-desktop-lifecycle.js";
import { createCodexDesktopLifecycle } from "./codex-desktop-integration.js";
import { DshRuntime } from "./dsh-runtime.js";
import { DshDesktopLifecycle } from "./dsh-desktop-lifecycle.js";
import { resolveDshCommand } from "./dsh-client.js";
import { HostService } from "./host-service.js";
import { createLocalKimiRuntime } from "./kimi-runtime.js";
import { createOpenClawLocalLauncher } from "./openclaw-local-launch.js";
import { agyLocallyAllowed, openAgyProfile } from "./agy-client.js";
import { AgyRuntime } from "./agy-runtime.js";
import { agySubmissionFence } from "./agy-submission-fence.js";
import { createOpenCodeLocalLauncher } from "./opencode-local-launch.js";
import { OpenCodeServiceConnection } from "./opencode-service-connection.js";
import { KIMI_DESKTOP_KIND, KIMI_KIND, type KimiKind } from "./kimi-sessions.js";
import { ProviderManager } from "./provider-manager.js";
import { describePath } from "./path.js";
import { AgentEnablementController, AgentEnablementStore } from "./agent-enablement.js";
import { readOpenClawDesktopSettings } from "./openclaw-gateway.js";
import { loadHermesRemoteGatewayConfig } from "./hermes-remote-gateway.js";
import { hostCliProfile } from "./cli-profile.js";

const USAGE = `orbis —— 电脑侧的 Host 进程

  orbis pair                 打开配对窗口并打印二维码
  orbis host                 常驻运行，等待手机连接
  orbis devices              列出已配对设备
  orbis devices revoke <id>  撤销一台设备

可选参数：
  --state-dir <路径>             覆盖状态目录（默认 ~/.orbis）
  --codex                        host 子命令：首次沿用 Codex 终端接入；开启时预启动终端后端
  --dsh                          host 子命令：首次沿用 DeepSeek 接入；开启时预启动 Web 后端
  --kimi-code                    host 子命令：首次启用 Kimi Code 接入，按需启动本机服务
  --sessions-root <路径>         host 子命令：只扫这个目录下的 Pi 会话（隔离测试台用它，
                                 免得把真实会话列进来；默认 ~/.pi/agent/sessions）
  --print-payload                pair 子命令：把配对载荷按一行 JSON 打到 stdout（不给二维码），
                                 供隔离测试台或脚本把载荷交给客户端，不必用摄像头扫码

环境变量：
  ORBIS_KIMI_CODE_SOURCE    选择 web（默认）或 desktop（macOS arm64）
  ORBIS_LAN_PORT             覆盖 LAN 直连端口（默认 42130）
`;

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      "state-dir": { type: "string" },
      "sessions-root": { type: "string" },
      "print-payload": { type: "boolean" },
      codex: { type: "boolean" },
      dsh: { type: "boolean" },
      "kimi-code": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const [command, ...rest] = parsed.positionals;
  const stateDir = parsed.values["state-dir"];

  if (parsed.values.help === true && command !== undefined) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "pair":
      await runPair(stateDir, parsed.values["print-payload"] === true);
      return;
    case "host":
      await runHost(stateDir, parsed.values.codex === true, parsed.values.dsh === true, parsed.values["sessions-root"], parsed.values["kimi-code"] === true);
      return;
    case "devices":
      await runDevices(rest[0], rest[1], stateDir);
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === undefined || parsed.values.help === true ? 0 : 2;
  }
}

/** 常驻模式：连上 Relay，开 LAN 端点，并开一条本机 loopback 等 Pi 扩展接进来。 */
async function runHost(
  stateDirOption: string | undefined,
  codexEnabled: boolean,
  dshEnabled: boolean,
  sessionsRoot: string | undefined,
  kimiCodeFlag = false,
): Promise<void> {
  const shutdown = waitForSignal();
  try {
    await runHostUntilShutdown(stateDirOption, codexEnabled, dshEnabled, sessionsRoot, kimiCodeFlag, shutdown.promise);
  } finally {
    shutdown.dispose();
  }
}

async function runHostUntilShutdown(
  stateDirOption: string | undefined,
  codexEnabled: boolean,
  dshEnabled: boolean,
  sessionsRoot: string | undefined,
  kimiCodeFlag: boolean,
  shutdown: Promise<void>,
): Promise<void> {
  const stateDir = resolveStateDir(stateDirOption);
  const profile = hostCliProfile(process.platform);
  const config = await loadHostConfig({ stateDir });

  if (await isLocalHostAlive(stateDir)) throw new Error("此状态目录已有正在运行的 Host");
  let service: HostService | undefined;
  const kimiKind = config.kimiCodeSource === "desktop" ? KIMI_DESKTOP_KIND : KIMI_KIND;
  const enablement = cliEnablement(stateDir, { ...(codexEnabled ? { codex: true } : {}), ...(dshEnabled ? { dsh: true } : {}),
    ...(agyLocallyAllowed() && sessionsRoot === undefined ? { agy: true } : {}),
    ...(config.kimiCodeEnabled || kimiCodeFlag ? { [kimiKind]: true } : {}) });
  const liveApply = (kind: AgentKind, liveEdit: boolean): boolean => liveEdit && kind === "dsh";
  const providers = new ProviderManager(stateDir, undefined, {
    beforeApply: async (kind, hotSwitch, liveEdit) => { if (!hotSwitch && !liveApply(kind, liveEdit)) await service?.assertProviderSwitchReady(kind); },
    afterApply: async (kind, hotSwitch, liveEdit) => { if (!hotSwitch) await service?.reloadProviderConfiguration(kind, await providers.environment(kind), liveApply(kind, liveEdit)); },
  });

  let codexRuntime: CodexRuntime | undefined, codexPending: Promise<CodexRuntime | undefined> | undefined;
  let codexGeneration = 0;
  let codexDesktop: CodexDesktopLifecycle | undefined, dshDesktop: DshDesktopLifecycle | undefined;
  const log = (line: string) => console.error(`[host] ${line}`);
  const ensureCodex = (): Promise<CodexRuntime | undefined> => {
    const lease = enablement.lease("codex");
    if (!lease) return Promise.resolve(undefined);
    if (codexRuntime?.isReady()) return Promise.resolve(codexRuntime);
    if (codexPending) return codexPending;
    const generation = codexGeneration;
    const pending = (async () => {
      const server = await CodexAppServer.create({ log });
      if (!lease.isCurrent() || generation !== codexGeneration) { await server.stop(); return undefined; }
      return codexRuntime = new CodexRuntime({ server, ...(profile.headless ? { headless: true } : {}), sourceCoalesceMs: CODEX_SOURCE_COALESCE_MS, log, onEvent: () => {} });
    })().finally(() => { if (codexPending === pending) codexPending = undefined; });
    return codexPending = pending;
  };
  const connectDsh = async (existing: boolean): Promise<DshRuntime | undefined> => {
    const lease = enablement.lease("dsh");
    if (!lease) return undefined;
    const env = await providers.environment("dsh");
    if (!lease.isCurrent()) return undefined;
    return existing ? DshRuntime.connectExisting(env) : DshRuntime.create(env);
  };

  try {
    service = await HostService.create({
      agentEnablement: enablement,
      ...(agyLocallyAllowed() && sessionsRoot === undefined ? { createAgyRuntime: (hostId: string) => new AgyRuntime(signal => openAgyProfile(stateDir, signal), hostId, agySubmissionFence(stateDir)) } : {}),
      createKimiCodeRuntime: async (kind: KimiKind) => {
        const source = kind === KIMI_DESKTOP_KIND ? "desktop" : "web";
        if (source === "desktop" && !profile.launchDesktopAgents) throw new Error("当前平台不支持 Kimi Code 桌面接入");
        return createLocalKimiRuntime({ stateDir, source, homeDir: config.kimiCodeHome,
        ...(config.kimiCodeEndpoint === undefined || source !== config.kimiCodeSource ? {} : { endpoint: config.kimiCodeEndpoint }), log });
      },
      kimiCodeDesktopSupported: profile.launchDesktopAgents,
      providers,
      relayUrl: config.relayUrl,
      relayTransport: config.relayTransport,
      relayHistoryMode: config.relayHistoryMode,
      credential: config.runtimeCredential,
      stateDir,
      preferAutoSessionSpawn: profile.headless,
      ...(config.adminToken === undefined ? {} : { adminToken: config.adminToken }),
      // 隔离测试台用：只列这个目录里的 Pi 会话，避免联调时把真实会话（以及它们的运行状态）拉进来。
      ...(sessionsRoot === undefined ? {} : { sessionsRoot }),
      ...(config.lanPort === undefined ? {} : { lanPort: config.lanPort }),
      ensureCodexRuntime: ensureCodex,
      codexLaunch: async request => {
        const lease = enablement.lease("codex");
        const runtime = await ensureCodex();
        if (!runtime || !lease?.isCurrent()) throw new Error("Codex 终端接入未启用或未就绪");
        service?.attachCodexRuntime(runtime);
        return runtime.prepareTerminalLaunch(request.cwd);
      },
      prepareManagedCodex: async (kind, lease) => {
        if (kind === "codex") {
          if (codexEnabled || profile.headless) void ensureCodex().then(runtime => { if (runtime && lease.isCurrent()) service?.attachCodexRuntime(runtime); }).catch(error => log(String(error)));
          return resolveCodexCommand().then(() => true, () => false);
        }
        if (!profile.launchDesktopAgents) return false;
        const lifecycle = codexDesktop = createCodexDesktopLifecycle({
          stateDir, log,
          onReady: runtime => {
            if (!lease.isCurrent() || codexDesktop !== lifecycle) throw new Error("Codex 桌面版接入已取消");
            service?.attachCodexDesktopRuntime(runtime);
          },
          onOffline: runtime => service?.detachCodexDesktopRuntime(runtime),
        });
        const installed = await lifecycle.isInstalled();
        if (lease.isCurrent()) void lifecycle.probe().catch(() => {});
        return installed;
      },
      releaseManagedCodex: async kind => {
        if (kind === "codex") {
          codexGeneration++; codexPending = undefined;
          const runtime = codexRuntime; codexRuntime = undefined;
          await runtime?.stop();
        } else {
          const lifecycle = codexDesktop; codexDesktop = undefined;
          await lifecycle?.stop();
        }
      },
      ensureCodexDesktop: () => codexDesktop?.ensureReady() ?? Promise.resolve(undefined),
      codexDesktopStatus: () => codexDesktop?.status,
      ensureDshRuntime: () => connectDsh(false),
      recoverDshRuntime: () => connectDsh(true),
      ...(sessionsRoot === undefined ? { hermes: { getRemoteGateway: () => loadHermesRemoteGatewayConfig(stateDir) },
        openClawLauncher: createOpenClawLocalLauncher(), createOpenCodeConnection: () => new OpenCodeServiceConnection({ launcher: createOpenCodeLocalLauncher() }) }
        : { openClaw: false as const, opencodeConnection: false as const }),
      prepareManagedDsh: async (kind, lease) => {
        if (kind === "dsh") {
          const env = await providers.environment("dsh");
          if (!lease.isCurrent()) return false;
          if (dshEnabled) void service?.prepareDshRuntime().catch(error => log(String(error)));
          return resolveDshCommand(env).then(() => true, () => false);
        }
        if (!profile.launchDesktopAgents) return false;
        const lifecycle = dshDesktop = new DshDesktopLifecycle({ stateDir, log, onStatusChange: () => {
          if (lease.isCurrent()) service?.announceDshDesktopStatus();
        } });
        const installed = await lifecycle.isInstalled();
        if (lease.isCurrent()) lifecycle.watch();
        return installed;
      },
      releaseManagedDsh: kind => { if (kind === "dshDesktop") { dshDesktop?.stop(); dshDesktop = undefined; } },
      dshDesktopStatus: () => dshDesktop?.status,
      ensureDshDesktopRuntime: () => dshDesktop?.ensure() ?? Promise.resolve(undefined),
      recoverDshDesktopRuntime: () => dshDesktop?.connectExisting() ?? Promise.resolve(undefined),
      onDshDesktopOffline: reason => dshDesktop?.noteOffline(reason),
      claude: {},
      log: (line) => console.error(`[host] ${line}`),
      onStateChange: (state) => console.error(`[host] relay ${state}`),
      onPathChange: (deviceId, change) => {
        console.error(`[host] 设备 ${deviceId} 切到${describePath(change.to)}`);
      },
      onData: (_deviceId, payload) => {
        console.error(`[host] 收到 ${payload.byteLength} 字节载荷，但没有对应的本机 runtime 能处理它`);
      },
    });

    await service.start();
    console.error(`[host] hostId=${service.hostId} 已就绪，共 ${service.devices.length} 台已配对设备`);
    if (service.lan !== undefined) {
      const endpoints = service.lan.endpoints.map((entry) => `${entry.host}:${entry.port}`).join("、");
      console.error(`[host] LAN 直连已就绪：${endpoints.length === 0 ? "（未找到非回环网卡）" : endpoints}`);
    }
    if (service.loopback !== undefined) {
      for (const runtime of service.localRuntimes) {
        console.error(`[host] 本机已接入 runtime ${runtime.runtimeId}（${runtime.cwd}）`);
      }
      console.error("[host] Agent 可在配对 App 的 Host 设置中修改；Ctrl+C 退出");
    }

    await shutdown;
  } finally {
    try { await service?.stop(); }
    finally { await providers.closeRouting(); }
  }
  console.error("[host] 已退出");
}

function cliEnablement(stateDir: string, choices: Partial<Record<AgentKind, boolean>> = {}): AgentEnablementController {
  return new AgentEnablementController(new AgentEnablementStore(stateDir, async () => {
    const openClaw = await readOpenClawDesktopSettings(stateDir);
    return { ...(openClaw.url ? { openclaw: true } : {}), ...choices };
  }, kind => kind !== "agy" || agyLocallyAllowed()), () => {});
}

/** 配对模式：短命进程。开窗、收 PAIR_REQUEST、落盘，然后退出。 */
async function runPair(stateDirOption: string | undefined, printPayload = false): Promise<void> {
  const stateDir = resolveStateDir(stateDirOption);
  const config = await loadHostConfig({ stateDir });

  // 只认这个状态目录里的常驻 Host：不同状态目录＝不同 Relay 身份，互不抢 runtimeId。
  if (await isLocalHostAlive(stateDir)) {
    console.error("本机已经有一个 `orbis host` 在运行，配对窗口开不起来。");
    console.error("两个进程在 Relay 上共用同一个 runtimeId，会互踢下线，配对消息大概率落在对方手里。");
    console.error("先停掉那个 host（Ctrl+C），再运行本命令。");
    process.exitCode = 2;
    return;
  }

  let resolvePaired: ((device: DeviceRecord) => void) | undefined;
  const paired = new Promise<DeviceRecord>((resolve) => {
    resolvePaired = resolve;
  });

  const service = await HostService.create({
    relayUrl: config.relayUrl,
    credential: config.runtimeCredential,
    stateDir,
    ...(config.lanPort === undefined ? {} : { lanPort: config.lanPort }),
    ...(config.adminToken === undefined ? {} : { adminToken: config.adminToken }),
    // 配对进程是短命的。它去开 loopback 只会覆盖掉常驻 Host 的发现文件，
    // 退出时再把文件删掉——结果是常驻 Host 明明在跑，Pi 却找不到它。
    loopback: false,
    // 同理不去 bind LAN 端口：那个端口归常驻 Host。但二维码里仍然要带 LAN 地址，
    // 否则手机永远拿不到「电脑在局域网里的位置」这条信息。
    lanListen: false,
    onPaired: (device) => resolvePaired?.(device),
    log: (line) => console.error(`[pair] ${line}`),
    // 窗口期内 Relay 掉线/重连要让用户看见：二维码扫不出去时，第一嫌疑就是它。
    onStateChange: (state) => console.error(`[pair] relay ${state}`),
  });

  await service.start();
  const opened = await service.openPairingWindow();
  const remainingSeconds = Math.round((opened.expiresAtMs - Date.now()) / 1_000);
  const pairingText = encodePairingQrText(opened.payload);
  if (printPayload) {
    // 只有这一行写到 stdout：脚本可以直接拿去当载荷用，诊断信息全部留在 stderr。
    console.log(pairingText);
  } else {
    process.stdout.write(await renderTerminalQr(pairingText));
    console.log(`请用 Orbis APP 扫码。窗口 ${remainingSeconds} 秒后关闭。`);
  }
  const lan = opened.payload.lan;
  if (lan !== undefined && lan.length > 0) {
    console.log(`同一局域网内会直连：${lan.map((entry) => `${entry.host}:${entry.port}`).join("、")}`);
  }

  // 这个定时器**不能 unref**：配对进程里没有别的常驻句柄（LAN/loopback 都关着），
  // Relay 掉线时剩下的只有它。unref 掉事件循环就空了，Node 会在扫码前直接退出
  // （表现为 "Detected unsettled top-level await"）——配对窗口正是要活满的这段时间。
  const expiry = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), Math.max(0, opened.expiresAtMs - Date.now()));
  });
  const device = await Promise.race([paired, expiry]);
  await service.stop();

  if (device === undefined) {
    console.error("配对窗口已过期，没有设备完成配对。");
    process.exitCode = 1;
    return;
  }
  console.log(`配对成功：${device.deviceId}`);
  console.log("接着运行 `orbis host` 常驻即可。");
}

/**
 * 本机是否有一个常驻 Host 活着。
 *
 * 依据是 loopback 发现文件里的 `pid` 还在：Host 起落都会维护这个文件，
 * 残留文件指向已退出的进程时探不出活进程，自然放行。这里只是防手滑，
 * 不是安全边界——判断错了的最坏结果和没有这个检查一样。
 */
async function isLocalHostAlive(stateDirOption?: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(resolveStateDir(stateDirOption), "loopback.json"), "utf8");
  } catch {
    return false;
  }
  try {
    const { pid } = LoopbackDescriptorSchema.parse(JSON.parse(raw) as unknown);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runDevices(
  action: string | undefined,
  deviceId: string | undefined,
  stateDirOption: string | undefined,
): Promise<void> {
  const stateDir = resolveStateDir(stateDirOption);
  const store = await loadDeviceStore(stateDir);

  if (action === undefined) {
    if (store.devices.length === 0) {
      console.log("还没有已配对的设备。在电脑上运行 `orbis pair` 开始配对。");
      return;
    }
    for (const device of store.devices) {
      const status = device.revoked ? "已撤销" : "有效  ";
      const createdAt = new Date(device.createdAt * 1_000).toISOString();
      console.log(`${status}  ${device.deviceId}  ${device.label || "(未命名)"}  ${createdAt}`);
    }
    return;
  }

  if (action === "revoke") {
    if (deviceId === undefined || deviceId.length === 0) {
      console.error("用法：orbis devices revoke <deviceId>");
      process.exitCode = 2;
      return;
    }
    if (!revokeDeviceRecord(store, deviceId)) {
      console.error(`没有找到设备 ${deviceId}`);
      process.exitCode = 1;
      return;
    }
    await saveDeviceStore(stateDir, store);
    console.log(`已撤销 ${deviceId}。如果 host 正在运行，重启它才会丢掉这条通道。`);
    return;
  }

  console.log(USAGE);
  process.exitCode = 2;
}

async function renderTerminalQr(text: string): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return await QRCode.toString(text, { type: "terminal", small: true });
}

function waitForSignal(): { promise: Promise<void>; dispose: () => void } {
  let resolveSignal!: () => void;
  const promise = new Promise<void>(resolve => { resolveSignal = resolve; });
  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    resolveSignal();
  };
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
  return { promise, dispose: () => { process.off("SIGINT", done); process.off("SIGTERM", done); } };
}

await main();
