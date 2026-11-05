import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRelayServer, type RelayServerOptions, type RelayServer } from "@orbis/relay";
import type { HostServiceOptions } from "../host-service.js";
import { relayHistoryMode } from "../history-delivery.js";

type Bridge = { url: string; quicPort: number; caFile: string; restartHost: () => Promise<void>; stop: () => Promise<void> };
const hostBridges = new Map<string, Bridge>();

const mode = process.env.ORBIS_TEST_RELAY_TRANSPORT ?? "ws";
if (mode !== "ws" && mode !== "quic") throw new Error(`Unknown test Relay transport: ${mode}`);
const bridges = new Map<string, Promise<Bridge>>();

async function startBridge(upstream: string): Promise<Bridge> {
  const binary = process.env.ORBIS_TEST_QUIC_BRIDGE;
  if (!binary) throw new Error("QUIC business regression requires ORBIS_TEST_QUIC_BRIDGE; no WS fallback");
  const child = spawn(binary, [upstream], { stdio: ["pipe", "pipe", "pipe"] });
  let errorOutput = "";
  child.stderr.on("data", chunk => { errorOutput = (errorOutput + String(chunk)).slice(-4096); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 5000);
  try {
    const first = new Promise<string>(resolve => lines.once("line", resolve));
    const line = await Promise.race([first, exited.then(result => {
      throw new Error(`QUIC bridge exited before ready: ${JSON.stringify(result)} ${errorOutput}`);
    })]);
    const metadata = JSON.parse(line) as { url: string; transport: string; alpn: string; quicPort: number; caFile: string };
    const endpoint = new URL(metadata.url);
    if (metadata.transport !== "quic" || metadata.alpn !== (process.env.ORBIS_TEST_HISTORY_STREAMS === "1" ? "orbis-relay-v3" : "orbis-relay-v2")
      || endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/v1/device") {
      throw new Error("Invalid isolated QUIC bridge metadata");
    }
    return { url: metadata.url, quicPort: metadata.quicPort, caFile: metadata.caFile, restartHost: async () => {
      let timer: NodeJS.Timeout | undefined;
      let onLine: (line: string) => void;
      try {
        await Promise.race([new Promise<void>((resolve, reject) => {
          onLine = line => {
            if (JSON.parse(line).type === "host.restarted") resolve();
            else reject(new Error("Unexpected QUIC fixture reply"));
          };
          lines.once("line", onLine);
          timer = setTimeout(() => reject(new Error("Host QUIC restart timed out")), 3000);
          child.stdin.write("restart-host\n");
        }), exited.then(() => { throw new Error("QUIC fixture exited during restart"); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); lines.off("line", onLine!); }
    }, stop: async () => {
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        const result = await exited;
        if (result.code !== 0) throw new Error(`QUIC bridge cleanup failed: ${JSON.stringify(result)} ${errorOutput}`);
      } finally { clearTimeout(deadline); lines.close(); }
    } };
  } catch (error) {
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(deadline); lines.close(); }
    throw error;
  } finally { clearTimeout(timeout); }
}

export async function restartBusinessHostQUIC(url: string): Promise<void> {
  const bridge = hostBridges.get(url);
  if (!bridge) throw new Error("No Host QUIC fixture for fault injection");
  await bridge.restartHost();
}

/** The reference phone retains its existing API; every selected leg uses real QUIC. */
export async function relayBusinessDeviceURL(upstream: string, selected: "ws" | "quic" = mode === "quic" ? "quic" : "ws"): Promise<string> {
  if (selected === "ws") return upstream;
  let bridge = bridges.get(upstream);
  if (!bridge) { bridge = startBridge(upstream); bridges.set(upstream, bridge); }
  return (await bridge).url;
}

export async function stopRelayBusinessTransports(): Promise<void> {
  const pending = [...bridges.values()];
  bridges.clear();
  hostBridges.clear();
  const results = await Promise.allSettled(pending.map(async bridge => (await bridge).stop()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "QUIC business fixture cleanup failed");
}


export async function createBusinessRelayServer(input: RelayServerOptions): Promise<RelayServer> {
  const options = { ...input };
  const relay = await createRelayServer(options);
  if (process.env.ORBIS_TEST_HOST_TRANSPORT !== "quic") return relay;
  try {
    const upstream = `${relay.url}/v1/device`;
    const starting = startBridge(upstream);
    bridges.set(upstream, starting);
    const bridge = await starting;
    options.quicPort = bridge.quicPort;
    options.quicHostEnabled = true;
    options.quicHistoryStreamsEnabled = process.env.ORBIS_TEST_HISTORY_STREAMS === "1";
    hostBridges.set(relay.url, bridge);
    return relay;
  } catch (error) { await relay.close(); throw error; }
}

export function relayBusinessHostOptions(url: string): Pick<HostServiceOptions, "relayTransport" | "relaySocketOptions" | "relayHistoryMode"> {
  const historyMode = relayHistoryMode(process.env.ORBIS_TEST_RELAY_HISTORY_MODE);
  if (process.env.ORBIS_TEST_HOST_TRANSPORT !== "quic") return { relayHistoryMode: historyMode };
  const bridge = hostBridges.get(url);
  const helperPath = process.env.ORBIS_TEST_QUIC_HELPER;
  if (bridge === undefined || helperPath === undefined) throw new Error("Host QUIC regression requires the native helper and dual-role fixture");
  return { relayHistoryMode: historyMode, relayTransport: "quic", relaySocketOptions: { helperPath, caFile: bridge.caFile } };
}
