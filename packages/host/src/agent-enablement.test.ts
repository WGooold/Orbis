import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentKindSchema } from "@orbis/protocol";
import { AgentEnablementController, AgentEnablementStore, AgentLifecycleRegistry, type AgentLifecycleLease } from "./agent-enablement.js";

const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "orbis-agent-enablement-"));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Catalog rows are exhaustive, and an installed or newly added Agent is not implicitly enabled.
it("persists an all-off baseline for every known source", async () => {
  const path = await directory();
  const snapshot = await new AgentEnablementStore(path).read();
  expect(snapshot.agents.map(row => row.kind)).toEqual(AgentKindSchema.options);
  expect(snapshot.agents.every(row => !row.enabled)).toBe(true);
  const reconsider = vi.fn(async () => ({ openclaw: true }));
  expect(await new AgentEnablementStore(path, reconsider).read()).toEqual(snapshot);
  expect(reconsider).not.toHaveBeenCalled();
});

// A stale write from a different client must not commit over a newer Host revision.
it("serializes competing changes and returns committed state on conflict and repeat", async () => {
  const path = await directory();
  const store = new AgentEnablementStore(path, async () => ({ codex: false, claude: true }));
  const [accepted, stale] = await Promise.all([
    store.set({ kind: "pi", enabled: true, expectedRevision: 0 }),
    store.set({ kind: "openclaw", enabled: true, expectedRevision: 0 }),
  ]);
  expect(accepted.status).toBe("applied");
  expect(stale).toEqual({ status: "conflict", snapshot: accepted.snapshot });
  expect(await store.set({ kind: "pi", enabled: true, expectedRevision: 0 })).toEqual({ status: "unchanged", snapshot: accepted.snapshot });
  expect(await new AgentEnablementStore(path).read()).toEqual(accepted.snapshot);
  expect(accepted.snapshot.agents.filter(row => row.enabled).map(row => row.kind)).toEqual(["pi", "claude"]);
});

// An older Host must not erase a newer source's stored preference on a downgrade.
it("preserves unknown choices but never routes or displays them", async () => {
  const path = await directory();
  const file = join(path, "agent-enablement.json");
  await writeFile(file, JSON.stringify({ version: 1, revision: 8, choices: { futureAgent: true } }));
  const store = new AgentEnablementStore(path);
  expect((await store.read()).agents.every(row => !row.enabled)).toBe(true);
  await expect(store.set({ kind: "futureAgent", enabled: true, expectedRevision: 8 })).rejects.toThrow();
  await store.set({ kind: "pi", enabled: true, expectedRevision: 8 });
  expect(JSON.parse(await readFile(file, "utf8")).choices).toEqual({ futureAgent: true, pi: true });
});

// Neither a corrupt record nor a failed save can activate a backend or advertise success.
it("fails closed on load and leaves the applied policy intact on failed save", async () => {
  const path = await directory();
  const file = join(path, "agent-enablement.json");
  await writeFile(file, "invalid");
  const publish = vi.fn();
  const controller = new AgentEnablementController(new AgentEnablementStore(path), publish);
  await expect(controller.read()).rejects.toThrow();
  expect(controller.allows("pi")).toBe(false);
  expect(publish).not.toHaveBeenCalled();
  await rm(file);
  await controller.read();
  await rm(file);
  await mkdir(file); // Make atomic rename deterministically fail, even under an unrestricted test user.
  await expect(controller.set({ kind: "pi", enabled: true, expectedRevision: 0 })).rejects.toThrow();
  expect(controller.allows("pi")).toBe(false);
  expect((await controller.read()).revision).toBe(0);
  expect(publish).toHaveBeenCalledTimes(1);
});

// Disable/re-enable must not admit a late attach from the first generation or disturb siblings.
it("invalidates only the lease belonging to the changed Agent", async () => {
  const path = await directory();
  const publish = vi.fn();
  const controller = new AgentEnablementController(new AgentEnablementStore(path, async () => ({ codex: true, codexDesktop: true })), publish);
  expect(controller.lease("codex")).toBeUndefined();
  await controller.read();
  const terminal = controller.lease("codex")!;
  const desktop = controller.lease("codexDesktop")!;
  await controller.set({ kind: "codexDesktop", enabled: false, expectedRevision: 0 });
  expect(controller.lease("codexDesktop")).toBeUndefined();
  expect(desktop.signal.aborted).toBe(true);
  await controller.set({ kind: "codexDesktop", enabled: true, expectedRevision: 1 });
  expect(desktop.isCurrent()).toBe(false);
  expect(controller.lease("codexDesktop")?.isCurrent()).toBe(true);
  expect(terminal.isCurrent()).toBe(true);
  expect(terminal.signal.aborted).toBe(false);
  expect(publish.mock.calls.map(([snapshot]) => snapshot.revision)).toEqual([0, 1, 2]);
});

// An off/on change must release the old connection before starting a new one, without blocking peers.
it("serializes start and stop only for the affected source and separates pause from preference", async () => {
  const store = new AgentEnablementStore(await directory(), async () => ({ codex: true }));
  const events: string[] = [];
  let resolvePending!: () => void;
  const pending = new Promise<void>(resolve => { resolvePending = resolve; });
  let firstLease: AgentLifecycleLease | undefined;
  const failures = vi.fn();
  const registry = new AgentLifecycleRegistry({
    codex: {
      async start(lease) {
        events.push("codex:start");
        if (firstLease === undefined) { firstLease = lease; await pending; }
        if (lease.isCurrent()) events.push("codex:publish");
      },
      async stop() { events.push("codex:stop"); },
    },
    pi: {
      async start() { events.push("pi:start"); },
      async stop() { events.push("pi:stop"); },
    },
  }, failures);
  const initial = await store.read();
  await registry.reconcile(initial, false);
  expect(events).toEqual([]);
  const opening = registry.reconcile(initial, true);
  const off = await store.set({ kind: "codex", enabled: false, expectedRevision: 0 });
  const closing = registry.reconcile(off.snapshot, true);
  expect(firstLease?.signal.aborted).toBe(true);
  const pi = await store.set({ kind: "pi", enabled: true, expectedRevision: 1 });
  const withPi = registry.reconcile(pi.snapshot, true);
  const on = await store.set({ kind: "codex", enabled: true, expectedRevision: 2 });
  const reopening = registry.reconcile(on.snapshot, true);
  expect(events).toEqual(["codex:start", "pi:start"]);
  resolvePending();
  await Promise.all([opening, closing, withPi, reopening]);
  expect(events).toEqual(["codex:start", "pi:start", "codex:stop", "codex:start", "codex:publish"]);
  await registry.reconcile(on.snapshot, false);
  expect(events.slice(-2)).toEqual(["pi:stop", "codex:stop"]);
  expect(await store.read()).toEqual(on.snapshot);
  expect(failures).not.toHaveBeenCalled();
});
