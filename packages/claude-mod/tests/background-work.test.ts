import { expect, test } from "claude-code/testing";
import { setup } from "./fixtures.ts";

type Inventory = { availability: string; truncated: boolean; items: { id: string; status: string }[] };

function inventories(world: ReturnType<typeof setup>["world"]): Inventory[] {
  return world.requests.flatMap(r => (r.body.event as { type?: string; tasks?: Inventory } | undefined)?.type === "tasks.snapshot"
    ? [(r.body.event as { tasks: Inventory }).tasks] : []);
}

// S60 / SC108: shells and Monitors share the one agent inventory. Their ids come from tool result
// records, never output text; the session's in-flight list on Stop is how an ended task leaves.
test("reports background shells and Monitors until the session's in-flight list drops them", async ($, on) => {
  const { clock, world } = setup(on);
  world.agents = [{ id: "agent-1", description: "Review", type: "Explore", status: "running" }];
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  world.toolResult = { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "shell-1" };
  await $.tool.call({ tool: "Bash", tool_use_id: "t1", command: "API_TOKEN=secret npm run dev", description: "Dev server", run_in_background: true });
  world.toolResult = { taskId: "watch-1", timeoutMs: 30000, persistent: false };
  await $.tool.call({ tool: "Monitor", tool_use_id: "t2", description: "Watch logs", timeout_ms: 30000, command: "tail -f log" });
  world.toolResult = { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "child-shell" };
  await $.tool.call({ tool: "Bash", tool_use_id: "t3", command: "sleep 9", description: "Child wait", run_in_background: true, agentId: "agent-1" });
  // A foreground result carries no task id and adds nothing.
  world.toolResult = { stdout: "Command running in background with ID: fake", stderr: "", interrupted: false };
  await $.tool.call({ tool: "Bash", tool_use_id: "t4", command: "echo", description: "Text only" });
  await clock.advance(750);
  expect(inventories(world).at(-1)).toEqual({ availability: "ready", truncated: false, items: [
    { id: "agent-1", title: "Review", kind: "Explore", status: "running" },
    { id: "child-shell", parentId: "agent-1", title: "Child wait", kind: "shell", status: "running" },
    { id: "shell-1", title: "Dev server", kind: "shell", status: "running" },
    { id: "watch-1", title: "Watch logs", kind: "monitor", status: "running" },
  ] });
  expect(JSON.stringify(inventories(world))).not.toContain("secret");

  world.toolResult = { message: "stopped", task_id: "shell-1", task_type: "local_bash", command: "npm run dev" };
  await $.tool.call({ tool: "TaskStop", tool_use_id: "t5", task_id: "shell-1" });
  await clock.advance(750);
  expect(inventories(world).at(-1)?.items).toContainEqual({ id: "shell-1", title: "Dev server", kind: "shell", status: "killed" });

  // The native list labels a Monitor as a shell and repeats subagents; neither replaces what is known.
  // A shell started without a description is listed with its command line as one (Claude Code 2.1.325).
  await $.classic.Stop({ session_id: world.sessionId, stop_hook_active: false, session_crons: [], background_tasks: [
    { id: "watch-1", type: "shell", status: "running", description: "Watch logs", command: "tail -f log" },
    { id: "agent-1", type: "subagent", status: "running", description: "Review", agent_type: "Explore" },
    { id: "flow-1", type: "workflow", status: "queued", description: "Nightly" },
    { id: "late-shell", type: "shell", status: "running", description: "API_TOKEN=secret make", command: "API_TOKEN=secret make" },
    { id: "child-shell", type: "shell", status: "running", description: "sleep 9", command: "sleep 9" },
  ] });
  await clock.advance(750);
  expect(inventories(world).at(-1)).toEqual({ availability: "ready", truncated: false, items: [
    { id: "agent-1", title: "Review", kind: "Explore", status: "running" },
    { id: "child-shell", parentId: "agent-1", title: "Child wait", kind: "shell", status: "running" },
    { id: "flow-1", title: "Nightly", kind: "workflow", status: "unknown" },
    { id: "late-shell", title: "", kind: "shell", status: "running" },
    { id: "watch-1", title: "Watch logs", kind: "monitor", status: "running" },
  ] });
  expect(JSON.stringify(inventories(world))).not.toContain("secret");

  world.agents[0]!.status = "completed";
  await $.classic.Stop({ session_id: world.sessionId, stop_hook_active: false, session_crons: [], background_tasks: [] });
  await clock.advance(750);
  expect(inventories(world).at(-1)?.items).toEqual([{ id: "agent-1", title: "Review", kind: "Explore", status: "completed" }]);
});

test("an engine whose Stop has no in-flight list reports no background shells", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  world.toolResult = { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "shell-1" };
  await $.tool.call({ tool: "Bash", tool_use_id: "t1", command: "sleep 99", description: "Wait", run_in_background: true });
  await clock.advance(750);
  expect(inventories(world).at(-1)?.items.map(item => item.id)).toEqual(["shell-1"]);
  // Without a list nothing would ever end the row, so it must not block close forever.
  await $.classic.Stop({ session_id: world.sessionId, stop_hook_active: false });
  await clock.advance(750);
  expect(inventories(world).at(-1)).toEqual({ availability: "ready", truncated: false, items: [] });
  world.toolResult = { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "shell-2" };
  await $.tool.call({ tool: "Bash", tool_use_id: "t2", command: "sleep 99", description: "Wait again", run_in_background: true });
  await clock.advance(750);
  expect(inventories(world).at(-1)?.items).toEqual([]);
});

test("another native session's ledger is not reported", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  world.toolResult = { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "old-shell" };
  await $.tool.call({ tool: "Bash", tool_use_id: "t1", command: "sleep 99", description: "Old", run_in_background: true });
  world.sessionId = "replacement-session";
  world.generation = "replacement-generation";
  await clock.advance(1500);
  const latest = world.requests.filter(r => (r.body.event as { type?: string } | undefined)?.type === "tasks.snapshot").at(-1);
  expect(latest?.body).toMatchObject({ runtimeId: "claude:replacement-session", event: { tasks: { availability: "ready", items: [] } } });
});
