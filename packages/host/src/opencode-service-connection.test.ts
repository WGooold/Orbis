import { describe, expect, it, vi } from "vitest";
import type { Endpoint } from "@opencode/client/service";
import { OPENCODE_CLIENT_VERSION, OpenCodeServiceConnection } from "./opencode-service-connection.js";

const endpoint: Endpoint = {
  url: "http://127.0.0.1:4096",
  auth: { type: "basic", username: "opencode", password: "local-service-secret" },
};
const client = (version: string) => ({ server: { info: vi.fn(async () => ({
  version, pid: 1, urls: [], paths: { tmp: "" },
})) } });

describe("OpenCode shared-service connection", () => {
  it("discovers a local service, authenticates with its supplied header, and accepts only the pinned version", async () => {
    const api = client(OPENCODE_CLIENT_VERSION);
    const createClient = vi.fn((options: { baseUrl: string; headers?: HeadersInit | undefined }) => {
      const headers = new Headers(options.headers);
      expect(options.baseUrl).toBe(endpoint.url);
      expect(headers.get("authorization")).toBe("Basic " + Buffer.from("opencode:local-service-secret").toString("base64"));
      return api as never;
    });
    const connection = new OpenCodeServiceConnection({ discover: async () => endpoint, createClient });

    await expect(connection.refresh()).resolves.toEqual({ state: "ready", version: OPENCODE_CLIENT_VERSION });
    expect(connection.isReady).toBe(true);
    expect(connection.client).toBe(api);
    expect(JSON.stringify(connection.status)).not.toContain("local-service-secret");
    connection.close();
  });

  it("reports missing and unsupported services without retaining a client", async () => {
    let discovered: Endpoint | undefined;
    const createClient = vi.fn(() => client("2.3.1") as never);
    const connection = new OpenCodeServiceConnection({ discover: async () => discovered, createClient });
    await expect(connection.refresh()).resolves.toEqual({ state: "unavailable", reason: "service_not_found" });
    expect(createClient).not.toHaveBeenCalled();

    discovered = endpoint;
    await expect(connection.refresh()).resolves.toEqual({ state: "unavailable", reason: "unsupported_version" });
    expect(connection.isReady).toBe(false);
    expect(connection.client).toBeUndefined();
    connection.close();
  });

  it("rejects non-loopback registrations before creating a client", async () => {
    const createClient = vi.fn(() => client(OPENCODE_CLIENT_VERSION) as never);
    const connection = new OpenCodeServiceConnection({
      discover: async () => ({ ...endpoint, url: "http://192.0.2.10:4096" }), createClient,
    });
    await expect(connection.refresh()).resolves.toEqual({ state: "unavailable", reason: "invalid_endpoint" });
    expect(createClient).not.toHaveBeenCalled();
    connection.close();
  });

  it("recovers after a disconnect and does not stop the external service on close", async () => {
    let online = false;
    const api = client(OPENCODE_CLIENT_VERSION);
    const connection = new OpenCodeServiceConnection({
      discover: async () => online ? endpoint : undefined,
      createClient: () => api as never,
    });
    await connection.refresh();
    expect(connection.status).toEqual({ state: "unavailable", reason: "service_not_found" });

    online = true;
    await connection.refresh();
    expect(connection.isReady).toBe(true);
    connection.close();
    expect(connection.status).toEqual({ state: "closed" });
  });

  it("turns health errors into a sanitized unavailable state", async () => {
    const connection = new OpenCodeServiceConnection({
      discover: async () => endpoint,
      createClient: () => ({ server: { info: async () => { throw new Error("request failed: local-service-secret"); } } }) as never,
    });
    await expect(connection.refresh()).resolves.toEqual({ state: "unavailable", reason: "connection_failed" });
    expect(JSON.stringify(connection.status)).not.toContain("local-service-secret");
    connection.close();
  });
});