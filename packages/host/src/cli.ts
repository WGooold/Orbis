#!/usr/bin/env node
/**
 * `pi-remote` 命令行（spec §4.1 / §4.4）。
 *
 *   pi-remote pair              打开 120 秒配对窗口，终端打印二维码
 *   pi-remote host              常驻，维持 Relay 通道与设备会话
 *   pi-remote devices           列出已配对设备
 *   pi-remote devices revoke ID 撤销一台设备
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
} from "@pi-remote/e2e";
import { LoopbackDescriptorSchema } from "@pi-remote/protocol";

import { loadHostConfig } from "./config.js";
import { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { DshRuntime } from "./dsh-runtime.js";
import { HostService } from "./host-service.js";
import { describePath } from "./path.js";

const USAGE = `pi-remote —— 电脑侧的 Host 进程

  pi-remote pair                 打开配对窗口并打印二维码
  pi-remote host                 常驻运行，等待手机连接
  pi-remote devices              列出已配对设备
  pi-remote devices revoke <id>  撤销一台设备

可选参数：
  --state-dir <路径>             覆盖状态目录（默认 ~/.pi-remote）
  --codex                        host 子命令：启用 Codex 后端（需已全局安装 codex-cli）
  --dsh                          host 子命令：启用 DeepSeek Harness 后端

环境变量：
  PI_REMOTE_LAN_PORT             覆盖 LAN 直连端口（默认 42130）
`;

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      "state-dir": { type: "string" },
      codex: { type: "boolean" },
      dsh: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const [command, ...rest] = parsed.positionals;
  const stateDir = parsed.values["state-dir"];

  switch (command) {
    case "pair":
      await runPair(stateDir);
      return;
    case "host":
      await runHost(stateDir, parsed.values.codex === true, parsed.values.dsh === true);
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
async function runHost(stateDirOption: string | undefined, codexEnabled: boolean, dshEnabled: boolean): Promise<void> {
  const stateDir = resolveStateDir(stateDirOption);
  const config = await loadHostConfig({ stateDir });

  // Codex 后端按需启用；起不来（未安装/版本太旧）不是致命错误，降级为纯 Pi。
  let codexServer: CodexAppServer | undefined;
  let codexRuntime: CodexRuntime | undefined;
  if (codexEnabled) {
    try {
      codexServer = await CodexAppServer.create({
        log: (line) => console.log(`[codex] ${line}`),
        onExit: (code) => console.log(`[codex] app-server 已退出（code=${code ?? "signal"}），Codex 后端不可用`),
      });
      codexRuntime = new CodexRuntime({
        server: codexServer,
        log: (line) => console.log(`[codex] ${line}`),
        onEvent: () => {}, // 真正的出口由 HostService 接管（setEventSink）
      });
    } catch (error) {
      console.error(`[codex] 后端未启用：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let dshRuntime: DshRuntime | undefined;
  if (dshEnabled) {
    try { dshRuntime = await DshRuntime.create(); }
    catch (error) { console.error(`[dsh] 后端未启用：${error instanceof Error ? error.message : String(error)}`); }
  }

  let service: HostService | undefined;
  try {
    service = await HostService.create({
      relayUrl: config.relayUrl,
      credential: config.runtimeCredential,
      stateDir,
      ...(config.adminToken === undefined ? {} : { adminToken: config.adminToken }),
      ...(config.lanPort === undefined ? {} : { lanPort: config.lanPort }),
      ...(config.stunServers.length > 0 ? { stunServers: config.stunServers } : {}),
      ...(codexRuntime === undefined ? {} : { codexRuntime }),
      ...(dshRuntime === undefined ? {} : { dshRuntime }),
      log: (line) => console.log(`[host] ${line}`),
      onStateChange: (state) => console.log(`[host] relay ${state}`),
      onPathChange: (deviceId, change) => {
        console.log(`[host] 设备 ${deviceId} 切到${describePath(change.to)}`);
      },
      onData: (_deviceId, payload) => {
        console.log(`[host] 收到 ${payload.byteLength} 字节载荷，但没有对应的本机 runtime 能处理它`);
      },
    });

    await service.start();
    console.log(`[host] hostId=${service.hostId} 已就绪，共 ${service.devices.length} 台已配对设备`);
    if (service.lan !== undefined) {
      const endpoints = service.lan.endpoints.map((entry) => `${entry.host}:${entry.port}`).join("、");
      console.log(`[host] LAN 直连已就绪：${endpoints.length === 0 ? "（未找到非回环网卡）" : endpoints}`);
    }
    if (service.loopback !== undefined) {
      for (const runtime of service.localRuntimes) {
        console.log(`[host] 本机已接入 runtime ${runtime.runtimeId}（${runtime.cwd}）`);
      }
      console.log("[host] 在另一台终端启动 Pi 即会自动接上本机通道；Ctrl+C 退出");
    }

    await waitForSignal();
  } finally {
    try { await service?.stop(); }
    finally { await Promise.all([codexServer?.stop(), dshRuntime?.stop()]); }
  }
  console.log("[host] 已退出");
}

/** 配对模式：短命进程。开窗、收 PAIR_REQUEST、落盘，然后退出。 */
async function runPair(stateDirOption: string | undefined): Promise<void> {
  const stateDir = resolveStateDir(stateDirOption);
  const config = await loadHostConfig({ stateDir });

  if (await isLocalHostAlive()) {
    console.error("本机已经有一个 `pi-remote host` 在运行，配对窗口开不起来。");
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
  process.stdout.write(await renderTerminalQr(encodePairingQrText(opened.payload)));
  console.log(`请用 Orbis APP 扫码。窗口 ${remainingSeconds} 秒后关闭。`);
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
  console.log("接着运行 `pi-remote host` 常驻即可。");
}

/**
 * 本机是否有一个常驻 Host 活着。
 *
 * 依据是 loopback 发现文件里的 `pid` 还在：Host 起落都会维护这个文件，
 * 残留文件指向已退出的进程时探不出活进程，自然放行。这里只是防手滑，
 * 不是安全边界——判断错了的最坏结果和没有这个检查一样。
 */
async function isLocalHostAlive(): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(resolveStateDir(undefined), "loopback.json"), "utf8");
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
      console.log("还没有已配对的设备。在电脑上运行 `pi-remote pair` 开始配对。");
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
      console.error("用法：pi-remote devices revoke <deviceId>");
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

function waitForSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

await main();
