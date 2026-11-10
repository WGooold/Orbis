import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer, type RawData } from "ws";

export type CodexTerminalConnection = {
  readonly endpoint: string;
  readonly selectedThreadId: string | undefined;
  readonly selectionPending: boolean;
  acquireClose: (threadId: string) => (() => void) | undefined;
  close: () => Promise<void>;
};
export type CodexTerminalConnectionInput = {
  upstreamEndpoint: string;
  onThread: (thread: Record<string, unknown>) => void;
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const internal = (thread: Record<string, unknown>): boolean => {
  const source = object(thread.source);
  return thread.ephemeral === true || typeof thread.parentThreadId === "string"
    || Object.hasOwn(source, "subagent") || Object.hasOwn(source, "subAgent");
};

/** Windows process snapshots must match an entire remote argument, including its
 * window identity. Matching a shared port or an endpoint prefix loses ownership. */
export function codexTerminalEndpoints(output: string, endpoints: readonly string[]): Set<string> {
  const alive = new Set<string>();
  for (const endpoint of endpoints) {
    const remote = new RegExp(codexTerminalRemotePattern(endpoint), "u");
    if (output.split("\n").some(line => remote.test(line))) alive.add(endpoint);
  }
  return alive;
}

/** Shared by the Windows watchdog and close script, including encoded wait shells. */
export function codexTerminalRemotePattern(endpoint: string): string {
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return String.raw`(?:^|\s)["']?--remote["']?(?:=|\s+)["']?${escaped}(?:["']?(?:\s|$))`;
}

/** A private loopback endpoint identifies one TUI for its entire lifetime. Only
 * replies to that TUI's own selection requests can change its current session;
 * global thread broadcasts and activity in other windows carry no ownership. */
export async function createCodexTerminalConnection(input: CodexTerminalConnectionInput): Promise<CodexTerminalConnection> {
  // The official TUI accepts only a bare host/port endpoint. Keep the listener
  // exclusively allocated to this window until its process is confirmed gone.
  const server: Server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let active: WebSocket | undefined;
  let selectedThreadId: string | undefined;
  let closed = false;
  let closing = false;
  let sequence = 0;
  let applied = 0;
  const pending = new Map<string | number, number>();
  const inspect = (data: RawData, outgoing: boolean): void => {
    for (const line of data.toString().split("\n")) {
      let frame: Record<string, unknown>;
      try { frame = object(JSON.parse(line)); } catch { continue; }
      if (typeof frame.id !== "number" && typeof frame.id !== "string") continue;
      if (outgoing) {
        if (["thread/start", "thread/resume", "thread/fork"].includes(String(frame.method)) && !internal(object(frame.params))) {
          pending.set(frame.id, ++sequence);
        }
      } else {
        const order = pending.get(frame.id);
        if (order === undefined || frame.method !== undefined) continue; // Server requests use a separate ID space.
        pending.delete(frame.id);
        const thread = object(object(frame.result).thread);
        if (frame.error !== undefined || typeof thread.id !== "string" || typeof thread.cwd !== "string" || internal(thread) || order < applied) continue;
        applied = order;
        selectedThreadId = thread.id;
        input.onThread(thread);
      }
    }
  };
  server.on("upgrade", (request, socket, head) => {
    if (closed || request.url !== "/" || request.headers.origin || active !== undefined) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => {
      active = client;
      const upstream = new WebSocket(input.upstreamEndpoint);
      sockets.add(client); sockets.add(upstream);
      const queued: Array<{ data: RawData; binary: boolean }> = [];
      let queuedBytes = 0;
      const disconnect = () => {
        if (active === client) { active = undefined; pending.clear(); }
        sockets.delete(client); sockets.delete(upstream);
        client.terminate(); upstream.terminate();
      };
      client.on("error", disconnect); upstream.on("error", disconnect);
      client.once("close", disconnect); upstream.once("close", disconnect);
      client.on("message", (data, binary) => {
        // Keep the selected identity stable while the OS verifies and terminates
        // this process. A concurrent /new or /resume must not change the victim.
        if (!binary && closing) {
          try {
            const frame = object(JSON.parse(data.toString()));
            if (["thread/start", "thread/resume", "thread/fork"].includes(String(frame.method)) && !internal(object(frame.params))) {
              client.send(JSON.stringify({ id: frame.id, error: { code: -32600, message: "Codex terminal is closing; retry after close completes" } }));
              return;
            }
          } catch { /* Forward non-selection frames unchanged. */ }
        }
        if (!binary) inspect(data, true);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else if (upstream.readyState === WebSocket.CONNECTING) {
          queuedBytes += Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;
          if (queuedBytes > 8 * 1024 * 1024) disconnect();
          else queued.push({ data, binary });
        }
      });
      upstream.once("open", () => {
        for (const { data, binary } of queued.splice(0)) upstream.send(data, { binary });
      });
      upstream.on("message", (data, binary) => {
        if (!binary) inspect(data, false);
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.on("error", () => {});
  server.unref();
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get selectedThreadId() { return selectedThreadId; },
    get selectionPending() { return pending.size > 0; },
    acquireClose: threadId => {
      if (closed || closing || pending.size > 0 || selectedThreadId !== undefined && selectedThreadId !== threadId) return undefined;
      closing = true;
      return () => { closing = false; };
    },
    close: async () => {
      if (closed) return;
      closed = true; pending.clear();
      for (const socket of sockets) socket.terminate();
      sockets.clear(); wss.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
