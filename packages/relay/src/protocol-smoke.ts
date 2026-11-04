import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

/** No production credential or session is needed to verify the version gate. */
export async function checkRelayProtocolCompatibility(baseUrl: string): Promise<void> {
  const base = new URL(baseUrl);
  if (base.protocol === "https:") base.protocol = "wss:";
  if (base.protocol === "http:") base.protocol = "ws:";
  if (base.protocol !== "ws:" && base.protocol !== "wss:") throw new Error("Expected a WebSocket or HTTP Relay URL");
  const probeId = `compat-probe-${randomUUID()}`;
  for (const route of ["runtime", "device"] as const) {
    for (const protocolVersion of [18, 19, 17, 20]) {
      const socket = new WebSocket(`${base.href.replace(/\/$/u, "")}/v1/${route}`);
      try {
        await once(socket, "open", { signal: AbortSignal.timeout(5_000) });
        const response = once(socket, "message", { signal: AbortSignal.timeout(5_000) });
        socket.send(JSON.stringify(route === "runtime" ? {
          type: "runtime.authenticate", protocolVersion, role: "host", credential: probeId,
          runtime: { runtimeId: probeId, name: "Compatibility probe", cwd: "/", status: "idle" },
        } : { type: "device.authenticate", protocolVersion, credential: probeId }));
        const [raw] = await response;
        const message = JSON.parse(raw.toString()) as { type?: string; code?: string };
        const expected = protocolVersion === 18 || protocolVersion === 19 ? "unauthorized" : "protocol_version_mismatch";
        if (message.type !== "protocol.error" || message.code !== expected) {
          throw new Error(`Relay ${route} protocol ${protocolVersion}: expected ${expected}, received ${message.type}/${message.code}`);
        }
      } finally {
        // These are unauthenticated probe sockets only, never user connections.
        if (socket.readyState !== WebSocket.CLOSED) {
          const closed = once(socket, "close").catch(() => undefined);
          socket.terminate();
          await closed;
        }
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  checkRelayProtocolCompatibility(process.argv[2] ?? "ws://127.0.0.1:8787")
    .then(() => console.log("Relay protocol gate verified: 18 / 19 reach credential validation; 17 / 20 rejected on both routes"))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
