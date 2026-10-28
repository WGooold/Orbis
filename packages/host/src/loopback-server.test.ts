/**
 * Host 的 loopback 端点（spec §7.3）。
 *
 * 重点不是消息处理（端到端已经覆盖），而是**发现文件的生命周期**：
 * 它必须在服务起来之后出现、在服务停下之前消失。留着一个指向死端口的文件，
 * 扩展会照它连上去然后空等——那是这条通道最容易踩、也最难查的坑。
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { LOOPBACK_DESCRIPTOR_FILE, LOOPBACK_PATH, LoopbackDescriptorSchema, PROTOCOL_VERSION, PROTOCOL_VERSION_ERROR_CODE } from "@orbis/protocol";

import { HostLoopbackServer } from "./loopback-server.js";

describe("HostLoopbackServer 的发现文件", () => {
  let dir: string | undefined;
  let server: HostLoopbackServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("用发现文件 token 认证终端 Codex 启动请求", async () => {
    dir = await mkdtemp(join(tmpdir(), "orbis-loopback-"));
    server = new HostLoopbackServer({
      stateDir: dir,
      hostId: "host-1",
      onCodexLaunch: async request => ({ endpoint: "ws://127.0.0.1:9000", command: "node.exe", prefixArgs: ["codex.js", request.cwd] }),
    });
    const descriptor = await server.start();
    const url = descriptor.url.replace(/^ws:/u, "http:");
    const body = JSON.stringify({ cwd: "C:\\work\\repo" });

    const unauthorized = await fetch(`${url}/v1/codex/launch`, { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${url}/v1/codex/launch`, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ endpoint: "ws://127.0.0.1:9000", command: "node.exe", prefixArgs: ["codex.js", "C:\\work\\repo"] });
  });

  it("通过认证的 Claude Hook 端点保持请求直到 bridge 返回结构化结果", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    const calls: { input: unknown; signal?: AbortSignal }[] = [];
    server = new HostLoopbackServer({
      stateDir: dir,
      hostId: "host-1",
      onClaudeHook: async (input, signal) => {
        calls.push(signal === undefined ? { input } : { input, signal });
        return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
      },
    });
    const descriptor = await server.start();
    const url = descriptor.url.replace(/^ws:/u, "http:");
    const body = JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1" });

    const unauthorized = await fetch(`${url}/v1/claude/hook`, { method: "POST", body });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${url}/v1/claude/hook`, {
      method: "POST", body,
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual(JSON.parse(body));
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it("为 Claude Mods 握手、poll 和 native event 提供认证的本机 HTTP 路由", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    const received: unknown[] = [];
    server = new HostLoopbackServer({
      stateDir: dir,
      hostId: "host-1",
      onClaudeModsHello: input => { received.push(input); return { ok: true, runtimeId: "claude:s1", generation: "g1" }; },
      onClaudeModsPoll: input => { received.push(input); return { ok: true, generation: "g1", commands: [] }; },
      onClaudeModsEvent: input => { received.push(input); return "accepted"; },
    });
    const descriptor = await server.start();
    const base = descriptor.url.replace(/^ws:/u, "http:");
    const headers = { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" };
    const hello = await fetch(`${base}/v1/claude/mods/hello`, { method: "POST", headers, body: JSON.stringify({ type: "hello" }) });
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ ok: true, runtimeId: "claude:s1", generation: "g1" });
    const poll = await fetch(`${base}/v1/claude/mods/poll`, { method: "POST", headers, body: JSON.stringify({ runtimeId: "claude:s1", generation: "g1" }) });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ ok: true, generation: "g1", commands: [] });
    const event = await fetch(`${base}/v1/claude/mods/event`, { method: "POST", headers,
      body: JSON.stringify({ runtimeId: "claude:s1", generation: "g1", event: { type: "turn.start" } }) });
    expect(event.status).toBe(202);
    expect(await event.json()).toEqual({ result: "accepted" });
    const unauthorized = await fetch(`${base}/v1/claude/mods/poll`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(received).toHaveLength(3);
  });

  it("拒绝无效 JSON、无效 Hook、未配置 bridge 和超大请求", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    server = new HostLoopbackServer({ stateDir: dir, hostId: "host-1", onClaudeHook: async input => {
      if (typeof input === "object" && input !== null && "nope" in input) throw new Error("invalid Claude Hook input");
      return { ok: true };
    } });
    const descriptor = await server.start();
    const url = descriptor.url.replace(/^ws:/u, "http:");
    const headers = { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" };
    const invalidJson = await fetch(`${url}/v1/claude/hook`, { method: "POST", headers, body: "{" });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: "invalid_json" });
    const invalidHook = await fetch(`${url}/v1/claude/hook`, { method: "POST", headers, body: JSON.stringify({ nope: true }) });
    expect(invalidHook.status).toBe(400);
    expect(await invalidHook.json()).toEqual({ error: "invalid_hook" });
    const unavailable = new HostLoopbackServer({ stateDir: dir, hostId: "host-2" });
    const unavailableDescriptor = await unavailable.start();
    try {
      const response = await fetch(`${unavailableDescriptor.url.replace(/^ws:/u, "http:")}/v1/claude/hook`, { method: "POST", headers: { authorization: `Bearer ${unavailableDescriptor.token}` }, body: "{}" });
      expect(response.status).toBe(503);
    } finally {
      await unavailable.stop();
    }
    const oversized = await fetch(`${url}/v1/claude/hook`, { method: "POST", headers, body: "x".repeat(256 * 1024 + 1) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request_too_large" });
  });

  it("客户端断开时取消正在等待的 Claude Hook", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    let aborted: AbortSignal | undefined;
    server = new HostLoopbackServer({
      stateDir: dir,
      hostId: "host-1",
      onClaudeHook: async (_input, signal) => {
        aborted = signal;
        await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { cancelled: true };
      },
    });
    const descriptor = await server.start();
    const address = new URL(descriptor.url.replace(/^ws:/u, "http:"));
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ hostname: address.hostname, port: Number(address.port), path: "/v1/claude/hook", method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json", "content-length": "2" } });
      req.once("error", () => resolve());
      req.write("{}");
      void vi.waitFor(() => expect(aborted).toBeDefined(), { timeout: 1_000 }).then(() => { req.destroy(); resolve(); }, reject);
    });
    await vi.waitFor(() => expect(aborted?.aborted).toBe(true));
  });

  it("启动时写 0600 的发现文件，停止时删掉它", async () => {
    dir = await mkdtemp(join(tmpdir(), "orbis-loopback-"));
    server = new HostLoopbackServer({ stateDir: dir, hostId: "host-1" });
    const descriptor = await server.start();

    const path = join(dir, LOOPBACK_DESCRIPTOR_FILE);
    const written = JSON.parse(await readFile(path, "utf8")) as unknown;
    expect(LoopbackDescriptorSchema.parse(written)).toEqual(descriptor);
    expect(descriptor.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/u);
    expect(descriptor.pid).toBe(process.pid);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    await server.stop();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("版本不匹配时回 protocol.error 并断开，同版本照常注册", async () => {
    dir = await mkdtemp(join(tmpdir(), "orbis-loopback-"));
    const online: string[] = [];
    server = new HostLoopbackServer({
      stateDir: dir,
      hostId: "host-1",
      onRuntimeOnline: runtime => online.push(runtime.runtimeId),
    });
    const descriptor = await server.start();
    const url = `${descriptor.url}${LOOPBACK_PATH}`;
    const authenticate = (protocolVersion: number, runtimeId: string): string => JSON.stringify({
      type: "runtime.authenticate",
      protocolVersion,
      credential: descriptor.token,
      role: "agent",
      runtime: { runtimeId, name: runtimeId, cwd: "C:\\work", status: "idle" },
    });

    // 静默丢弃会让旧扩展的 TUI 永远停在 connecting：连接通着、没有错误、也不重连。
    const stranger = new WebSocket(url);
    await once(stranger, "open");
    const closed = once(stranger, "close");
    const rejection = once(stranger, "message");
    stranger.send(authenticate(PROTOCOL_VERSION - 1, "runtime-old"));
    const [refusal] = await rejection;
    expect(JSON.parse(refusal.toString())).toMatchObject({ type: "protocol.error", code: PROTOCOL_VERSION_ERROR_CODE });
    await closed;
    expect(online).toEqual([]);

    const peer = new WebSocket(url);
    await once(peer, "open");
    const ready = once(peer, "message");
    peer.send(authenticate(PROTOCOL_VERSION, "runtime-current"));
    const [confirmation] = await ready;
    expect(JSON.parse(confirmation.toString())).toMatchObject({ type: "runtime.ready", runtimeId: "runtime-current" });
    expect(online).toEqual(["runtime-current"]);
    peer.close();
  });
});
