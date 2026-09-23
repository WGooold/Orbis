/**
 * M3 进程激活冒烟（spec §8）：本脚本 = 真 HostService + 假手机。
 *
 * 走的是和真机完全一样的链路：真 Relay、真扫码配对流程、真 E2E 握手，
 * 假手机用同一套 e2e 原语独立推导密钥。三条消息各验一遍：
 *
 *   session.list    → 磁盘扫描出的历史会话（cwd 来自会话文件首行）
 *   session.browse  → 空路径返回盘符；再浏览一次仓库根目录看 hasSessions
 *   session.activate（仅 --spawn 时）→ 在仓库根目录 headless 拉起一个真 Pi，
 *                     等它经 loopback 注册回来（runtime.online），然后杀掉。
 *                     注意：这会在真实会话存储里留一条新会话记录。
 *
 * 用法：
 *   node scripts/m3-smoke.mjs           # 只跑 list + browse（无副作用）
 *   node scripts/m3-smoke.mjs --spawn   # 额外真拉起一个 Pi（会留会话记录）
 *
 * 前提：`npm run build` 已执行；配对需要 adminToken（~/.pi-remote/config.json
 * 的 adminToken 或环境变量 PI_REMOTE_ADMIN_TOKEN）。
 */
import WebSocket from "ws";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HostService, loadHostConfig, relayHttpBase } from "../packages/host/dist/index.js";
import { createRelayServer } from "../packages/relay/dist/index.js";
import {
  E2eChannel,
  DeviceHandshake,
  buildPairEnvelope,
  buildPlaintextEnvelope,
  createDevicePairingSession,
  fromBase64Url,
  generateX25519KeyPair,
  readHandshakeEnvelope,
  readPairEnvelope,
  verifyPairAccept,
} from "../packages/e2e/dist/index.js";
import { PROTOCOL_VERSION } from "../packages/protocol/dist/index.js";

const stateDir = join(homedir(), ".pi-remote");
const repoDir = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/u, "");
const wantSpawn = process.argv.includes("--spawn");

const log = (line) => console.log(line);

// ── 起本地 Relay（v2）：冒烟测试自包含在本机，不连接生产服务 ──
const config = await loadHostConfig({ stateDir });
if (config.adminToken === undefined) {
  console.error("缺少 adminToken：请在 ~/.pi-remote/config.json 配 adminToken，或设 PI_REMOTE_ADMIN_TOKEN");
  process.exit(1);
}
const relay = await createRelayServer({
  port: 0,
  runtimeCredentials: [config.runtimeCredential],
  adminToken: config.adminToken,
  stateFile: join(stateDir, "smoke-relay-state.json"),
});
log(`[relay] 本地 v2 Relay 已启动：${relay.url}`);

// ── 起 Host（真进程逻辑，连本地 Relay）───────────────────────────────────────
const host = await HostService.create({
  relayUrl: relay.url,
  credential: config.runtimeCredential,
  adminToken: config.adminToken,
  stateDir,
  reconnect: false,
  onStateChange: (state) => log(`[host] relay 状态: ${state}`),
  log,
});
await host.start();
log(`\n[host] 已启动 hostId=${host.hostId}`);

// ── 假手机：扫码配对 → HS → 三条 M3 消息 ─────────────────────────────────────
const opened = await host.openPairingWindow();
const payload = opened.payload;

const response = await fetch(`${relayHttpBase(relay.url)}/v1/pairings`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: payload.code, deviceName: "M3 冒烟假手机" }),
});
if (!response.ok) throw new Error(`配对码兑换失败：HTTP ${response.status}`);
const paired = await response.json();

const socket = new WebSocket(`${relay.url}/v1/device`);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
socket.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: paired.credential }));

// 每条路径的密钥独立推导；统一队列：握手阶段存信封，业务阶段存解密后的消息。
let channel;
const queue = [];
const waiters = new Set();
const runtimeOnline = [];

function handleEnvelope(envelope) {
  if (channel === undefined) {
    deliver({ envelope });
    return;
  }
  // 探针原样回声，让对端算得出 RTT（假手机要做的两件事之一）。
  if (envelope.hdr.k === "ping") {
    const echo = channel.open(envelope);
    socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: channel.seal({ k: "ping", room: payload.hostId, from: paired.deviceId, to: payload.hostId, n: channel.nextSequence() }, echo) }));
    return;
  }
  const message = JSON.parse(channel.open(envelope).toString("utf8"));
  if (message.type === "runtime.online") runtimeOnline.push(message);
  deliver({ message });
}

socket.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (frame.type !== "v2.frame") {
    console.log("[phone] 明文帧:", JSON.stringify(frame).slice(0, 200));
    return;
  }
  handleEnvelope(frame.envelope);
});

function deliver(item) {
  const waiter = waiters.values().next().value;
  if (waiter !== undefined) {
    waiters.delete(waiter);
    waiter(item);
    return;
  }
  queue.push(item);
}

function send(envelope) {
  socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
}

async function nextItem(timeoutMs = 15_000) {
  const queued = queue.shift();
  if (queued !== undefined) return queued;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`等消息超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const waiter = (item) => {
      clearTimeout(timer);
      resolve(item);
    };
    waiters.add(waiter);
  });
}

async function nextEnvelope(timeoutMs = 15_000) {
  for (;;) {
    const item = await nextItem(timeoutMs);
    if (item.envelope !== undefined) return item.envelope;
  }
}

async function nextMessage(timeoutMs = 15_000) {
  for (;;) {
    const item = await nextItem(timeoutMs);
    if (item.message !== undefined) return item.message;
  }
}

function sealData(payloadText) {
  return channel.seal(
    { k: "data", room: payload.hostId, from: paired.deviceId, to: payload.hostId, n: channel.nextSequence() },
    Buffer.from(payloadText, "utf8"),
  );
}

// PAIR：用 QR 里的 hostPub + psk 独立算出 pskRoot（信任根只有二维码）。
const pairingSession = createDevicePairingSession({
  hostPublicRaw: fromBase64Url(payload.hostPub, "hostPub"),
  psk: fromBase64Url(payload.psk, "psk"),
  deviceId: paired.deviceId,
  deviceKeyPair: generateX25519KeyPair(),
});
send(buildPairEnvelope({ room: payload.hostId, from: paired.deviceId, to: payload.hostId, body: pairingSession.request }));
const accept = readPairEnvelope(await nextEnvelope());
if (accept.type !== "pair-accept") throw new Error(`期望 pair-accept，收到 ${accept.type}`);
verifyPairAccept(pairingSession, accept);

// HS1 → HS2 → HS3：连接级临时密钥，明文交换。
const handshake = new DeviceHandshake(pairingSession.pskRoot);
send(buildPlaintextEnvelope({ kind: "hs", room: payload.hostId, from: paired.deviceId, to: payload.hostId, body: handshake.start() }));
const hs2 = readHandshakeEnvelope(await nextEnvelope());
if (hs2.type !== "hs2") throw new Error(`期望 hs2，收到 ${hs2.type}`);
send(buildPlaintextEnvelope({ kind: "hs", room: payload.hostId, from: paired.deviceId, to: payload.hostId, body: handshake.accept(hs2) }));
channel = new E2eChannel({ keys: handshake.keys, role: "device" });

// 欢迎消息：device.ready + device.path
log("[phone] 收到:", (await nextMessage()).type);
log("[phone] 收到:", (await nextMessage()).type);

// ── 1) session.list：历史会话 ────────────────────────────────────────────────
send(sealData(JSON.stringify({ type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "m3-list" })));
const listResult = await nextMessage();
if (listResult.type !== "session.list.result") throw new Error(`期望 session.list.result，收到 ${listResult.type}`);
const byCwd = new Map();
for (const entry of listResult.sessions) {
  byCwd.set(entry.cwd, (byCwd.get(entry.cwd) ?? 0) + 1);
}
log(`\n[1] session.list：共 ${listResult.sessions.length} 条历史会话，分布在 ${byCwd.size} 个目录`);
for (const [cwd, count] of [...byCwd.entries()].slice(0, 8)) {
  log(`    ${cwd}  ×${count}`);
}

// ── 2) session.browse：盘符 → 仓库根目录 ─────────────────────────────────────
send(sealData(JSON.stringify({ type: "session.browse", protocolVersion: PROTOCOL_VERSION, requestId: "m3-browse-root" })));
const rootResult = await nextMessage();
log(`\n[2] session.browse（空路径=盘符）：${rootResult.entries.map((entry) => entry.name).join("  ")}`);

send(sealData(JSON.stringify({ type: "session.browse", protocolVersion: PROTOCOL_VERSION, requestId: "m3-browse-repo", path: repoDir })));
const repoResult = await nextMessage();
const withHistory = repoResult.entries.filter((entry) => entry.hasSessions).map((entry) => entry.name);
log(`    browse ${repoDir} → ${repoResult.entries.length} 个子目录，其中有会话历史：${withHistory.length === 0 ? "（无）" : withHistory.join(", ")}`);

// ── 3) session.activate（--spawn 才真拉起）────────────────────────────────────
if (wantSpawn) {
  log("\n[3] session.activate：在仓库根目录 headless 拉起一个真 Pi（约 20 秒内应注册回来）…");
  send(sealData(JSON.stringify({
    type: "session.activate",
    protocolVersion: PROTOCOL_VERSION,
    requestId: "m3-activate",
    target: { type: "new", agentKind: "pi", cwd: repoDir },
    spawnMode: "headless",
  })));
  const activated = await nextMessage();
  if (activated.type === "protocol.error") {
    log(`    激活失败：[${activated.code}] ${activated.message}`);
  } else {
    log(`    已拉起：pid=${activated.pid} spawnMode=${activated.spawnMode} sessionId=${activated.sessionId ?? "（待回执）"}`);
    const deadline = Date.now() + 20_000;
    while (runtimeOnline.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (runtimeOnline.length === 0) {
      log("    ⚠ 20 秒内没等到 runtime.online（Pi 进程可能没装好或扩展加载失败）");
    } else {
      for (const online of runtimeOnline) {
        log(`    ✅ Pi 经 loopback 注册回来：runtimeId=${online.runtime.runtimeId} cwd=${online.runtime.cwd}`);
      }
    }
    if (activated.pid !== undefined) {
      try {
        process.kill(activated.pid);
        log(`    已清理测试进程 pid=${activated.pid}`);
      } catch {
        log(`    ⚠ 测试进程 pid=${activated.pid} 清理失败，请手动结束`);
      }
    }
  }
} else {
  log("\n[3] session.activate：跳过（加 --spawn 真拉起一个 Pi 验证；会在会话存储留一条记录）");
}

socket.close();
await host.stop();
await relay.close();
log("\n冒烟完成 ✅");
process.exit(0);
