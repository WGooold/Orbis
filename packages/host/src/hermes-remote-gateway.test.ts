import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  attachRemoteHermesGateway,
  hermesRemoteAttachSshArgs,
  hermesRemoteTunnelSshArgs,
  loadHermesRemoteGatewayConfig,
  parseHermesRemoteAttachResult,
  saveHermesRemoteGatewaySettings,
  validateHermesRemoteGatewayConfig,
} from "./hermes-remote-gateway.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function stateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "orbis-hermes-remote-test-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

const endpoint = {
  profile_id: "/home/hermes/.hermes",
  instance_id: "remote-owner",
  authority_epoch: 2,
  runtime_protocol: 1,
  api_origin: "http://127.0.0.1:43120",
  supervisor: "service",
  capabilities: ["session-authority-v1"],
};
function attached(url = "ws://127.0.0.1:43120/api/ws") {
  return JSON.stringify({ state: "ready", endpoint, protocol: "hermes-gateway-v1", url,
    protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.single-use_ticket"] });
}

// HERMES-REMOTE-01: remote service access stays inside SSH and never disables host-key checks.
test("validates SSH target, profile and environment configuration without shell metacharacters", async () => {
  expect(validateHermesRemoteGatewayConfig({ host: "orbis@hermes-box", port: 2222, profile: "work-1" }))
    .toEqual({ host: "orbis@hermes-box", port: 2222, profile: "work-1" });
  for (const host of ["-oProxyCommand=evil", "-oProxyCommand=evil@hermes-box", "user@remote;id", "remote host", "user@host$(id)"]) {
    expect(() => validateHermesRemoteGatewayConfig({ host })).toThrow();
  }
  const args = hermesRemoteAttachSshArgs({ host: "hermes-box", port: 2222 });
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args).toContain("BatchMode=yes");
  expect(args.at(-1)).toBe("hermes gateway attach --json");
  expect(hermesRemoteAttachSshArgs({ host: "hermes-box", port: 22, profile: "work" }).at(-1))
    .toBe("hermes --profile=work gateway attach --json");

  const dir = await stateDir();
  expect(await loadHermesRemoteGatewayConfig(dir, {})).toBeUndefined();
  const saved = await saveHermesRemoteGatewaySettings(dir, "hermes-box", 2222, "work", {});
  expect(saved).toEqual({ source: "file", host: "hermes-box", port: 2222, profile: "work", invalid: false });
  const path = join(dir, "hermes-remote-gateway.json");
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ host: "hermes-box", port: 2222, profile: "work" });
  expect(await loadHermesRemoteGatewayConfig(dir, { ORBIS_HERMES_SSH_HOST: "remote", ORBIS_HERMES_SSH_PORT: "2200" }))
    .toEqual({ host: "remote", port: 2200 });
  expect(await loadHermesRemoteGatewayConfig(dir, { ORBIS_HERMES_SSH_HOST: "" })).toBeUndefined();
  await expect(saveHermesRemoteGatewaySettings(dir, "remote", 22, "", { ORBIS_HERMES_SSH_HOST: "remote" })).rejects.toThrow(/环境变量/);
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await expect(loadHermesRemoteGatewayConfig(dir, {})).rejects.toThrow(/private regular file/);
  }
});

// HERMES-REMOTE-01: remote attach credentials are accepted only for a loopback owner endpoint.
test("parses attach ticket and binds its URL to the reported owner identity", () => {
  const parsed = parseHermesRemoteAttachResult(attached());
  expect(parsed.endpoint.profile_id).toBe(endpoint.profile_id);
  expect(parsed.protocols[1]).toMatch(/^hermes-gateway-ticket\./u);
  expect(() => parseHermesRemoteAttachResult(attached("ws://example.com:43120/api/ws"))).toThrow(/本机 Gateway/);
  expect(() => parseHermesRemoteAttachResult(attached("ws://127.0.0.1:43121/api/ws"))).toThrow(/身份不匹配/);
  expect(() => parseHermesRemoteAttachResult(JSON.stringify({ state: "absent" }))).toThrow(/未就绪/);
  const invalid = JSON.parse(attached()) as Record<string, any>;
  invalid.protocols[1] = "hermes-gateway-ticket.bad ticket";
  expect(() => parseHermesRemoteAttachResult(JSON.stringify(invalid))).toThrow(/协议无效/);
});

// HERMES-REMOTE-01: the SSH forward is owned by this connection and released on close/failure.
test("creates a private WebSocket forward from the single-use remote attach ticket", async () => {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean };
  child.exitCode = null; child.signalCode = null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => { child.signalCode = signal ?? "SIGTERM"; child.emit("close", null, child.signalCode); return true; });
  const spawnTunnel = vi.fn((args: string[]) => {
    expect(args).toEqual(hermesRemoteTunnelSshArgs({ host: "user@hermes-box", port: 2222 }, 41414, "127.0.0.1", 43120));
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as Pick<ChildProcess, "exitCode" | "signalCode" | "kill" | "once" | "off">;
  });
  const connect = vi.fn(async () => {});
  const result = await attachRemoteHermesGateway({ host: "user@hermes-box", port: 2222 }, {
    runAttach: async () => attached(),
    allocatePort: async () => 41414,
    spawnTunnel,
    connect,
  });
  expect(result.url).toBe("ws://127.0.0.1:41414/api/ws");
  expect(result.protocols[1]).toBe("hermes-gateway-ticket.single-use_ticket");
  expect(spawnTunnel).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledWith(result.url);
  await result.close();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});
