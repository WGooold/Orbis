/**
 * 扩展侧的本机接入（spec §7.3）。
 *
 * 这里不重跑 `RelayRuntimeTransport` 已有的行为（`transport.test.ts` 覆盖了），
 * 只验证本机特有的事：发现文件怎么读、通道怎么选（不回落到中继）、封装的 URL 与凭据对不对。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import {
  LOOPBACK_PATH,
  PROTOCOL_VERSION,
  type LoopbackDescriptor,
  type RuntimeCommand,
} from "@pi-remote/protocol";

import {
  LoopbackHostTransport,
  readLoopbackDescriptor,
  resolveRuntimeTransport,
} from "./loopback.js";

const metadata = {
  runtimeId: "pi-1",
  name: "pi",
  cwd: "/work/project",
  status: "idle",
} as const;

const descriptor = (url: string, token = "loopback-token"): LoopbackDescriptor => ({
  version: 1,
  url,
  token,
  hostId: "host-1",
  pid: 4242,
});

describe("readLoopbackDescriptor", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const write = async (contents: string): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    const path = join(dir, "loopback.json");
    await writeFile(path, contents, "utf8");
    return path;
  };

  it("没有文件时安静地返回 undefined，不抛错", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    await expect(readLoopbackDescriptor(join(dir, "nope.json"))).resolves.toBeUndefined();
  });

  it("内容不是合法契约时当作没有 Host（坏 JSON / 版本不认识 / 字段缺失）", async () => {
    await expect(readLoopbackDescriptor(await write("{ not json"))).resolves.toBeUndefined();
    await expect(readLoopbackDescriptor(await write(JSON.stringify({ ...descriptor("ws://127.0.0.1:1"), version: 2 }))))
      .resolves.toBeUndefined();
    await expect(readLoopbackDescriptor(await write(JSON.stringify({ version: 1, url: "ws://127.0.0.1:1" }))))
      .resolves.toBeUndefined();
  });

  it("读出完整契约", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    const path = join(dir, "loopback.json");
    const value = descriptor("ws://127.0.0.1:51234");
    await writeFile(path, `\uFEFF${JSON.stringify(value)}`, "utf8");
    await expect(readLoopbackDescriptor(path)).resolves.toEqual(value);
  });
});

describe("本机 loopback 接入", () => {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let transport: LoopbackHostTransport | undefined;
  let runtime: TestLoopbackHost | undefined;

  afterEach(async () => {
    transport?.close();
    await runtime?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = undefined;
    wss = undefined;
    transport = undefined;
    runtime = undefined;
  });

  const listen = async (): Promise<TestLoopbackHost> => {
    server = createServer();
    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      wss!.handleUpgrade(request, socket, head, (client) => wss!.emit("connection", client, request));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return new TestLoopbackHost(`ws://127.0.0.1:${port}`, wss);
  };

  it("把 Host 当成本地 Relay：用 token 作凭据、走 LOOPBACK_PATH", async () => {
    const host = await listen();
    runtime = host;
    const connected = vi.fn();
    const command = vi.fn<(commandId: string, runtimeId: string, command: RuntimeCommand) => void>();
    transport = new LoopbackHostTransport({ descriptor: descriptor(host.url), reconnect: false });

    await transport.start(metadata, { connected, resync: vi.fn(), command });
    await vi.waitFor(() => expect(connected).toHaveBeenCalled());

    expect(host.paths).toEqual([LOOPBACK_PATH]);
    expect(host.registrations).toEqual([{ credential: "loopback-token", runtimeId: "pi-1" }]);

    transport.publish({ type: "runtime.status", status: "running" });
    await expect(host.next()).resolves.toMatchObject({
      type: "runtime.event",
      runtimeId: "pi-1",
      event: { type: "runtime.status", status: "running" },
    });

    await host.send({
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "pi-1",
      commandId: "cmd-1",
      command: { type: "stop" },
    });
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith("cmd-1", "pi-1", { type: "stop" }));
  });

  // (a)：扩展**永远**只走本机 loopback。Host 不在时也绝不回落到中继——
  // 中继那条"运行时"入口会把明文会话事件广播给设备，等于让中继看见会话内容。
  it("Host 活着就接上，且只走 loopback", async () => {
    const host = await listen();
    runtime = host;
    const stateDir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    try {
      const path = join(stateDir, "loopback.json");
      await writeFile(path, JSON.stringify(descriptor(host.url)), "utf8");
      transport = await resolveRuntimeTransport({
        onConnectionStateChange: vi.fn(),
        descriptorPath: path,
      });
      expect(transport).toBeInstanceOf(LoopbackHostTransport);
      transport.start(metadata, { connected: vi.fn(), resync: vi.fn(), command: vi.fn() });
      await vi.waitFor(() => expect(host.registrations).toHaveLength(1));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("还没有发现文件时只等待：Host 起来后自己接上（不回落到中继）", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    try {
      const path = join(stateDir, "loopback.json");
      // 此刻 Host 还没起、发现文件也不存在。拿到的仍然是一个 loopback 通道（占位端点等待）。
      transport = await resolveRuntimeTransport({
        onConnectionStateChange: vi.fn(),
        descriptorPath: path,
      });
      expect(transport).toBeInstanceOf(LoopbackHostTransport);
      transport.start(metadata, { connected: vi.fn(), resync: vi.fn(), command: vi.fn() });
      // Host 起来并写出发现文件之后，通道应当自己接上——线上不需要 /reload。
      const host = await listen();
      runtime = host;
      await writeFile(path, JSON.stringify(descriptor(host.url)), "utf8");
      await vi.waitFor(() => expect(host.registrations).toHaveLength(1));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

/** 一个只会应答的最小 Host：够验证扩展侧的契约即可。 */
class TestLoopbackHost {
  readonly url: string;
  readonly paths: string[] = [];
  readonly registrations: { credential: string; runtimeId: string }[] = [];
  readonly #socket: Promise<WebSocket>;
  readonly #inbox: Record<string, unknown>[] = [];
  readonly #waiters = new Set<(message: Record<string, unknown>) => void>();

  constructor(url: string, wss: WebSocketServer) {
    this.url = url;
    this.#socket = new Promise<WebSocket>((resolve) => {
      wss.on("connection", (socket, request) => {
        this.paths.push(new URL(request.url ?? "/", "ws://127.0.0.1").pathname);
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.type === "runtime.authenticate") {
            const runtime = message.runtime as { runtimeId: string };
            this.registrations.push({ credential: String(message.credential), runtimeId: runtime.runtimeId });
            socket.send(JSON.stringify({
              type: "runtime.ready",
              protocolVersion: PROTOCOL_VERSION,
              runtimeId: runtime.runtimeId,
            }));
            return;
          }
          this.#push(message);
        });
        resolve(socket);
      });
    });
  }

  async next(timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return queued;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter = (message: Record<string, unknown>): void => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`等待扩展消息超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  async send(message: unknown): Promise<void> {
    (await this.#socket).send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    (await this.#socket).close();
  }

  #push(message: Record<string, unknown>): void {
    for (const waiter of this.#waiters) {
      this.#waiters.delete(waiter);
      waiter(message);
      return;
    }
    this.#inbox.push(message);
  }
}
