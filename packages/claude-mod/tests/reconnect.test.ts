import { expect, mock, test } from "claude-code/testing";
import { setup } from "./fixtures.ts";

test("rediscovers a restarted Host without restarting the native Claude session", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(hellos()).toHaveLength(1);
  expect(hellos()[0]?.body.processId).toBe(4242);

  world.reachable = false;
  await clock.advance(1500);
  world.descriptorPresent = false;
  await clock.advance(750);
  expect(hellos()).toHaveLength(1);

  world.descriptor = { url: "ws://127.0.0.1:42002", token: "second-host-token-for-test" };
  world.descriptorPresent = true;
  world.reachable = true;
  world.generation = "second-generation";
  await clock.advance(750);
  expect(hellos()).toHaveLength(2);
  expect(hellos()[1]?.body.sessionId).toBe(hellos()[0]?.body.sessionId);
  expect(hellos()[1]?.body.instanceId).toBe(hellos()[0]?.body.instanceId);
  expect(world.requests).toContainEqual(expect.objectContaining({
    url: "http://127.0.0.1:42002/v1/claude/mods/poll",
    authorization: "Bearer second-host-token-for-test",
    body: { runtimeId: "claude:same-native-session", generation: "second-generation" },
  }));
  expect(world.requests.some(request => request.url.endsWith("/event") && request.body.generation === "second-generation"
    && (request.body.event as { type?: string }).type === "session.state")).toBe(true);
  expect(world.statuses.at(-1)).toBeUndefined();
});

test("preserves the generation across a temporary HTTP failure on the same Host", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  world.reachable = false;
  await clock.advance(750);
  world.reachable = true;
  await clock.advance(750);
  expect(hellos()).toHaveLength(1);
  expect(world.requests.at(-1)?.body.generation).toBe("first-generation");
  expect(world.statuses.at(-1)).toBeUndefined();
});

// CLAUDE-LIVE-01: a retained native source must receive the rest of the current step
// under the renewed generation, without replaying its already-acknowledged prefix.
test("rebinds a streaming step only when the Host acknowledges its retained source", async ($, on) => {
  const { clock, world } = setup(on);
  mock.session(on);
  on("turn.step", async function* (_$, event) {
    yield { kind: "text", index: 0, text: "p".repeat(800) };
    world.pollError = "stale_generation";
    await clock.advance(750);
    world.pollError = "";
    world.generation = "renewed-generation";
    world.resumed = true;
    await clock.advance(750);
    yield { kind: "text", index: 0, text: " suffix" };
    return { turnId: event.turnId, index: event.index, answer: "done", toolUses: [], stopReason: "end_turn", usage: null };
  });
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "task", turnId: "main" });
  const stream = $.turn.step({ turnId: "main", index: 0, model: "test", messageCount: 1 });
  for await (const chunk of stream) expect(chunk.kind).toBe("text");
  await stream.result;
  const deliveries = world.requests.filter(request => (request.body.event as { type?: string })?.type === "turn.step.chunks");
  expect(deliveries.map(request => request.body)).toEqual([
    { runtimeId: "claude:same-native-session", generation: "first-generation", event: {
      type: "turn.step.chunks", turnId: "main", stepIndex: 0, chunks: [{ blockIndex: 0, contentType: "text", delta: "p".repeat(800) }],
    } },
    { runtimeId: "claude:same-native-session", generation: "renewed-generation", event: {
      type: "turn.step.chunks", turnId: "main", stepIndex: 0, chunks: [{ blockIndex: 0, contentType: "text", delta: " suffix" }],
    } },
  ]);
  await $.session.append({ door: "response", uuid: "native-row", origin: { kind: "model", model: "test" },
    message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "done" }] } });
  await $.turn.complete({ turnId: "main", answer: "done", durationMs: 1, reason: "answer", isAborted: false });
  expect(world.requests.some(request => request.body.generation === "renewed-generation"
    && (request.body.event as { type?: string })?.type === "turn.step.finished")).toBe(true);
});

test("scopes a refused hello's backoff to that Host endpoint and token", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  world.rejection = "missing_capability:test";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await clock.advance(1500);
  expect(hellos()).toHaveLength(1);
  world.descriptor.token = "new-host-token-at-same-port";
  world.generation = "second-generation";
  world.rejection = "";
  await clock.advance(750);
  expect(hellos()).toHaveLength(2);
  expect(hellos()[1]?.authorization).toBe("Bearer new-host-token-at-same-port");
});

test("does not replay an in-flight prompt or send its old result to the restarted Host", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  world.commands = [{ commandId: "old-command", command: { type: "user_message", text: "mock prompt" } }];
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(world.submits).toBe(1);
  await clock.advance(750);
  expect(world.submits).toBe(1);
  world.commands = [];
  world.descriptor = { url: "ws://127.0.0.1:42002", token: "second-host-token-for-test" };
  world.generation = "second-generation";
  await clock.advance(3750);
  expect(hellos()).toHaveLength(2);
  expect(world.submits).toBe(1);
  expect(world.requests.some(request => request.url.endsWith("/event")
    && (request.body.event as { commandId?: string }).commandId === "old-command")).toBe(false);
});

test("keeps follow-ups out of prompt.submit during a native turn while polling and stop continue", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "original task", turnId: "running-turn" });
  world.commands = [
    { commandId: "follow-up", command: { type: "user_message", text: "next task" } },
    { commandId: "stop", command: { type: "stop" } },
  ];
  await clock.advance(2250);
  expect(world.submits).toBe(0);
  expect(world.aborts).toEqual(["running-turn"]);
  expect(world.requests.filter(request => request.url.endsWith("/poll")).length).toBeGreaterThanOrEqual(4);
  expect(world.requests.some(request => (request.body.event as { type?: string; commandId?: string } | undefined)?.commandId === "follow-up")).toBe(false);
  await $.tool.call({ tool: "Bash", command: "echo this command must not run" });
  expect(world.requests.some(request => (request.body.event as { type?: string } | undefined)?.type === "tool.finished")).toBe(true);
  await $.turn.complete({ turnId: "running-turn", answer: "", durationMs: 2250, reason: "aborted", isAborted: true });
  world.commands = world.commands.filter(item => item.commandId !== "stop");
  await clock.advance(750);
  expect(world.submits).toBe(1);
  await clock.advance(750);
  expect(world.submits).toBe(1);
});

test("submits only one follow-up at a time when an idle poll contains several messages", async ($, on) => {
  const { clock, world } = setup(on);
  world.commands = [
    { commandId: "first", command: { type: "user_message", text: "first" } },
    { commandId: "second", command: { type: "user_message", text: "second" } },
  ];
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(world.submits).toBe(1);
  await clock.advance(2250);
  expect(world.submits).toBe(1);
  world.commands = world.commands.filter(item => item.commandId !== "first");
  await clock.advance(1500);
  expect(world.submits).toBe(2);
});

test("keeps a follow-up deferred after a subagent ends, then reports its native submit result", async ($, on) => {
  const { clock, world } = setup(on);
  world.denyPrompt = false;
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "original task", turnId: "main-turn" });
  world.commands = [{ commandId: "follow-up", command: { type: "user_message", text: "next task" } }];
  await $.turn.start({ text: "child task", turnId: "child-turn", agentId: "child" });
  await $.turn.complete({ turnId: "child-turn", agentId: "child", answer: "child done", durationMs: 0, reason: "answer", isAborted: false });
  await clock.advance(750);
  expect(world.submits).toBe(0);
  await $.turn.complete({ turnId: "main-turn", answer: "done", durationMs: 750, reason: "answer", isAborted: false });
  await clock.advance(750);
  expect(world.submits).toBe(1);
  world.commands = [];
  await clock.advance(3000);
  expect(world.requests.some(request => {
    const event = request.body.event as { type?: string; commandId?: string; ok?: boolean; status?: string } | undefined;
    return event?.type === "command.result" && event.commandId === "follow-up" && event.ok === true && event.status === "success";
  })).toBe(true);
});

test("waits for the Host completion capture barrier before submitting the next prompt", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "original task", turnId: "main-turn" });
  world.commands = [{ commandId: "follow-up", command: { type: "user_message", text: "next task" } }];
  world.completionDelay = 3000;
  const completion = $.turn.complete({ turnId: "main-turn", answer: "done", durationMs: 0, reason: "answer", isAborted: false });
  await clock.settle();
  await clock.advance(2250);
  expect(world.submits).toBe(0);
  await clock.advance(1500);
  await completion;
  expect(world.submits).toBe(1);
});

test("does not submit a deferred follow-up after its Host generation is replaced", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "original task", turnId: "running-turn" });
  world.commands = [{ commandId: "old-follow-up", command: { type: "user_message", text: "old next task" } }];
  await clock.advance(750);
  expect(world.submits).toBe(0);
  world.commands = [];
  world.descriptor = { url: "ws://127.0.0.1:42002", token: "second-host-token-for-test" };
  world.generation = "second-generation";
  await clock.advance(750);
  await $.turn.complete({ turnId: "running-turn", answer: "done", durationMs: 1500, reason: "answer", isAborted: false });
  await clock.advance(750);
  expect(world.submits).toBe(0);
});

test("reserves all native response UUIDs before storage and seals their step before the next request", async ($, on) => {
  const { clock, world } = setup(on);
  mock.session(on);
  on("turn.step", async function* (_$, event) {
    yield { kind: "text", index: 0, text: "same text" };
    return { turnId: event.turnId, index: event.index, answer: "same text", toolUses: [], stopReason: "end_turn", usage: null };
  });
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "task", turnId: "main" });
  const runStep = async (index: number, agentId?: string) => {
    const stream = $.turn.step({ turnId: "main", index, model: "test", messageCount: 1, ...(agentId ? { agentId } : {}) });
    for await (const chunk of stream) { expect(chunk.kind).toBe("text"); }
    await stream.result;
  };
  const append = (uuid: string, agentId?: string) => $.session.append({ uuid, door: "response",
    origin: { kind: "model", model: "test" }, message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "same text" }] },
    ...(agentId ? { agentId } : {}) });
  await runStep(0);
  await append("first-uuid");
  await runStep(0, "child");
  await append("child-uuid", "child");
  await append("second-uuid");
  const events = () => world.requests.flatMap(request => request.body.event ? [request.body.event as Record<string, unknown>] : []);
  expect(events().filter(event => event.type === "turn.step.row").map(event => event.uuid)).toEqual(["first-uuid", "second-uuid"]);
  expect(events().filter(event => event.type === "turn.step.finished")).toHaveLength(0);
  await runStep(1);
  expect(events().find(event => event.type === "turn.step.finished")).toEqual({ type: "turn.step.finished", turnId: "main", stepIndex: 0, uuids: ["first-uuid", "second-uuid"] });
  const seal = events().findIndex(event => event.type === "turn.step.finished");
  const nextChunks = events().findIndex(event => event.type === "turn.step.chunks" && event.stepIndex === 1);
  expect(seal).toBeLessThan(nextChunks);
  await append("third-uuid");
  await $.turn.complete({ turnId: "main", answer: "done", durationMs: 1, reason: "answer", isAborted: false });
  expect(events().filter(event => event.type === "turn.step.finished").at(-1)).toEqual({ type: "turn.step.finished", turnId: "main", stepIndex: 1, uuids: ["third-uuid"] });
  expect(events().findIndex(event => event.type === "turn.complete")).toBeGreaterThan(events().findIndex(event => event.type === "turn.step.finished" && event.stepIndex === 1));
});

for (const error of ["unauthorized", "stale_generation", "bridge_offline"]) {
  test(`refreshes the connection generation after ${error}`, async ($, on) => {
    const { clock, world, hellos } = setup(on);
    await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
    await clock.settle();
    world.pollError = error;
    await clock.advance(750);
    world.pollError = "";
    world.generation = "renewed-generation";
    await clock.advance(750);
    expect(hellos()).toHaveLength(2);
    expect(world.requests.at(-1)?.body.generation).toBe("renewed-generation");
  });
}

test("defers a phone submission during standalone compaction and releases it on native completion", async ($, on) => {
  const { clock, world } = setup(on);
  on("session.compact", async (_$, event) => {
    await clock.sleep(3000);
    return { messages: event.messages };
  });
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  const compacting = $.session.compact({ messages: [{ role: "user", text: "existing context", toolUses: [], toolResults: [] }] });
  await clock.settle();
  world.commands = [{ commandId: "during-compaction", command: { type: "user_message", text: "next task" } }];
  await clock.advance(2250);
  expect(world.submits).toBe(0);
  expect(world.requests.some(request => (request.body.event as { type?: string; phase?: string } | undefined)?.phase === "running")).toBe(true);
  await clock.advance(1500);
  await compacting;
  expect(world.submits).toBe(1);
});


test("tracks background inventory after main completion and restores it on Host reconnection", async ($, on) => {
  const { clock, world } = setup(on);
  world.agents = [{ id: "child", description: "Review", type: "Explore", status: "running" }];
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "main", turnId: "main" });
  await $.turn.complete({ turnId: "main", answer: "delegated", durationMs: 0, reason: "answer", isAborted: false });
  await clock.advance(750);
  const inventories = () => world.requests.filter(r => (r.body.event as {type?: string})?.type === "tasks.snapshot");
  expect(inventories().at(-1)?.body.event).toMatchObject({ tasks: { availability: "ready", items: [{id: "child", status: "running"}] } });
  world.generation = "reconnected";
  world.descriptor = { url: "ws://127.0.0.1:42002", token: "replacement-host-token" };
  await clock.advance(750);
  expect(inventories().at(-1)?.body.generation).toBe("reconnected");
  expect(inventories().at(-1)?.body.event).toMatchObject({ tasks: { items: [{id: "child", status: "running"}] } });
  world.agentListFails = true;
  await clock.advance(750);
  expect(inventories().at(-1)?.body.event).toMatchObject({ tasks: { availability: "unknown" } });
  world.agentListFails = false;
  world.agents[0]!.status = "completed";
  await clock.advance(750);
  expect(inventories().at(-1)?.body.event).toMatchObject({ tasks: { availability: "ready", items: [{id: "child", status: "completed"}] } });
});

test("does not register noninteractive child executions as ordinary sessions", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: null, isInteractive: false });
  await $.turn.start({ text: "child", turnId: "child-turn" });
  await clock.advance(3000);
  expect(hellos()).toHaveLength(0);
  expect(world.requests).toHaveLength(0);
});

test("drops a delayed task read after the native session changes and bounds incomplete inventories", async ($, on) => {
  const { clock, world } = setup(on);
  world.agents = [{ id: "old-child", description: "Old", type: "Explore", status: "running" }];
  world.agentListDelay = 1500;
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  world.sessionId = "replacement-session";
  world.generation = "replacement-generation";
  world.agents = [];
  world.agentListDelay = 0;
  await clock.advance(2250);
  const inventories = () => world.requests.filter(r => (r.body.event as {type?: string})?.type === "tasks.snapshot");
  expect(inventories().some(r => JSON.stringify(r.body.event).includes("old-child"))).toBe(false);
  expect(inventories().at(-1)?.body).toMatchObject({ runtimeId: "claude:replacement-session", generation: "replacement-generation",
    event: { tasks: { availability: "ready", items: [] } } });
  world.agents = Array.from({ length: 257 }, (_, index) => ({ id: String(index), description: "Task", type: "Explore", status: "running" }));
  await clock.advance(750);
  expect(inventories().at(-1)?.body.event).toMatchObject({ tasks: { availability: "unknown", truncated: true } });
  world.agents = [];
  world.agentListDelay = 3750;
  await clock.advance(4500);
  expect(inventories().at(-1)?.body.event).toMatchObject({ tasks: { availability: "unknown", truncated: false } });
});

test("child tool completion preserves approval identity without becoming a main tool or main completion", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.tool.call({ tool: "Bash", command: "unused", tool_use_id: "child-tool", agentId: "child" });
  const events = world.requests.map(r => r.body.event).filter(Boolean);
  expect(events).toContainEqual({ type: "task.tool.finished", agentId: "child", toolCallId: "child-tool", toolName: "Bash", arguments: { command: "unused" } });
  expect(events.some(event => (event as {type: string}).type === "tool.started")).toBe(false);
});

// S51 / SC73: phone model/depth changes affect subsequent turns. A native
// fallback during the active turn must retain its own model identity.
test("pins phone model and effort changes while preserving native fallback models", async ($, on) => {
  const { clock, world } = setup(on);
  mock.session(on);
  on("config.set", (_$, event) => {
    expect(event.key).toBe("model");
    world.model = String(event.value);
    return { value: event.value };
  });
  const seen: { turnId: string; effort: unknown; model: string }[] = [];
  on("turn.step", async function* (_$, event) {
    seen.push({ turnId: event.turnId, effort: event.effort, model: event.model });
    yield { kind: "text", index: 0, text: "synthetic" };
    return { turnId: event.turnId, index: event.index, answer: "done", toolUses: [], stopReason: "end_turn", usage: null };
  });
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "first", turnId: "first" });
  const step = async (turnId: string, index: number, model: string) => {
    const stream = $.turn.step({ turnId, index, model, effort: "low", messageCount: 1 });
    for await (const chunk of stream) { void chunk; /* Drain the isolated native stream. */ }
    await stream.result;
  };
  await step("first", 0, "original-model");
  world.commands = [{ commandId: "next-depth", command: { type: "slash", name: "effort", args: "high" } }];
  await clock.advance(750);
  world.commands = [{ commandId: "next-model", command: { type: "slash", name: "model", args: "next-model" } }];
  await clock.advance(750);
  world.commands = [];
  await step("first", 1, "next-model");
  await step("first", 2, "native-fallback");
  await $.turn.complete({ turnId: "first", answer: "done", durationMs: 1, reason: "answer", isAborted: false });
  await $.turn.start({ text: "second", turnId: "second" });
  await step("second", 0, "next-model");
  expect(seen).toEqual([
    { turnId: "first", effort: "low", model: "original-model" },
    { turnId: "first", effort: "low", model: "original-model" },
    { turnId: "first", effort: "low", model: "native-fallback" },
    { turnId: "second", effort: "high", model: "next-model" },
  ]);
});
