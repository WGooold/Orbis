import { describe, expect, it } from "vitest";
import { AgentTaskInventorySchema } from "@orbis/protocol";
import { CodexAgentTasks, codexChildThread } from "./codex-agent-tasks.js";

// Verify generated Codex 0.165 native collaboration records, not tool names/output heuristics.
const collab = (states: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "collabAgentToolCall", id: "call", tool: "spawnAgent", status: "completed", senderThreadId: "parent",
  receiverThreadIds: Object.keys(states), agentsStates: Object.fromEntries(Object.entries(states).map(([id, status]) => [id, { status, message: "private result" }])),
  prompt: "private instructions", model: "private model", reasoningEffort: "high", ...extra,
});

describe("Codex native child tasks", () => {
  it("maps native agent status without treating a completed collaboration call as child completion", () => {
    const tasks = new CodexAgentTasks("parent");
    tasks.observeItem(collab({ a: "pendingInit", b: "running", c: "completed", d: "errored", e: "shutdown", f: "notFound", g: "interrupted" }));
    expect(tasks.snapshot()).toEqual({ availability: "unknown", truncated: true, items: [
      ["a", "pending"], ["b", "running"], ["c", "completed"], ["d", "failed"], ["e", "killed"], ["f", "unknown"], ["g", "idle"],
    ].map(([id, status]) => ({ id, title: id, kind: "subagent", status })) });
    expect(AgentTaskInventorySchema.safeParse(tasks.snapshot()).success).toBe(true);
    expect(JSON.stringify(tasks.snapshot())).not.toMatch(/private|prompt|message|model|reasoningEffort/);
    tasks.observeItem(collab({}, { tool: "wait", receiverThreadIds: ["b"] }));
    expect(tasks.snapshot().items.find(task => task.id === "b")?.status).toBe("running");
  });

  it("keeps independent nested identities and only uses native short display fields", () => {
    const tasks = new CodexAgentTasks("parent");
    tasks.observeThread({ id: "a", parentThreadId: "parent", agentNickname: "Ada", agentRole: "worker", status: { type: "active", activeFlags: [] } });
    tasks.observeItem(collab({ b: "running" }, { senderThreadId: "a" }));
    tasks.observeStatus("b", { type: "active", activeFlags: ["waitingOnUserInput"] });
    expect(tasks.snapshot().items).toEqual([
      { id: "a", title: "Ada", kind: "worker", status: "running" },
      { id: "b", parentId: "a", title: "b", kind: "subagent", status: "waiting" },
    ]);
    tasks.observeStatus("a", { type: "idle" });
    expect(tasks.snapshot().items[0]?.status).toBe("idle");
    expect(tasks.snapshot().items[1]?.status).toBe("waiting");
    tasks.observeItem(collab({ b: "completed" }, { tool: "wait", senderThreadId: "parent" }));
    expect(tasks.snapshot().items[1]?.parentId).toBe("a");
  });

  it("supports legacy subagent source spellings without matching ordinary fork ancestry", () => {
    for (const key of ["subagent", "subAgent"]) expect(codexChildThread({ id: "a", source: { [key]: { thread_spawn: { parent_thread_id: "parent", agent_nickname: "Ada", agent_role: "worker" } } } })).toMatchObject({ id: "a", parentId: "parent", title: "Ada", kind: "worker" });
    expect(codexChildThread({ id: "a", forkedFromId: "parent", source: "cli" })).toBeUndefined();
  });

  it("replays explicit activity lifecycle but keeps omitted children and stale last-known evidence", () => {
    const tasks = new CodexAgentTasks("parent");
    tasks.observeItem(collab({ a: "running" }));
    tasks.replay([{ items: [{ type: "subAgentActivity", id: "event", agentThreadId: "b", agentPath: "root/b", kind: "completed" }] }]);
    expect(tasks.snapshot().items.map(task => [task.id, task.status])).toEqual([["a", "running"], ["b", "completed"]]);
    expect(tasks.replay([])).toBeUndefined();
    expect(tasks.stale()).toMatchObject({ availability: "unknown", truncated: false, items: [{ id: "a", status: "running" }, { id: "b", status: "completed" }] });
    tasks.observeStatus("a", { type: "notLoaded" });
    expect(tasks.snapshot()).toMatchObject({ availability: "unknown", truncated: true, items: [{ id: "a", status: "unknown" }, { id: "b", status: "unknown" }] });
  });

  it("keeps live completion over older persistence but accepts later native lifecycle records", () => {
    const tasks = new CodexAgentTasks("parent");
    tasks.observeItem(collab({ a: "completed" }));
    tasks.replay([{ items: [collab({ a: "running" })] }]);
    expect(tasks.snapshot().items[0]?.status).toBe("completed");
    tasks.observeStatus("a", { type: "idle" });
    expect(tasks.snapshot().items[0]?.status).toBe("completed");
    tasks.replay([{ items: [collab({ a: "running" }, { id: "earlier" })] }]);
    expect(tasks.snapshot().items[0]?.status).toBe("completed");
    tasks.replay([{ items: [collab({ a: "running" }), collab({ a: "running" }, { id: "later", tool: "resumeAgent" })] }]);
    expect(tasks.snapshot().items[0]?.status).toBe("running");
  });

  it("keeps a later native registry resume over the old completed collaboration item", () => {
    const tasks = new CodexAgentTasks("parent");
    tasks.observeItem(collab({ a: "completed" }));
    tasks.observeStatus("a", { type: "active", activeFlags: ["waitingOnApproval"] });
    tasks.replay([{ items: [collab({ a: "completed" })] }]);
    expect(tasks.snapshot().items[0]?.status).toBe("waiting");
  });

  it("does not revive stale status from a receiver-only partial update", () => {
    const tasks = new CodexAgentTasks("parent");
    tasks.observeItem(collab({ a: "running", b: "running" }));
    tasks.stale();
    tasks.observeItem(collab({}, { tool: "wait", receiverThreadIds: ["a"] }));
    expect(tasks.snapshot()).toMatchObject({ availability: "unknown", truncated: true, items: [
      { id: "a", status: "unknown" }, { id: "b", status: "unknown" },
    ] });
  });

  it("bounds inventory and rejects unrepresentable identities instead of truncating them", () => {
    const tasks = new CodexAgentTasks("parent");
    tasks.observeItem(collab(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i).padStart(3, "0"), "running"]))));
    expect(tasks.snapshot().items).toHaveLength(256);
    expect(AgentTaskInventorySchema.safeParse(tasks.snapshot()).success).toBe(true);
    tasks.observeItem(collab({ ["a".repeat(257)]: "running", "   ": "running", parent: "running" }));
    expect(tasks.snapshot().items.every(task => task.id.length <= 256 && task.id !== "parent")).toBe(true);
  });
});
