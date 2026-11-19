import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkProviderEndpoint, fetchProviderModels, parseScutilProxy, parseWindowsProxy, requestViaProxy, shouldBypassProxy } from "./provider-network.js";
// Exercise the production worker boundary; npm run build/typecheck generates these files.
import { queryProviderUsage } from "../dist/provider-usage.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function endpoint(handler: Parameters<typeof createServer>[0] extends never ? never : (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}
describe("provider network operations", () => {
  it("treats HTTP 401 as reachable and never sends a credential or generation request", async () => {
    let authorization: string | undefined;
    const url = await endpoint((req, res) => { expect(req.method).toBe("GET"); authorization = req.headers.authorization; res.writeHead(401); res.end(); });
    expect(await checkProviderEndpoint(url)).toMatchObject({ httpStatus: 401 });
    expect(authorization).toBeUndefined();
  });
  it("fetches and deduplicates native models with the selected authentication format", async () => {
    const url = await endpoint((req, res) => {
      expect(req.url).toBe("/v1/models"); expect(req.headers["x-api-key"]).toBe("local-test");
      res.end(JSON.stringify({ data: [{ id: "a" }, { id: "a" }, { id: "b" }] }));
    });
    expect(await fetchProviderModels({ baseUrl: url, apiKey: "local-test", api: "anthropic-messages", model: "", providerKey: "custom" })).toEqual([{ id: "a", name: "a" }, { id: "b", name: "b" }]);
  });
  it.each(["openai-completions", "openai-responses"])("keeps an explicit root URL for %s instead of testing a different API path", async (api) => {
    const url = await endpoint((req, res) => {
      expect(req.method).toBe("GET"); expect(req.url).toBe("/models"); expect(req.headers.authorization).toBe("Bearer local-test");
      res.end(JSON.stringify({ data: [{ id: "root-model" }] }));
    });
    expect(await fetchProviderModels({ baseUrl: url, apiKey: "local-test", api, model: "", providerKey: "custom" })).toEqual([{ id: "root-model", name: "root-model" }]);
  });
  it.each(["/gateway/v1", "/gateway/v1/"])("preserves the configured API prefix %s", async (path) => {
    const url = await endpoint((req, res) => {
      expect(req.url).toBe("/gateway/v1/models");
      res.end(JSON.stringify({ data: [] }));
    });
    expect(await fetchProviderModels({ baseUrl: url + path, apiKey: "", api: "openai-responses", model: "", providerKey: "custom" })).toEqual([]);
  });
  it("treats a models suffix as part of the saved API root, as inference does", async () => {
    const url = await endpoint((req, res) => {
      expect(req.url).toBe("/v1/models/models");
      res.writeHead(404); res.end();
    });
    await expect(fetchProviderModels({ baseUrl: `${url}/v1/models`, apiKey: "", api: "openai-responses", model: "", providerKey: "custom" })).rejects.toThrow("HTTP 404");
  });
  it.each([200, 405])("explains an HTML website response with HTTP %s without exposing its contents", async (status) => {
    const url = await endpoint((req, res) => {
      expect(req.url).toBe("/models");
      res.writeHead(status, { "content-type": "text/html" });
      res.end("<html><title>405 Not Allowed</title><body>private-response-details</body></html>");
    });
    const request = fetchProviderModels({ baseUrl: url, apiKey: "", api: "openai-responses", model: "", providerKey: "custom" });
    await expect(request).rejects.toThrow("API 地址及版本路径（如 /v1）");
    await expect(request).rejects.not.toThrow("private-response-details");
  });
  it("recognizes HTML even when the upstream omits its content type", async () => {
    const url = await endpoint((_req, res) => { res.end("<!DOCTYPE html><html><body>website</body></html>"); });
    await expect(fetchProviderModels({ baseUrl: url, apiKey: "", api: "openai-completions", model: "", providerKey: "custom" })).rejects.toThrow("HTML 网页");
  });
  it("reports an unsupported models method even when the upstream returns JSON", async () => {
    const url = await endpoint((_req, res) => { res.writeHead(405, { "content-type": "application/json" }); res.end("{}"); });
    await expect(fetchProviderModels({ baseUrl: url, apiKey: "", api: "openai-responses", model: "", providerKey: "custom" })).rejects.toThrow("HTTP 405），请检查 API 地址");
  });
  it("executes a CC Switch request/extractor script without Node privileges", async () => {
    const url = await endpoint((req, res) => { expect(req.headers.authorization).toBe("Bearer usage-key"); res.end('{"balance":12.5}'); });
    const script = { enabled: true, language: "javascript" as const, timeout: 5, code: "({ request: {url:'{{baseUrl}}/balance', headers:{Authorization:'Bearer {{apiKey}}'}}, extractor: r => ({ remaining:r.balance, unit:'USD', extra:typeof process }) })" };
    expect(await queryProviderUsage(script, { baseUrl: url, apiKey: "usage-key" })).toEqual([{ remaining: 12.5, unit: "USD", extra: "undefined" }]);
  });
  it("parses system proxy settings and routes requests through HTTP and SOCKS5 proxies", async () => {
    const scutil = `
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : internal.example
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}`;
    expect(parseScutilProxy(scutil, "https:")).toEqual({ url: "http://127.0.0.1:7891/", exceptions: ["*.local", "internal.example"] });
    expect(parseScutilProxy(scutil, "http:")).toEqual({ url: "http://127.0.0.1:7890/", exceptions: ["*.local", "internal.example"] });
    expect(parseWindowsProxy("ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443\nProxyOverride    REG_SZ    *.local;<local>\n", "https:"))
      .toEqual({ url: "http://127.0.0.1:8443/", exceptions: ["*.local", "<local>"] });
    expect(shouldBypassProxy("api.internal.example", ["*.local", "internal.example"])).toBe(true);
    expect(shouldBypassProxy("chatgpt.com", ["*.local", "internal.example"])).toBe(false);

    const httpProxy = await endpoint((req, res) => {
      expect(req.url).toBe("http://chatgpt.com/backend-api/wham/usage");
      expect(req.headers.authorization).toBe("Bearer secret");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":"http-proxy"}');
    });
    const httpRes = await requestViaProxy("http://chatgpt.com/backend-api/wham/usage", { headers: { Authorization: "Bearer secret" } }, httpProxy);
    expect(await httpRes.json()).toEqual({ ok: "http-proxy" });

    const sockets = new Set<import("node:net").Socket>();
    const socksServer = createTcpServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(Buffer.from([0x05, 0x00]));
        socket.once("data", req => {
          expect(req[1]).toBe(0x01);
          expect(req[3]).toBe(0x03);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
          socket.once("data", httpReq => {
            expect(httpReq.toString("utf8")).toContain("GET /backend-api/wham/usage HTTP/1.1");
            socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"ok\":\"socks5\"}");
          });
        });
      });
    });
    await new Promise<void>(resolve => socksServer.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => { for (const s of sockets) s.destroy(); socksServer.close(err => err ? reject(err) : resolve()); }));
    const socksAddr = socksServer.address();
    if (!socksAddr || typeof socksAddr === "string") throw new Error("No socks port");
    const socksRes = await requestViaProxy("http://chatgpt.com/backend-api/wham/usage", { headers: { Authorization: "Bearer secret" } }, `socks5h://127.0.0.1:${socksAddr.port}`);
    expect(await socksRes.json()).toEqual({ ok: "socks5" });
  });
});
