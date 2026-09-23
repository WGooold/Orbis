// 线上中继认不认本仓库现在的协议？
//
// 只发不会被路由的帧（目标设备不存在），看中继回的是：
//   invalid_message —— 它不认识这种帧（部署的那份比协议旧）
//   device_offline  —— 它认识，只是目标不在线
// 不碰真机：自己的 runtimeId 用 probe-*，不占用 host 的 runtimeId。
//
// 为什么需要它：中继和 host 是分开部署的，而 `protocolVersion` 与 `EnvelopeKind` 是双方
// 的共同契约。部署落后一个提交时，新帧会被中继回绝，但症状在客户端看起来是「下载卡住 /
// 对端不回应 / 手机一打开就报协议错误」，根本联想不到中继版本——中继日志里才看得到一行
// invalid_message。这条命令把那个结论变成几秒即可复现的事实。
//
// 两个曾经的坑，都会让这个脚本**自己撒谎**（把「报文不合规」说成「部署落后」）：
//   1. 版本号写死在脚本里（`const PROTOCOL_VERSION = 3`），协议升到 4 之后它还在按旧版探测；
//      现在 import 权威常量（`packages/protocol`）。
//   2. `runtime.authenticate` 缺 `role`（ADR-0008 起必填：中继只接受网关）、加密帧缺 `ch`
//      （同为必填）。少了它们，**当前版本**的部署也会回 invalid_message。
//
//   node scripts/relay-protocol-probe.mjs
import WebSocket from "ws";

import { PROTOCOL_VERSION } from "../packages/protocol/dist/index.js";
import { resolveStateDir } from "@pi-remote/e2e";

import { loadHostConfig } from "../packages/host/dist/config.js";

const RESPONSE_TIMEOUT_MS = 6_000;
const stateDir = resolveStateDir(undefined);
const config = await loadHostConfig({ stateDir });

const describe = (reply) => `${reply.type}${reply.code === undefined ? "" : ` code=${reply.code}`}`;

/**
 * 开一条 runtime 连接、发一条 authenticate，把中继的**第一条**回复交回来。
 *
 * `socket` 在成功时一并返回：调用方还要用它继续探帧种类（失败时中继已经关了它）。
 */
const authenticate = async (label, body) => {
  const socket = new WebSocket(`${config.relayUrl}/v1/runtime`);
  const queue = [];
  socket.on("message", (raw) => {
    try {
      queue.push(JSON.parse(raw.toString()));
    } catch {
      // 非 JSON 一律忽略：中继只发 JSON。
    }
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
  } catch (error) {
    console.log(`${label.padEnd(30)} → 连接失败：${error.message}`);
    return { socket: undefined, reply: { type: "connect_failed" } };
  }
  socket.send(JSON.stringify(body));
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (queue.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const reply = queue.shift() ?? { type: "timeout" };
  console.log(`${label.padEnd(30)} → ${describe(reply)}`);
  return { socket, queue, reply };
};

const runtimeId = `probe-${Date.now()}`;
const metadata = { runtimeId, name: "probe", cwd: ".", status: "idle" };

console.log(`relay=${config.relayUrl}`);

// 先按本仓库当前协议认证。`role: "host"` 不能省（ADR-0008）。
const current = await authenticate(`authenticate v${PROTOCOL_VERSION}`, {
  type: "runtime.authenticate",
  protocolVersion: PROTOCOL_VERSION,
  credential: config.runtimeCredential,
  role: "host",
  runtime: metadata,
});

let live = current.socket;
if (current.reply.type !== "runtime.ready") {
  // 当前协议没被接受。两种可能必须分开说：线上落后一版，还是这份凭据已经失效。
  // 凭据失效回 `unauthorized`，与版本无关；于是再按上一版试一次来区分「落后」。
  const previous = await authenticate(`authenticate v${PROTOCOL_VERSION - 1}`, {
    type: "runtime.authenticate",
    protocolVersion: PROTOCOL_VERSION - 1,
    credential: config.runtimeCredential,
    runtime: { ...metadata, runtimeId: `${runtimeId}-prev` },
  });
  live = previous.reply.type === "runtime.ready" ? previous.socket : undefined;
  if (live !== undefined) {
    console.log(`→ 线上中继停在 protocol v${PROTOCOL_VERSION - 1}：本仓库的帧会被它回绝，先部署中继。`);
  } else {
    console.log("→ 两版都不被接受：先确认这台机器上的 runtime 凭据（回 unauthorized 就是凭据问题）。");
  }
} else {
  console.log(`→ 线上中继认 protocol v${PROTOCOL_VERSION}。`);
}

if (live === undefined) {
  console.log("（认证没过，帧种类探测跳过。）");
  process.exit(0);
}

// 加密帧**必填** `ch`：不带上它，这一代之后的任何部署都会回 invalid_message，与「部署比
// 协议旧」一字不差——探测就失去分辨力了。所以这里必须带上。
const envelope = (k) => JSON.stringify({
  type: "v2.frame",
  protocolVersion: PROTOCOL_VERSION,
  envelope: {
    v: 2,
    hdr: { k, room: "probe", from: runtimeId, to: "probe-no-such-device", n: 0, ch: "ctl" },
    ct: "AAAA",
  },
});

// data/ping/bin 是这份部署一定认识的（对照）；zzz 一定不认识（证明中继确实在校验）。
for (const kind of ["data", "ping", "bin", "zzz"]) {
  live.send(envelope(kind));
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (current.queue.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const reply = current.queue.shift() ?? { type: "timeout" };
  const verdict = reply.code === "device_offline"
    ? "接受（只是目标不在线）"
    : reply.code === "invalid_message"
      ? "不认识这种帧"
      : `其他：${describe(reply)}`;
  console.log(`${kind.padEnd(5)} → ${String(reply.code ?? reply.type).padEnd(15)} ${verdict}`);
}

live.close();
