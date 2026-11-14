import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCodexTurnConfiguration } from "./codex-turn-configuration.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";
import type { RuntimeEvent } from "@orbis/protocol";
import type { AgentExecutionState, AgentModelState } from "@orbis/protocol";
import { AgentStateRegistry } from "./agent-state-registry.js";
import { AgentStateFacts } from "./agent-state-facts.js";
import { AgentConversationState } from "./agent-conversation-state.js";
import { CompactStateModel } from "./compact-state-model.js";
import { buildAgentStateSnapshotParts } from "./agent-state-snapshot.js";

// S52 / SC76: real source records and native turn identities, all in isolated fixtures.
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orbis-turn-config-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "rollout.jsonl");
  const header = line("session_meta", { id: "thread", model_provider: "fixture" });
  const context = line("turn_context", { turn_id: "active", model: "a", effort: "low" });
  await writeFile(path, header + context);
  return { path, dir, header, context };
}

it("reads only complete contexts belonging to the exact thread and turn", async () => {
  const f = await fixture();
  expect(await readCodexTurnConfiguration(f.path, "thread", "active")).toEqual({ turnId: "active", model: { provider: "fixture", id: "a" }, thinkingLevel: "low" });
  expect(await readCodexTurnConfiguration(f.path, "other", "active")).toBeUndefined();
  expect(await readCodexTurnConfiguration(f.path, "thread", "other")).toBeUndefined();
  await writeFile(f.path, f.header + f.context.trimEnd());
  expect(await readCodexTurnConfiguration(f.path, "thread", "active")).toBeUndefined();
});

it("keeps contexts outside the bounded tail unknown instead of using the session defaults", async () => {
  const f = await fixture();
  await writeFile(f.path, f.header + f.context + line("response_item", { text: "x".repeat(2 * 1024 * 1024) }));
  expect(await readCodexTurnConfiguration(f.path, "thread", "active")).toBeUndefined();
});

async function harness(active = true, kind: "codex" | "codexDesktop" = "codex") {
  const f = await fixture();
  const events: RuntimeEvent[] = [];
  const registry = new AgentStateRegistry();
  const facts = new AgentStateFacts({ registry, hostId: "host", kindOf: () => kind });
  const conversation = new AgentConversationState(registry);
  const sessionId = kind === "codexDesktop" ? "codex-desktop:thread" : "thread";
  const runtimeId = kind === "codexDesktop" ? sessionId : "codex:thread";
  const scope = { kind: "agent" as const, key: { hostId: "host", agentKind: kind, sessionId } };
  const settings = { model: "b", modelProvider: "fixture", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } };
  const request = vi.fn(async (method: string) => {
    if (method === "thread/resume") return { thread: { id: "thread", cwd: f.dir, path: f.path }, ...settings };
    if (method === "thread/turns/list") return { data: active ? [{ id: "active", status: "inProgress", startedAt: 1, items: [] }] : [] };
    if (method === "model/list") return { data: [
      { id: "a", displayName: "A", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
      { id: "b", displayName: "B", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    ] };
    if (method === "turn/start") return { turn: { id: "next" } };
    return { data: [] };
  });
  const server = { request, mode: kind === "codexDesktop" ? "external" : "owned" } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, sourceCoalesceMs: 0, rolloutRoot: f.dir, onEvent: event => {
    events.push(event);
    if (event.type === "session.patch" || event.type === "session.snapshot") {
      conversation.accept(scope, event, ready => facts.prepareConversation(runtimeId, event, ready));
    } else facts.observe(runtimeId, event);
  } });
  runtime.seedDesktopThreads(kind === "codexDesktop" ? ["thread"] : []);
  runtime.markStarted();
  await runtime.activate({ type: "resume", sessionId });
  runtime.handleCommand({ type: "session.sync", sessionId, syncId: "fixture-sync", range: "preview" }, "sync", "thread");
  cleanup.push(() => server.onExit?.(0));
  return { runtime, server, request, events, registry, scope, metadata: () => runtime.directoryEntries()[0]! };
}

it.each(["codex", "codexDesktop"] as const)("%s recovers an already-running native turn through split compact frames", async kind => {
  const h = await harness(true, kind);
  await vi.waitFor(() => expect(h.metadata().currentTurnConfiguration).toMatchObject({ turnId: "active", model: { id: "a" }, thinkingLevel: "low" }));
  expect(h.metadata()).toMatchObject({ model: { id: "b" }, thinkingLevel: "high" });
  // A mid-turn attach must deliver matching execution/model identities to Android,
  // without relying on an earlier turn/started notification from this connection.
  expect(h.registry.read<AgentExecutionState>(h.scope, "execution")?.value?.turn?.turnId).toBe("active");
  expect(h.registry.read<AgentModelState>(h.scope, "model")?.value).toMatchObject({
    id: "b", currentTurn: { turnId: "active", model: { id: "a" }, thinkingLevel: "low" },
  });
  // Android receives execution and model on separate lanes. Neither compact
  // projection nor serialization may strip the turn identity or current values.
  const compact = new CompactStateModel(h.registry);
  cleanup.push(() => compact.close());
  const frames = JSON.parse(JSON.stringify(buildAgentStateSnapshotParts({ registry: compact.ensure(h.scope),
    requestId: "wire", scope: h.scope, domains: ["execution", "model"], stateFormat: "compact-v2" })));
  expect(frames).toHaveLength(2);
  expect(frames[0].domains[0].value.turn.turnId).toBe("active");
  expect(frames[1].domains[0].value.currentTurn).toMatchObject({ turnId: "active", model: { id: "a" }, thinkingLevel: "low" });
  h.server.onNotification?.("thread/settings/updated", { threadId: "thread", threadSettings: { model: "b", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } });
  expect(h.metadata().currentTurnConfiguration).toMatchObject({ model: { id: "a" }, thinkingLevel: "low" });
  h.server.onNotification?.("turn/completed", { threadId: "thread", turn: { id: "active", status: "completed" } });
  expect(h.metadata()).toMatchObject({ model: { id: "b" }, currentTurnConfiguration: null });
});

it("binds accepted phone parameters to the returned turn even when response precedes turn/started", async () => {
  const h = await harness(false);
  h.runtime.dispatchCommand("codex:thread", "send", { type: "user_message", text: "fixture" });
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: "b", effort: "high" })));
  await new Promise(resolve => setImmediate(resolve));
  h.server.onNotification?.("turn/started", { threadId: "thread", turn: { id: "next", startedAt: 1 } });
  expect(h.metadata().currentTurnConfiguration).toMatchObject({ turnId: "next", model: { id: "b" }, thinkingLevel: "high" });
  h.runtime.dispatchCommand("codex:thread", "model", { type: "slash.execute", name: "model", args: "a" });
  expect(h.metadata()).toMatchObject({ model: { id: "a" }, thinkingLevel: "low", currentTurnConfiguration: { model: { id: "b" }, thinkingLevel: "high" } });
});

it("does not reuse an old turn's configuration for an external new turn or after rerouting", async () => {
  const h = await harness();
  await vi.waitFor(() => expect(h.metadata().currentTurnConfiguration?.model?.id).toBe("a"));
  h.server.onNotification?.("model/rerouted", { threadId: "thread", turnId: "active", fromModel: "a", toModel: "b" });
  expect(h.metadata().currentTurnConfiguration?.model?.id).toBe("b");
  expect(h.metadata().currentTurnConfiguration?.thinkingLevel).toBeUndefined();
  h.server.onNotification?.("turn/started", { threadId: "thread", turn: { id: "external", startedAt: 2 } });
  expect(h.metadata().currentTurnConfiguration).toEqual({ turnId: "external" });
});

// SC86: Codex enriches both request and selection through the same model catalog.
it("uses the same catalog name for an unchanged Codex request and selection", async () => {
  const h = await harness();
  await vi.waitFor(() => expect(h.metadata().currentTurnConfiguration?.model?.id).toBe("a"));
  h.server.onNotification?.("thread/settings/updated", { threadId: "thread",
    threadSettings: { model: "a", modelProvider: "fixture", effort: "low" } });
  expect(h.metadata().model).toEqual({ provider: "fixture", id: "a", name: "A" });
  expect(h.metadata().currentTurnConfiguration?.model).toEqual(h.metadata().model);
  expect(h.metadata().currentTurnConfiguration?.thinkingLevel).toBe(h.metadata().thinkingLevel);
});

it("keeps an early reroute authoritative when a rollout read is still in flight", async () => {
  const h = await harness();
  h.server.onNotification?.("model/rerouted", { threadId: "thread", turnId: "active", fromModel: "a", toModel: "b" });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.metadata().currentTurnConfiguration).toEqual({ turnId: "active", model: { provider: "fixture", id: "b", name: "B" } });
});
