#!/usr/bin/env node
/**
 * 会话内存压测台：把「Pi 的内存为什么涨」做成可以随时、秒级复现的实验。
 *
 * 它 import 的是真正在跑的构建产物（packages 下各包的 dist），不是重写的一份近似实现：
 *   - turn    复刻扩展在回合里的每-token 路径（live 工具结果 + message_update）
 *   - pages   App 打开会话翻历史：每页都走一遍 syncSession（reconcile 全量 + 投影全量）
 *   - sync    复刻 syncSession（reconcile 全量 + sessionGraphFromEntries）
 *   - sendqueue 对端不读时，扩展的发件队列有没有上界（真实事故的那条路径）
 *   - catalog 直接调 Pi 的 SessionManager.listAll()（每次 transport 连上都会跑一次）
 *   - oom     用 --max-old-space-size 起子进程，稳定复现 heap 上限崩溃
 *
 * 这些场景都不需要模型、不需要手机、不碰正在运行的 Host / Pi 会话。
 *
 * 前置：改了 packages 下的 src 之后先 npm run build（脚本读 dist）。
 *
 * 用法（Windows Node；示例默认值就是本机实测过的量级）：
 *   node scripts/perf/session-memory-stress.mjs --scene turn    --live-mb 1 --tokens 300
 *   node scripts/perf/session-memory-stress.mjs --scene pages   --session-mb 10
 *   node scripts/perf/session-memory-stress.mjs --scene sync    --session-mb 30 --syncs 5
 *   node scripts/perf/session-memory-stress.mjs --scene sync    --session-mb 60 --sync-rate 4 --seconds 30
 *   node scripts/perf/session-memory-stress.mjs --scene catalog
 *   node scripts/perf/session-memory-stress.mjs --scene oom     --session-mb 400 --heap-mb 900
 *
 * 退出码：0 = 跑完；1 = 参数错误；oom 场景按子进程结果（137/134 或 stderr 命中 heap out of memory 记 0）。
 */

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
// Windows 上动态 import 绝对路径必须是 file:// URL。
const mod = (relative) => import(pathToFileURL(resolve(repo, relative)).href);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") === false ? process.argv[++index] : "1";
  args.set(key, value);
}
const flag = (name, fallback) => (args.has(name) ? args.get(name) : fallback);
const num = (name, fallback) => {
  const value = Number(flag(name, fallback));
  if (!Number.isFinite(value)) throw new Error(`--${name} 需要数字`);
  return value;
};
const scene = flag("scene", "turn");
const json = args.has("json");

const mb = (bytes) => Math.round(bytes / 1024 / 1024);
const heapNow = () => process.memoryUsage().heapUsed;
const rssNow = () => process.memoryUsage().rss;

function report(title, facts) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ scene, title, ...facts })}\n`);
    return;
  }
  console.log(`\n== ${title} ==`);
  for (const [key, value] of Object.entries(facts)) console.log(`  ${key}: ${value}`);
}

/** 造历史：`--images` 张 1MB base64 图 + 其余用文本凑到 `--session-mb`。 */
function buildHistory(sessionMb, images) {
  const raw = [];
  let parentId = null;
  const imageCount = Math.max(0, Math.min(images, Math.floor(sessionMb)));
  const textTarget = Math.max(0, sessionMb - imageCount) * 1024 * 1024;
  let written = 0;
  let index = 0;
  while (written < textTarget || raw.length < imageCount) {
    const asImage = index < imageCount;
    let message;
    if (asImage) {
      message = {
        role: "toolResult", toolCallId: `call-${index}`, toolName: "read", isError: false,
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "A".repeat(1024 * 1024), mimeType: "image/png" },
        ],
      };
      written += 1024 * 1024;
    } else {
      const text = (String(index).padStart(6, "0") + "-").repeat(350).slice(0, 2_800);
      message = { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text }] };
      written += text.length;
    }
    const entry = { type: "message", id: `e${index}`, parentId, timestamp: new Date().toISOString(), message };
    raw.push(entry);
    parentId = entry.id;
    index += 1;
  }
  return raw;
}

async function sceneTurn() {
  const { RecoverableSessionSource } = await mod("packages/protocol/dist/session-source.js");
  const { messageToRemote } = await mod("packages/pi-extension/dist/pi-adapter.js");
  const liveMb = num("live-mb", 1);
  const tokens = num("tokens", 300);
  const chunk = num("chunk", 200);

  async function run(withLive) {
    const source = new RecoverableSessionSource("stress", () => {});
    source.transaction(() => source.observe({ type: "turn.started", turnId: "t1", startedAt: Date.now() }));
    source.transaction(() => source.observe({
      type: "tool.started", toolCallId: "c1", toolName: "read", arguments: { path: "shot.png" },
    }));
    if (withLive) {
      source.transaction(() => source.observe({
        type: "tool.finished", toolCallId: "c1", toolName: "read", isError: false,
        result: {
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "A".repeat(liveMb * 1024 * 1024), mimeType: "image/png" },
          ],
        },
      }));
    }
    const message = { role: "assistant", content: [{ type: "text", text: "" }] };
    let peak = 0;
    const started = performance.now();
    for (let index = 0; index < tokens; index += 1) {
      message.content[0].text += "x".repeat(chunk);
      // 与 index.ts 的 message_update 完全同形：一次 transaction + upsertMessage。
      source.transaction(() => {
        source.upsertMessage({ message: messageToRemote("m1", message), finished: false, contentComplete: true });
      });
      peak = Math.max(peak, heapNow());
    }
    return { ms: performance.now() - started, peak };
  }

  const baseline = await run(false);
  globalThis.gc?.();
  const withLive = await run(true);
  const perToken = (withLive.ms / tokens).toFixed(2);
  const baseToken = (baseline.ms / tokens).toFixed(2);
  report("turn：回合内每个 token 的代价", {
    "live 工具结果": `${liveMb}MB`,
    tokens,
    基线: `${baseline.ms.toFixed(0)}ms（${baseToken}ms/token）`,
    含live: `${withLive.ms.toFixed(0)}ms（${perToken}ms/token）`,
    放大倍数: `${(withLive.ms / Math.max(baseline.ms, 1)).toFixed(1)}×`,
    峰值heap: `${mb(withLive.peak)}MB`,
    结论: Number(perToken) > Number(baseToken) * 3
      ? "放大：每个 delta 都在为 live 状态重复付费（修复前 ≈6.8ms/token @1MB）"
      : "未放大：每 token 与 live 体积无关（ADR-0035 §12/§13 修复后的预期）",
  });
}

async function scenePages() {
  const { RecoverableSessionSource } = await mod("packages/protocol/dist/session-source.js");
  const { prepareSessionSync, selectPreparedSessionSync } = await mod("packages/protocol/dist/index.js");
  const { sessionEntriesFromEntries } = await mod("packages/pi-extension/dist/pi-adapter.js");
  const sessionMb = num("session-mb", 10);
  const images = num("images", 0);
  const pageEntries = num("page-entries", 30); // 与 HostConnection.historyPageSize 一致

  const raw = buildHistory(sessionMb, images);
  const head = raw.at(-1).id;
  const source = new RecoverableSessionSource("stress", () => {});
  globalThis.gc?.();
  const baseHeap = heapNow();
  let peak = heapNow();

  // 完全按 App 的路径翻历史：preview 一页，然后用 beforeEntryId 一页页往前拉。
  // 每一步都走一遍 syncSession 的真实实现（reconcile 全量 + sessionGraphFromEntries 全量）。
  let before = null;
  let pages = 0;
  let totalMs = 0;
  let prepared;
  let prepareMs = 0;
  for (;;) {
    pages += 1;
    const pageStart = performance.now();
    // 与当前实现一致（ADR-0035 §3/§8）：翻页不 reconcile、不重算投影，只换页。
    if (before === null) {
      source.transaction(() => source.reconcile(sessionEntriesFromEntries(raw), head));
      const prepareStart = performance.now();
      prepared = prepareSessionSync(sessionEntriesFromEntries(raw), "stress", head, {});
      prepareMs = performance.now() - prepareStart;
    }
    let snapshot;
    try {
      snapshot = selectPreparedSessionSync(prepared, {
        syncId: `p${pages}`,
        sessionId: "stress",
        range: before === null ? "preview" : "history",
        ...(before === null ? {} : { beforeEntryId: before }),
        maxEntries: pageEntries,
      }, [], source.snapshot());
    } catch (error) {
      console.log(`  第 ${pages} 页失败：${error.message}`);
      break;
    }
    totalMs += performance.now() - pageStart;
    peak = Math.max(peak, heapNow(), rssNow());
    if (snapshot.entries.length === 0) break;
    before = snapshot.entries[0].entryId;
    if (snapshot.hasOlder !== true) break;
    if (pages > 5000) break;
  }

  const totalEntryCount = raw.length;
  report(`pages：App 加载聊天记录（S≈${sessionMb}MB，${totalEntryCount} 条，每页 ${pageEntries} 条）`, {
    会话总量: `${sessionMb}MB（图片 ${images} 张）`,
    翻页数: `${pages} 页`,
    总耗时: `${(totalMs / 1000).toFixed(1)}s`,
    一次性预处理: `${prepareMs.toFixed(0)}ms`,
    平均每页: `${(totalMs / Math.max(pages, 1)).toFixed(1)}ms`,
    峰值: `heap ${mb(peak)}MB rss=${mb(rssNow())}MB`,
    常驻增量: `${mb(heapNow() - baseHeap)}MB`,
    累计分配估算: `一次性 ≈${sessionMb}MB 投影 + ${pages} 页 × 页字节`,
    结论: pages > 1
      ? (totalMs / Math.max(pages, 1) < Math.max(prepareMs / 5, 1)
        ? "每页 O(页)：预处理只做一次，翻页只换页"
        : "每页成本与预处理同量级：调用方仍在每页重算")
      : "只有一页，无法判断翻页成本",
  });
}

async function sceneSync() {
  const { RecoverableSessionSource } = await mod("packages/protocol/dist/session-source.js");
  const { sessionEntriesFromEntries, sessionGraphFromEntries } = await mod(
    "packages/pi-extension/dist/pi-adapter.js",
  );
  const sessionMb = num("session-mb", 30);
  const images = num("images", 0);
  const syncs = num("syncs", 3);
  const rate = num("sync-rate", 0);
  const seconds = num("seconds", 0);

  const raw = buildHistory(sessionMb, images);
  const head = raw.at(-1).id;
  const source = new RecoverableSessionSource("stress", () => {});
  globalThis.gc?.();
  const baseHeap = heapNow();

  const doSync = (index) => {
    const started = performance.now();
    source.transaction(() => source.reconcile(sessionEntriesFromEntries(raw), head));
    try {
      sessionGraphFromEntries(raw, "stress", head,
        { syncId: `s${index}`, sessionId: "stress", range: "preview", maxEntries: 30 }, [], source.snapshot());
    } catch (error) {
      if (index === 0) console.log(`  (preview 未通过：${error.message})`);
    }
    return performance.now() - started;
  };

  if (rate > 0 && seconds > 0) {
    // 模拟手机轮询：按频率持续 sync，每秒记一次 heap，直到时间用完或 heap 撞上限。
    let index = 0;
    let peak = heapNow();
    const t0 = Date.now();
    const deadline = t0 + seconds * 1000;
    let nextSample = t0 + 1000;
    const samples = [];
    while (Date.now() < deadline) {
      doSync(index++);
      const now = Date.now();
      peak = Math.max(peak, heapNow(), rssNow());
      if (now >= nextSample) {
        samples.push({ t: Math.round((now - t0) / 1000), heap: mb(heapNow()), rss: mb(rssNow()) });
        nextSample += 1000;
      }
      await new Promise((done) => setTimeout(done, Math.max(1, Math.round(1000 / rate))));
    }
    const elapsed = Date.now() - t0;
    report(`sync：${rate} 次/秒 持续 ${seconds}s（S≈${sessionMb}MB）`, {
      会话总量: `${sessionMb}MB（图片 ${images} 张）`,
      完成sync: `${index} 次`,
      平均每次: `${(elapsed / Math.max(index, 1)).toFixed(0)}ms`,
      峰值: `heap ${mb(peak)}MB rss=${mb(rssNow())}MB`,
      曲线: samples.map((s) => `${s.t}s:${s.heap}MB`).join(" "),
    });
    return;
  }

  let peak = heapNow();
  const startedMs = performance.now();
  for (let index = 0; index < syncs; index += 1) {
    const cost = doSync(index);
    peak = Math.max(peak, heapNow(), rssNow());
    if (!json) console.log(`  sync ${index}: ${cost.toFixed(0)}ms heap=${mb(heapNow())}MB rss=${mb(rssNow())}MB`);
  }
  const total = performance.now() - startedMs;
  report(`sync：${syncs} 次全量 reconcile（S≈${sessionMb}MB）`, {
    会话总量: `${sessionMb}MB（图片 ${images} 张）`,
    单次: `${(total / syncs).toFixed(0)}ms`,
    峰值: `heap ${mb(peak)}MB`,
    常驻增量: `${mb(heapNow() - baseHeap)}MB`,
    预测: `每次分配 ≈ 2–4 × S = ${sessionMb * 2}–${sessionMb * 4}MB`,
  });
}


/**
 * 对端不读时，Pi 侧的发件队列有没有上限。
 *
 * 真实事故里 Pi 的 V8 heap 几乎不动、CPU 只有个位数，RSS 却按 45MB/s 涨到 4GB：
 * 这是 ws 的 outbound buffer（external memory），不是会话数据。
 */
async function sceneSendQueue() {
  const { WebSocketServer } = await import("ws");
  const { RelayRuntimeTransport } = await mod("packages/pi-extension/dist/transport.js");
  const { PROTOCOL_VERSION } = await mod("packages/protocol/dist/index.js");
  const events = num("events", 600);
  const payloadMb = num("payload-mb", 1);
  const rate = num("rate", 100);

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((done) => server.once("listening", done));
  const port = server.address().port;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "sendqueue" }));
    // 关键：接受连接后立刻停止读取，模拟 Host 卡住（事件循环被占满 / 处理不过来）。
    socket._socket.pause();
  });

  const transport = new RelayRuntimeTransport({ relayUrl: `ws://127.0.0.1:${port}`, credential: "x" });
  await transport.start({ runtimeId: "sendqueue", name: "n", cwd: "c", status: "idle" }, {
    connected: () => {},
    resync: () => {},
    command: () => {},
    error: () => {},
  });
  await new Promise((done) => setTimeout(done, 300));

  const payload = "A".repeat(payloadMb * 1024 * 1024);
  const baseRss = rssNow();
  let peakRss = baseRss;
  let peakHeap = heapNow();
  for (let index = 0; index < events; index += 1) {
    transport.publish({
      type: "notification.source", producerEpoch: "e", sessionId: "s", revision: 1,
      complete: true, notifications: [], pad: payload,
    });
    peakRss = Math.max(peakRss, rssNow());
    peakHeap = Math.max(peakHeap, heapNow());
    if (index % rate === 0) await new Promise((done) => setTimeout(done, 1));
  }
  const totalMb = events * payloadMb;
  report(`sendqueue：对端不读时连发 ${events} × ${payloadMb}MB（合计 ${totalMb}MB）`, {
    "RSS 增长": `${mb(peakRss - baseRss)}MB`,
    "heap 峰值": `${mb(peakHeap)}MB`,
    结论: (peakRss - baseRss) > totalMb * 0.5 * 1024 * 1024
      ? "无背压：对端不读时发件队列会一直吞到进程 OOM（heap 不动，全是 buffer）"
      : "有界：内存没有随发送量线性增长",
  });
  transport.close();
  server.close();
}

async function sceneCatalog() {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  let peak = heapNow();
  const started = performance.now();
  const infos = await SessionManager.listAll((_loaded, _total, partial) => {
    peak = Math.max(peak, heapNow(), rssNow());
    return partial;
  });
  const elapsed = performance.now() - started;
  const textBytes = infos.reduce((sum, info) => sum + Buffer.byteLength(info.allMessagesText ?? "", "utf8"), 0);
  report("catalog：每次 transport 连上都会跑一次 SessionManager.listAll()", {
    会话数: infos.length,
    耗时: `${(elapsed / 1000).toFixed(1)}s`,
    峰值: `heap ${mb(peak)}MB rss=${mb(rssNow())}MB`,
    "retained 文本": `${mb(textBytes)}MB`,
    提示: "这条与当前会话读不读图无关；它按整个会话库计价，连接每重建一次就付一次。",
  });
}

function sceneOom() {
  const sessionMb = num("session-mb", 400);
  const heapMb = num("heap-mb", 900);
  const images = num("images", 0);
  const childArgs = [
    `--max-old-space-size=${heapMb}`,
    fileURLToPath(import.meta.url),
    "--scene", "sync",
    "--session-mb", String(sessionMb),
    "--images", String(images),
    "--syncs", "1",
  ];
  console.log(`\n== oom：${sessionMb}MB 历史 + ${heapMb}MB heap 上限 ==`);
  console.log(`  ${process.execPath} ${childArgs.join(" ")}`);
  const result = spawnSync(process.execPath, childArgs, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const hit = /heap out of memory|Reached heap limit/i.test(output);
  const frames = output.split("\n").filter((line) => /ValueDeserializer|structuredClone|reconcile/.test(line)).slice(0, 3);
  console.log(`  退出码: ${result.status}`);
  console.log(`  命中 heap OOM: ${hit ? "是" : "否"}`);
  if (frames.length) console.log(`  关键栈: ${frames.join(" | ")}`);
  if (!hit && result.status !== 0) console.log(output.split("\n").slice(-8).join("\n"));
  if (!hit) process.exitCode = 1;
}

try {
  if (scene === "turn") await sceneTurn();
  else if (scene === "pages") await scenePages();
  else if (scene === "sync") await sceneSync();
  else if (scene === "sendqueue") await sceneSendQueue();
  else if (scene === "catalog") await sceneCatalog();
  else if (scene === "oom") sceneOom();
  else {
    console.error(`未知 scene：${scene}（turn | pages | sync | sendqueue | catalog | oom）`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
