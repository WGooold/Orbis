import { describe, expect, it } from "vitest";
import { createRelayServer } from "./index.js";

describe("native QUIC discovery", () => {
  it("advertises Host ALPN only when the Host endpoint is explicitly enabled", async () => {
    const relay = await createRelayServer({ port: 0, host: "127.0.0.1", quicPort: 24443, quicHostEnabled: true });
    try {
      const response = await fetch(relay.url.replace(/^ws/u, "http") + "/v1/transports");
      expect(await response.json()).toEqual({ version: 1, quic: { port: 24443, alpn: "orbis-relay-v2", hostAlpn: "orbis-relay-host-v2" } });
    } finally { await relay.close(); }
  });
  it.each([undefined, 443, 24443])("advertises only the configured same-host UDP port: %s", async quicPort => {
    const relay = await createRelayServer({ port: 0, host: "127.0.0.1", ...(quicPort === undefined ? {} : { quicPort }) });
    try {
      const response = await fetch(relay.url.replace(/^ws/u, "http") + "/v1/transports");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ version: 1, quic: quicPort === undefined ? null : { port: quicPort, alpn: "orbis-relay-v2" } });
    } finally { await relay.close(); }
  });

  it.each([0, -1, 65536, 1.5, NaN, Infinity])("rejects invalid port %s before listening", async quicPort => {
    await expect(createRelayServer({ quicPort })).rejects.toThrow("quicPort");
  });
});
