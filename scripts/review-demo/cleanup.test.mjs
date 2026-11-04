import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cleanupReviewResources, stopSpawnedAgents } from "./cleanup.mjs";

function tracked(child) {
  return { get running() {
    return child.exitCode === null && child.signalCode === null ? [{ pid: child.pid }] : [];
  } };
}

function killIfAlive(pid) {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function message(child) {
  let output = "";
  let errors = "";
  const readError = data => { errors += data; };
  child.stderr.on("data", readError);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`Review child did not become ready: ${errors}`)), 5_000);
      const exited = code => done(new Error(`Review child exited ${code}: ${errors}`));
      const read = data => {
        output += data;
        if (output.includes("\n")) {
          try { done(undefined, JSON.parse(output.split("\n")[0])); }
          catch (error) { done(error); }
        }
      };
      const done = (error, value) => {
        clearTimeout(timer);
        child.stdout.off("data", read);
        child.off("exit", exited);
        if (error) reject(error); else resolve(value);
      };
      child.once("exit", exited);
      child.stdout.on("data", read);
    });
  } finally { child.stderr.off("data", readError); }
}

async function acceptsConnection(port) {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

it.each([true, false])("reaps an owned process tree (root ignores SIGTERM: %s), releases its directory and preserves an unrelated process", async ignoreTerm => {
  const dir = await mkdtemp(join(tmpdir(), "orbis-review-cleanup-"));
  const childCode = `
    const server = require('node:net').createServer();
    process.on('SIGTERM', () => {});
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
  `;
  const rootCode = `
    const { spawn } = require('node:child_process');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    child.stdout.pipe(process.stdout);
    setInterval(() => {}, 1000);
  `;
  const root = spawn(process.execPath, ["-e", rootCode], { cwd: dir, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  const siblingClosed = once(sibling, "close");
  const rootClosed = once(root, "close");
  const spawner = tracked(root);
  let descendant;
  try {
    descendant = await message(root);
    expect(await acceptsConnection(descendant.port)).toBe(true);
    await stopSpawnedAgents(spawner, { graceMs: 100 });
    await rootClosed;
    await vi.waitFor(async () => expect(await acceptsConnection(descendant.port)).toBe(false));
    expect(spawner.running).toEqual([]);
    expect(() => process.kill(sibling.pid, 0)).not.toThrow();
    await rm(dir, { recursive: true, maxRetries: 10, retryDelay: 100 });
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    console.info("Verified review process cleanup", JSON.stringify({ root: root.pid, descendant: descendant.pid, unrelated: sibling.pid }));
  } finally {
    try {
      await stopSpawnedAgents(spawner, { graceMs: 0 });
      // The descendant is also ours; ensure an assertion failure cannot orphan it.
      if (descendant) {
        killIfAlive(descendant.pid);
      }
    } finally {
      sibling.kill("SIGKILL");
      await siblingClosed;
      await rootClosed;
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}, 20_000);

it("uses Windows tree termination for the positive owned PID and waits for its exit", async () => {
  let agents = [{ pid: 987654 }];
  const spawner = { get running() { return agents; } };
  const kill = vi.fn(() => { throw new Error("POSIX kill must not be used on Windows"); });
  const run = vi.fn(async (command, args) => {
    expect(command).toMatch(/\\System32\\taskkill\.exe$/u);
    expect(args).toEqual(["/PID", "987654", "/T", "/F"]);
    setTimeout(() => { agents = []; }, 25);
  });
  await stopSpawnedAgents(spawner, { platform: "win32", run, kill });
  expect(spawner.running).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
  expect(kill).not.toHaveBeenCalled();
});

it("reports a failed Windows tree termination and a remaining process", async () => {
  const failure = Object.assign(new Error("taskkill denied"), { code: 1 });
  const spawner = { running: [{ pid: 987654 }] };
  try {
    await stopSpawnedAgents(spawner, { platform: "win32", run: async () => { throw failure; }, forceMs: 0 });
    expect.fail("A live process must fail cleanup");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(failure);
    expect(error.errors.some(item => item.message.includes("987654"))).toBe(true);
  }
});

it("rejects unsafe process identifiers before issuing any termination", async () => {
  const run = vi.fn();
  const kill = vi.fn();
  for (const pid of [0, -1, 1.5, process.pid]) {
    await expect(stopSpawnedAgents({ running: [{ pid }] }, { run, kill })).rejects.toThrow("Invalid owned review process PID");
  }
  expect(run).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
});

it("drains fixture state before an awaited cleanup and closes remaining resources after failures", async () => {
  const closed = [];
  const state = {
    dir: "/fixture-must-be-retained",
    spawner: { running: [{ pid: 987654 }] },
    devices: [{ close: () => { closed.push("first device"); throw new Error("device failed"); } }, { close: () => closed.push("second device") }],
    portal: { close: () => closed.push("portal") },
    host: { stop: () => closed.push("Host") },
    relay: { close: () => closed.push("Relay") },
    pairing: { dispose: () => closed.push("pairing") },
  };
  const remove = vi.fn();
  const stopAgents = async () => {
    expect(state).toEqual({});
    throw new Error("owned process is still running");
  };
  const outcome = cleanupReviewResources(state, { stopAgents, remove }).catch(error => error);
  expect(state).toEqual({});
  const error = await outcome;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map(item => item.message)).toEqual([
    "review agents cleanup failed", "device cleanup failed", "Retained directory for live review processes: /fixture-must-be-retained",
  ]);
  expect(closed).toEqual(["first device", "second device", "portal", "Host", "Relay", "pairing"]);
  expect(remove).not.toHaveBeenCalled();
  await cleanupReviewResources(state);
  expect(closed).toHaveLength(6);
});

it("retains directory-removal failures while leaving the next fixture clean", async () => {
  const state = { dir: "/fixture", pairing: { dispose: vi.fn() } };
  const failure = Object.assign(new Error("directory is locked"), { code: "EBUSY" });
  const outcome = await cleanupReviewResources(state, { remove: async () => { throw failure; } }).catch(error => error);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome.errors[0].cause).toBe(failure);
  expect(state).toEqual({});
  await expect(cleanupReviewResources(state)).resolves.toBeUndefined();
});
