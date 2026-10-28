import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@orbis/protocol";
import type { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { AgentConversationState } from "./agent-conversation-state.js";
import { AgentStateFacts } from "./agent-state-facts.js";
import { AgentStateRegistry } from "./agent-state-registry.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

const question = { id: "question", type: "agentMessage", delivery: "async", phase: "final_answer",
  text: "Choose", questions: [{ title: "Which option?", options: ["A", "B"] }] };
const reply = { id: "reply", type: "userMessage", content: [{ type: "text", text:
  `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "question", 0]), question: "Which option?", answer: "A" }])}\n</send_user_message_question_reply>` }] };
const answer = { id: "answer", type: "agentMessage", text: "Continuing after the desktop answer" };

async function harness(sourceCoalesceMs = 0) {
  const events: RuntimeEvent[] = [], rejected: string[] = [];
  const registry = new AgentStateRegistry();
  const facts = new AgentStateFacts({ registry, hostId: "host", kindOf: () => "codexDesktop" });
  const model = new AgentConversationState(registry);
  const scope = { kind: "agent" as const, key: { hostId: "host", agentKind: "codexDesktop" as const, sessionId: "codex-desktop:a" } };
  let turns: unknown[] = [];
  const request = vi.fn(async (method: string) => {
    if (method === "thread/resume") return { thread: { id: "a", cwd: "D:/fixture" } };
    if (method === "thread/turns/list") return { data: turns };
    return { data: [] };
  });
  const server = { mode: "external", request } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, sourceCoalesceMs, rolloutRoot: "D:/not-existing-question-sync-rollouts", onEvent: event => {
    events.push(event);
    if (event.type === "session.patch" || event.type === "session.snapshot") {
      model.accept(scope, event, ready => facts.prepareConversation("codex-desktop:a", event, ready), reason => rejected.push(reason));
    } else facts.observe("codex-desktop:a", event);
  } });
  runtime.seedDesktopThreads(["a"]);
  cleanups.push(() => server.onExit?.(0));
  const activate = () => runtime.activate({ type: "resume", sessionId: "codex-desktop:a" });
  await activate();
  const notify = (method: string, params: Record<string, unknown>) => server.onNotification?.(method, { threadId: "a", turnId: "turn", ...params });
  const sync = () => runtime.handleCommand({ type: "session.sync", sessionId: "codex-desktop:a", syncId: "sync", range: "preview" }, "sync", "a");
  sync();
  return { events, rejected, registry, scope, runtime, model, notify, sync, activate, request,
    native: (items: unknown[]) => { turns = [{ id: "turn", status: "inProgress", startedAt: 1_800_000_000, items }]; } };
}

describe("Codex desktop question conversation sync", () => {
  it("keeps accepting updates after reactivating an attached thread without a question", async () => {
    const h = await harness();
    const before = { id: "before", type: "agentMessage", text: "Before reactivation" };
    h.notify("turn/started", { turn: { id: "turn", startedAt: 1_800_000_000 } });
    h.notify("item/completed", { item: before });
    h.sync();
    h.native([before]);
    await h.activate();
    h.notify("item/completed", { item: answer });
    expect(h.rejected).toEqual([]);
    expect(h.model.hasBaseline(h.scope)).toBe(true);
    expect(h.registry.read<{ head: { leafId: string } }>(h.scope, "history")?.value?.head.leafId).toBe("answer");
  });

  it("keeps accepting chat after a desktop question and local answer in the same turn", async () => {
    const h = await harness();
    h.notify("turn/started", { turn: { id: "turn", startedAt: 1_800_000_000 } });
    h.notify("item/started", { item: question });
    h.notify("item/completed", { item: question });
    h.notify("item/started", { item: reply });
    h.notify("item/completed", { item: reply });
    h.notify("item/started", { item: { ...answer, text: "" } });
    h.notify("item/agentMessage/delta", { itemId: answer.id, delta: answer.text });
    h.notify("item/completed", { item: answer });
    expect(h.rejected).toEqual([]);
    expect(h.events).toContainEqual(expect.objectContaining({ type: "interaction.resolved", source: "local" }));
    expect(h.registry.read<{ head: { leafId: string } }>(h.scope, "history")?.value?.head.leafId).toBe("answer");
  });

  it.each([0, 100])("keeps the source continuous when reactivating a desktop question (coalesce=%s)", async coalesce => {
    const h = await harness(coalesce);
    h.notify("turn/started", { turn: { id: "turn", startedAt: 1_800_000_000 } });
    h.notify("item/completed", { item: question });
    h.sync();
    const before = h.events.filter(event => event.type === "session.snapshot").at(-1)!.source!;
    h.native([question]);
    await h.activate();
    h.notify("item/completed", { item: reply });
    h.notify("item/completed", { item: answer });
    expect(h.rejected).toEqual([]);
    h.sync();
    expect(h.model.hasBaseline(h.scope)).toBe(true);
    const after = h.events.filter(event => event.type === "session.snapshot").at(-1)!;
    expect(after.source?.epoch).toBe(before.epoch);
    expect(after.source!.seq).toBeGreaterThan(before.seq);
    expect(h.registry.read<{ head: { leafId: string } }>(h.scope, "history")?.value?.head.leafId).toBe("answer");
  });

  it("keeps chat updating after a native replay discovers the desktop answer", async () => {
    const h = await harness();
    h.notify("turn/started", { turn: { id: "turn", startedAt: 1_800_000_000 } });
    h.notify("item/completed", { item: question });
    h.native([question, reply]);
    h.runtime.announce("a");
    await vi.waitFor(() => expect(h.request.mock.calls.filter(([method]) => method === "thread/turns/list")).toHaveLength(2));
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: "interaction.resolved", source: "local" })));
    h.notify("item/completed", { item: answer });
    expect(h.rejected).toEqual([]);
    expect(h.registry.read<{ head: { leafId: string } }>(h.scope, "history")?.value?.head.leafId).toBe("answer");
  });

  it("publishes replies discovered by reactivation with a new sequence in the same epoch", async () => {
    const h = await harness();
    h.notify("turn/started", { turn: { id: "turn", startedAt: 1_800_000_000 } });
    h.notify("item/completed", { item: question });
    h.sync();
    const before = h.events.filter(event => event.type === "session.snapshot").at(-1)!.source!;
    h.native([question, reply]);
    await h.activate();
    h.sync();
    const after = h.events.filter(event => event.type === "session.snapshot").at(-1)!;
    expect(after.source?.epoch).toBe(before.epoch);
    expect(after.source!.seq).toBeGreaterThan(before.seq);
    expect(h.rejected).toEqual([]);
    expect(h.registry.read<{ head: { leafId: string } }>(h.scope, "history")?.value?.head.leafId).toBe("reply");
  });
});
