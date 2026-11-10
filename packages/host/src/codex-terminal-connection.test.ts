// SC74: Exercise actual loopback WebSockets, including identical cwd/request IDs,
// stale broadcasts and out-of-order selection replies. No user sessions or models.
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexTerminalEndpoints, createCodexTerminalConnection } from "./codex-terminal-connection.js";
import { CodexAppServer } from "./codex-daemon.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  cleanups.push(async () => {
    for (const client of upstream.clients) client.terminate();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const open = async () => {
    const onThread = vi.fn();
    const connection = await createCodexTerminalConnection({
      upstreamEndpoint: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`, onThread,
    });
    cleanups.push(connection.close);
    const connected = once(upstream, "connection");
    const client = new WebSocket(connection.endpoint);
    client.on("error", () => {});
    cleanups.push(async () => { client.terminate(); });
    await once(client, "open");
    const [native] = await connected as [WebSocket];
    const received: unknown[] = [];
    client.on("message", data => received.push(JSON.parse(data.toString())));
    const request = async (id: number, threadId: string, extra: Record<string, unknown> = {}) => {
      const observed = once(native, "message");
      client.send(JSON.stringify({ id, method: "thread/resume", params: { threadId, ...extra } }));
      await observed;
    };
    const reply = (id: number, threadId: string, extra: Record<string, unknown> = {}) =>
      native.send(JSON.stringify({ id, result: { thread: { id: threadId, cwd: "/same-project", ...extra } } }));
    return { connection, onThread, client, native, request, reply, received };
  };
  return { open };
}

describe("Codex terminal connection ownership", () => {
  it("matches exact remote arguments rather than endpoint prefixes or reused ports", () => {
    const a = "ws://127.0.0.1:51217/window-a"; const b = "ws://127.0.0.1:51217/window-b";
    expect([...codexTerminalEndpoints(`codex.exe resume old --remote "${a}"\nnode.exe codex.js --remote=${b}`, [a, b])]).toEqual([a, b]);
    expect([...codexTerminalEndpoints(`codex.exe --remote ${a}-other\nnode.exe other.js ${b}`, [a, b])]).toEqual([]);
    expect([...codexTerminalEndpoints(`codex.exe --remote ${b}`, [a, b])]).toEqual([b]);
    expect([...codexTerminalEndpoints("codex.exe --remote ws://127.0.0.1:51217", ["ws://127.0.0.1:5121", "ws://127.0.0.1:51217"])]).toEqual(["ws://127.0.0.1:51217"]);
    expect([...codexTerminalEndpoints("& 'codex' 'resume' 'session' '--remote' 'ws://127.0.0.1:51217' ; exit 0", ["ws://127.0.0.1:5121", "ws://127.0.0.1:51217"])]).toEqual(["ws://127.0.0.1:51217"]);
  });

  // Opt-in native protocol gate: same selected CLI as Host, isolated native home,
  // empty synthetic sessions and no turn/start or inference calls.
  it.skipIf(process.env.ORBIS_CODEX_NATIVE_TEST !== "1")("routes independent selections through the installed native Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-terminal-native-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home"); const cwd = join(root, "workspace");
    await mkdir(home); await mkdir(cwd);
    await writeFile(join(home, "config.toml"), 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
    const server = await CodexAppServer.create({ requestTimeoutMs: 15_000,
      spawnImpl: (command, args) => spawn(command, args, { cwd,
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] }),
    });
    cleanups.push(() => server.stop());
    const open = async () => {
      const selections: string[] = [];
      const connection = await createCodexTerminalConnection({ upstreamEndpoint: server.endpoint!, onThread: thread => selections.push(String(thread.id)) });
      cleanups.push(connection.close);
      const client = new WebSocket(connection.endpoint);
      client.on("error", () => {}); cleanups.push(async () => { client.terminate(); });
      await once(client, "open");
      let nextId = 0;
      const rpc = async (method: string, params: unknown) => {
        const id = ++nextId;
        const result = new Promise<Record<string, unknown>>((resolve, reject) => {
          const listen = (data: WebSocket.RawData) => {
            const frame = JSON.parse(data.toString());
            if (frame.id !== id || frame.method !== undefined) return;
            client.off("message", listen); clearTimeout(timer);
            if (frame.error) reject(new Error(JSON.stringify(frame.error))); else resolve(frame.result);
          };
          const timer = setTimeout(() => { client.off("message", listen); reject(new Error(`Timed out: ${method}`)); }, 10_000);
          client.on("message", listen);
        });
        client.send(JSON.stringify({ id, method, params }));
        return result;
      };
      await rpc("initialize", { clientInfo: { name: "orbis-terminal-regression", version: "1" }, capabilities: { experimentalApi: true } });
      client.send(JSON.stringify({ method: "initialized" }));
      const start = async () => (await rpc("thread/start", { cwd })).thread as Record<string, unknown>;
      return { connection, selections, start };
    };
    const a = await open(); const b = await open();
    const firstA = await a.start(); const firstB = await b.start();
    expect(a.connection.selectedThreadId).toBe(firstA.id); expect(b.connection.selectedThreadId).toBe(firstB.id);
    expect(firstA.id).not.toBe(firstB.id);
    // An unrelated native client selects an old/other thread; both TUIs see its
    // broadcasts but neither can change card or close ownership from those alone.
    await server.request("thread/start", { cwd });
    expect(a.selections).toEqual([firstA.id]); expect(b.selections).toEqual([firstB.id]);
    const nextB = await b.start();
    expect(a.connection.selectedThreadId).toBe(firstA.id); expect(b.connection.selectedThreadId).toBe(nextB.id);
    await a.connection.close();
    const finalB = await b.start();
    expect(b.connection.selectedThreadId).toBe(finalB.id);
  }, 30_000);

  it("binds two same-directory TUIs independently and ignores old-session broadcasts", async () => {
    const h = await fixture(); const a = await h.open(); const b = await h.open();
    expect(a.connection.endpoint).not.toBe(b.connection.endpoint);
    await a.request(1, "live-a"); await b.request(1, "live-b");
    a.reply(1, "live-a"); b.reply(1, "live-b");
    await vi.waitFor(() => expect([a.connection.selectedThreadId, b.connection.selectedThreadId]).toEqual(["live-a", "live-b"]));
    const old = { method: "thread/status/changed", params: { threadId: "closed-old", status: { type: "idle" } } };
    for (let repeat = 0; repeat < 3; repeat++) {
      a.native.send(JSON.stringify(old)); b.native.send(JSON.stringify(old));
      a.native.send(JSON.stringify({ method: "thread/started", params: { thread: { id: "closed-old", cwd: "/same-project" } } }));
    }
    await vi.waitFor(() => expect(a.received).toHaveLength(7));
    expect(a.onThread).toHaveBeenCalledTimes(1); expect(b.onThread).toHaveBeenCalledTimes(1);
    expect([a.connection.selectedThreadId, b.connection.selectedThreadId]).toEqual(["live-a", "live-b"]);
    // Releasing A cannot disconnect or reassign B.
    await a.connection.close();
    await b.request(2, "next-b"); b.reply(2, "next-b");
    await vi.waitFor(() => expect(b.connection.selectedThreadId).toBe("next-b"));
  });

  it("accepts only successful correlated selections and keeps newer replies", async () => {
    const h = await fixture(); const a = await h.open();
    await a.request(1, "older"); await a.request(2, "newer");
    expect(a.connection.selectionPending).toBe(true);
    a.reply(2, "newer"); a.reply(1, "older"); a.reply(999, "unsolicited");
    await vi.waitFor(() => expect(a.received).toHaveLength(3));
    expect(a.connection.selectedThreadId).toBe("newer");
    expect(a.onThread).toHaveBeenCalledTimes(1); expect(a.connection.selectionPending).toBe(false);
    await a.request(3, "rejected");
    a.native.send(JSON.stringify({ id: 3, error: { code: -1, message: "rejected" } }));
    await vi.waitFor(() => expect(a.connection.selectionPending).toBe(false));
    expect(a.connection.selectedThreadId).toBe("newer");
  });

  it("forwards approvals and content without mistaking internal threads for selections", async () => {
    const h = await fixture(); const a = await h.open();
    for (const [index, extra] of [{ ephemeral: true }, { source: { subAgent: {} } }, { parentThreadId: "parent" }].entries()) {
      await a.request(index, "internal"); a.reply(index, "internal", extra);
    }
    await vi.waitFor(() => expect(a.received).toHaveLength(3));
    expect(a.onThread).not.toHaveBeenCalled();
    await a.request(7, "live");
    const approval = { id: 7, method: "item/commandExecution/requestApproval", params: { command: "echo test" } };
    a.native.send(JSON.stringify(approval));
    await vi.waitFor(() => expect(a.received).toContainEqual(approval));
    expect(a.connection.selectionPending).toBe(true);
    a.reply(7, "live");
    await vi.waitFor(() => expect(a.connection.selectedThreadId).toBe("live"));
    const received = once(a.native, "message");
    a.client.send(JSON.stringify({ id: 7, result: { decision: "accept" } }));
    expect(JSON.parse(String((await received)[0]))).toEqual({ id: 7, result: { decision: "accept" } });
  });

  it("blocks concurrent selection during process close and releases the guard on failure", async () => {
    const h = await fixture(); const a = await h.open();
    await a.request(1, "live");
    expect(a.connection.acquireClose("live")).toBeUndefined();
    a.reply(1, "live");
    await vi.waitFor(() => expect(a.connection.selectedThreadId).toBe("live"));
    expect(a.connection.acquireClose("other")).toBeUndefined();
    const release = a.connection.acquireClose("live");
    expect(release).toBeTypeOf("function");
    const nativeMessage = vi.fn(); a.native.on("message", nativeMessage);
    a.client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "other" } }));
    await vi.waitFor(() => expect(a.received).toContainEqual(expect.objectContaining({ id: 2, error: expect.any(Object) })));
    expect(nativeMessage).not.toHaveBeenCalled();
    expect(a.connection.selectedThreadId).toBe("live");
    release!();
    await a.request(3, "other"); a.reply(3, "other");
    await vi.waitFor(() => expect(a.connection.selectedThreadId).toBe("other"));
  });
});
