import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Only terminate roots recorded by this isolated fixture's SessionSpawner. */
export async function stopSpawnedAgents(spawner, {
  platform = process.platform,
  run = execute,
  kill = process.kill.bind(process),
  graceMs = 5_000,
  forceMs = 5_000,
} = {}) {
  if (!spawner) return;
  const roots = spawner.running.map(agent => agent.pid);
  for (const pid of roots) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      throw new Error(`Invalid owned review process PID: ${pid}`);
    }
  }
  const owned = new Set(roots);
  const remaining = () => spawner.running.filter(agent => owned.has(agent.pid));
  const pending = () => {
    const pids = new Set(remaining().map(agent => agent.pid));
    if (platform !== "win32") {
      // A root may exit on SIGTERM while its child keeps running in the group.
      for (const pid of roots) {
        try { kill(-pid, 0); pids.add(pid); }
        catch (error) {
          if (error?.code === "EPERM") pids.add(pid);
          else if (error?.code !== "ESRCH") throw error;
        }
      }
    }
    return [...pids];
  };
  const errors = [];
  const wait = async milliseconds => {
    const deadline = Date.now() + milliseconds;
    while (pending().length && Date.now() < deadline) await delay(25);
  };
  const terminate = async (pid, signal) => {
    try {
      if (platform === "win32") {
        // Negative PIDs are POSIX process groups, not Windows process trees.
        // Pin the executable and PID; never kill by image name or invoke a shell.
        await run(win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
      } else {
        kill(-pid, signal);
      }
    } catch (error) {
      // A concurrent normal exit is harmless; permission and tool errors on a
      // still-running owned process must be reported, not treated as an exit.
      if (error?.code !== "ESRCH" && pending().includes(pid)) errors.push(error);
    }
  };

  await Promise.all(roots.map(pid => terminate(pid, "SIGTERM")));
  await wait(platform === "win32" ? forceMs : graceMs);
  if (platform !== "win32" && pending().length) {
    await Promise.all(pending().map(pid => terminate(pid, "SIGKILL")));
    await wait(forceMs);
  }
  if (pending().length) errors.push(new Error(`Review processes did not exit: ${pending().join(", ")}`));
  if (errors.length) throw new AggregateError(errors, "Review process cleanup failed");
}

/** Drain state before awaiting, close every resource, and retain all failures. */
export async function cleanupReviewResources(state, {
  stopAgents = stopSpawnedAgents,
  remove = rm,
} = {}) {
  const resources = { ...state };
  for (const key of Object.keys(state)) delete state[key];
  const errors = [];
  const attempt = async (name, action) => {
    try { await action(); return true; }
    catch (cause) { errors.push(new Error(`${name} cleanup failed`, { cause })); return false; }
  };
  const agentsStopped = await attempt("review agents", () => stopAgents(resources.spawner));
  for (const device of new Set([resources.device, ...(resources.devices ?? [])].filter(Boolean))) {
    await attempt("device", () => device.close());
  }
  await attempt("portal", () => resources.portal?.close());
  await attempt("Host", () => resources.host?.stop());
  await attempt("Relay", () => resources.relay?.close());
  for (const pairing of new Set([resources.pairing, ...(resources.pairings ?? [])].filter(Boolean))) {
    await attempt("pairing", () => pairing.dispose());
  }
  if (resources.dir && agentsStopped) {
    // Windows can release file handles just after the child exit event.
    await attempt(`temporary directory ${resources.dir}`, () => remove(resources.dir,
      { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  } else if (resources.dir) {
    errors.push(new Error(`Retained directory for live review processes: ${resources.dir}`));
  }
  if (errors.length) throw new AggregateError(errors, "Review fixture cleanup failed");
}
