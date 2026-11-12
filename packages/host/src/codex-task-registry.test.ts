import { describe, expect, it, vi } from "vitest";
import { CodexTaskRegistry } from "./codex-task-registry.js";
import { CodexAgentTasks } from "./codex-agent-tasks.js";

const child = (id: string, parentThreadId = "root", type = "idle") => ({ id, parentThreadId, status: { type }, agentNickname: id });
const support = () => { throw new Error("parentThreadId and ancestorThreadId are mutually exclusive"); };
const completed = (id: string) => ({ id: "event-" + id, type: "subAgentActivity", agentThreadId: id, kind: "completed" });

// SC83: only a stable, bounded, fully paginated native descendant registry can
// unblock completed tasks. Silent legacy field omission and races stay restrictive.
describe("Codex complete task registry", () => {
  it("reads all pages, archived descendants and nested parents before clearing incompleteness", async () => {
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.parentThreadId) return support();
      if (params.archived) return { data: [child("d", "b")] };
      return params.cursor ? { data: [child("b", "a"), child("c")] } : { data: [child("a")], nextCursor: "page2" };
    });
    const registry = new CodexTaskRegistry(request), tasks = new CodexAgentTasks("root");
    for (const id of ["a", "b", "c", "d"]) tasks.observeItem(completed(id));
    await tasks.reconcile(() => registry.read("root"));
    expect(tasks.snapshot()).toMatchObject({ availability: "ready", truncated: false });
    expect(tasks.snapshot().items.map(item => item.status)).toEqual(Array(4).fill("completed"));
    expect(tasks.snapshot().items.find(item => item.id === "d")?.parentId).toBe("b");
    tasks.observeStatus("d", { type: "active", activeFlags: ["waitingOnApproval"] });
    expect(tasks.snapshot()).toMatchObject({ availability: "ready", items: expect.arrayContaining([expect.objectContaining({ id: "d", status: "waiting" })]) });
    tasks.observeItem(completed("e"));
    expect(tasks.snapshot()).toMatchObject({ availability: "unknown", truncated: true });
    expect(request.mock.calls.filter(([, params]) => params.parentThreadId)).toHaveLength(1);
  });

  it("does not trust an old server silently ignoring descendant filters", async () => {
    const request = vi.fn(async () => ({ data: [] })), registry = new CodexTaskRegistry(request);
    const tasks = new CodexAgentTasks("root"); tasks.observeItem(completed("a"));
    await tasks.reconcile(() => registry.read("root"));
    expect(tasks.snapshot()).toMatchObject({ availability: "unknown", truncated: true, items: [{ id: "a" }] });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["cycle", "foreign", "cursor", "malformed", "overflow", "failure", "changed"])("keeps partial evidence on %s", async mode => {
    let scans = 0;
    const registry = new CodexTaskRegistry(async (_method, params) => {
      if (params.parentThreadId) return support();
      if (params.archived) return { data: [] };
      scans++;
      if (mode === "failure") throw new Error("offline");
      if (mode === "cycle") return { data: [child("a", "b"), child("b", "a")] };
      if (mode === "foreign") return { data: [child("a", "other")] };
      if (mode === "cursor") return { data: [], nextCursor: "repeat" };
      if (mode === "malformed") return { data: [], nextCursor: 7 };
      if (mode === "overflow") return { data: Array.from({ length: 257 }, (_, i) => child(String(i))) };
      return { data: scans === 1 ? [child("a")] : [child("a"), child("new")] };
    });
    const tasks = new CodexAgentTasks("root"); tasks.observeItem(completed("a"));
    await tasks.reconcile(() => registry.read("root"));
    expect(tasks.snapshot()).toMatchObject({ availability: "unknown", truncated: true, items: [{ id: "a", status: "completed" }] });
  });

  it("invalidates in-flight reconciliation on new lifecycle or disconnect, and retries cleanly", async () => {
    const tasks = new CodexAgentTasks("root"); tasks.observeItem(completed("a"));
    let resolve!: (rows: unknown[]) => void;
    const pending = tasks.reconcile(() => new Promise<unknown[]>(done => { resolve = done; }));
    tasks.observeStatus("a", { type: "active" }); resolve([child("a")]); await pending;
    expect(tasks.snapshot()).toMatchObject({ availability: "unknown", items: [{ status: "running" }] });
    await tasks.reconcile(async () => [child("a", "root", "active")]);
    expect(tasks.snapshot()).toMatchObject({ availability: "ready", items: [{ status: "running" }] });
    const disconnected = tasks.reconcile(() => new Promise<unknown[]>(done => { resolve = done; }));
    tasks.stale(); resolve([child("a")]); await disconnected;
    expect(tasks.snapshot().availability).toBe("unknown");
    await tasks.reconcile(async () => [child("a")]);
    expect(tasks.snapshot()).toMatchObject({ availability: "ready", items: [{ status: "idle" }] });
    await tasks.reconcile(async () => { throw new Error("offline"); });
    expect(tasks.snapshot().availability).toBe("unknown");
  });

  it("keeps known missing ephemeral children and unknown lifecycles restrictive", async () => {
    const tasks = new CodexAgentTasks("root"); tasks.observeItem(completed("ephemeral"));
    await tasks.reconcile(async () => []);
    expect(tasks.snapshot()).toMatchObject({ availability: "unknown", truncated: true, items: [{ id: "ephemeral" }] });
    const fresh = new CodexAgentTasks("root");
    await fresh.reconcile(async () => [child("a", "root", "notLoaded")]);
    expect(fresh.snapshot()).toMatchObject({ availability: "ready", truncated: false, items: [{ status: "unknown" }] });
  });
});
