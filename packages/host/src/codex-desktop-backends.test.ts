/**
 * CODEX-DESKTOP-SUPERVISION-01 (ADR-0096): a Desktop backend whose bridge is gone keeps native thread
 * writer locks ("thread … already has an active writer"). Reproduced on 2026-11-21: a 0.1.24 wrapper died
 * without stopping its `app-server --listen` child, which survived the Codex update for hours.
 *
 * These tests orphan real processes and pin the safety boundary: a backend whose bridge is alive, a
 * reused PID, or a process without this Host's marker is never signalled.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import {
  backendLeaseDirectory, carriesEndpointMarker, listensAt, reapOrphanedDesktopBackends, recordBackendLease, type ReapDependencies,
} from "./codex-desktop-backends.js";
import { processAlive } from "./codex-desktop-endpoint.js";
import type { ProcessIdentity } from "./owned-processes.js";

const BACKEND = `
if (process.argv.includes("--ignore-term")) process.on("SIGTERM", () => {});
setInterval(() => {}, 1 << 30);
`;

async function fixture() {
  const root = await testDirectory(join(tmpdir(), "orbis-desktop-backends-"));
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const script = join(root, "fake-codex.mjs");
  await writeFile(script, BACKEND);
  const endpoint = join(state, "codex-desktop-endpoint.json");
  const started: number[] = [];
  onTestFinished(() => { for (const pid of started) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  const port = () => 40_000 + Math.floor(Math.random() * 20_000);

  /** A backend whose bridge (a shell) exits right after starting it. */
  async function orphan(options: { marker?: string | null; ignoreTerm?: boolean } = {}): Promise<{ pid: number; bridgePid: number; url: string }> {
    const url = `ws://127.0.0.1:${port()}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ORBIS_CODEX_DESKTOP_ENDPOINT;
    if (options.marker !== null) env.ORBIS_CODEX_DESKTOP_ENDPOINT = options.marker ?? endpoint;
    const args = [script, "app-server", "--listen", url, ...(options.ignoreTerm ? ["--ignore-term"] : [])].map(value => `'${value}'`).join(" ");
    const bridge = spawn("/bin/sh", ["-c", `'${process.execPath}' ${args} >/dev/null 2>&1 & echo $!`], { env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    bridge.stdout!.on("data", chunk => { output += String(chunk); });
    await new Promise(resolve => bridge.once("close", resolve));
    const pid = Number(output.trim());
    started.push(pid);
    await vi.waitFor(() => expect(processAlive(pid)).toBe(true));
    return { pid, bridgePid: bridge.pid!, url };
  }

  /** A backend whose bridge stays alive as its parent. */
  async function bridged(): Promise<{ bridge: ChildProcess; pid: number; url: string }> {
    const url = `ws://127.0.0.1:${port()}`;
    const bridge = spawn(process.execPath, ["-e", `
      const child = require("node:child_process").spawn(process.execPath, ${JSON.stringify([script, "app-server", "--listen", url])}, { stdio: "ignore", env: { ...process.env, ORBIS_CODEX_DESKTOP_ENDPOINT: ${JSON.stringify(endpoint)} } });
      console.log(child.pid); setInterval(() => {}, 1 << 30);`], { stdio: ["ignore", "pipe", "ignore"] });
    started.push(bridge.pid!);
    const pid = await new Promise<number>(resolve => bridge.stdout!.once("data", chunk => resolve(Number(String(chunk).trim()))));
    started.push(pid);
    return { bridge, pid, url };
  }
  return { root, endpoint, orphan, bridged };
}

describe("ownership evidence", () => {
  it("matches only an app-server listening at exactly the leased URL", () => {
    expect(listensAt("/A/codex -c x=1 app-server --analytics-default-enabled --listen ws://127.0.0.1:52641", "ws://127.0.0.1:52641")).toBe(true);
    expect(listensAt("/A/codex app-server --listen ws://127.0.0.1:526410", "ws://127.0.0.1:52641")).toBe(false);
    expect(listensAt("/A/codex resume x --remote ws://127.0.0.1:52641", "ws://127.0.0.1:52641")).toBe(false);
  });

  it("requires this Host's exact endpoint path as a whole environment entry", () => {
    const endpoint = "/Users/x/.orbis/codex-desktop-endpoint.json";
    expect(carriesEndpointMarker(`codex app-server PATH=/bin ORBIS_CODEX_DESKTOP_ENDPOINT=${endpoint} HOME=/Users/x`, endpoint)).toBe(true);
    expect(carriesEndpointMarker(`codex ORBIS_CODEX_DESKTOP_ENDPOINT=${endpoint}.other`, endpoint)).toBe(false);
    expect(carriesEndpointMarker("codex ORBIS_CODEX_DESKTOP_ENDPOINT=/Users/y/.orbis/codex-desktop-endpoint.json", endpoint)).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("reaping orphaned Desktop backends", () => {
  it("stops a leased backend whose bridge has exited and releases its lease", async () => {
    const f = await fixture();
    const backend = await f.orphan({ marker: null });
    recordBackendLease(f.endpoint, { schema: 1, instanceId: "11111111-1111-4111-8111-111111111111", codexPid: backend.pid, bridgePid: backend.bridgePid, url: backend.url, startedAt: new Date().toISOString() });
    const result = await reapOrphanedDesktopBackends(f.endpoint, { graceMs: 2_000 });
    expect(result).toEqual({ stopped: [backend.pid], remaining: [] });
    expect(processAlive(backend.pid)).toBe(false);
    expect(existsSync(join(backendLeaseDirectory(f.endpoint), "11111111-1111-4111-8111-111111111111.json"))).toBe(false);
  });

  it("escalates to SIGKILL when the orphan ignores SIGTERM", async () => {
    const f = await fixture();
    const backend = await f.orphan({ marker: null, ignoreTerm: true });
    recordBackendLease(f.endpoint, { schema: 1, instanceId: "33333333-3333-4333-8333-333333333333", codexPid: backend.pid, bridgePid: backend.bridgePid, url: backend.url, startedAt: new Date().toISOString() });
    const signals: string[] = [];
    const result = await reapOrphanedDesktopBackends(f.endpoint, { graceMs: 300, dependencies: { signal: (pid, signal) => { signals.push(signal); process.kill(pid, signal); } } });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.stopped).toEqual([backend.pid]);
  });

  // Released wrappers wrote no lease; their last descriptor still names the backend.
  it("stops the backend named by a dead previous endpoint descriptor", async () => {
    const f = await fixture();
    const backend = await f.orphan({ marker: null });
    await writeFile(f.endpoint, JSON.stringify({ schema: 1, url: backend.url, codexPid: backend.pid, bridgePid: backend.bridgePid, startedAt: new Date().toISOString() }));
    expect((await reapOrphanedDesktopBackends(f.endpoint, { graceMs: 2_000 })).stopped).toEqual([backend.pid]);
  });

  it("never signals a backend whose bridge is alive, or a reused PID", async () => {
    const f = await fixture();
    const live = await f.bridged();
    const bridgePid = live.bridge.pid!;
    recordBackendLease(f.endpoint, { schema: 1, instanceId: "44444444-4444-4444-8444-444444444444", codexPid: live.pid, bridgePid, url: live.url, startedAt: new Date().toISOString() });
    // This test process does not listen at the leased URL: a reused PID, whatever its parent.
    recordBackendLease(f.endpoint, { schema: 1, instanceId: "55555555-5555-4555-8555-555555555555", codexPid: process.pid, bridgePid: 0x7ffffff0, url: "ws://127.0.0.1:1", startedAt: new Date().toISOString() });
    const signal = vi.fn();
    expect(await reapOrphanedDesktopBackends(f.endpoint, { dependencies: { signal } })).toEqual({ stopped: [], remaining: [] });
    expect(signal).not.toHaveBeenCalled();
    expect(processAlive(live.pid)).toBe(true);
    expect(existsSync(join(backendLeaseDirectory(f.endpoint), "44444444-4444-4444-8444-444444444444.json"))).toBe(true);
    expect(existsSync(join(backendLeaseDirectory(f.endpoint), "55555555-5555-4555-8555-555555555555.json"))).toBe(false);
  });

  // Orphans of wrappers that wrote neither lease nor a surviving descriptor (the 2026-11-21 case).
  it.runIf(process.platform === "darwin")("stops an unrecorded orphan only when it carries this Host's endpoint", async () => {
    const f = await fixture();
    const ours = await f.orphan();
    const other = await f.orphan({ marker: join(f.root, "other-host", "codex-desktop-endpoint.json") });
    const unmarked = await f.orphan({ marker: null });
    await vi.waitFor(() => expect(Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(ours.pid)]).toString().trim())).toBe(1));
    expect((await reapOrphanedDesktopBackends(f.endpoint, { graceMs: 2_000 })).stopped).toEqual([ours.pid]);
    expect(processAlive(other.pid)).toBe(true);
    expect(processAlive(unmarked.pid)).toBe(true);
  });
});

describe("reaping on Windows", () => {
  const row = (pid: number, parent: number, started: string, executable = "C:\\codex.exe"): ProcessIdentity => ({ pid, parent, started, executable });

  it("does not read the process table when nothing could be orphaned", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-desktop-backends-win-"));
    const table = vi.fn(async () => [] as ProcessIdentity[]);
    await expect(reapOrphanedDesktopBackends(join(root, "codex-desktop-endpoint.json"), { dependencies: { platform: "win32", table } }))
      .resolves.toEqual({ stopped: [], remaining: [] });
    expect(table).not.toHaveBeenCalled();
  });

  // Windows keeps the dead parent's PID; a newer process with that PID is not the bridge.
  it("treats a reused bridge PID as gone and stops the leased backend", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-desktop-backends-win-"));
    const endpoint = join(root, "codex-desktop-endpoint.json");
    recordBackendLease(endpoint, { schema: 1, instanceId: "66666666-6666-4666-8666-666666666666", codexPid: 700, bridgePid: 600, url: "ws://127.0.0.1:52641", startedAt: new Date().toISOString() });
    let rows = [row(600, 4, "200", "C:\\Windows\\notepad.exe"), row(700, 600, "100")];
    const signal = vi.fn((pid: number) => { rows = rows.filter(entry => entry.pid !== pid); });
    const dependencies: Partial<ReapDependencies> = { platform: "win32", table: async () => rows,
      command: async pid => pid === 700 ? "C:\\codex.exe app-server --listen ws://127.0.0.1:52641" : "", signal, wait: async () => {} };
    expect(await reapOrphanedDesktopBackends(endpoint, { dependencies })).toEqual({ stopped: [700], remaining: [] });
    expect(signal).toHaveBeenCalledExactlyOnceWith(700, "SIGTERM");
    // With its real bridge alive (created before the backend), nothing is signalled.
    recordBackendLease(endpoint, { schema: 1, instanceId: "77777777-7777-4777-8777-777777777777", codexPid: 700, bridgePid: 600, url: "ws://127.0.0.1:52641", startedAt: new Date().toISOString() });
    rows = [row(600, 4, "50", "C:\\node.exe"), row(700, 600, "100")];
    signal.mockClear();
    expect(await reapOrphanedDesktopBackends(endpoint, { dependencies })).toEqual({ stopped: [], remaining: [] });
    expect(signal).not.toHaveBeenCalled();
  });
});
