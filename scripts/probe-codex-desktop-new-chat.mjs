#!/usr/bin/env node
/**
 * 探针：定位「Codex 桌面版新建会话后发送，任务却跑在另一个会话里，空白会话还留着」的链路。
 *
 * 它只观察，不改桌面版、不改 Host、不写原生库：
 *   1. 以第二个客户端接入桌面版自己的 app-server（只发只读 RPC：thread/loaded/list、
 *      thread/read、thread/turns/list）。
 *   2. 追加读原生日志库 `~/.codex/logs_2.sqlite`：otel span 里带
 *      `otel.name="thread/start|thread/resume|thread/unsubscribe|thread/archive"`、
 *      `app_server.connection_id`、`app_server.client_name`、`rpc.request_id`，
 *      以及 `codex.op="turn_input"` 的 `conversation.id` / `turn.id`。
 *      于是可以回答「哪个客户端（桌面版 / orbis-host）在什么毫秒建了哪个线程」
 *      和「用户这条消息进了哪个线程」。
 *   3. 读 Host 的落盘视图：`<state>/codex-desktop-threads.json`（Host 收编过的桌面线程台账）
 *      和 `<state>/diagnostics.ndjson`（Host 发布的 codex-desktop:* 事件）。
 *   4. 交互标记：终端里每按一次回车（可带文字）就打一个点，把机器时间线对齐到
 *      「点了新聊天」「按了发送」这些用户动作上。
 *
 * 三种结论分别对应链路上的不同位置：
 *   - 线程都是 `Codex Desktop` 建的、发送时新建线程 → 桌面版这一侧（App 只镜像）。
 *   - 出现 `orbis-host` 建的线程 → Orbis 侧自建（App 的 activate 泄漏）。
 *   - 原生只有一个线程但 App 显示两个 → Host/App 投影重复。
 *
 * 用法：
 *   node scripts/probe-codex-desktop-new-chat.mjs                # 观察，Ctrl-C 结束并出报告
 *   node scripts/probe-codex-desktop-new-chat.mjs --duration 120  # 自动结束
 *   node scripts/probe-codex-desktop-new-chat.mjs --control       # 隔离环境对照：Host 的 resume 会不会造线程
 *
 * 三个入口按现场选：
 *   - 还能复现、要对齐「我点了什么」→ 本文件 live 模式（回车打标记，只读接入 app-server）。
 *   - 事故已过去、只剩日志 → 本文件 --replay N（不连端点），或共用取证的 diagnose/trace。
 *   - 要排除 Orbis 参与了触发 → 退出 Host 后复现，只跑 --replay；Host 的收编动作用 --control 反证。
 *
 * 只查日志的取证（不需要桌面版在跑、不需要连端点）用共用工具：
 *   ~/.orbis/tools/ui-regression/codex-log-forensics.py {procs,spans,threads,diagnose,host,trace}
 * 方法（四路证据各能证明什么、判定分支、反证要求）见同目录 codex-log-forensics.md。
 *
 * 观察模式不会调用模型：探针不发送任何消息。
 * 对照模式用临时 CODEX_HOME 起一份自己的 app-server，不碰用户桌面版与 ~/.codex。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import WebSocket from "ws";

const { values: options } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "codex-home": { type: "string" },
    "endpoint-file": { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
    duration: { type: "string" },
    "poll-ms": { type: "string" },
    control: { type: "boolean" },
    replay: { type: "string" },
    "self-test": { type: "boolean" },
    verbose: { type: "boolean" },
  },
});

const POLL_MS = Number(options["poll-ms"] ?? 400);
const DURATION_MS = Number(options.duration ?? 0) * 1_000;
const STATE_DIR = options["state-dir"] ?? resolveStateDir();
const CODEX_HOME = options["codex-home"] ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
const CLIENT_NAME = "orbis-new-chat-probe";

function resolveStateDir() {
  const current = join(homedir(), ".orbis");
  const legacy = join(homedir(), ".pi-remote");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

// ── 时间线 ────────────────────────────────────────────────────────────────────

class Timeline {
  constructor(file) {
    this.file = file;
    this.events = [];
    this.onEvent = undefined;
  }

  add(type, data = {}) {
    const event = { at: Date.now(), type, ...data };
    this.events.push(event);
    if (this.file !== undefined) appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.onEvent?.(event);
    return event;
  }

  matching(type, predicate = () => true) {
    return this.events.filter(event => event.type === type && predicate(event));
  }
}

// ── app-server 只读客户端 ─────────────────────────────────────────────────────

class NativeClient {
  #pending = new Map();
  #nextId = 0;
  #ws;
  #timeline;
  #closed = false;
  /** 观察该连接收到的广播（用来判断 Host 的动作会不会被桌面版看到）。 */
  onBroadcast;

  static async connect(url, timeline) {
    const client = new NativeClient(timeline);
    client.#timeline = timeline;
    client.#ws = new WebSocket(url, { handshakeTimeout: 5_000, maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      client.#ws.once("open", resolve);
      client.#ws.once("error", reject);
    });
    client.#ws.on("message", raw => client.#onMessage(raw.toString()));
    client.#ws.on("close", () => { client.#closed = true; });
    await client.request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: CLIENT_NAME, title: "Orbis new-chat probe", version: "0.1.0" },
    });
    client.notify("initialized");
    return client;
  }

  #onMessage(line) {
    let frame;
    try { frame = object(JSON.parse(line)); } catch { return; }
    const id = frame.id;
    const pending = id === undefined ? undefined : this.#pending.get(String(id));
    if (pending !== undefined && frame.method === undefined) {
      this.#pending.delete(String(id));
      if (frame.error !== undefined && frame.error !== null) pending.reject(new Error(object(frame.error).message ?? "app-server error"));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method === undefined) return;
    if (id !== undefined) {
      // 服务端请求（审批 / 问卷）归回合所有者；探针不拥有任何回合，回错误帧避免对方挂住。
      this.#send({ id, error: { code: -32601, message: "orbis-new-chat-probe does not serve requests" } });
      this.#timeline.add("app.serverRequest", { method: frame.method });
      return;
    }
    const params = object(frame.params);
    const threadId = text(params.threadId) || text(object(params.thread).id) || text(object(params.turn).threadId);
    const event = { at: Date.now(), method: frame.method, ...(threadId === "" ? {} : { threadId }) };
    this.#timeline.add("app.broadcast", event);
    this.onBroadcast?.(event);
  }

  #send(value) {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(value));
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  request(method, params = {}, timeoutMs = 8_000) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(String(id), {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.#send({ id, method, params });
    });
  }

  close() {
    this.#closed = true;
    try { this.#ws.close(); } catch { /* 已关闭 */ }
  }
}

// ── 原生线程轮询：现在到底有几个会话、谁有回合 ────────────────────────────────

class NativePoller {
  threads = new Map();
  /** 探针接入时已经在线程表里的会话：它们不是本次窗口新建的。 */
  baseline = new Set();

  constructor(client, timeline) {
    this.client = client;
    this.timeline = timeline;
  }

  async #loadedIds() {
    const ids = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const page = object(await this.client.request("thread/loaded/list", cursor === undefined ? {} : { cursor }));
      if (!Array.isArray(page.data)) throw new Error("thread/loaded/list 响应缺少 data");
      for (const id of page.data) if (typeof id === "string") ids.add(id);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor !== undefined && (cursors.has(cursor) || ids.size > 4_096)) break;
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    return ids;
  }

  async #read(threadId) {
    const result = object(await this.client.request("thread/read", { threadId, includeTurns: false }));
    return object(result.thread);
  }

  /** 未落盘的草稿线程会拒绝 turns/list（not materialized yet），那不是错误而是关键证据。 */
  async turns(threadId) {
    try {
      const page = object(await this.client.request("thread/turns/list", {
        threadId, itemsView: "full", sortDirection: "asc", limit: 50,
      }));
      const turns = Array.isArray(page.data) ? page.data : [];
      let firstUserText;
      let secondUserText;
      for (const turn of turns) {
        for (const item of Array.isArray(object(turn).items) ? object(turn).items : []) {
          if (object(item).type !== "userMessage") continue;
          const value = userMessageText(object(item));
          if (value === "") continue;
          if (firstUserText === undefined) firstUserText = value;
          else if (secondUserText === undefined) secondUserText = value;
        }
      }
      return { count: turns.length, firstUserText, secondUserText, unmaterialized: false };
    } catch (error) {
      const message = describeError(error);
      if (/not materialized yet|no rollout found/iu.test(message)) return { count: 0, unmaterialized: true };
      return { count: undefined, error: message };
    }
  }

  async #snapshot(threadId, reason) {
    const snapshot = await this.#read(threadId);
    const turns = await this.turns(threadId);
    const existing = this.threads.get(threadId);
    const record = {
      threadId,
      firstSeenAt: existing?.firstSeenAt ?? Date.now(),
      status: text(object(snapshot.status).type) || "unknown",
      activeFlags: Array.isArray(object(snapshot.status).activeFlags) ? object(snapshot.status).activeFlags : [],
      name: text(snapshot.name),
      cwd: text(snapshot.cwd),
      path: text(snapshot.path) || undefined,
      source: object(snapshot.source).type ?? snapshot.source,
      originator: text(snapshot.originator) || undefined,
      ephemeral: snapshot.ephemeral === true,
      turns: turns.count,
      turnsUnmaterialized: turns.unmaterialized === true,
      firstUserText: turns.firstUserText ?? existing?.firstUserText,
      secondUserText: turns.secondUserText ?? existing?.secondUserText,
      lastReadAt: Date.now(),
    };
    this.threads.set(threadId, record);
    const changed = existing === undefined || existing.status !== record.status || existing.turns !== record.turns
      || existing.path !== record.path;
    if (changed) {
      this.timeline.add(existing === undefined ? "native.appeared" : "native.changed", {
        threadId, reason, status: record.status, turns: record.turns,
        unmaterialized: record.turnsUnmaterialized, path: record.path, cwd: record.cwd,
        firstUserText: truncate(record.firstUserText, 90),
      });
    }
    return record;
  }

  markBaseline() {
    for (const id of this.threads.keys()) this.baseline.add(id);
  }

  async tick() {
    const loaded = await this.#loadedIds();
    for (const id of loaded) {
      if (!this.threads.has(id)) await this.#snapshot(id, "loaded_list");
      else if (this.threads.get(id).loaded === false) {
        this.threads.get(id).loaded = true;
        this.timeline.add("native.reloaded", { threadId: id });
      }
    }
    for (const [id, record] of this.threads) {
      if (record.loaded === false) continue;
      if (!loaded.has(id)) {
        record.loaded = false;
        record.unloadedAt = Date.now();
        this.timeline.add("native.unloaded", { threadId: id, turns: record.turns, status: record.status });
      }
    }
    // 状态/回合刷新：新线程立刻读，其余轮转着读，避免把桌面版自己的 2s 轮询放大太多。
    const live = [...this.threads.values()].filter(record => record.loaded !== false);
    const refreshed = live.filter(record => Date.now() - record.lastReadAt < 1_000);
    const queue = live.filter(record => !refreshed.includes(record) && (record.status === "active" || record.turns === 0));
    for (const record of queue.slice(0, 8)) {
      try {
        const snapshot = await this.#read(record.threadId);
        const nextStatus = text(object(snapshot.status).type) || "unknown";
        if (nextStatus !== record.status || record.turns === 0) await this.#snapshot(record.threadId, "status");
        else record.lastReadAt = Date.now();
      } catch (error) {
        this.timeline.add("native.readError", { threadId: record.threadId, error: describeError(error) });
      }
    }
  }
}

function userMessageText(item) {
  const content = item.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    const value = object(part);
    if (typeof value.text === "string") parts.push(value.text);
  }
  return parts.join(" ").trim();
}

function truncate(value, limit) {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// ── 原生日志库：谁在什么时候建了哪个线程、消息进了哪个线程 ────────────────────

const THREAD_RPC = new Set([
  "thread/start", "thread/resume", "thread/fork", "thread/archive", "thread/unarchive",
  "thread/unsubscribe", "thread/delete", "turn/start", "turn/steer",
]);

class NativeLogReader {
  constructor(path, timeline) {
    this.path = path;
    this.timeline = timeline;
    this.db = undefined;
    this.lastId = 0;
    this.seen = new Set();
    this.error = undefined;
    this.warnings = 0;
    this.startedAt = Date.now();
  }

  async open() {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      this.db = new DatabaseSync(this.path, { readOnly: true });
      const row = object(this.db.prepare("select max(id) as id from logs").get());
      // 只看最近一小段：库会裁剪，真正的证据在探针运行期间产生。
      this.lastId = Math.max(0, Number(row.id ?? 0) - 400);
      this.timeline.add("nativeLog.opened", { path: this.path, fromId: this.lastId });
    } catch (error) {
      this.error = describeError(error);
      this.timeline.add("nativeLog.unavailable", { path: this.path, error: this.error });
    }
  }

  close() {
    try { this.db?.close(); } catch { /* 忽略 */ }
  }

  poll() {
    if (this.db === undefined) return;
    let rows;
    try {
      rows = this.db.prepare(`select id, ts, ts_nanos, level, target, feedback_log_body as body, thread_id
        from logs where id > ? order by id limit 2000`).all(this.lastId);
    } catch (error) {
      this.timeline.add("nativeLog.error", { error: describeError(error) });
      return;
    }
    for (const row of rows) this.ingestRow(row);
  }

  /**
   * 一行原生日志 → 时间线事件。otel span 头里有 otel.name / rpc.request_id /
   * app_server.connection_id / app_server.client_name；线程 id 优先用列的 thread_id。
   */
  ingestRow(row) {
    this.lastId = Math.max(this.lastId, Number(row.id));
    const body = text(row.body);
    if (body === "") return;
    const at = Number(row.ts) * 1_000 + Math.round(Number(row.ts_nanos ?? 0) / 1e6);
    const name = /otel\.name="([^"]+)"/u.exec(body)?.[1];
    const clientName = /app_server\.client_name="([^"]*)"/u.exec(body)?.[1];
    const connectionId = Number(/app_server\.connection_id=(\d+)/u.exec(body)?.[1] ?? NaN);
    const threadId = text(row.thread_id) || /(?:thread_id|conversation\.id)=([0-9a-f-]{36})/u.exec(body)?.[1];
    const level = text(row.level);
    if (name !== undefined && THREAD_RPC.has(name)) {
      const requestId = /rpc\.request_id=([^ "}]+)/u.exec(body)?.[1] ?? `${row.id}`;
      if (this.seen.has(`rpc:${requestId}`)) return;
      this.seen.add(`rpc:${requestId}`);
      this.timeline.add("native.rpc", {
        at, op: name, threadId, requestId,
        ...(clientName === undefined ? {} : { client: clientName }),
        ...(Number.isNaN(connectionId) ? {} : { connection: connectionId }),
      });
      return;
    }
    const operation = /codex\.op="([^"]+)"/u.exec(body)?.[1];
    if (operation === "turn_input") {
      const turnId = /turn\.id="([0-9a-f-]+)"/u.exec(body)?.[1];
      const submissionId = /submission\.id="([0-9a-f-]+)"/u.exec(body)?.[1] ?? `${row.id}`;
      if (this.seen.has(`turn:${submissionId}`)) return;
      this.seen.add(`turn:${submissionId}`);
      this.timeline.add("native.turnInput", { at, threadId, turnId, submissionId });
      return;
    }
    if ((level === "ERROR" || level === "WARN") && at >= this.startedAt - 3_000 && this.warnings < 40) {
      const key = `warn:${text(row.target)}:${body.slice(0, 120)}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.warnings += 1;
      this.timeline.add("native.warning", {
        at, level, target: text(row.target), threadId, message: truncate(body, 200),
        ...(clientName === undefined ? {} : { client: clientName }),
      });
    }
  }
}

// ── Host 的落盘视图 ──────────────────────────────────────────────────────────

class HostView {
  constructor(stateDir, timeline) {
    this.ledgerPath = join(stateDir, "codex-desktop-threads.json");
    this.diagnosticsPath = join(stateDir, "diagnostics.ndjson");
    this.timeline = timeline;
    this.ledger = new Set();
    this.ledgerLoaded = false;
    this.diagnosticsOffset = existsSync(this.diagnosticsPath) ? statSync(this.diagnosticsPath).size : 0;
    this.seenDiagnostics = new Set();
  }

  poll() {
    try {
      const list = JSON.parse(readFileSync(this.ledgerPath, "utf8"));
      if (Array.isArray(list)) {
        const next = new Set(list.filter(id => typeof id === "string"));
        const added = [...next].filter(id => !this.ledger.has(id));
        if (!this.ledgerLoaded) {
          this.timeline.add("host.ledgerLoaded", { count: next.size });
          this.ledgerLoaded = true;
        } else if (added.length > 0) {
          this.timeline.add("host.ledgerAdded", { threads: added });
        }
        this.ledger = next;
      }
    } catch { /* 台账可能不存在或正在改写 */ }
    try {
      const size = statSync(this.diagnosticsPath).size;
      if (size <= this.diagnosticsOffset) return;
      const handle = readFileSync(this.diagnosticsPath);
      const chunk = handle.subarray(this.diagnosticsOffset, size).toString("utf8");
      this.diagnosticsOffset = size;
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        let record;
        try { record = object(JSON.parse(line)); } catch { continue; }
        const sessionId = text(record.sessionId);
        if (!sessionId.startsWith("codex-desktop:")) continue;
        const key = text(record.recordId);
        if (key !== "" && this.seenDiagnostics.has(key)) continue;
        if (key !== "") this.seenDiagnostics.add(key);
        this.timeline.add("host.diagnostic", {
          threadId: sessionId.slice("codex-desktop:".length),
          category: text(record.category), severity: text(record.severity),
          message: truncate(text(record.message), 160),
        });
      }
    } catch { /* 忽略 */ }
  }
}

// ── 报告 ─────────────────────────────────────────────────────────────────────

function buildReport({ timeline, poller, nativeLog, host }) {
  const events = timeline.events;
  const markers = events.filter(event => event.type === "user.marker");
  const startedAt = events[0]?.at ?? Date.now();
  const inWindow = event => event.at >= startedAt - 3_000;
  const nativeRpcs = events.filter(event => event.type === "native.rpc" && inWindow(event)).sort((a, b) => a.at - b.at);
  const turnInputs = events.filter(event => event.type === "native.turnInput" && inWindow(event)).sort((a, b) => a.at - b.at);

  const threads = new Map();
  const ensure = id => {
    if (!threads.has(id)) threads.set(id, { threadId: id });
    return threads.get(id);
  };
  for (const record of poller.threads.values()) Object.assign(ensure(record.threadId), record);
  for (const rpc of nativeRpcs) {
    if (rpc.threadId === undefined) continue;
    const entry = ensure(rpc.threadId);
    if (rpc.op === "thread/start") {
      if (entry.createdAt === undefined || rpc.at < entry.createdAt) {
        entry.createdAt = rpc.at;
        entry.createdBy = rpc.client ?? "unknown";
        entry.createdConnection = rpc.connection;
      }
    }
    if (rpc.op === "thread/resume" && rpc.client !== CLIENT_NAME) {
      entry.hostResumedAt ??= rpc.at;
      entry.hostResumedBy = rpc.client;
    }
    if (rpc.op === "thread/unsubscribe" && rpc.client !== CLIENT_NAME) {
      entry.hostUnsubscribedAt = rpc.at;
    }
    if (rpc.op === "thread/archive") entry.archivedAt = rpc.at;
  }
  for (const input of turnInputs) {
    if (input.threadId === undefined) continue;
    const entry = ensure(input.threadId);
    entry.firstTurnInputAt ??= input.at;
    entry.turnInputs = (entry.turnInputs ?? 0) + 1;
  }
  for (const id of host.ledger) ensure(id).inHostLedger = true;
  for (const entry of threads.values()) {
    entry.hostTouched = entry.hostResumedAt !== undefined || entry.hostUnsubscribedAt !== undefined;
  }

  const newThreads = [...threads.values()].filter(entry => {
    if (entry.createdAt !== undefined) return entry.createdAt >= startedAt - 3_000;
    // 没有 thread/start 记录时只能按「接入后新出现」判断；接入时的基线线程一律排除。
    if (poller.baseline.has(entry.threadId)) return false;
    return entry.firstSeenAt !== undefined && entry.firstSeenAt >= startedAt;
  }).sort((a, b) => (a.createdAt ?? a.firstSeenAt ?? 0) - (b.createdAt ?? b.firstSeenAt ?? 0));

  const guiStarts = nativeRpcs.filter(rpc => rpc.op === "thread/start" && /codex desktop/iu.test(rpc.client ?? ""));
  const hostStarts = nativeRpcs.filter(rpc => rpc.op === "thread/start" && !/codex desktop/iu.test(rpc.client ?? "")
    && rpc.client !== CLIENT_NAME);
  const isDraft = entry => (entry.turns ?? 0) === 0 && entry.path === undefined
    && entry.turnsUnmaterialized !== false && entry.archivedAt === undefined;
  const drafts = newThreads.filter(isDraft);
  const working = newThreads.filter(entry => (entry.turns ?? 0) >= 1 || entry.path !== undefined);

  const findings = [];
  if (hostStarts.length > 0) {
    findings.push({
      kind: "orbis_created_thread",
      verdict: "Orbis 侧自己在原生建了线程（thread/start 的 client 不是桌面版）",
      evidence: hostStarts.map(rpc => ({ threadId: rpc.threadId, at: relative(rpc.at, startedAt), client: rpc.client })),
    });
  }
  if (drafts.length >= 1 && working.length >= 1) {
    const creators = new Set(newThreads.map(entry => entry.createdBy ?? "未知"));
    findings.push({
      kind: "duplicate_native_threads",
      verdict: creators.has("Codex Desktop") && !creators.has("orbis-host")
        ? "两个原生会话都是桌面版这一侧建的：点击时一个 0 回合空草稿，发送时又另起一个线程跑任务"
        : "同一窗口内既有一个 0 回合空线程，也有一个真正执行任务的线程",
      evidence: newThreads.map(entry => ({
        threadId: entry.threadId,
        创建者: entry.createdBy ?? "未知（原生日志未保留该行）",
        创建时刻: entry.createdAt === undefined ? undefined : relative(entry.createdAt, startedAt),
        回合数: entry.turns,
        落盘: entry.path === undefined ? "无（草稿）" : "有",
        首次消息: truncate(entry.firstUserText, 40),
        收到用户消息时刻: entry.firstTurnInputAt === undefined ? undefined : relative(entry.firstTurnInputAt, startedAt),
        Host已订阅: entry.hostTouched === true,
        Host台账内: entry.inHostLedger === true,
      })),
    });
  } else if (drafts.length >= 1) {
    findings.push({
      kind: "empty_draft_only",
      verdict: "窗口内只捕捉到 0 回合的空草稿（点击已落成原生线程，还没看到发送）",
      evidence: drafts.map(entry => ({
        threadId: entry.threadId,
        创建者: entry.createdBy ?? "未知",
        Host已订阅: entry.hostTouched === true,
        Host台账内: entry.inHostLedger === true,
      })),
    });
  }
  const sendCreatesThread = newThreads.filter(entry => entry.firstTurnInputAt !== undefined
    && entry.createdAt !== undefined && entry.firstTurnInputAt - entry.createdAt <= 3_000);
  if (sendCreatesThread.length > 0) {
    findings.push({
      kind: "send_starts_new_thread",
      verdict: "发送动作在原生侧就是一次 thread/start（不是复用点击时那个线程）",
      evidence: sendCreatesThread.map(entry => ({
        threadId: entry.threadId,
        创建者: entry.createdBy ?? "未知",
        创建到收到消息毫秒: entry.firstTurnInputAt - entry.createdAt,
      })),
    });
  }
  if (newThreads.length <= 1 && markers.length > 0 && newThreads.every(entry => (entry.turns ?? 0) >= 1)) {
    findings.push({
      kind: "single_native_thread",
      verdict: "本次窗口原生只有 1 个线程；若 App 显示两个会话，问题在 Host/App 投影而不是原生链",
      evidence: newThreads.map(entry => ({ threadId: entry.threadId, turns: entry.turns })),
    });
  }
  const draftsAdoptedByHost = drafts.filter(entry => entry.inHostLedger === true || entry.hostTouched === true);
  if (draftsAdoptedByHost.length > 0) {
    findings.push({
      kind: "empty_thread_mirrored",
      verdict: "空线程被 Host 收编，所以 App 里那张空白会话卡片就是它（镜像而来，不是另一次创建）",
      evidence: draftsAdoptedByHost.map(entry => ({
        threadId: entry.threadId,
        Host已订阅: entry.hostTouched === true,
        Host台账内: entry.inHostLedger === true,
      })),
    });
  }

  return {
    startedAt, markers, newThreads,
    guiStarts: guiStarts.length, hostStarts: hostStarts.length,
    nativeStartedThreads: [...threads.values()],
    findings,
    sources: {
      nativeAppServer: "thread/loaded/list + thread/read + thread/turns/list（只读）",
      nativeLog: nativeLog.path,
      hostLedger: host.ledgerPath,
      hostDiagnostics: host.diagnosticsPath,
    },
  };
}

function relative(at, base) {
  if (at === undefined) return undefined;
  return `+${((at - base) / 1_000).toFixed(3)}s`;
}

function printReport(report) {
  const lines = [];
  lines.push("");
  lines.push("══════ Codex 桌面版「新建会话 → 发送」链路探针报告 ══════");
  lines.push(`起点：${new Date(report.startedAt).toISOString()}`);
  lines.push(`数据源：${report.sources.nativeAppServer}`);
  lines.push(`        原生日志 ${report.sources.nativeLog}`);
  lines.push(`        Host 台账 ${report.sources.hostLedger}`);
  lines.push(`        Host 诊断 ${report.sources.hostDiagnostics}`);
  lines.push("");
  if (report.markers.length > 0) {
    lines.push("── 用户动作标记 ──");
    for (const marker of report.markers) {
      lines.push(`  ${relative(marker.at, report.startedAt)}  ${marker.label}`);
    }
    lines.push("");
  }
  lines.push(`── 本次窗口新建的原生线程（${report.newThreads.length}）──`);
  if (report.newThreads.length === 0) lines.push("  无（没观察到 thread/start）");
  for (const entry of report.newThreads) {
    lines.push(`  ${entry.threadId}`);
    lines.push(`    创建者       ${entry.createdBy ?? "未知"}${entry.createdConnection === undefined ? "" : `（connection ${entry.createdConnection}）`}`);
    lines.push(`    创建时刻     ${relative(entry.createdAt ?? entry.firstSeenAt, report.startedAt) ?? "未知"}`);
    lines.push(`    落盘 rollout ${entry.path ?? (entry.turnsUnmaterialized === true ? "未落盘（空草稿）" : "未知")}`);
    lines.push(`    回合数       ${entry.turns ?? (entry.turnsUnmaterialized === true ? "0（未 materialize）" : "未知")}`);
    if (entry.firstUserText !== undefined) lines.push(`    首条消息     ${entry.firstUserText}`);
    lines.push(`    收到消息     ${relative(entry.firstTurnInputAt, report.startedAt) ?? "从未"}`);
    lines.push(`    Host 订阅    ${entry.hostResumedAt === undefined
      ? entry.hostUnsubscribedAt === undefined ? "否" : `是（${relative(entry.hostUnsubscribedAt, report.startedAt)} 已退订）`
      : `是（${relative(entry.hostResumedAt, report.startedAt)}，${entry.hostResumedBy ?? "Host"}）`}`);
    lines.push(`    Host 台账    ${entry.inHostLedger === true ? "在（App 能看到这张卡片）" : "不在"}`);
    lines.push(`    状态         ${entry.status ?? "未知"}${entry.unloadedAt === undefined ? "" : "（已卸载）"}`);
  }
  lines.push("");
  lines.push("── 链路判定 ──");
  if (report.findings.length === 0) {
    lines.push("  证据不足：窗口内没有捕捉到 thread/start 与用户消息。检查是否点开桌面版的新聊天、");
    lines.push("  以及 ~/.codex/logs_2.sqlite 是否有新行（该库会裁剪，建议复现时同步开着探针）。");
  }
  for (const finding of report.findings) {
    lines.push(`  ● ${finding.verdict}`);
    for (const item of finding.evidence) lines.push(`      ${JSON.stringify(item)}`);
  }
  lines.push("");
  lines.push("── 读法 ──");
  lines.push("  thread/start 的 client_name 决定是谁建的会话：`Codex Desktop` = 桌面版，`orbis-host` = Host。");
  lines.push("  App 里那张空白卡片 ⇔ 建了但 0 回合、又被 Host 收编的原生线程；");
  lines.push("  真正执行任务的会话 ⇔ 收到 turn_input 的那个线程。");
  lines.push("  归档/卸载前，Host 会一直把那个空线程当成在线会话发布，所以它「还在」。");
  lines.push("══════════════════════════════════════════════════════");
  console.log(lines.join("\n"));
}

// ── 观察模式 ─────────────────────────────────────────────────────────────────

function resolveEndpoint() {
  if (options.url !== undefined) return { url: options.url, file: undefined };
  const file = options["endpoint-file"] ?? join(STATE_DIR, "codex-desktop-endpoint.json");
  if (!existsSync(file)) {
    throw new Error(`找不到桌面版端点描述文件：${file}\n`
      + "说明桌面版当前不是经 Orbis 包装器启动的（或 Host 状态目录不同）。\n"
      + "临时可用 --url ws://127.0.0.1:<端口> 指定（端口见 `ps aux | grep 'app-server.*--listen'`）。");
  }
  const descriptor = object(JSON.parse(readFileSync(file, "utf8")));
  if (typeof descriptor.url !== "string") throw new Error(`端点描述文件缺少 url：${file}`);
  for (const key of ["bridgePid", "codexPid"]) {
    const pid = descriptor[key];
    if (typeof pid !== "number") continue;
    try { process.kill(pid, 0); } catch { throw new Error(`端点描述里的 ${key}=${pid} 已不在运行，请重开桌面版后重试`); }
  }
  return { url: descriptor.url, file, descriptor };
}

async function runLive() {
  const endpoint = resolveEndpoint();
  const directory = options.out ?? join(process.cwd(), ".artifacts", "probe-codex-desktop-new-chat", stamp());
  mkdirSync(directory, { recursive: true });
  const timeline = new Timeline(join(directory, "timeline.jsonl"));
  const startedAt = Date.now();
  timeline.add("probe.start", {
    endpointUrl: endpoint.url, endpointFile: endpoint.file,
    stateDir: STATE_DIR, codexHome: CODEX_HOME, pid: process.pid, argv: process.argv.slice(2),
  });

  console.log(`接入桌面版 app-server：${endpoint.url}`);
  const client = await NativeClient.connect(endpoint.url, timeline);
  console.log("已握手（只读）。");
  const poller = new NativePoller(client, timeline);
  const nativeLog = new NativeLogReader(join(CODEX_HOME, "logs_2.sqlite"), timeline);
  await nativeLog.open();
  if (nativeLog.error !== undefined) console.log(`原生日志库不可用（不影响其余证据）：${nativeLog.error}`);
  const host = new HostView(STATE_DIR, timeline);

  timeline.onEvent = event => {
    // 原生日志回填的旧事件不进实时输出，只在报告里参与判定窗口。
    if (event.at < startedAt - 3_000) return;
    if (!options.verbose && !isHighlight(event)) return;
    const detail = event.threadId === undefined ? "" : ` ${event.threadId}`;
    const extra = event.op === undefined ? "" : ` ${event.op}`;
    const who = event.client === undefined ? "" : ` by ${event.client}`;
    const turns = event.turns === undefined ? "" : ` turns=${event.turns}`;
    const label = event.label === undefined ? "" : `「${event.label}」`;
    console.log(`  ${relative(event.at, startedAt)} ${event.type}${extra}${detail}${who}${turns}${label}`);
  };

  console.log("");
  console.log("现在去桌面版操作。每做一个动作按一次回车，可在同一行写标记，例如：");
  console.log("  点击新聊天⏎   输入并发送⏎");
  console.log("Ctrl-C 结束并输出报告。");
  console.log("");
  attachMarkers(timeline);

  const tick = async () => {
    try { await poller.tick(); } catch (error) { timeline.add("poll.error", { error: describeError(error) }); }
    nativeLog.poll();
    host.poll();
  };
  await tick();
  poller.markBaseline();
  timeline.add("probe.baseline", { threads: [...poller.baseline] });
  const timer = setInterval(() => { void tick(); }, POLL_MS);

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    detachMarkers();
    const report = buildReport({ timeline, poller, nativeLog, host });
    printReport(report);
    writeFileSync(join(directory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(directory, "health.json"), `${JSON.stringify({
      output: directory,
      threadsSeen: report.newThreads.length,
      findings: report.findings.map(finding => finding.kind),
      nativeLogError: nativeLog.error,
    }, null, 2)}\n`);
    console.log(`\n证据目录：${directory}`);
    client.close();
    nativeLog.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void finish(); });
  if (DURATION_MS > 0) setTimeout(() => { void finish(); }, DURATION_MS).unref?.();
  await new Promise(() => {});
}

function isHighlight(event) {
  if (event.type === "user.marker" || event.type === "native.appeared" || event.type === "native.unloaded") return true;
  if (event.type === "native.rpc") return true;
  if (event.type === "native.turnInput") return true;
  if (event.type === "host.ledgerAdded") return true;
  if (event.type === "nativeLog.unavailable") return true;
  return false;
}

let detachMarkers = () => {};

function attachMarkers(timeline) {
  if (process.stdin.isTTY === false && process.stdin.readable === false) return;
  const onData = chunk => {
    for (const line of String(chunk).split("\n")) {
      const label = line.trim();
      if (line === "" && label === "") continue;
      timeline.add("user.marker", { label: label === "" ? "动作" : label });
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.resume();
  detachMarkers = () => {
    process.stdin.off("data", onData);
    process.stdin.pause();
  };
}

// ── 对照模式：Host 的 resume 会不会造线程 ────────────────────────────────────

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForPort(port, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app-server 提前退出 code=${child.exitCode}`);
    const ok = await new Promise(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 500 });
      socket.once("open", () => { socket.close(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await delay(100);
  }
  throw new Error("app-server 未监听");
}

function resolveControlCli() {
  const candidates = [
    process.env.ORBIS_PROBE_CODEX_CLI?.trim(),
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  ].filter(Boolean);
  const agents = join(homedir(), ".orbis", "agents", "codex");
  if (existsSync(agents)) {
    for (const entry of readdirSync(agents)) {
      const vendor = join(agents, entry, "node_modules");
      if (!existsSync(vendor)) continue;
      for (const name of readdirSync(vendor)) {
        if (!name.startsWith("@openai/codex-darwin") && !name.startsWith("@openai/codex-linux")) continue;
        const bin = join(vendor, name, "vendor");
        if (!existsSync(bin)) continue;
        for (const arch of readdirSync(bin)) {
          const candidate = join(bin, arch, "bin", "codex");
          if (existsSync(candidate)) candidates.push(candidate);
        }
      }
    }
  }
  for (const candidate of candidates) {
    // 必须绕开 Orbis 包装器，否则对照实验会被同一条桥接逻辑改写。
    if (candidate.includes(`wrapper${process.platform === "win32" ? "\\" : "/"}`)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function runControl() {
  const directory = options.out ?? join(process.cwd(), ".artifacts", "probe-codex-desktop-new-chat", `${stamp()}-control`);
  mkdirSync(directory, { recursive: true });
  const timeline = new Timeline(join(directory, "timeline.jsonl"));
  const cli = resolveControlCli();
  const result = { mode: "control", cli, passed: false, checks: [] };
  const check = (name, condition, detail = {}) => {
    result.checks.push({ name, passed: condition === true, ...detail });
    console.log(`  ${condition === true ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
    return condition === true;
  };
  if (cli === undefined) {
    console.log("找不到可用于对照的 Codex CLI（用 ORBIS_PROBE_CODEX_CLI 指定），跳过。");
    result.skipped = "no_cli";
    writeFileSync(join(directory, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const root = join(directory, "tmp");
  const home = join(root, "codex-home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, "config.toml"), 'sandbox_mode = "read-only"\napproval_policy = "never"\n');
  const port = await freePort();
  const child = spawn(cli, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
    env: { ...process.env, CODEX_HOME: home, ORBIS_CODEX_DESKTOP_ENDPOINT: join(root, "unused.json") },
    cwd: workspace, stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(chunk.toString()));
  let gui;
  let host;
  try {
    await waitForPort(port, child);
    gui = await NativeClient.connect(`ws://127.0.0.1:${port}`, timeline); // 模拟桌面版
    host = await NativeClient.connect(`ws://127.0.0.1:${port}`, timeline); // 模拟 Host 收编
    host.notify("initialized");
    // 桌面版点「新聊天」= thread/start（这是 Orbis 侧完全无法触发的动作）。
    const started = object(await gui.request("thread/start", { cwd: workspace }));
    const threadId = text(object(started.thread).id);
    check("桌面版侧 thread/start 得到线程", threadId !== "", { threadId });
    const before = await host.request("thread/loaded/list", {});
    check("新线程已加载", Array.isArray(before.data) && before.data.includes(threadId));
    // Host 收编时的真实动作：thread/resume（无覆盖项）。它不该造线程，也不该把草稿踢掉。
    // 同时记录桌面版这条连接收到的广播：Host 的动作只有通过广播才可能被桌面版看见。
    const guiBroadcasts = [];
    gui.onBroadcast = event => guiBroadcasts.push(event);
    let resumeError;
    try { await host.request("thread/resume", { threadId }, 15_000); } catch (error) { resumeError = describeError(error); }
    await delay(500);
    check("Host resume 没有向桌面版广播该线程的状态变化",
      !guiBroadcasts.some(event => event.threadId === threadId),
      { broadcasts: guiBroadcasts.filter(event => event.threadId === threadId) });
    const after = await host.request("thread/loaded/list", {});
    check("Host resume 后线程仍在加载列表（未因失败被卸载）",
      Array.isArray(after.data) && after.data.includes(threadId), { threadId, resumeError });
    check("Host resume 没有产生第二个线程", Array.isArray(after.data) && after.data.length === 1,
      { loadedCount: Array.isArray(after.data) ? after.data.length : undefined });
    const read = object(await host.request("thread/read", { threadId, includeTurns: false }));
    check("Host resume 后草稿线程仍可读", text(object(read.thread).id) === threadId,
      { status: object(object(read.thread).status).type, resumeError });
    // 未落盘的草稿会拒绝 turns/list，这本身也是「没有回合」的原生证据。
    let turnCount;
    let turnsError;
    try {
      const turns = object(await host.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", limit: 10 }));
      turnCount = Array.isArray(turns.data) ? turns.data.length : undefined;
    } catch (error) {
      turnsError = describeError(error);
      if (/not materialized yet|no rollout found/iu.test(turnsError)) turnCount = 0;
    }
    check("草稿线程仍是 0 回合（resume 不会替它写回合）", turnCount === 0, { turnCount, turnsError });
    result.passed = result.checks.every(entry => entry.passed);
  } catch (error) {
    result.error = describeError(error);
  } finally {
    gui?.close();
    host?.close();
    child.kill();
    writeFileSync(join(directory, "app-server-stderr.log"), stderr.join(""));
    writeFileSync(join(directory, "summary.json"), `${JSON.stringify({ ...result, timelineEvents: timeline.events.length }, null, 2)}\n`);
    rmSync(join(directory, "tmp"), { recursive: true, force: true });
    console.log(`\n对照证据：${directory}`);
  }
  console.log(result.passed === true
    ? "对照通过：Host 的收编（thread/resume）不会新建线程，也不会让草稿线程消失 —— 双会话不可能由这一跳产生。"
    : "对照未通过：见上方 FAIL 项。");
}

/** 从 rollout 数回合：`turn_context` 每回合一条，落盘文件是唯一的活动证据。 */
function countRolloutTurns(path) {
  try {
    if (statSync(path).size > 16 * 1024 * 1024) return undefined;
    return readFileSync(path, "utf8").split("\n").filter(line => line.includes('"type":"turn_context"')).length;
  } catch { return undefined; }
}

/** rollout 落盘即「这个线程真的存在过」；空草稿只有内存里的线程。 */
function findRollout(threadId, days = 7) {
  const roots = [join(CODEX_HOME, "sessions"), join(CODEX_HOME, "archived_sessions")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (let back = 0; back < days; back += 1) {
      const day = new Date(Date.now() - back * 86_400_000);
      const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) if (name.includes(threadId)) return join(dir, name);
    }
  }
  return undefined;
}

// ── 事后回放：用同一套解析与判定看已经发生的事 ──────────────────────────────

async function runReplay() {
  const minutes = Number(options.replay ?? 30);
  const since = Date.now() - minutes * 60_000;
  const directory = options.out ?? join(process.cwd(), ".artifacts", "probe-codex-desktop-new-chat", `${stamp()}-replay`);
  mkdirSync(directory, { recursive: true });
  const timeline = new Timeline(join(directory, "timeline.jsonl"));
  // 回放的时间轴起点就是窗口起点，判定与相对时间都以它为准。
  timeline.add("probe.replay", { at: since, since, minutes });
  const logPath = join(CODEX_HOME, "logs_2.sqlite");
  const reader = new NativeLogReader(logPath, timeline);
  reader.startedAt = since;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(logPath, { readOnly: true });
  const rows = db.prepare(`select id, ts, ts_nanos, level, target, feedback_log_body as body, thread_id
    from logs where ts >= ? order by id`).all(Math.floor(since / 1_000) - 1);
  db.close();
  for (const row of rows) reader.ingestRow(row);
  timeline.add("probe.replayRows", { count: rows.length, since, minutes });
  const host = new HostView(STATE_DIR, timeline);
  host.poll();
  const poller = { threads: new Map(), baseline: new Set() };
  for (const rpc of timeline.events.filter(event => event.type === "native.rpc" && event.op === "thread/start")) {
    if (rpc.threadId === undefined) continue;
    const rollout = findRollout(rpc.threadId);
    const turns = rollout === undefined ? undefined : countRolloutTurns(rollout);
    poller.threads.set(rpc.threadId, {
      threadId: rpc.threadId,
      firstSeenAt: rpc.at,
      loaded: true,
      status: rollout === undefined ? "notLoaded" : "unknown",
      turns: rollout === undefined ? 0 : turns,
      turnsUnmaterialized: rollout === undefined,
      ...(rollout === undefined ? {} : { path: rollout }),
    });
  }
  const report = buildReport({ timeline, poller, nativeLog: reader, host });
  printReport(report);
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n证据目录：${directory}`);
  if (report.newThreads.length === 0) {
    console.log("回放窗口内原生日志没有 thread/start：库可能已裁剪，或窗口内确实没建会话。");
  }
}

// ── 自检：判定逻辑与 otel 解析必须能被证实 ───────────────────────────────────

async function runSelfTest() {
  const failures = [];
  const check = (name, condition, detail = {}) => {
    if (condition !== true) failures.push(name);
    console.log(`  ${condition === true ? "PASS" : "FAIL"} ${name} ${Object.keys(detail).length === 0 ? "" : JSON.stringify(detail)}`);
  };

  // 1. 原生日志解析：一行 otel span 能还原「谁建了哪个线程」。
  const parseTimeline = new Timeline(undefined);
  const reader = new NativeLogReader(join(CODEX_HOME, "logs_2.sqlite"), parseTimeline);
  const draftId = "01a1f266-c9e5-7f03-9e2d-3110e1e53d31";
  const workId = "01a1f266-e783-7173-a70f-8aba0c89e71c";
  reader.ingestRow({
    id: 1, ts: 1_795_068_185, ts_nanos: 62_722_000, level: "INFO", target: "codex_core::shell_snapshot", thread_id: draftId,
    body: 'app_server.request{otel.kind="server" otel.name="thread/start" rpc.method="thread/start" '
      + 'rpc.request_id=thread/start:abc app_server.connection_id=0 app_server.client_name="Codex Desktop"}:created',
  });
  const startEvent = parseTimeline.events.find(event => event.type === "native.rpc");
  check("解析 thread/start 的线程与客户端",
    startEvent?.op === "thread/start" && startEvent?.threadId === draftId && startEvent?.client === "Codex Desktop",
    startEvent ?? {});
  reader.ingestRow({
    id: 2, ts: 1_795_068_192, ts_nanos: 0, level: "DEBUG", target: "codex_core::session::handlers", thread_id: workId,
    body: `session_loop{thread_id=${workId}}:submission_dispatch{otel.name="op.dispatch.turn_input" `
      + `submission.id="01a1f266-e8c1-7843-bc23-dc074202d43d" codex.op="turn_input"}:codex.turn_input{`
      + `conversation.id=${workId} turn.id="01a1f266-e863-7eb1-a8a3-52bab6cb8b68"}`,
  });
  const turnEvent = parseTimeline.events.find(event => event.type === "native.turnInput");
  check("解析用户消息进入的线程", turnEvent?.threadId === workId, turnEvent ?? {});

  // 2. 判定：桌面版点一次、发送时另起线程。
  const now = Date.now();
  const duplicateTimeline = new Timeline(undefined);
  duplicateTimeline.add("probe.start", { at: now - 10_000 });
  duplicateTimeline.add("user.marker", { at: now - 6_000, label: "点击新聊天" });
  duplicateTimeline.add("user.marker", { at: now - 4_000, label: "发送" });
  duplicateTimeline.add("native.rpc", { at: now - 6_000, op: "thread/start", threadId: draftId, client: "Codex Desktop", connection: 0 });
  duplicateTimeline.add("native.rpc", { at: now - 4_000, op: "thread/start", threadId: workId, client: "Codex Desktop", connection: 0 });
  duplicateTimeline.add("native.turnInput", { at: now - 3_900, threadId: workId });
  duplicateTimeline.add("native.rpc", { at: now - 3_500, op: "thread/resume", threadId: draftId, client: "orbis-host", connection: 2 });
  const duplicateReport = buildReport({
    timeline: duplicateTimeline,
    poller: {
      threads: new Map([
        [draftId, { threadId: draftId, firstSeenAt: now - 5_900, status: "idle", turns: 0, turnsUnmaterialized: true, loaded: true }],
        [workId, { threadId: workId, firstSeenAt: now - 3_900, status: "active", turns: 1, turnsUnmaterialized: false,
          path: `/tmp/${workId}.jsonl`, firstUserText: "跑一下这个任务", loaded: true }],
      ]),
      baseline: new Set(),
    },
    nativeLog: { path: "(selftest)" },
    host: { ledgerPath: "(selftest)", diagnosticsPath: "(selftest)", ledger: new Set([draftId]) },
  });
  const kinds = new Set(duplicateReport.findings.map(finding => finding.kind));
  check("识别出「一个空草稿 + 一个真正执行」", kinds.has("duplicate_native_threads"), [...kinds]);
  check("识别出「发送时才 thread/start」", kinds.has("send_starts_new_thread"), [...kinds]);
  check("识别出空草稿被 Host 收编", kinds.has("empty_thread_mirrored"), [...kinds]);
  check("没有误判为 Orbis 自建线程", !kinds.has("orbis_created_thread"), [...kinds]);
  check("报告的线程数正确", duplicateReport.newThreads.length === 2, { count: duplicateReport.newThreads.length });

  // 3. 判定：Host 自己建线程 → 指向 Orbis 侧。
  const hostTimeline = new Timeline(undefined);
  hostTimeline.add("probe.start", { at: now - 10_000 });
  hostTimeline.add("native.rpc", { at: now - 2_000, op: "thread/start", threadId: workId, client: "orbis-host", connection: 2 });
  const hostReport = buildReport({
    timeline: hostTimeline,
    poller: {
      threads: new Map([[workId, { threadId: workId, firstSeenAt: now - 2_000, status: "idle", turns: 0, loaded: true }]]),
      baseline: new Set(),
    },
    nativeLog: { path: "(selftest)" },
    host: { ledgerPath: "(selftest)", diagnosticsPath: "(selftest)", ledger: new Set() },
  });
  check("识别出 Orbis 侧自建线程", hostReport.findings.some(finding => finding.kind === "orbis_created_thread"),
    hostReport.findings.map(finding => finding.kind));

  // 4. 判定：只有一个线程且有回合 → 指向投影层。
  const singleTimeline = new Timeline(undefined);
  singleTimeline.add("probe.start", { at: now - 10_000 });
  singleTimeline.add("user.marker", { at: now - 5_000, label: "发送" });
  singleTimeline.add("native.rpc", { at: now - 6_000, op: "thread/start", threadId: workId, client: "Codex Desktop", connection: 0 });
  const singleReport = buildReport({
    timeline: singleTimeline,
    poller: {
      threads: new Map([[workId, { threadId: workId, firstSeenAt: now - 5_900, status: "active", turns: 2,
        path: `/tmp/${workId}.jsonl`, loaded: true }]]),
      baseline: new Set(),
    },
    nativeLog: { path: "(selftest)" },
    host: { ledgerPath: "(selftest)", diagnosticsPath: "(selftest)", ledger: new Set([workId]) },
  });
  check("单线程窗口指向投影层", singleReport.findings.some(finding => finding.kind === "single_native_thread"),
    singleReport.findings.map(finding => finding.kind));

  console.log(failures.length === 0 ? "\n自检通过。" : `\n自检失败：${failures.join(" / ")}`);
  if (failures.length > 0) process.exitCode = 1;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

if (options["self-test"] === true) {
  await runSelfTest();
} else if (options.replay !== undefined) {
  await runReplay();
} else if (options.control === true) {
  await runControl();
} else {
  try {
    await runLive();
  } catch (error) {
    console.error(`探针启动失败：${describeError(error)}`);
    process.exitCode = 1;
  }
}
