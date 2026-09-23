// 开发用：一个进程同时当「常驻 Host」和「配对窗口」，避免
// `pair`（短命）与 `host`（常驻）争抢同一个 runtime 凭据互踢。
//
//   node scripts/host-pair.mjs [--dsh] [轮换秒数，默认 240]
//
// 每轮换一次配对码（Relay 侧配对码 TTL 300s，所以轮换必须小于它），
// 二维码写到 .scratch/pair-qr.txt/.png；配对成功后停止轮换、继续常驻，
// 手机那边的 HS1/HS2/HS3 由同一个进程直接应答（不需要再重启 host）。
import { existsSync, rmSync, writeFileSync } from "node:fs";

import QRCode from "qrcode";

import { encodePairingQrText, resolveStateDir } from "@pi-remote/e2e";
import { loadHostConfig } from "../packages/host/dist/config.js";
import { CodexAppServer } from "../packages/host/dist/codex-daemon.js";
import { CodexRuntime } from "../packages/host/dist/codex-runtime.js";
import { DshRuntime } from "../packages/host/dist/dsh-runtime.js";
import { HostService } from "../packages/host/dist/host-service.js";

import { parseRotateSeconds } from "./host-pair-args.mjs";

const rotateMs = parseRotateSeconds(process.argv) * 1_000;
const qrTextPath = ".scratch/pair-qr.txt";
const qrPngPath = ".scratch/pair-qr.png";

const stateDir = resolveStateDir(undefined);
const config = await loadHostConfig({ stateDir });

// Codex 后端：起不来（未安装/版本太旧）不是致命错误，降级为纯 Pi（同正式 CLI --codex）。
let codexServer;
let codexRuntime;
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
  console.log("[codex] 后端已就绪");
} catch (error) {
  console.error(`[codex] 后端未启用：${error instanceof Error ? error.message : String(error)}`);
}

let dshRuntime;
if (process.argv.includes("--dsh")) {
  try { dshRuntime = await DshRuntime.create(); console.log("[dsh] 后端已就绪"); }
  catch (error) { console.error(`[dsh] 后端未启用：${error.message}`); }
}

const service = await HostService.create({
  relayUrl: config.relayUrl,
  // 必须显式传：HostService 只在 stunServers 非空时才建 P2P 管理器，漏传就是「P2P 静默关闭」——
  // 症状是手机状态页永远显示中继，而日志里连一行理由都没有。正式 CLI 也传同一份配置。
  ...(config.stunServers.length > 0 ? { stunServers: config.stunServers } : {}),
  ...(codexRuntime === undefined ? {} : { codexRuntime }),
  ...(dshRuntime === undefined ? {} : { dshRuntime }),
  credential: config.runtimeCredential,
  ...(config.adminToken === undefined ? {} : { adminToken: config.adminToken }),
  onPaired: (device) => {
    console.log(`PAIRED device=${device.deviceId} name=${device.name ?? "<none>"}`);
  },
  log: (line) => console.log(`[host] ${line}`),
  onStateChange: (state) => console.log(`[host] relay ${state}`),
});

// 启动重试：relay 首次连接失败时 start() 直接抛出（设计如此：凭据错这类问题应当立刻暴露）。
// 但网络抖动（校园网/VPN 掉线、DNS 短暂失效）也会命中这条路，而顶层 await 一抛进程就退出，
// Host 于是「无声消失」——常驻脚本的责任就是活着，所以这里做指数退避重试，而不是让进程死掉。
for (let attempt = 1; ; attempt += 1) {
  try {
    await service.start();
    break;
  } catch (error) {
    const waitMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    console.error(
      `[host] 启动失败（${error instanceof Error ? error.message : String(error)}），` +
        `${Math.round(waitMs / 1000)}s 后重试（第 ${attempt} 次）`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
console.log(`[host] 已启动（relay=${config.relayUrl}，轮换=${rotateMs / 1000}s）`);

let windowTimer = null;

let rotating = false;
async function openFreshWindow() {
  // 防重入：relay 慢的时候一次轮换可能超过间隔，叠起来就是雪崩式的
  // relay 请求 + 二维码生成，正是「事件循环被占满」的另一种形态。
  if (rotating) return;
  rotating = true;
  try {
    const opened = await service.openPairingWindow({ ttlSeconds: 300 });
    const qrText = encodePairingQrText(opened.payload);
    writeFileSync(qrTextPath, qrText);
    await QRCode.toFile(qrPngPath, qrText, { width: 640, margin: 2 });
    const left = Math.round((opened.expiresAtMs - Date.now()) / 1_000);
    console.log(`WINDOW_READY code=${opened.payload.code} expires_in=${left}s`);
  } finally {
    rotating = false;
  }
}

await openFreshWindow();
// 不 unref：事件循环本来就靠常驻连接活着。
// 轮换**不因配对成功而停止**：Relay 侧多个配对码可以并存，各码只在自己 TTL 内有效、
// 被用掉才消费。停轮换的后果是「上次配对之后就再也没有可用的码」——真机上很难反应过来。
windowTimer = setInterval(() => {
  openFreshWindow().catch((error) => console.log(`WINDOW_ERR ${error.message}`));
}, rotateMs);

// 手动换码：出现 .scratch/pair-rotate 文件即立刻开一个窗口并删除该文件。
// （真机上「码过期了」「想换一个」都很频繁，等 4 分钟轮换或重启进程都太笨。）
const rotateTriggerPath = ".scratch/pair-rotate";
setInterval(() => {
  if (!existsSync(rotateTriggerPath)) return;
  try {
    rmSync(rotateTriggerPath);
  } catch {
    return;
  }
  console.log("WINDOW_REQUEST 手动换码");
  openFreshWindow().catch((error) => console.log(`WINDOW_ERR ${error.message}`));
}, 1_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (windowTimer !== null) clearInterval(windowTimer);
    console.log(`[host] 收到 ${signal}，正在停止…`);
    service.stop()
      .catch(() => {})
      .finally(() => codexServer?.stop())
      .finally(() => dshRuntime?.stop())
      .finally(() => process.exit(0));
  });
}
