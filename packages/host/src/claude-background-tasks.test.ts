import { describe, expect, it, vi } from "vitest";
import { AgentTaskInventorySchema, agentTasksAllowQuit, type RuntimeEvent } from "@orbis/protocol";
import { CLAUDE_BRIDGE_CAPABILITIES, ClaudeModsBridge } from "./claude-mods-bridge.js";
import { ClaudeSessionHistory } from "./claude-session-history.js";
import { ClaudeHookBridge } from "./claude-hook-bridge.js";
import type { ClaudeProcessIdentity } from "./claude-process.js";

function fixture(beforeTerminate?: (isCurrent: () => boolean) => Promise<void>) {
  const events: RuntimeEvent[] = [];
  const terminate = vi.fn(async (_identity: ClaudeProcessIdentity, isCurrent: () => boolean) => { await beforeTerminate?.(isCurrent); });
  const toolFinished = vi.fn(), taskFinished = vi.fn();
  const bridge = new ClaudeModsBridge({
    createHistory: (id, config, publish) => new ClaudeSessionHistory(id, config, publish, { locate: async () => undefined }),
    processControl: { capture: async pid => ({ pid, started: "start", executable: "claude", command: "claude" }), terminate },
    onEvent: (_id, event) => events.push(event), onToolFinished: toolFinished, onTaskTurnFinished: taskFinished,
  });
  const hello = { type: "hello", instanceId: "instance", sessionId: "parent", cwd: "/repo", claudeVersion: "2.1.317",
    bridgeVersion: "4", interactive: true, capabilities: CLAUDE_BRIDGE_CAPABILITIES, processId: 4242 };
  const connected = bridge.hello(hello);
  if (!connected.ok) throw new Error(connected.error);
  const send = (event: unknown) => bridge.receiveEvent(connected.runtimeId, connected.generation, event);
  const tasks = (items: unknown[], availability = "ready", truncated = false) => send({ type: "tasks.snapshot", tasks: { availability, items, truncated } });
  return { bridge, events, terminate, toolFinished, taskFinished, hello, connected, send, tasks };
}
const child = (id: string, status = "running", parentId?: string) => ({ id, title: "检查代码", kind: "Explore", status, ...(parentId ? { parentId } : {}) });

describe("Claude background tasks (ADR-0062)", () => {
  it("keeps main input idle and available while distinct nested children work, and main completion leaves them intact", async () => {
    const f = fixture();
    try {
      f.tasks([child("a"), child("b", "waiting", "a")]);
      expect(f.bridge.statusOf(f.connected.runtimeId)).toBe("idle");
      expect(f.bridge.sendCommand(f.connected.runtimeId, "message", { type: "user_message", text: "next" })).toBe("accepted");
      f.send({ type: "turn.start", turnId: "main" });
      f.send({ type: "task.turn.finished", agentId: "a" });
      expect(f.bridge.statusOf(f.connected.runtimeId)).toBe("running");
      f.send({ type: "turn.complete", turnId: "main" });
      expect(f.bridge.statusOf(f.connected.runtimeId)).toBe("idle");
      f.bridge.announce(f.connected.runtimeId);
      expect(f.events.filter(e => e.type === "execution.tasks").at(-1)).toMatchObject({ tasks: { items: [child("a"), child("b", "waiting", "a")] } });
      expect(f.bridge.runtimeIds()).toEqual(["claude:parent"]);
    } finally { f.bridge.close(); }
  });

  it("retains last inventory on unknown, forbids unsafe close, rejects malformed and old-generation inventories", async () => {
    const f = fixture();
    try {
      await Promise.resolve();
      expect(f.bridge.hasCommand(f.connected.runtimeId, "quit")).toBe(false);
      f.tasks([child("a")]);
      await expect(f.bridge.quit(f.connected.runtimeId)).rejects.toThrow("子任务");
      f.tasks([], "unknown");
      expect(f.events.filter(e => e.type === "execution.tasks").at(-1)).toMatchObject({ tasks: { availability: "unknown", items: [child("a")] } });
      expect(f.tasks([child("a"), child("a")])).toBe("invalid");
      f.tasks([child("a", "completed")]);
      expect(f.bridge.hasCommand(f.connected.runtimeId, "quit")).toBe(true);
      expect(await f.bridge.receiveRequestWithBoundaries({ runtimeId: f.connected.runtimeId, generation: f.connected.generation,
        event: { type: "tasks.snapshot", tasks: { availability: "ready", items: [child("a"), child("a")], truncated: false } } })).toBe("invalid");
      expect(f.bridge.hasCommand(f.connected.runtimeId, "quit")).toBe(false);
      f.tasks([]);
      f.bridge.announce(f.connected.runtimeId);
      expect(f.events.filter(e => e.type === "execution.tasks").at(-1)).toMatchObject({ tasks: { availability: "ready", items: [] } });
      f.tasks([child("last-known")]);
      const next = f.bridge.hello(f.hello);
      expect(next.ok).toBe(true);
      expect(f.events.filter(e => e.type === "execution.tasks").at(-1)).toMatchObject({ tasks: { availability: "unknown", items: [child("last-known")] } });
      expect(f.tasks([])).toBe("stale");
      expect(f.bridge.hasCommand(f.connected.runtimeId, "quit")).toBe(false);
      expect(f.terminate).not.toHaveBeenCalled();
    } finally { f.bridge.close(); }
  });

  it("expires stale task evidence even while the main runtime remains connected", async () => {
    const f = fixture();
    try {
      await Promise.resolve(); f.tasks([]);
      expect(f.bridge.hasCommand(f.connected.runtimeId, "quit")).toBe(true);
      f.bridge.expireStale(Date.now() + 5_001);
      expect(f.bridge.isOnline(f.connected.runtimeId)).toBe(true);
      expect(f.bridge.hasCommand(f.connected.runtimeId, "quit")).toBe(false);
      await expect(f.bridge.quit(f.connected.runtimeId)).rejects.toThrow("子任务");
    } finally { f.bridge.close(); }
  });

  it("rechecks new background work after asynchronous process identity verification", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async isCurrent => { await gate; if (!isCurrent()) throw new Error("close invalidated"); });
    try {
      await Promise.resolve(); f.tasks([]);
      const close = f.bridge.quit(f.connected.runtimeId);
      f.tasks([child("new-child")]);
      release();
      await expect(close).rejects.toThrow("close invalidated");
      expect(f.bridge.isOnline(f.connected.runtimeId)).toBe(true);
    } finally { release(); f.bridge.close(); }
  });

  it("does not register a noninteractive execution or leak child tools into main output", () => {
    const f = fixture();
    try {
      expect(f.bridge.hello({ ...f.hello, sessionId: "child", instanceId: "child", interactive: false })).toEqual({ ok: false, error: "non_interactive_session" });
      f.events.length = 0;
      f.send({ type: "task.tool.finished", agentId: "a", toolName: "Bash", toolCallId: "tool-a", arguments: { command: "test" } });
      expect(f.toolFinished).toHaveBeenCalledWith("claude:parent", "Bash", { command: "test" }, "a", "tool-a");
      expect(f.events).toEqual([]);
      expect(f.bridge.runtimeIds()).toEqual(["claude:parent"]);
    } finally { f.bridge.close(); }
  });

  it("keeps child approvals on their exact owner and main completion cannot settle them", async () => {
    const bridge = new ClaudeHookBridge({ hasSession: id => id === "claude:parent" });
    const input = { hook_event_name: "PermissionRequest", session_id: "parent", agent_id: "child", tool_use_id: "child-tool",
      cwd: "/repo", tool_name: "Bash", tool_input: { command: "same" } };
    try {
      const pending = bridge.accept(input);
      const otherPending = bridge.accept({ ...input, tool_use_id: "other-child-tool" });
      bridge.resolveLocally("claude:parent");
      bridge.resolveLocally("claude:parent", "Bash", input.tool_input, "other-child", "child-tool");
      expect(bridge.pendingRequests("claude:parent")).toHaveLength(2);
      bridge.resolveLocally("claude:parent", "Bash", { truncated: true }, "child", "child-tool");
      expect(await pending).toEqual({});
      expect(bridge.pendingRequests("claude:parent")).toHaveLength(1);
      bridge.resolveLocally("claude:parent", undefined, undefined, "child");
      expect(await otherPending).toEqual({});
      expect(await bridge.accept({ ...input, session_id: "unidentified-child" })).toEqual({});
      for (const transcript_path of ["/repo/parent/subagents/child.jsonl", "C:\\repo\\parent\\subagents\\child.jsonl"]) {
        expect(await bridge.accept({ ...input, agent_id: undefined, transcript_path })).toEqual({});
      }
      expect(bridge.runtimeIds()).toEqual([]);
    } finally { bridge.close(); }
  });

  it("requires a bounded complete inventory to authorize close", () => {
    expect(AgentTaskInventorySchema.safeParse({ availability: "ready", items: [], truncated: true }).success).toBe(false);
    for (const status of ["pending", "running", "waiting", "unknown"] as const) {
      expect(agentTasksAllowQuit({ availability: "ready", items: [{ ...child("a"), status }], truncated: false })).toBe(false);
    }
    expect(AgentTaskInventorySchema.safeParse({ availability: "ready", items: Array.from({ length: 257 }, (_, i) => child(String(i))), truncated: false }).success).toBe(false);
  });
});
