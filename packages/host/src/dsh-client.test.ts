import { afterEach, describe, expect, it, vi } from "vitest";
import { DshAcpClient } from "./dsh-client.js";

const clients: DshAcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.stop(); });

async function fixture() {
  const script = `
    const readline = require("node:readline");
    const input = readline.createInterface({ input: process.stdin });
    let cancelled;
    const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    input.on("line", line => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") send(frame.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } } });
      if (frame.method === "$/cancel_request") cancelled = frame.params.requestId;
      if (frame.method === "echo") {
        const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "中文", cancelled } }) + "\\n");
        const split = bytes.indexOf(Buffer.from("中")) + 1;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
      }
      if (frame.method === "invalid") process.stdout.write("not JSON\\n");
    });
  `;
  const client = await DshAcpClient.create({ cli: { command: process.execPath, prefixArgs: ["-e", script, "--"] }, timeoutMs: 5000 });
  clients.push(client);
  return client;
}

describe("DSH ACP transport", () => {
  it("decodes UTF-8 across stdout chunks and cancels timed-out reads without losing the connection", async () => {
    const client = await fixture();
    await expect(client.request("session/list", {}, 30)).rejects.toThrow("超时");
    await expect(client.request("echo", {})).resolves.toEqual({ text: "中文", cancelled: 2 });
  });

  it("disconnects after a timed-out mutation so late sessions cannot outlive ownership", async () => {
    const client = await fixture();
    client.onExit = vi.fn();
    await expect(client.request("session/new", {}, 30)).rejects.toThrow("超时");
    expect(client.onExit).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("重启 Host"));
    await expect(client.request("echo", {})).rejects.toThrow("离线");
    await client.stop();
  });

  it("rejects pending work and closes on a malformed frame", async () => {
    const client = await fixture();
    await expect(client.request("invalid", {})).rejects.toThrow("无效的 ACP");
    await expect(client.request("echo", {})).rejects.toThrow("离线");
  });
});
