import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@pi-remote/protocol";

const DEFAULT_CONFIG = "scripts/load/configs/smoke.json";
const sleep = (ms) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const now = () => performance.now();
const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const parseArgs = () => {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const scenarioIndex = args.indexOf("--scenario");
  const durationIndex = args.indexOf("--duration");
  return {
    config: configIndex >= 0 ? args[configIndex + 1] : DEFAULT_CONFIG,
    scenario: scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined,
    duration: durationIndex >= 0 ? Number(args[durationIndex + 1]) : undefined,
  };
};
const loadConfig = async () => {
  const args = parseArgs();
  const file = resolve(args.config ?? DEFAULT_CONFIG);
  const config = JSON.parse(await readFile(file, "utf8"));
  if (args.scenario) config.scenario = args.scenario;
  if (args.duration !== undefined && Number.isFinite(args.duration)) config.durationSeconds = args.duration;
  if (!/^wss?:\/\//.test(config.relayUrl)) throw new Error("relayUrl must use ws:// or wss://");
  if (config.relayUrl.includes("orbising.com") && process.env.ORBIS_LOAD_ALLOW_PRODUCTION !== "1") {
    throw new Error("Refusing to load-test orbising.com; use a dedicated Relay or set ORBIS_LOAD_ALLOW_PRODUCTION=1");
  }
  return config;
};

class Metrics {
  startedAt = now();
  intervals = [];
  latency = [];
  counters = { connected: 0, authenticated: 0, connectErrors: 0, messagesSent: 0, messagesReceived: 0, framesSent: 0, framesReceived: 0, protocolErrors: 0, closed: 0, transfersStarted: 0 };
  recordLatency(value) { if (Number.isFinite(value)) this.latency.push(value); }
  snapshot(extra = {}) {
    return { at: new Date().toISOString(), elapsedSeconds: (now() - this.startedAt) / 1000, ...this.counters, p50Ms: percentile(this.latency, 0.5), p95Ms: percentile(this.latency, 0.95), p99Ms: percentile(this.latency, 0.99), ...extra };
  }
  flushLatency() { const result = { p50Ms: percentile(this.latency, 0.5), p95Ms: percentile(this.latency, 0.95), p99Ms: percentile(this.latency, 0.99), samples: this.latency.length }; this.latency = []; return result; }
}

const connect = (url, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => { socket.terminate(); reject(new Error(`connect timeout: ${url}`)); }, timeoutMs);
  const fail = error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); };
  socket.once("open", () => { clearTimeout(timer); resolve(socket); });
  socket.once("error", fail);
});
const waitFor = (socket, predicate, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("message timeout")); }, timeoutMs);
  const onMessage = raw => {
    let value;
    try { value = JSON.parse(raw.toString()); } catch { return; }
    if (!predicate(value)) return;
    clearTimeout(timer); socket.off("message", onMessage); resolve(value);
  };
  socket.on("message", onMessage);
});
const frame = (from, to, n, bytes, channel = "ctl") => ({
  type: "v2.frame", protocolVersion: PROTOCOL_VERSION,
  envelope: { v: 2, hdr: { k: "data", room: from, from, to, n, ch: channel }, ct: JSON.stringify({ sentAt: Date.now(), padding: "x".repeat(Math.max(0, bytes - 32)) }) },
});
const safeClose = socket => { if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "load complete"); };

class Device {
  constructor(config, hostId, deviceId, metrics, slow) { this.config = config; this.hostId = hostId; this.deviceId = deviceId; this.metrics = metrics; this.slow = slow; this.n = 1; this.socket = undefined; this.timer = undefined; }
  async start() {
    this.socket = await connect(`${this.config.relayUrl}/v1/device`);
    this.metrics.counters.connected++;
    this.socket.on("message", raw => {
      let value; try { value = JSON.parse(raw.toString()); } catch { this.metrics.counters.protocolErrors++; return; }
      this.metrics.counters.messagesReceived++;
      if (value.type === "v2.frame") {
        this.metrics.counters.framesReceived++;
        const respond = () => this.send(this.hostId, Math.max(64, value.envelope?.ct?.length ?? this.config.messageBytes));
        if (this.slow) {
          const delayMs = Math.max(1, Math.ceil((Number(this.config.messageBytes) / Number(this.config.slowDeviceRateBytesPerSecond)) * 1000));
          this.socket._socket?.pause();
          setTimeout(() => { this.socket?._socket?.resume(); respond(); }, delayMs);
        } else respond();
      }
      if (value.type === "protocol.error") this.metrics.counters.protocolErrors++;
    });
    this.socket.on("close", () => { this.metrics.counters.closed++; if (this.timer) clearInterval(this.timer); });
    this.socket.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: this.config.deviceCredentials[this.deviceId] }));
    await waitFor(this.socket, value => value.type === "device.ready");
    this.metrics.counters.authenticated++;
  }
  send(to, bytes = this.config.messageBytes) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const value = frame(this.deviceId, to, this.n++, bytes);
    this.socket.send(JSON.stringify(value));
    this.metrics.counters.messagesSent++; this.metrics.counters.framesSent++;
  }
  close() { safeClose(this.socket); }
}

class Host {
  constructor(config, hostId, metrics) { this.config = config; this.hostId = hostId; this.metrics = metrics; this.n = 1; this.socket = undefined; }
  async start() {
    this.socket = await connect(`${this.config.relayUrl}/v1/runtime`);
    this.metrics.counters.connected++;
    this.socket.on("message", raw => {
      let value; try { value = JSON.parse(raw.toString()); } catch { this.metrics.counters.protocolErrors++; return; }
      this.metrics.counters.messagesReceived++;
      if (value.type === "v2.frame") {
        this.metrics.counters.framesReceived++;
        try {
          const sentAt = JSON.parse(value.envelope?.ct ?? "{}").sentAt;
          if (typeof sentAt === "number") this.metrics.recordLatency(Date.now() - sentAt);
        } catch { this.metrics.counters.protocolErrors++; }
      }
      if (value.type === "protocol.error") this.metrics.counters.protocolErrors++;
    });
    this.socket.on("close", () => { this.metrics.counters.closed++; });
    this.socket.send(JSON.stringify({ type: "runtime.authenticate", protocolVersion: PROTOCOL_VERSION, credential: this.config.runtimeCredential, role: "host", runtime: { runtimeId: this.hostId, name: this.hostId, cwd: "/load-test", status: "idle" } }));
    await waitFor(this.socket, value => value.type === "runtime.ready");
    this.metrics.counters.authenticated++;
  }
  send(to, bytes = this.config.messageBytes, channel = "ctl") {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const value = frame(this.hostId, to, this.n++, bytes, channel);
    this.socket.send(JSON.stringify(value));
    this.metrics.counters.messagesSent++; this.metrics.counters.framesSent++;
  }
  close() { safeClose(this.socket); }
}

const main = async () => {
  const config = await loadConfig();
  const metrics = new Metrics();
  const hosts = []; const devices = [];
  config.deviceCredentials = {};
  for (let h = 0; h < config.hostCount; h++) {
    const hostId = `load-host-${h}`;
    const host = new Host(config, hostId, metrics); hosts.push(host);
    for (let d = 0; d < config.devicesPerHost; d++) {
      const deviceId = `${hostId}-device-${d}`;
      config.deviceCredentials[deviceId] = `load-device-${deviceId}`;
      devices.push(new Device(config, hostId, deviceId, metrics, d < config.slowDevices));
    }
  }
  const sockets = [...hosts, ...devices];
  const rampMs = Math.max(0, Number(config.rampUpSeconds) * 1000);
  const delay = sockets.length === 0 ? 0 : rampMs / sockets.length;
  for (const client of sockets) { await client.start().catch(error => { metrics.counters.connectErrors++; console.error(`[load] connect failed: ${error.message}`); }); if (delay) await sleep(delay); }
  const activeDevices = devices.filter(device => device.socket?.readyState === WebSocket.OPEN);
  const activeHosts = hosts.filter(host => host.socket?.readyState === WebSocket.OPEN);
  const hostById = new Map(activeHosts.map(host => [host.hostId, host]));
  const interval = Math.max(100, 1000 / Math.max(0.1, Number(config.messageRatePerDevice)));
  const messageTimer = setInterval(() => {
    if (config.scenario === "reconnect") return;
    for (const device of activeDevices) hostById.get(device.hostId)?.send(device.deviceId);
    if (config.scenario === "mixed" || config.scenario === "backpressure") {
      for (let i = 0; i < Math.min(Number(config.activeTransfers), activeDevices.length); i++) {
        const device = activeDevices[i]; const host = hostById.get(device.hostId);
        host?.send(device.deviceId, Math.min(8192, Number(config.messageBytes)), "bulk");
      }
    }
  }, interval);
  const metricsTimer = setInterval(() => console.log(JSON.stringify({ type: "metrics", ...metrics.snapshot({ latency: metrics.flushLatency(), connections: sockets.filter(client => client.socket?.readyState === WebSocket.OPEN).length }) })), Math.max(1000, Number(config.metricsIntervalSeconds) * 1000));
  const stopAt = Date.now() + Number(config.durationSeconds) * 1000;
  while (Date.now() < stopAt) {
    if (config.scenario === "reconnect" && Math.random() < 0.1) {
      const client = sockets[Math.floor(Math.random() * sockets.length)]; client?.close();
    }
    await sleep(250);
  }
  clearInterval(messageTimer); clearInterval(metricsTimer); sockets.forEach(client => client.close());
  await sleep(250);
  const report = { type: "summary", config, counters: metrics.counters, latency: metrics.flushLatency(), elapsedSeconds: (now() - metrics.startedAt) / 1000 };
  console.log(JSON.stringify(report));
  const output = process.env.ORBIS_LOAD_REPORT;
  if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`); }
};
main().catch(error => { console.error(`[load] fatal: ${error.stack ?? error}`); process.exitCode = 1; });
