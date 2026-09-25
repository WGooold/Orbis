import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkProviderEndpoint, fetchProviderModels } from "./provider-network.js";
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
  it("executes a CC Switch request/extractor script without Node privileges", async () => {
    const url = await endpoint((req, res) => { expect(req.headers.authorization).toBe("Bearer usage-key"); res.end('{"balance":12.5}'); });
    const script = { enabled: true, language: "javascript" as const, timeout: 5, code: "({ request: {url:'{{baseUrl}}/balance', headers:{Authorization:'Bearer {{apiKey}}'}}, extractor: r => ({ remaining:r.balance, unit:'USD', extra:typeof process }) })" };
    expect(await queryProviderUsage(script, { baseUrl: url, apiKey: "usage-key" })).toEqual([{ remaining: 12.5, unit: "USD", extra: "undefined" }]);
  });
});
