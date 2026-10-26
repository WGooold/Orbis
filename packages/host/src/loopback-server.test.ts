/**
 * Host 的 loopback 端点（spec §7.3）。
 *
 * 重点不是消息处理（端到端已经覆盖），而是**发现文件的生命周期**：
 * 它必须在服务起来之后出现、在服务停下之前消失。留着一个指向死端口的文件，
 * 扩展会照它连上去然后空等——那是这条通道最容易踩、也最难查的坑。
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
