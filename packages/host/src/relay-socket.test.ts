import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { NativeQuicSocket, closeRelaySocket, prepareRelaySocket } from "./relay-socket.js";

function delayed<T>(value: T, delay: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value); }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function discoveryAfter(delay: number): void {
  vi.stubGlobal("fetch", vi.fn((_url: unknown, options: RequestInit) => delayed(new Response(JSON.stringify({
    version: 1, quic: { port: 24443, hostAlpn: "orbis-relay-host-v2" },
  })), delay, options.signal!)));
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Host QUIC preparation budgets", () => {
  it("selects five streams only from the explicit compatible adapter advertisement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      version: 1, quic: { port: 24443, hostAlpn: "orbis-relay-host-v2", historyHostAlpn: "orbis-relay-host-v3" },
    }))));
    const native = {} as NativeQuicSocket;
    const prepare = vi.spyOn(NativeQuicSocket, "prepare").mockResolvedValue(native);
    expect(await prepareRelaySocket("wss://relay.example", "quic", new AbortController().signal)).toEqual({ socket: native, kind: "quic" });
    expect(prepare).toHaveBeenCalledWith("relay.example:24443", "relay.example", expect.any(AbortSignal), { streamVersion: 3 });
  });

  it("allows explicit QUIC on a slow path within its preparation budgets", async () => {
    discoveryAfter(1200);
    const native = {} as NativeQuicSocket;
    const prepare = vi.spyOn(NativeQuicSocket, "prepare").mockImplementation(
      (_address, _serverName, signal) => delayed(native, 2000, signal),
    );
    const result = await prepareRelaySocket("wss://relay.example", "quic", new AbortController().signal);
    expect(result).toEqual({ socket: native, kind: "quic" });
    expect(prepare).toHaveBeenCalledWith("relay.example:24443", "relay.example", expect.any(AbortSignal), {});
  });

  // NQ-16: Auto must skip even a slow QUIC discovery and let the caller own WS authentication.
  it("prepares Auto directly over WS without discovery or a native candidate", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Missing test port");
    discoveryAfter(2000);
    const prepare = vi.spyOn(NativeQuicSocket, "prepare");
    let frames = 0;
    server.on("connection", socket => socket.on("message", () => { frames++; }));
    try {
      const result = await prepareRelaySocket(`ws://127.0.0.1:${address.port}`, "auto", new AbortController().signal);
      expect(result.kind).toBe("ws");
      expect(prepare).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(frames).toBe(0);
      await closeRelaySocket(result.socket);
    } finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("does not turn user cancellation into a fallback or native connection", async () => {
    discoveryAfter(2000);
    const prepare = vi.spyOn(NativeQuicSocket, "prepare");
    const controller = new AbortController();
    const pending = prepareRelaySocket("wss://relay.example", "quic", controller.signal);
    controller.abort(new Error("selection superseded"));
    await expect(pending).rejects.toThrow("selection superseded");
    expect(prepare).not.toHaveBeenCalled();
  });
});
