import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { EnvelopeChannel } from "@orbis/protocol";

export type RelayTransportMode = "ws" | "quic" | "auto";
export type RelayTransportKind = "ws" | "quic";
export type RelaySocket = WebSocket | NativeQuicSocket;
export type PreparedRelaySocket = { socket: RelaySocket; kind: RelayTransportKind };
export type RelaySocketOptions = {
  helperPath?: string;
  /** Additional trust roots, also honored through NODE_EXTRA_CA_CERTS. Never disables TLS validation. */
  caFile?: string;
  prepareTimeoutMs?: number;
  streamVersion?: 2 | 3;
};

const MAX_FRAME = 2 * 1024 * 1024;
const LANE_LIMITS = [4 * 1024 * 1024, 32 * 1024 * 1024, 64 * 1024 * 1024, 16 * 1024 * 1024, 16 * 1024 * 1024] as const;
const MAX_FRAMES = 16384;

export function relayTransportMode(value: unknown): RelayTransportMode {
  if (value === undefined) return "auto";
  if (value === "ws" || value === "quic" || value === "auto") return value;
  throw new Error("relayTransport / ORBIS_RELAY_TRANSPORT 必须是 ws、quic 或 auto");
}

function laneFor(text: string): number {
  const m = JSON.parse(text) as { type?: string; envelope?: { hdr?: { k?: string; ch?: string } } };
  const hdr = m.envelope?.hdr;
  if (m.type !== "v2.frame" || hdr?.k === "hs" || hdr?.k === "pair") return 0;
  const lane = ["ctl", "msg", "bulk", "history", "catchup"].indexOf(hdr?.ch ?? "");
  if (lane < 0) throw new Error("Invalid QUIC frame lane");
  return lane;
}

function packet(op: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length + 5);
  out.writeUInt32BE(payload.length + 1);
  out[4] = op;
  payload.copy(out, 5);
  return out;
}

/** bufferedAmount includes IPC bytes until the helper completes QUIC WriteLane.
 * This is local write progress, never a peer ACK or permission to replay data. */
export class NativeQuicSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  #child: ChildProcessWithoutNullStreams;
  #lanes: Socket[] = [];
  #pending: number[][] = [[], [], []];
  #bytes = [0, 0, 0];
  #count = 0;
  #killTimer: NodeJS.Timeout | undefined;
  #exit: Promise<void>;

  readonly supportsHistoryStreams: boolean;

  private constructor(helper: string, version: number) {
    super();
    this.supportsHistoryStreams = version === 3;
    const count = this.supportsHistoryStreams ? 5 : 3;
    this.#pending = Array.from({ length: count }, () => []);
    this.#bytes = Array<number>(count).fill(0);
    // Preparation can fail before HostRelayClient has attached its listeners.
    this.on("error", () => undefined);
    this.#child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child.stderr.resume(); // Never forward helper output containing runtime context.
    this.#child.on("error", () => this.#fail(new Error("无法启动原生 QUIC helper")));
    this.#exit = new Promise(resolve => this.#child.once("close", () => {
      if (this.#killTimer !== undefined) clearTimeout(this.#killTimer);
      for (const socket of this.#lanes) socket.destroy();
      this.readyState = WebSocket.CLOSED;
      this.#bytes.fill(0);
      this.#pending = this.#pending.map(() => []);
      this.#count = 0;
      this.emit("close");
      resolve();
    }));
    this.#child.stdin.on("error", () => this.close());
  }

  static async prepare(address: string, serverName: string, signal: AbortSignal, options: RelaySocketOptions): Promise<NativeQuicSocket> {
    signal.throwIfAborted();
    const helper = options.helperPath ?? process.env["ORBIS_QUIC_HELPER"] ?? fileURLToPath(new URL(`../native/bin/orbis-quic-client${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
    const socket = new NativeQuicSocket(helper, options.streamVersion ?? 2);
    const laneCount = socket.supportsHistoryStreams ? 5 : 3;
    const token = randomBytes(32).toString("hex");
    const config = Buffer.from(JSON.stringify({ address, serverName, token, streamVersion: options.streamVersion ?? 2, caFile: options.caFile ?? process.env["NODE_EXTRA_CA_CERTS"] }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(config.length);
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        let listening = false;
        const fail = (error: unknown): void => { cleanup(); reject(error); };
        const closed = (): void => fail(new Error("QUIC helper 在就绪前退出"));
        const abort = (): void => fail(signal.reason);
        const cleanup = (): void => {
          signal.removeEventListener("abort", abort);
          socket.off("error", fail);
          socket.off("close", closed);
          socket.#child.stdout.off("data", data);
        };
        const data = (chunk: Buffer): void => {
          stdout += chunk.toString();
          if (stdout.length > 65536) { fail(new Error("Invalid helper response")); return; }
          let newline: number;
          while ((newline = stdout.indexOf("\n")) >= 0) {
            const line = stdout.slice(0, newline);
            stdout = stdout.slice(newline + 1);
            try {
              const msg = JSON.parse(line) as { type?: string; port?: number };
              if (msg.type === "ipc.listening" && !listening && Number.isInteger(msg.port) && msg.port! > 0 && msg.port! <= 65535) {
                listening = true;
                for (let lane = 0; lane < laneCount; lane++) socket.#connectLane(lane, msg.port!, token);
              } else if (msg.type === "transport.ready" && listening && socket.#lanes.length === laneCount) {
                socket.readyState = WebSocket.OPEN;
                cleanup();
                // Keep stdout drained, but it never carries application data.
                socket.#child.stdout.resume();
                resolve();
              } else { fail(new Error("Invalid helper response")); }
            } catch { fail(new Error("Invalid helper response")); }
          }
        };
        socket.on("error", fail);
        socket.once("close", closed);
        signal.addEventListener("abort", abort, { once: true });
        socket.#child.stdout.on("data", data);
        socket.#child.stdin.write(Buffer.concat([header, config]));
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      return socket;
    } catch (error) { await socket.closeAndJoin(); throw error; }
  }

  #connectLane(lane: number, port: number, token: string): void {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    socket.pause(); // Host installs its listeners before business frames may arrive.
    this.#lanes[lane] = socket;
    socket.once("connect", () => socket.write(packet(0, Buffer.from(JSON.stringify({ token, lane })))));
    socket.on("error", () => this.#fail(new Error("QUIC IPC connection failed")));
    socket.on("close", () => { if (this.readyState < WebSocket.CLOSING) this.close(); });
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const size = pending.readUInt32BE();
        if (size < 1 || size > MAX_FRAME + 1) { this.#fail(new Error("Invalid QUIC IPC size")); return; }
        if (pending.length < size + 4) return;
        const op = pending[4];
        const body = pending.subarray(5, size + 4);
        pending = pending.subarray(size + 4);
        if (op === 1 && body.length === 4) {
          const expected = this.#pending[lane]!.shift();
          if (expected === undefined || body.readUInt32BE() !== expected) { this.#fail(new Error("Invalid QUIC write receipt")); return; }
          this.#bytes[lane]! -= expected;
          this.#count--;
        } else if (op === 0) {
          try {
            if (laneFor(body.toString("utf8")) !== lane) throw new Error("Invalid lane");
          } catch { this.#fail(new Error("Invalid QUIC received frame")); return; }
          this.emit("message", body, false);
        } else { this.#fail(new Error("Invalid QUIC IPC operation")); return; }
      }
    });
  }

  activate(): void { for (const socket of this.#lanes) socket.resume(); }
  get bufferedAmount(): number { return this.#bytes.reduce((a, b) => a + b, 0); }
  bufferedAmountFor(channel: EnvelopeChannel): number {
    return this.#bytes[["ctl", "msg", "bulk", "history", "catchup"].indexOf(channel)] ?? 0;
  }

  send(text: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error("QUIC transport is not open");
    const lane = laneFor(text);
    if (lane >= this.#lanes.length) throw new Error("History stream was not negotiated by the adapter");
    const body = Buffer.from(text);
    if (body.length === 0 || body.length > MAX_FRAME || this.#count >= MAX_FRAMES || this.#bytes[lane]! + body.length > LANE_LIMITS[lane]!) {
      const error = new Error("QUIC lane queue capacity reached");
      this.#fail(error);
      throw error;
    }
    if ([1, 3, 4].includes(lane) && [1, 3, 4].reduce((n, i) => n + (this.#bytes[i] ?? 0), 0) + body.length > 32 * 1024 * 1024) {
      const error = new Error("QUIC session queue capacity reached"); this.#fail(error); throw error;
    }
    this.#pending[lane]!.push(body.length);
    this.#bytes[lane]! += body.length;
    this.#count++;
    this.#lanes[lane]!.write(packet(0, body));
  }

  #fail(error: Error): void { this.emit("error", error); this.close(); }
  close(): void {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    for (const socket of this.#lanes) socket.destroy();
    this.#child.stdin.end();
    // Normal EOF joins Go pumps. A wedged helper is bounded and reaped too.
    this.#killTimer = setTimeout(() => this.#child.kill("SIGKILL"), 2000);
    this.#killTimer.unref();
  }
  terminate(): void { this.close(); }
  async closeAndJoin(): Promise<void> { this.close(); await this.#exit; }
}

export async function closeRelaySocket(socket: RelaySocket): Promise<void> {
  if (socket instanceof NativeQuicSocket) return socket.closeAndJoin();
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => socket.terminate(), 1000);
    timer.unref();
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.close(1000, "transport handoff");
  });
}

async function prepareWS(relayUrl: string, signal: AbortSignal): Promise<PreparedRelaySocket> {
  signal.throwIfAborted();
  const socket = new WebSocket(`${relayUrl.replace(/\/$/u, "")}/v1/runtime`, { handshakeTimeout: 5000 });
  socket.on("error", () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener("abort", abort); socket.off("open", open); socket.off("error", error); socket.off("close", closed); };
      const open = (): void => { cleanup(); resolve(); };
      const error = (e: unknown): void => { cleanup(); reject(e); };
      const closed = (): void => error(new Error("Relay closed before open"));
      const abort = (): void => error(signal.reason);
      socket.once("open", open); socket.once("error", error); socket.once("close", closed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return { socket, kind: "ws" };
  } catch (e) { await closeRelaySocket(socket); throw e; }
}

export async function prepareRelaySocket(relayUrl: string, mode: RelayTransportMode, signal: AbortSignal, options: RelaySocketOptions = {}): Promise<PreparedRelaySocket> {
  if (mode !== "quic") return prepareWS(relayUrl, signal);
  try {
    const url = new URL(relayUrl.replace(/\/$/u, "") + "/v1/transports");
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(hostname))) throw new Error("QUIC discovery requires HTTPS");
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const discoverySignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    const response = await fetch(url, { signal: discoverySignal, redirect: "error" });
    if (!response.ok || response.body === null) throw new Error("Relay has no Host QUIC advertisement");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 65536) throw new Error("QUIC discovery response too large");
        parts.push(item.value);
      }
    } finally { await reader.cancel(); }
    const info = JSON.parse(Buffer.concat(parts).toString()) as { version?: number; quic?: { port?: number; hostAlpn?: string; historyHostAlpn?: string } };
    const port = info.quic?.port;
    if (info.version !== 1 || info.quic?.hostAlpn !== "orbis-relay-host-v2" || !Number.isInteger(port) || port! < 1 || port! > 65535) throw new Error("Relay has no compatible Host QUIC endpoint");
    const address = `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
    const socket = await NativeQuicSocket.prepare(address, hostname, AbortSignal.any([signal, AbortSignal.timeout(options.prepareTimeoutMs ?? 5000)]), { ...options, ...(info.quic?.historyHostAlpn === "orbis-relay-host-v3" ? { streamVersion: 3 as const } : {}) });
    return { socket, kind: "quic" };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}
