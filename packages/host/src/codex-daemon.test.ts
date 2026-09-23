/**
 * CodexAppServer 的 JSON-RPC 客户端测试。传输用假对象注入（生产是 WebSocket），
 * 逐条验证：握手、请求关联、通知、服务端请求回帧、连接断开时的 reject。
 */
import { describe, expect, it, vi } from "vitest";

import { CodexAppServer, type CodexTransport } from "./codex-daemon.js";

type FakeTransportHarness = {
  transport: CodexTransport;
  /** 客户端发出的帧（每条一个 JSON 字符串，无换行）。 */
  sent: string[];
  /** 模拟服务端来帧（容忍一帧多行，与生产行为一致）。 */
  emit: (text: string) => void;
  /** 模拟连接断开（code 传 null 表示未知）。 */
  drop: (code: number | null) => void;
};

function fakeTransport(): FakeTransportHarness {
  const sent: string[] = [];
  const messageHandlers: Array<(text: string) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];
  const transport: CodexTransport = {
    send: (text) => {
      sent.push(text);
    },
    close: async () => {},
    onMessage: (handler) => messageHandlers.push(handler),
    onClose: (handler) => closeHandlers.push(handler),
  };
  return {
    transport,
    sent,
    emit: (text) => {
      for (const handler of [...messageHandlers]) handler(text);
    },
    drop: (code) => {
      for (const handler of [...closeHandlers]) handler(code);
    },
  };
}

describe("CodexAppServer", () => {
  it("handles equal IDs in opposite RPC directions and sends only one answer", async () => {
    const harness = fakeTransport();
    const requests: string[] = [];
    const creating = CodexAppServer.create({ transportImpl: async () => harness.transport,
      onServerRequest: (request) => {
        requests.push(request.method);
        request.respond({ decision: "accept" });
        request.fail("duplicate");
        request.respond({ decision: "decline" });
      },
    });
    await vi.waitFor(() => expect(harness.sent.length).toBe(1));
    harness.emit(JSON.stringify({ id: 1, result: {} }));
    const server = await creating;
    const pending = server.request("thread/list", {});
    harness.emit(JSON.stringify({ id: 2, method: "item/commandExecution/requestApproval", params: {} }));
    harness.emit(JSON.stringify({ id: 2, result: { data: [] } }));
    await expect(pending).resolves.toEqual({ data: [] });
    expect(requests).toEqual(["item/commandExecution/requestApproval"]);
    expect(harness.sent.map((s) => JSON.parse(s)).filter((f) => f.id === 2 && f.method === undefined))
      .toEqual([{ id: 2, result: { decision: "accept" } }]);
    await server.stop();
  });
  it("握手：initialize 请求带 clientInfo，应答后发 initialized 通知", async () => {
    const harness = fakeTransport();
    // create() 会阻塞在 initialize 上，所以先启动、看到请求帧后再应答。
    const creating = CodexAppServer.create({
      transportImpl: () => Promise.resolve(harness.transport),
      requestTimeoutMs: 2_000,
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((frame) => frame.includes('"initialize"'))).toBe(true);
    });
    harness.emit(JSON.stringify({ id: 1, result: { userAgent: "x" } }));
    const server = await creating;
    expect(JSON.parse(harness.sent[0] ?? "{}")).toMatchObject({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "pi-remote-host" } },
    });
    expect(JSON.parse(harness.sent[1] ?? "{}")).toEqual({ method: "initialized" });
    expect(server.endpoint).toBeTruthy();
    await server.stop();
  });

  it("请求响应按 id 关联；错误帧 reject 并带 message", async () => {
    const harness = fakeTransport();
    const creating = CodexAppServer.create({
      transportImpl: () => Promise.resolve(harness.transport),
      requestTimeoutMs: 2_000,
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((frame) => frame.includes('"initialize"'))).toBe(true);
    });
    harness.emit(JSON.stringify({ id: 1, result: {} }));
    const server = await creating;
    const ok = server.request("thread/list", { limit: 5 });
    const bad = server.request("account/read");
    harness.emit(JSON.stringify({ id: 3, error: { code: -1, message: "未登录" } }));
    harness.emit(JSON.stringify({ id: 2, result: { data: [] } }));
    await expect(ok).resolves.toEqual({ data: [] });
    await expect(bad).rejects.toThrow("未登录");
    await server.stop();
  });

  it("服务端请求（审批）回帧：respond 写 result，fail 写 error", async () => {
    const harness = fakeTransport();
    const requests: unknown[] = [];
    const creating = CodexAppServer.create({
      transportImpl: () => Promise.resolve(harness.transport),
      requestTimeoutMs: 2_000,
      onServerRequest: (request) => {
        requests.push(request);
        request.respond({ decision: "accept" });
      },
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((frame) => frame.includes('"initialize"'))).toBe(true);
    });
    harness.emit(JSON.stringify({ id: 1, result: {} }));
    const server = await creating;
    harness.emit(
      JSON.stringify({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { command: ["ls"] } }),
    );
    await vi.waitFor(() => expect(requests.length).toBe(1));
    expect(JSON.parse(harness.sent.at(-1) ?? "{}")).toEqual({ id: "srv-1", result: { decision: "accept" } });
    await server.stop();
  });

  it("通知原样转发给 onNotification；非 JSON 行不炸", async () => {
    const harness = fakeTransport();
    const notifications: Array<[string, unknown]> = [];
    const creating = CodexAppServer.create({
      transportImpl: () => Promise.resolve(harness.transport),
      requestTimeoutMs: 2_000,
      onNotification: (method, params) => notifications.push([method, params]),
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((frame) => frame.includes('"initialize"'))).toBe(true);
    });
    harness.emit(JSON.stringify({ id: 1, result: {} }));
    const server = await creating;
    harness.emit("这不是 JSON");
    harness.emit(JSON.stringify({ method: "item/completed", params: { item: { id: "a" } } }));
    await vi.waitFor(() => expect(notifications.length).toBe(1));
    expect(notifications[0]?.[0]).toBe("item/completed");
    await server.stop();
  });

  it("连接意外断开：在途请求全部 reject，onExit 触发", async () => {
    const harness = fakeTransport();
    let exited: number | null | undefined;
    const creating = CodexAppServer.create({
      transportImpl: () => Promise.resolve(harness.transport),
      requestTimeoutMs: 2_000,
      onExit: (code) => {
        exited = code;
      },
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((frame) => frame.includes('"initialize"'))).toBe(true);
    });
    harness.emit(JSON.stringify({ id: 1, result: {} }));
    const server = await creating;
    const pending = server.request("thread/list");
    harness.drop(1006);
    await expect(pending).rejects.toThrow("1006");
    await vi.waitFor(() => expect(exited).toBe(1006));
    // stop() 在已断开后不应再报 onExit。
    await server.stop();
  });

  it("stop() 后在途请求被 reject 为「已被关闭」，onExit 不触发", async () => {
    const harness = fakeTransport();
    let exited: number | null | undefined;
    const creating = CodexAppServer.create({
      transportImpl: () => Promise.resolve(harness.transport),
      requestTimeoutMs: 2_000,
      onExit: (code) => {
        exited = code;
      },
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((frame) => frame.includes('"initialize"'))).toBe(true);
    });
    harness.emit(JSON.stringify({ id: 1, result: {} }));
    const server = await creating;
    const pending = server.request("thread/list");
    await server.stop();
    await expect(pending).rejects.toThrow("已被关闭");
    expect(exited).toBeUndefined();
  });
});
