import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeEventSchema, type RuntimeEvent } from "@pi-remote/protocol";
import type { DshWebConnection } from "./dsh-web-client.js";
import { DshWebRuntime } from "./dsh-web-runtime.js";
import { AgentConversationState } from "./agent-conversation-state.js";
import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";

const roots: string[] = [];
const runtimes: DshWebRuntime[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function discoveryFixture() {
  let items: Record<string, unknown>[] = [];
  const subscriptions: { method: string; args: Record<string, unknown>; frame: (value: unknown) => void; fail?: ((error: Error) => void) | undefined; closed: boolean }[] = [];
  const request = vi.fn<(method: string, args?: unknown) => Promise<unknown>>(async method => {
    if (method === "session/list") return { items };
    if (method === "workspace/create") return { workspace: { workspaceId: "workspace" } };
    if (method === "session/page") return { records: [] };
    return {};
  });
  const client: DshWebConnection = {
    onEvent: undefined, onExit: undefined, onReconnect: undefined,
    request: request as DshWebConnection["request"],
    subscribe(method, args, frame, fail) {
      const subscription = { method, args, frame, fail, closed: false }; subscriptions.push(subscription);
      if (method === "workspace/follow") queueMicrotask(() => frame({ type: "baseline", value: { archivedSessionIds: ["archived"] } }));
      return () => { subscription.closed = true; };
    },
    respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  };
  const runtime = new DshWebRuntime(client); runtimes.push(runtime);
  const events: { event: RuntimeEvent; runtimeId: string }[] = [];
  runtime.setEventSink((event, runtimeId) => { RuntimeEventSchema.parse(event); events.push({ event: structuredClone(event), runtimeId }); });
  const offline = vi.fn(); runtime.onOffline = offline;
  const archives = vi.fn(); runtime.onArchiveChange = archives;
  const metadata = vi.fn(); runtime.onMetadataChange = metadata;
  const changed = vi.fn(); runtime.onCatalogChange = changed;
  const emit = (event: string, ...args: unknown[]) => client.onEvent?.({ type: "emit", event, args });
  const live = (id: string, running = false) => ({ sessionId: id, cwd: "D:/work", projections: { kind: "sequenced", asOfSeq: 0, values: { title: `Title ${id}` } }, updatedAt: 1000, agentAvailable: true, running });
  const follows = () => subscriptions.filter(item => item.method === "session/follow" && !item.closed);
  return { runtime, client, events, offline, archives, metadata, changed, emit, live, follows, subscriptions, request,
    list: (next: Record<string, unknown>[]) => { items = next; } };
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("DeepSeek Web runtime adapter", () => {
  it("accepts preview and paged history through the Host conversation model", async () => {
    const f = discoveryFixture();
    const model = new AgentConversationState(new AgentStateRegistry());
    const scope: StateScope = { kind: "agent", key: { hostId: "isolated", agentKind: "dsh", sessionId: "dsh:browser" } };
    const rejected: RuntimeEvent[] = [];
    f.runtime.setEventSink((event, runtimeId) => {
      RuntimeEventSchema.parse(event);
      f.events.push({ event: structuredClone(event), runtimeId });
      if ((event.type === "session.patch" || event.type === "session.snapshot") && !model.accept(scope, event)) rejected.push(event);
    });
    f.list([f.live("browser", true)]); await f.runtime.start();
    const record = (seq: number, type = "custom") => ({ event: { seq, time: 1000 + seq, type, data: {} } });
    f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: 12,
      records: [record(10), record(11), record(12, "turn/end")], assistantStream: { revision: 0 } });
    for (const syncId of ["preview-1", "preview-2"]) {
      f.runtime.dispatchCommand("dsh:browser", syncId, { type: "session.sync", sessionId: "dsh:browser", syncId, range: "preview" });
      await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === syncId)).toBe(true));
    }
    expect(model.hasBaseline(scope)).toBe(true);
    f.request.mockImplementation(async method => method === "session/page" ? { records: Array.from({ length: 10 }, (_, seq) => record(seq)) } : {});
    f.runtime.dispatchCommand("dsh:browser", "history", { type: "session.sync", sessionId: "dsh:browser", syncId: "history", range: "history", beforeEntryId: "dsh:browser:web:10" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "history")).toBe(true));
    expect(rejected).toEqual([]);
    expect(model.hasBaseline(scope)).toBe(true);
  });

  it("keeps a ready baseline when the running turn started before the bounded follow tail", async () => {
    // ADR-0043：有界 tail 里没有本轮 `turn/start` 只说明起点不在这一页。把它当成「清单不完整」
    // 会让 checkpoint 不再是基线：Host 丢掉 canonical、手机不能投影也不能应用 patch，
    // 运行期间的历史整段消失。live 正文来自 assistantStream 的完整前缀，缺口另有 #checkSource。
    const f = discoveryFixture();
    const model = new AgentConversationState(new AgentStateRegistry());
    const scope: StateScope = { kind: "agent", key: { hostId: "isolated", agentKind: "dsh", sessionId: "dsh:long" } };
    const rejected: RuntimeEvent[] = [];
    f.runtime.setEventSink((event, runtimeId) => {
      RuntimeEventSchema.parse(event);
      f.events.push({ event: structuredClone(event), runtimeId });
      if ((event.type === "session.patch" || event.type === "session.snapshot") && !model.accept(scope, event)) rejected.push(event);
    });
    f.list([f.live("long", true)]); await f.runtime.start();
    const record = (seq: number, type = "custom") => ({ event: { seq, time: 1000 + seq, type, data: {} } });
    // 尾部窗口从本轮中间开始：既没有 turn/start，也没有 turn/end。
    f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: 42,
      records: [record(40), record(41), record(42, "tool/call")], assistantStream: { revision: 0 } });
    f.runtime.dispatchCommand("dsh:long", "preview", { type: "session.sync", sessionId: "dsh:long", syncId: "preview", range: "preview" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "preview")).toBe(true));
    const preview = f.events.find(({ event }) => event.type === "session.snapshot" && event.syncId === "preview")!.event;
    expect(preview).toMatchObject({ source: { ready: true }, live: { complete: true },
      checkpoint: { headCompleteness: "complete", inventoryComplete: true } });
    expect(rejected).toEqual([]);
    expect(model.hasBaseline(scope)).toBe(true);
  });

  it("keeps an in-flight preview alive across native connection replacement", async () => {
    const f = discoveryFixture(); f.list([f.live("recover", true)]); await f.runtime.start();
    const baseline = deferred<unknown>();
    const baseRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, args) => method === "session/page" ? baseline.promise : baseRequest(method, args));

    // A preview starts the first source check and waits for its follow baseline.
    f.runtime.dispatchCommand("dsh:recover", "preview-after-gap", {
      type: "session.sync", sessionId: "dsh:recover", syncId: "preview-after-gap", range: "preview",
    });
    await vi.waitFor(() => expect(f.follows().length).toBe(1));

    // Carrier reconnect replaces the pending follow while the preview owns its source check.
    f.client.onReconnect?.();
    f.subscriptions.find(subscription => subscription.method === "workspace/follow")!.frame({
      type: "baseline", value: { archivedSessionIds: [] },
    });
    await vi.waitFor(() => expect(f.follows().length).toBe(1));
    f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: -1,
      records: [], assistantStream: { revision: 0 } });
    baseline.resolve({ records: [] });

    await vi.waitFor(() => expect(f.events.some(({ event }) =>
      event.type === "session.snapshot" && event.syncId === "preview-after-gap")).toBe(true));
    expect(f.events.some(({ event }) => event.type === "command.result" &&
      event.commandId === "preview-after-gap" && !event.ok)).toBe(false);
  });

  it("rebuilds retry and compaction from native durable events and settles only their explicit outcomes", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true)]); await f.runtime.start();
    const follow = f.follows()[0]!;
    const record = (seq: number, type: string, data: unknown) => ({ type: "event", event: { seq, type, time: seq + 1000, data } });
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 2, records: [
      record(0, "turn/start", { turn: 1 }),
      record(1, "compaction/start", { turn: 1, compactionId: "compact-1" }),
      record(2, "llm/retry", { turn: 1, retry: 2, retryId: "retry-1" }),
    ] });
    const activity = () => f.events.flatMap(item => item.event.type === "execution.activity" ? [item.event] : []).at(-1)!;
    expect(activity()).toEqual({ type: "execution.activity", retry: { phase: "running", turnId: "dsh:busy:web:0", attempt: 2 },
      compaction: { phase: "running", turnId: "dsh:busy:web:0" } });
    f.emit("api-session/status", "busy", false);
    expect(activity().retry).toMatchObject({ phase: "running" });
    follow.frame(record(3, "compaction/end", { turn: 1, compactionId: "compact-1", error: "summary failed" }));
    expect(activity().compaction).toEqual({ phase: "failed", turnId: "dsh:busy:web:0" });
    follow.frame(record(4, "assistant/message", { message: { id: "answer", content: [{ type: "text", text: "recovered" }] } }));
    expect(activity().retry).toEqual({ phase: "idle", turnId: "dsh:busy:web:0", attempt: 2 });
    f.runtime.announce();
    expect(activity().compaction).toEqual({ phase: "failed", turnId: "dsh:busy:web:0" });
  });

  it("recovers the native inbox including other frontends, fences old baselines and retains native cancellation ids", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true)]);
    const priorRequest = f.request.getMockImplementation()!;
    const inbox = { "next-turn": [{ id: "native-phone", source: { rpcId: "phone-id" }, content: [{ type: "text", text: "phone queued" }] }],
      "next-step": [{ id: "native-browser", source: { kind: "input" }, content: [{ type: "text", text: "browser steering" }] }] };
    let baseline: unknown = { asOfSeq: 10, values: { inbox } };
    f.request.mockImplementation((method, args) => method === "session/projections" ? Promise.resolve(baseline) : priorRequest(method, args));
    await f.runtime.start();
    const delivery = () => f.events.flatMap(item => item.event.type === "delivery.snapshot" ? [item.event] : []);
    await vi.waitFor(() => expect(delivery().at(-1)).toEqual({ type: "delivery.snapshot", complete: true, items: [
      { queueId: "phone-id", text: "phone queued", delivery: "followUp", state: "accepted" },
      { queueId: "native-browser", text: "browser steering", delivery: "steer", state: "accepted" },
    ] }));
    f.runtime.dispatchCommand("dsh:busy", "cancel", { type: "user_message.cancel", messageId: "phone-id" });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("session/updateQueue", { request: {
      sessionId: "busy", itemId: "native-phone", action: { kind: "remove" },
    } }));
    const control = f.subscriptions.find(item => item.method === "session/control")!;
    control.frame({ type: "projection", sessionId: "busy", key: "inbox", seq: 11, value: { "next-turn": [], "next-step": [] } });
    expect(delivery().at(-1)).toEqual({ type: "delivery.snapshot", items: [], complete: true });
    f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: -1, records: [],
      projections: { asOfSeq: 10, values: { inbox } } });
    expect(delivery().at(-1)?.items).toEqual([]);
    // A successful read with no inbox key still cannot prove the queue is empty.
    baseline = { asOfSeq: 12, values: {} };
    const count = delivery().length;
    f.runtime.announce(); await Promise.resolve(); await Promise.resolve();
    expect(delivery()).toHaveLength(count);
    expect(f.events).toContainEqual({ runtimeId: "dsh:busy", event: {
      type: "execution.activity", retry: "unavailable", compaction: "unavailable",
    } });
  });

  it("marks an oversized native inbox partial instead of claiming the truncated page is complete", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true)]); await f.runtime.start();
    const control = f.subscriptions.find(item => item.method === "session/control")!;
    control.frame({ type: "projection", sessionId: "busy", key: "inbox", seq: 20, value: {
      "next-turn": Array.from({ length: 257 }, (_, index) => ({ id: `queued-${index}`, content: [{ type: "text", text: "queued" }] })),
      "next-step": [],
    } });
    const snapshot = f.events.flatMap(item => item.event.type === "delivery.snapshot" ? [item.event] : []).at(-1)!;
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(256);
  });

  it("refreshes thinking choices on announce after model configuration changes", async () => {
    const f = discoveryFixture();
    let enabled = false;
    f.request.mockImplementation(async method => {
      if (method === "session/list") return { items: [f.live("busy", true)] };
      if (method === "session/modelCatalog") return { default: { provider: "custom", model: "same-id" }, groups: [
        { id: "other", models: [{ id: "same-id" }] },
        { id: "custom", models: [{ id: "same-id", ...(enabled ? { reasoning: { efforts: [{ id: "high", name: "High" }] } } : {}) }] },
      ] };
      return {};
    });
    await f.runtime.start();
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.model?.id).toBe("same-id"));
    enabled = true;
    f.runtime.announce();
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: "runtime.capabilities", capabilities: expect.objectContaining({ commands: expect.arrayContaining([
        expect.objectContaining({ name: "thinking", argument: expect.objectContaining({ options: [{ value: "high", label: "High" }] }) }),
      ]) }),
    }) })));
  });
  it("reads native title hints for busy, cold and archived sessions and resumes with the catalog title", async () => {
    const f = discoveryFixture();
    f.list([f.live("busy", true), { ...f.live("cold"), agentAvailable: false, projections: { kind: "cached", asOfSeq: 500, values: { title: "冷会话标题" } } }, f.live("archived")]);
    await f.runtime.start();
    expect(f.runtime.directoryEntries()[0]?.sessionName).toBe("Title busy");
    expect(await f.runtime.catalog()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "dsh:cold", name: "冷会话标题" })]));
    expect(await f.runtime.catalog(true)).toEqual([expect.objectContaining({ sessionId: "dsh:archived", name: "Title archived" })]);
    await f.runtime.activate({ type: "resume", sessionId: "dsh:cold" });
    expect(f.runtime.directoryEntries().find(item => item.sessionId === "dsh:cold")?.sessionName).toBe("冷会话标题");
    const follow = f.follows().find(item => (item.args.request as { address: { sessionId: string } }).address.sessionId === "cold")!;
    follow.frame({ type: "snapshot", header: { cwd: "D:/work", createdAt: 1000 }, cursor: -1, records: [], projections: { asOfSeq: 2, values: { title: "实时标题" } } });
    expect(f.runtime.directoryEntries().find(item => item.sessionId === "dsh:cold")?.sessionName).toBe("实时标题");
    expect((await f.runtime.catalog()).find(item => item.sessionId === "dsh:cold")?.name).toBe("实时标题");
  });

  it("resumes a blank browser draft that the sidebar deliberately hides", async () => {
    const f = discoveryFixture();
    // A brand new browser Session has no content yet: native `blank` is true.
    f.list([{ ...f.live("draft"), blank: true }]);
    await f.runtime.start();
    expect(f.runtime.directoryEntries()).toEqual([]);
    expect(await f.runtime.catalog()).toEqual([]);
    // The phone can still hold its id (last selection, fork, web link) and reopen it.
    await f.runtime.activate({ type: "resume", sessionId: "dsh:draft" });
    expect(f.runtime.directoryEntries().map(item => item.sessionId)).toEqual(["dsh:draft"]);
    expect(await f.runtime.catalog()).toEqual([]);
  });

  it("syncs title control baselines before discovery and fences stale updates and list hints", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true), f.live("idle")]);
    const starting = f.runtime.start();
    const control = f.subscriptions.find(item => item.method === "session/control")!;
    control.frame({ type: "baseline", value: { projections: { busy: { asOfSeq: 10, values: { title: "基线标题" } }, idle: { asOfSeq: 10, values: { title: "未打开的会话" } } } } });
    await starting;
    expect(f.runtime.directoryEntries()[0]?.sessionName).toBe("基线标题");
    control.frame({ type: "projection", sessionId: "busy", key: "title", seq: 12, value: "自动生成的标题" });
    control.frame({ type: "projection", sessionId: "busy", key: "title", seq: 11, value: "旧标题" });
    expect(f.runtime.directoryEntries()[0]?.sessionName).toBe("自动生成的标题");
    expect(await f.runtime.catalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "dsh:busy", name: "自动生成的标题" }),
      expect.objectContaining({ sessionId: "dsh:idle", name: "未打开的会话" }),
    ]));
    expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "runtime.metadata", metadata: expect.objectContaining({ sessionName: "自动生成的标题" }) }) }));
    control.frame({ type: "projection", sessionId: "busy", key: "title", seq: 13, value: null });
    expect(f.runtime.directoryEntries()[0]?.sessionName).toBeUndefined();
    expect((await f.runtime.catalog()).find(item => item.sessionId === "dsh:busy")?.name).toBe("");
    control.frame({ type: "projection", sessionId: "idle", key: "title", seq: 14, value: { invalid: true } });
    expect((await f.runtime.catalog()).find(item => item.sessionId === "dsh:idle")?.name).toBe("未打开的会话");
    f.list([{ ...f.live("busy", true), projections: { kind: "sequenced", asOfSeq: 1, values: { title: "重连标题" } } }]);
    f.client.onReconnect?.();
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.sessionName).toBe("重连标题"));
  });

  it("recovers a failed title control stream and clears absent title capabilities in complete baselines", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true), f.live("idle")]); await f.runtime.start();
    const control = f.subscriptions.find(item => item.method === "session/control")!;
    vi.useFakeTimers();
    try {
      control.fail!(new Error("control interrupted"));
      await vi.advanceTimersByTimeAsync(2_000);
      const replacement = f.subscriptions.filter(item => item.method === "session/control" && !item.closed).at(-1)!;
      expect(replacement).not.toBe(control);
      replacement.frame({ type: "baseline", value: { projections: { busy: { asOfSeq: 10, values: {} }, idle: { asOfSeq: 10, values: { title: "恢复后的目录标题" } } } } });
      expect(f.runtime.directoryEntries()[0]?.sessionName).toBeUndefined();
      expect((await f.runtime.catalog()).find(item => item.sessionId === "dsh:busy")?.name).toBe("");
      expect((await f.runtime.catalog()).find(item => item.sessionId === "dsh:idle")?.name).toBe("恢复后的目录标题");
    } finally { vi.useRealTimers(); }
  });

  it("syncs durable title events and normalized rename acknowledgements to the catalog", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    f.follows()[0]!.frame({ type: "event", event: { seq: 1, time: 1000, type: "session/title", data: { title: "日志中的标题" } } });
    expect(f.runtime.directoryEntries()[0]?.sessionName).toBe("日志中的标题");
    expect((await f.runtime.catalog())[0]?.name).toBe("日志中的标题");
    const base = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, args) => method === "session/rename" ? Promise.resolve({ title: "服务端规范化标题", seq: 2 }) : base(method, args));
    f.runtime.dispatchCommand("dsh:browser", "rename", { type: "slash.execute", name: "name", args: "请求的标题" });
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.sessionName).toBe("服务端规范化标题"));
    expect((await f.runtime.catalog())[0]?.name).toBe("服务端规范化标题");
  });

  it("reports the session's own model selection and thinking level instead of the deployment default", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true)]);
    const base = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, args) => {
      if (method === "session/modelCatalog") return { default: { provider: "custom", model: "gpt-6-astra" }, groups: [
        { id: "custom", name: "Custom", models: [{ id: "gpt-6-astra", name: "GPT-6 Astra" }] },
        { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash", reasoning: {
          efforts: [{ id: "high", name: "高" }, { id: "low", name: "低" }], defaultEffort: "high",
        } }] },
      ] };
      return base(method, args);
    });
    await f.runtime.start();
    // 还没有选择投影时，只有部署默认值可以显示。
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.model).toEqual({ provider: "custom", id: "gpt-6-astra", name: "GPT-6 Astra" }));
    expect(f.runtime.directoryEntries()[0]?.thinkingLevel).toBeUndefined();
    const control = f.subscriptions.find(item => item.method === "session/control")!;
    control.frame({ type: "projection", sessionId: "busy", key: "modelSelection", seq: 5, value: {
      lastUsed: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
      next: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
    } });
    const entry = () => f.runtime.directoryEntries()[0];
    expect(entry()?.model).toEqual({ provider: "deepseek-official", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" });
    expect(entry()?.thinkingLevel).toBe("high");
    expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "runtime.metadata",
      metadata: expect.objectContaining({ thinkingLevel: "high" }) }) }));
    // 重新读目录（手机重连时会做）不能把会话模型改回部署默认值。
    f.runtime.announce();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("session/modelCatalog", {}));
    await Promise.resolve();
    expect(entry()?.model?.id).toBe("deepseek-flash");
    // 迟到的旧投影不能覆盖更新的事实。
    control.frame({ type: "projection", sessionId: "busy", key: "modelSelection", seq: 4, value: {
      lastUsed: { provider: "custom", model: "gpt-6-astra" }, next: { provider: "custom", model: "gpt-6-astra" },
    } });
    expect(entry()?.model?.id).toBe("deepseek-flash");
    // 待生效的选择（next）优先于上次请求用的选择（lastUsed）。
    control.frame({ type: "projection", sessionId: "busy", key: "modelSelection", seq: 6, value: {
      lastUsed: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
      next: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "low" },
    } });
    expect(entry()?.thinkingLevel).toBe("low");
  });

  it("applies the selection carried by a follow snapshot for a resumed session", async () => {
    const f = discoveryFixture(); f.list([f.live("cold")]);
    const base = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, args) => {
      if (method === "session/modelCatalog") return { default: { provider: "custom", model: "gpt-6-astra" }, groups: [
        { id: "deepseek-official", models: [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash" }] },
      ] };
      return base(method, args);
    });
    await f.runtime.start();
    await f.runtime.activate({ type: "resume", sessionId: "dsh:cold" });
    const follow = f.follows().find(item => (item.args.request as { address: { sessionId: string } }).address.sessionId === "cold")!;
    follow.frame({ type: "snapshot", header: { cwd: "D:/work", createdAt: 1000 }, cursor: -1, records: [], projections: {
      asOfSeq: 3, values: { modelSelection: {
        lastUsed: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "medium" }, next: null,
      } },
    } });
    const entry = f.runtime.directoryEntries().find(item => item.sessionId === "dsh:cold");
    expect(entry?.model).toEqual({ provider: "deepseek-official", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" });
    expect(entry?.thinkingLevel).toBe("medium");
  });

  it("takes the normalized selection returned by /model and /thinking", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true)]);
    const base = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, args) => {
      if (method === "session/modelCatalog") return { default: { provider: "custom", model: "gpt-6-astra" }, groups: [
        { id: "custom", models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: { efforts: [{ id: "high", name: "高" }, { id: "max", name: "最高" }] } }] },
      ] };
      if (method === "session/selectModel") {
        const request = (args as { request: { provider: string; model: string; reasoningEffort?: string } }).request;
        return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : { reasoningEffort: "high" }) } };
      }
      return base(method, args);
    });
    await f.runtime.start();
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.model?.id).toBe("gpt-6-astra"));
    f.runtime.dispatchCommand("dsh:busy", "thinking", { type: "slash.execute", name: "thinking", args: "max" });
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.thinkingLevel).toBe("max"));
    f.runtime.dispatchCommand("dsh:busy", "model", { type: "slash.execute", name: "model", args: JSON.stringify({ provider: "custom", model: "gpt-6-astra", reasoningEffort: "high" }) });
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.thinkingLevel).toBe("high"));
  });

  it("exposes native permission choices, confirms writes, and rejects busy or unavailable changes", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]);
    const base = f.request.getMockImplementation()!;
    let profile = "workspace-write"; let seq = 10; let fail = false;
    f.request.mockImplementation(async (method, args) => {
      if (method === "permissionPresets/catalog") return { options: [{ value: "workspace-write", name: "Workspace" }, { value: "danger-full-access", name: "Full" }] };
      if (method === "session/projections") return { asOfSeq: seq, values: { permissions: { currentValue: profile } } };
      if (method === "commands/execute") {
        if (fail) return { result: { kind: "error", text: "native refusal" } };
        profile = "danger-full-access"; seq++;
        return { commandId: "native", result: { kind: "success" } };
      }
      return base(method, args);
    });
    await f.runtime.start();
    await vi.waitFor(() => expect(f.runtime.directoryEntries()[0]?.permissions?.profile).toBe(profile));
    expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "runtime.capabilities", capabilities: expect.objectContaining({ commands: expect.arrayContaining([expect.objectContaining({ name: "permission-preset" })]) }) }) }));
    const apply = (id: string, value: string) => f.runtime.dispatchCommand("dsh:browser", id, { type: "permissions.update", settingId: "permission-preset", value });
    const result = (id: string) => f.events.find(item => item.event.type === "command.result" && item.event.commandId === id)?.event;
    apply("busy", "danger-full-access");
    await vi.waitFor(() => expect(result("busy")).toMatchObject({ ok: false }));
    f.emit("api-session/status", "browser", false);
    apply("invalid", "arbitrary");
    await vi.waitFor(() => expect(result("invalid")).toMatchObject({ ok: false }));
    apply("write", "danger-full-access");
    await vi.waitFor(() => expect(result("write")).toMatchObject({ ok: true }));
    expect(f.request).toHaveBeenCalledWith("commands/execute", { agentId: "browser", line: "/permission danger-full-access", submittedAttachments: [] });
    expect(f.runtime.directoryEntries()[0]?.permissions).toMatchObject({ profile: "danger-full-access", sandbox: "unknown" });
    const control = f.subscriptions.find(item => item.method === "session/control")!;
    control.frame({ type: "projection", sessionId: "browser", key: "permissions", value: { currentValue: "workspace-write" }, seq: 12 });
    control.frame({ type: "projection", sessionId: "browser", key: "permissions", value: { currentValue: "danger-full-access" }, seq: 11 });
    expect(f.runtime.directoryEntries()[0]?.permissions?.profile).toBe("workspace-write");
    const follow = f.follows()[0]!;
    follow.frame({ type: "event", event: { seq: 0, time: 1, type: "sandbox/mode", data: { mode: "danger-full-access" } } });
    follow.frame({ type: "event", event: { seq: 1, time: 2, type: "approval/policy", data: { policy: "never" } } });
    expect(f.runtime.directoryEntries()[0]?.permissions).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
    fail = true; apply("refusal", "danger-full-access");
    await vi.waitFor(() => expect(result("refusal")).toMatchObject({ ok: false, error: "native refusal" }));
  });
  it("keeps recovery active until a valid current follow snapshot and isolates catalog recovery", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]);
    const base = f.request.getMockImplementation()!; let badSkills = true; let badModels = true;
    f.request.mockImplementation(async (method, args) => {
      if (method === "skills/list" && badSkills) throw new Error("skills unavailable");
      if (method === "session/modelCatalog" && badModels) throw new Error("models unavailable");
      return base(method, args);
    });
    await f.runtime.start();
    const codes = () => f.events.filter(({event}) => event.type === "notification.source").at(-1)!.event;
    await vi.waitFor(() => expect(codes()).toMatchObject({ notifications: expect.arrayContaining([
      expect.objectContaining({code: "dsh.skills"}), expect.objectContaining({code: "dsh.models"}),
    ]) }));
    const old = f.follows()[0]!; f.client.onReconnect?.();
    expect(codes()).toMatchObject({ notifications: expect.arrayContaining([expect.objectContaining({code: "dsh.recovery"})]) });
    const snapshot = { type: "snapshot", header: {createdAt: 1000, cwd: "D:/work"}, cursor: -1, records: [] };
    old.frame(snapshot);
    f.subscriptions.find(item => item.method === "workspace/follow")!.frame({ type: "baseline", value: {archivedSessionIds: []} });
    await vi.waitFor(() => expect(f.follows()).toHaveLength(1));
    f.follows()[0]!.frame({ type: "snapshot" });
    expect(codes()).toMatchObject({ notifications: expect.arrayContaining([expect.objectContaining({code: "dsh.recovery"})]) });
    f.follows()[0]!.frame(snapshot);
    expect(codes()).toMatchObject({ notifications: expect.not.arrayContaining([expect.objectContaining({code: "dsh.recovery"})]) });
    badSkills = false; f.runtime.syncNotifications("dsh:browser");
    await vi.waitFor(() => expect(codes()).toMatchObject({ notifications: [expect.objectContaining({code: "dsh.models"})] }));
    badModels = false; f.runtime.syncNotifications("dsh:browser");
    await vi.waitFor(() => expect(codes()).toMatchObject({ notifications: [] }));
  });
  it("only follows working ordinary Agents and keeps resumable cold and idle sessions in the catalog", async () => {
    const f = discoveryFixture();
    f.list([f.live("busy", true), f.live("idle"), { ...f.live("cold"), agentAvailable: false }, f.live("archived"), { ...f.live("child"), origin: "subagent" }]);
    await f.runtime.start();
    expect(f.runtime.directoryEntries()).toEqual([
      expect.objectContaining({ sessionId: "dsh:busy", status: "running", sessionName: "Title busy" }),
    ]);
    expect(f.follows()).toHaveLength(1);
    expect((await f.runtime.catalog()).map(item => item.sessionId)).toEqual(["dsh:busy", "dsh:idle", "dsh:cold"]);
    expect(f.request.mock.calls.some(([method]) => method === "session/create" || method === "workspace/create")).toBe(false);
    expect(f.metadata).toHaveBeenCalled();
  });

  it("does not add subagent runs or replacement blank drafts to the ordinary sidebar after each prompt", async () => {
    const f = discoveryFixture();
    const parent = f.live("parent", true);
    let rows: Record<string, unknown>[] = [parent];
    f.list(rows); await f.runtime.start();
    for (let turn = 1; turn <= 3; turn++) {
      rows = [...rows, { ...f.live(`child-${turn}`, true), origin: "subagent", parentSessionId: "parent", blank: false }, { ...f.live(`draft-${turn}`), blank: true }];
      f.list(rows);
      f.emit("api-session/added", rows.at(-2));
      f.emit("api-session/added", rows.at(-1));
      expect((await f.runtime.catalog()).map(item => item.sessionId)).toEqual(["dsh:parent"]);
      expect(f.runtime.directoryEntries().map(item => item.sessionId)).toEqual(["dsh:parent"]);
    }
    await expect(f.runtime.activate({ type: "resume", sessionId: "dsh:child-1" })).rejects.toThrow("找不到");
    expect(f.request.mock.calls.some(([method, args]) => method === "session/create" && (args as { request?: { sessionId?: string } }).request?.sessionId === "child-1")).toBe(false);
  });

  it("follows a browser Agent once it starts working, shares both directions, and keeps it online after it finishes", async () => {
    const f = discoveryFixture(); await f.runtime.start();
    f.emit("api-session/added", f.live("browser"));
    f.emit("api-session/added", f.live("browser"));
    expect(f.follows()).toHaveLength(0);
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    f.emit("api-session/status", "browser", true);
    expect(f.follows()).toHaveLength(1);
    expect(f.runtime.directoryEntries()[0]?.status).toBe("running");
    const follow = f.follows()[0]!;
    follow.frame({ type: "event", event: { seq: 0, time: 1000, type: "user/message", data: { role: "user", source: { kind: "user", rpcId: "web-1" }, content: [{ type: "text", text: "from browser" }] } } });
    expect(f.events).toContainEqual(expect.objectContaining({ runtimeId: "dsh:browser", event: expect.objectContaining({ type: "session.patch", entries: [expect.objectContaining({ data: { message: expect.objectContaining({ content: [{ type: "text", text: "from browser" }] }) } })], live: expect.objectContaining({ messages: [] }) }) }));
    expect(f.runtime.dispatchCommand("dsh:browser", "mobile-1", { type: "user_message", text: "from phone", messageId: "mobile-1" })).toBe("handled");
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("session/prompt", { request: expect.objectContaining({ sessionId: "browser", content: [{ type: "text", text: "from phone" }] }) }));
    f.emit("api-session/status", "browser", false);
    expect(f.runtime.directoryEntries()[0]?.status).toBe("idle");
    f.emit("api-session/removed", "browser");
    expect(f.runtime.directoryEntries()).toEqual([]);
    expect(f.offline).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ runtimeId: "dsh:browser" })]);
    const count = f.events.length;
    follow.frame({ type: "event", event: { seq: 1, time: 1001, type: "turn/start", data: { turn: 1 } } });
    expect(f.events).toHaveLength(count);
  });

  it("reconciles missed additions and removals when the Web connection reconnects", async () => {
    const f = discoveryFixture(); f.list([f.live("old", true)]); await f.runtime.start();
    f.list([f.live("new", true), { ...f.live("old"), agentAvailable: false }]);
    f.client.onReconnect?.();
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    await vi.waitFor(() => expect(f.runtime.directoryEntries().map(item => item.sessionId)).toEqual(["dsh:new"]));
    expect(f.follows()).toHaveLength(1);
    expect(f.offline).toHaveBeenCalled();
  });

  it("does not let an older list response undo notifications received during that request", async () => {
    const f = discoveryFixture(); f.list([f.live("old")]); await f.runtime.start();
    const pending = deferred<unknown>();
    f.request.mockImplementationOnce(() => pending.promise);
    f.client.onReconnect?.();
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    expect(f.follows()).toHaveLength(0);
    f.emit("api-session/removed", "old");
    f.emit("api-session/added", f.live("new", true));
    pending.resolve({ items: [f.live("old")] });
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(4));
    expect(f.runtime.directoryEntries().map(item => item.sessionId)).toEqual(["dsh:new"]);
    expect(f.follows()).toHaveLength(1);
  });

  it("waits for the fresh archive baseline before following Agents after reconnect", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    f.client.onReconnect?.();
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(2));
    expect(f.follows()).toHaveLength(0);
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: ["browser"] } });
    expect(f.follows()).toHaveLength(0);
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
  });

  it("reloads failed skills and model reads after the native session is verified on reconnect", async () => {
    const f = discoveryFixture();
    const baseRequest = f.request.getMockImplementation()!;
    let unavailable = true;
    f.request.mockImplementation((method, args) => {
      if (unavailable && ["skills/list", "session/modelCatalog"].includes(method)) return Promise.reject(new Error("DSH Web is disconnected"));
      return baseRequest(method, args);
    });
    f.list([f.live("browser", true)]); await f.runtime.start();
    const notifications = () => f.events.map(({ event }) => event).filter(event => event.type === "notification.source").at(-1)?.notifications ?? [];
    await vi.waitFor(() => expect(notifications().map(item => item.code)).toEqual(expect.arrayContaining(["dsh.skills", "dsh.models"])));
    unavailable = false;
    const skillsReads = () => f.request.mock.calls.filter(([method]) => method === "skills/list").length;
    const before = skillsReads();
    f.client.onReconnect?.();
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(2));
    expect(skillsReads()).toBe(before);
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    await vi.waitFor(() => expect(skillsReads()).toBe(before + 1));
    await vi.waitFor(() => expect(notifications().map(item => item.code)).not.toEqual(expect.arrayContaining(["dsh.skills", "dsh.models"])));
    expect(notifications().some(item => ["dsh.skills", "dsh.models"].includes(item.code))).toBe(false);
  });

  it("keeps a pending preview behind native membership and archive verification on reconnect", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: -1, records: [], assistantStream: { revision: 0 } });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    try {
      f.runtime.dispatchCommand("dsh:browser", "pending-preview", {
        type: "session.sync", sessionId: "dsh:browser", syncId: "pending-preview", range: "preview",
      });
      expect(f.follows()).toHaveLength(1);
      f.client.onReconnect?.();
      expect(f.follows()).toHaveLength(0);
      await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(2));
      f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: ["browser"] } });
      expect(f.follows()).toHaveLength(0);
      await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "command.result" && event.commandId === "pending-preview" && !event.ok)).toBe(true));
    } finally { clock.mockRestore(); }
  });

  it("retries a failed follow only after rechecking that its native Agent is still live", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    vi.useFakeTimers();
    try {
      f.follows()[0]!.fail!(new Error("follow interrupted"));
      expect(f.follows()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.follows()).toHaveLength(1);
      f.follows()[0]!.fail!(new Error("follow ended"));
      f.list([{ ...f.live("browser"), agentAvailable: false }]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.follows()).toHaveLength(0);
      expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("mirrors browser archive changes and keeps a quit Agent detached until it works again or the APP reopens it", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const workspace = f.subscriptions.find(item => item.method === "workspace/follow")!;
    workspace.frame({ type: "archived", archivedSessionIds: ["browser"] });
    expect(f.runtime.directoryEntries()).toEqual([]);
    expect(f.archives).toHaveBeenCalledWith("dsh:browser", true);
    workspace.frame({ type: "archived", archivedSessionIds: [] });
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(true);
    f.runtime.dispatchCommand("dsh:browser", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false));
    // The work this Agent already had running is not new activity, so it stays detached.
    f.emit("api-session/added", f.live("browser", true));
    f.emit("api-session/status", "browser", true);
    f.client.onReconnect?.();
    workspace.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === "session/list")).toHaveLength(2));
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    workspace.frame({ type: "archived", archivedSessionIds: ["browser"] });
    workspace.frame({ type: "archived", archivedSessionIds: [] });
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    // New browser work revives it without an APP action, and an explicit APP reopen always works.
    f.emit("api-session/status", "browser", false);
    f.emit("api-session/status", "browser", true);
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(true);
    f.runtime.dispatchCommand("dsh:browser", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false));
    await f.runtime.activate({ type: "resume", sessionId: "dsh:browser" });
    expect(f.follows()).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === "workspace/archiveSession")).toBe(false);
  });

  it("stops a running Agent before detaching on /quit and confirms the command first", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const order: string[] = [];
    f.runtime.setEventSink(event => { if (event.type === "command.result") order.push("result"); });
    f.runtime.onOffline = () => order.push("offline");
    f.runtime.dispatchCommand("dsh:browser", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false));
    expect(f.request).toHaveBeenCalledWith("session/cancel", { request: { sessionId: "browser" } });
    // runtime.offline 会让 APP 把这个 runtime 上未完成的命令记成 cancelled，
    // 所以成功回执必须排在 detach 之前。
    expect(order).toEqual(["result", "offline"]);
    // 重开时沿用发现流里最后一次原生 running，而不是因为本地会话已 detach 就报「空闲」。
    await f.runtime.activate({ type: "resume", sessionId: "dsh:browser" });
    expect(f.runtime.directoryEntries()[0]?.status).toBe("running");
  });

  it("keeps a running Agent attached and visible when native cancellation fails", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const base = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, args) => method === "session/cancel"
      ? Promise.reject(new Error("cancel refused"))
      : base(method, args));
    f.runtime.dispatchCommand("dsh:browser", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: "command.result", commandId: "quit", ok: false,
    }) })));
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(true);
    expect(f.offline).not.toHaveBeenCalled();
  });

  it("reuses the browser-discovered subscription when an APP activation races its creation event", async () => {
    const f = discoveryFixture(); await f.runtime.start();
    f.list([f.live("browser")]);
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, args) => {
      if (method === "session/create") f.emit("api-session/added", f.live("browser"));
      return request(method, args);
    });
    await f.runtime.activate({ type: "resume", sessionId: "dsh:browser" });
    expect(f.follows()).toHaveLength(1);
    expect(f.subscriptions.filter(item => item.method === "session/follow")).toHaveLength(1);
  });

  it("ignores late discovery results and notifications after stop", async () => {
    const f = discoveryFixture();
    const pending = deferred<unknown>();
    f.request.mockImplementationOnce(() => pending.promise);
    const start = f.runtime.start();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("session/list", expect.anything()));
    await f.runtime.stop();
    pending.resolve({ items: [f.live("late")] }); await start;
    f.emit("api-session/added", f.live("later"));
    expect(f.runtime.directoryEntries()).toEqual([]);
    expect(f.follows()).toEqual([]);
    expect(f.subscriptions.every(item => item.closed)).toBe(true);
  });

  it("updates one live card per tool call before completion, including interleaved calls and empty name updates", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const follow = f.follows()[0]!;
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: -1, records: [] });
    follow.frame({ type: "assistant-stream", frame: { type: "start", attemptId: "attempt", time: 1001 } });
    const send = (id: string, argumentsDelta: string, name?: string) => follow.frame({ type: "assistant-stream",
      frame: { type: "chunk", attemptId: "attempt", chunk: { type: "tool-call-delta", id, argumentsDelta, ...(name ? { name } : {}) } } });
    const content = () => {
      const event = f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event;
      if (event?.type !== "session.patch") throw new Error("missing live patch");
      return event.live?.messages[0]?.message.content;
    };
    send("pwsh-1", '{"command":', "pwsh");
    send("pwsh-1", '"Get-');
    expect(content()).toEqual([{ type: "tool_call", toolCallId: "pwsh-1", toolName: "pwsh", arguments: '{"command":"Get-' }]);
    send("pwsh-2", '{"command":"pwd"}', "pwsh");
    send("pwsh-1", 'Location"}');
    send("pwsh-2", "", "functions.pwsh");
    expect(content()).toEqual([
      { type: "tool_call", toolCallId: "pwsh-1", toolName: "pwsh", arguments: '{"command":"Get-Location"}' },
      { type: "tool_call", toolCallId: "pwsh-2", toolName: "functions.pwsh", arguments: '{"command":"pwd"}' },
    ]);
  });

  it("combines live text and reasoning fragments while preserving whitespace and block boundaries", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const follow = f.follows()[0]!;
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: -1, records: [] });
    follow.frame({ type: "assistant-stream", frame: { type: "start", attemptId: "attempt", time: 1001 } });
    const chunks = [
      { type: "reasoning-delta", text: "先" },
      { type: "reasoning-delta", text: "检查。\n" },
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " " },
      { type: "text-delta", text: "world\n\n" },
      { type: "text-delta", text: "下一段。" },
      { type: "reasoning-delta", text: "再确认" },
      { type: "text-delta", text: "完成。" },
    ];
    chunks.forEach((chunk, index) => {
      follow.frame({ type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt", index, chunk } });
    });
    expect(f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event).toMatchObject({
      live: { messages: [expect.objectContaining({ message: expect.objectContaining({ content: [
        { type: "thinking", text: "先检查。\n" },
        { type: "text", text: "Hello world\n\n下一段。" },
        { type: "thinking", text: "再确认" },
        { type: "text", text: "完成。" },
      ] }) })] },
    });
  });

  it("restores an in-progress browser reply and replays it when the APP opens the discovered session", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const follow = f.follows()[0]!;
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 0,
      records: [{ type: "event", event: { seq: 0, time: 1000, type: "turn/start", data: { turn: 1 } } }],
      assistantStream: { revision: 2, activeAttempt: { attemptId: "attempt-1", turn: 1, step: 1, nextIndex: 1, startedAfterSeq: 0,
        stream: [{ time: 1001, chunk: { type: "text-delta", text: "already sent " } }] } } });
    follow.frame({ type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt-1", index: 1, chunk: { type: "text-delta", text: "and still streaming" } } });
    f.events.length = 0;
    f.runtime.dispatchCommand("dsh:browser", "sync", { type: "session.sync", sessionId: "dsh:browser", syncId: "sync", range: "preview" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot")).toBe(true));
    const restored = f.events.find(({ event }) => event.type === "session.snapshot")?.event;
    expect(restored).toMatchObject({ live: { messages: [expect.objectContaining({ message: expect.objectContaining({ messageId: "attempt-1", content: [{ type: "text", text: "already sent and still streaming" }] }) })] } });
    follow.frame({ type: "assistant-stream", frame: { type: "end", attemptId: "attempt-1", outcome: { kind: "committed", seq: 1 } } });
    // An ended but uncommitted attempt stays recoverable until its canonical record arrives.
    expect(f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event).toMatchObject({ live: { messages: [expect.objectContaining({ finished: true })] } });
    follow.frame({ type: "event", event: { seq: 1, time: 1090, type: "assistant/message", data: { message: { id: "native-1", content: [{ type: "text", text: "already sent and still streaming" }] } } } });
    const commit = f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event;
    expect(commit).toMatchObject({ entries: [expect.objectContaining({ entryId: "dsh:browser:web:1" })], live: { messages: [] } });
    follow.frame({ type: "event", event: { seq: 2, time: 1100, type: "turn/end", data: { turn: 1 } } });
    expect(f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event).toMatchObject({ live: { turn: expect.objectContaining({ durationMs: expect.any(Number) }), messages: [] } });
  });

  it("repairs silently missed native completion on a periodic check and rejects the replaced follow's late frames", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const opening = f.follows()[0]!;
    const record = (seq: number, type: string, data: unknown) => ({ event: { seq, time: 1000 + seq, type, data } });
    opening.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 0, records: [record(0, "turn/start", { turn: 1 })],
      assistantStream: { activeAttempt: { attemptId: "attempt", stream: [{ time: 1001, chunk: { type: "text-delta", text: "partial" } }] } } });
    const original = f.events.filter(({ event }) => event.type === "session.patch").at(-1)!.event;
    if (original.type !== "session.patch") throw new Error("missing baseline");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    try {
      f.runtime.dispatchCommand("dsh:browser", "check", { type: "session.sync", sessionId: "dsh:browser", syncId: "check", range: "preview",
        knownState: { epoch: original.source.epoch, seq: original.seq, head: original.head } });
      const fresh = f.follows()[0]!;
      expect(fresh).not.toBe(opening);
      // The native source contains completion, but its previous notifications never reached adapter.
      fresh.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 2, records: [record(0, "turn/start", { turn: 1 }),
        record(1, "assistant/message", { message: { id: "native", content: [{ type: "text", text: "complete" }] } }),
        record(2, "turn/end", { turn: 1 })], assistantStream: { revision: 3 } });
      await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "check")).toBe(true));
      const repaired = f.events.find(({ event }) => event.type === "session.snapshot" && event.syncId === "check")!.event;
      expect(repaired).toMatchObject({ source: { ready: true }, live: { complete: true, turn: null, messages: [] } });
      if (repaired.type !== "session.snapshot") throw new Error("missing repair");
      expect(repaired.entries.some(entry => entry.entryId === "dsh:browser:web:1")).toBe(true);
      const count = f.events.length;
      opening.frame({ type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt", chunk: { type: "text-delta", text: "late" } } });
      expect(f.events).toHaveLength(count);
      clock.mockReturnValue(Date.now() + 16_000);
      f.runtime.dispatchCommand("dsh:browser", "same", { type: "session.sync", sessionId: "dsh:browser", syncId: "same", range: "preview",
        knownState: { epoch: repaired.source!.epoch, seq: repaired.source!.seq, head: repaired.checkpoint!.head } });
      f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 2, records: [record(0, "turn/start", { turn: 1 }),
        record(1, "assistant/message", { message: { id: "native", content: [{ type: "text", text: "complete" }] } }),
        record(2, "turn/end", { turn: 1 })], assistantStream: { revision: 3 } });
      await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "same" && event.selection === "unchanged")).toBe(true));
    } finally { clock.mockRestore(); }
  });

  it("returns a verified bounded native tail without claiming its missing ancestors are cached", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const record = (seq: number, type = "custom") => ({ event: { seq, time: 1000 + seq, type, data: {} } });
    f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: 12,
      records: [record(10), record(11), record(12, "turn/end")], assistantStream: { revision: 0 } });
    f.runtime.dispatchCommand("dsh:browser", "tail", { type: "session.sync", sessionId: "dsh:browser", syncId: "tail", range: "preview" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "tail")).toBe(true));
    const tail = f.events.find(({ event }) => event.type === "session.snapshot" && event.syncId === "tail")!.event;
    expect(tail).toMatchObject({ entries: [expect.objectContaining({ entryId: "dsh:browser:web:10", parentId: "dsh:browser:web:9" }), expect.anything(), expect.anything()], hasOlder: true, complete: false, live: { complete: true } });
    f.request.mockImplementation(async method => method === "session/page" ? { records: Array.from({ length: 10 }, (_, seq) => record(seq)) } : {});
    f.runtime.dispatchCommand("dsh:browser", "history", { type: "session.sync", sessionId: "dsh:browser", syncId: "history", range: "history", beforeEntryId: "dsh:browser:web:10" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "history")).toBe(true));
    const history = f.events.find(({ event }) => event.type === "session.snapshot" && event.syncId === "history")!.event;
    expect(history).toMatchObject({ complete: true, hasOlder: false });
    if (history.type !== "session.snapshot") throw new Error("missing history");
    expect(history.live).toBeUndefined();
    expect(history.checkpoint).toBeUndefined();
    expect(history.entries).toHaveLength(10);
  });

  it("reads the native archive set and blocks switching during browser-only work", async () => {
    const request = vi.fn(async (method: string) => method === "session/list" ? { items: [
      { sessionId: "saved", cwd: "D:/work", updatedAt: 10, running: false },
      { sessionId: "browser", cwd: "D:/work", updatedAt: 20, running: true },
    ] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as unknown as DshWebConnection["request"],
      subscribe: (_method, _args, onFrame) => { queueMicrotask(() => onFrame({ type: "baseline", value: { archivedSessionIds: ["saved"] } })); return () => {}; },
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    expect((await runtime.catalog()).map(item => item.sessionId)).toEqual(["dsh:browser"]);
    expect((await runtime.catalog(true)).map(item => item.sessionId)).toEqual(["dsh:saved"]);
    await expect(runtime.assertProviderSwitchReady()).rejects.toThrow("浏览器会话正在工作");
  });

  it("reloads an edited provider live while a browser session is working, and still guards switches", async () => {
    const home = await mkdtemp(join(tmpdir(), "orbis-dsh-live-")); roots.push(home);
    const request = vi.fn(async (method: string) => method === "session/list" ? { items: [
      { sessionId: "browser", cwd: "D:/work", updatedAt: 20, running: true },
    ] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as unknown as DshWebConnection["request"],
      subscribe: vi.fn(() => () => {}), respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const env = { DSH_HOME: home };
    // 切换供应商（live 缺省）仍然要求空闲。
    await expect(runtime.reloadProviderConfiguration(env)).rejects.toThrow("浏览器会话正在工作");
    const calls = request.mock.calls.length;
    // 编辑当前在用的供应商必须能穿过准入检查，把新配置真正应用并校验。
    await expect(runtime.reloadProviderConfiguration(env, true)).resolves.toBeUndefined();
    expect(request.mock.calls.slice(calls).map(call => call[0])).not.toContain("session/list");
  });

  it("puts app-created sessions in the matching Web workspace and keeps quit separate from archive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-workspace-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "workspace/create") return { workspace: { workspaceId: "workspace-app", path: cwd } };
      if (method === "session/create") return { sessionId: "web-workspace" };
      return {};
    });
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as unknown as DshWebConnection["request"],
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => { follow = undefined; }; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => { RuntimeEventSchema.parse(event); events.push(event); });
    await runtime.activate({ type: "new", cwd });
    expect(request).toHaveBeenCalledWith("workspace/create", { request: { path: cwd } });
    expect(request).toHaveBeenCalledWith("session/create", { request: { workspaceId: "workspace-app" } });
    follow!({ type: "snapshot", header: { createdAt: 1000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });

    runtime.dispatchCommand("dsh:web-workspace", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "quit" && event.ok)).toBe(true));
    expect(request.mock.calls.some(([method]) => method === "workspace/archiveSession")).toBe(false);
    expect(runtime.ownsRuntime("dsh:web-workspace")).toBe(false);
  });

  it("archives an active Web runtime only through the sidebar archive operation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-archive-")); roots.push(cwd);
    const request = vi.fn(async (method: string) => method === "workspace/create"
      ? { workspace: { workspaceId: "workspace-archive", path: cwd } }
      : method === "session/create" ? { sessionId: "web-archive" } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as unknown as DshWebConnection["request"],
      subscribe: vi.fn(() => () => {}), respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    await runtime.activate({ type: "new", cwd });
    await runtime.setArchived("dsh:web-archive", true);
    expect(request).toHaveBeenCalledWith("workspace/archiveSession", { request: { sessionId: "web-archive" } });
    expect(runtime.ownsRuntime("dsh:web-archive")).toBe(false);
  });
  it("maps the shared Web session stream to Pi-shaped turns, tools, queue delivery, and IDs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-1" } } : method === "session/create" ? { sessionId: "web-1" } : method === "skills/list" ? { skills: [] } : {});
    const request = requestMock as unknown as DshWebConnection["request"];
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request,
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => { follow = undefined; }; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink((event) => { RuntimeEventSchema.parse(event); events.push(event); });
    await runtime.activate({ type: "new", cwd });
    follow!({ type: "snapshot", header: { createdAt: 1000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("skills/list", expect.anything()));
    expect(runtime.dispatchCommand("dsh:web-1", "send", { type: "user_message", messageId: "mobile-1", text: "hello", delivery: "followUp" })).toBe("handled");
    await vi.waitFor(() => expect(events.some(event => event.type === "message.queued" && event.state === "accepted")).toBe(true));
    const event = (seq: number, type: string, data: unknown, time = 1100) => follow!({ type: "event", event: { seq, type, time, data } });
    event(0, "turn/start", { turn: 1 });
    event(1, "user/message", { id: "u1", role: "user", source: { kind: "user", rpcId: "mobile-1" }, content: [{ type: "text", text: "hello" }] });
    event(2, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: '{"command":"echo ok"}' });
    event(3, "tool/result", { turn: 1, step: 1, message: { id: "tool-1", role: "tool", source: { kind: "tool", callId: "call-1" }, toolCallId: "call-1", content: [{ type: "text", text: "ok" }] } });
    event(4, "assistant/message", { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "done" }] }, stream: [] });
    event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }, 1200);
    const final = events.filter(item => item.type === "session.patch").at(-1);
    expect(final).toMatchObject({ live: { turn: expect.objectContaining({ durationMs: 100 }), messages: [], tools: [] }, head: { leafId: "dsh:web-1:web:5" } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.patch", live: expect.objectContaining({ tools: [expect.objectContaining({ toolCallId: "call-1", toolName: "bash", state: "started" })] }) }),
      expect.objectContaining({ type: "message.queued", queueId: "mobile-1", state: "delivered" }),
    ]));
    const committed = events.flatMap(item => item.type === "session.patch" ? item.entries ?? [] : []);
    expect(committed.find(entry => entry.entryId === "dsh:web-1:web:3")?.data.message).toMatchObject({ toolCallId: "call-1", isError: false });
    expect(request).toHaveBeenCalledWith("session/prompt", expect.objectContaining({ request: expect.objectContaining({ requestId: "mobile-1", mode: "queue" }) }));
  });

  it("rejects a reused message ID whose payload changed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-2" } } : method === "session/create" ? { sessionId: "web-2" } : {});
    const request = requestMock as unknown as DshWebConnection["request"];
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request,
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => {}; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    follow!({ type: "snapshot", header: { createdAt: 1000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });
    runtime.dispatchCommand("dsh:web-2", "first", { type: "user_message", messageId: "same", text: "one" });
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "first" && event.status === "success")).toBe(true));
    runtime.dispatchCommand("dsh:web-2", "second", { type: "user_message", messageId: "same", text: "two" });
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "second" && event.status === "message_id_conflict")).toBe(true));
    expect(requestMock.mock.calls.filter(call => call[0] === "session/prompt")).toHaveLength(1);
  });

  it("retains the durable prefix when follow reopens after a reconnect", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-reconnect" } } : method === "session/create"
      ? { sessionId: "web-reconnect" }
      : method === "session/page" ? { records: [] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: requestMock as unknown as DshWebConnection["request"],
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => {}; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    const record = (seq: number, type: string, data: unknown) => ({ type: "event", event: { seq, time: 1_000 + seq, type, data } });
    follow!({ type: "snapshot", header: { createdAt: 1_000, cwd }, cursor: 0, records: [record(0, "turn/start", { turn: 1 })], hasMore: false, projections: { asOfSeq: 0, values: {} }, assistantStream: { revision: 0 } });
    follow!(record(1, "user/message", { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] }));
    // A reconnect opening is only a bounded tail. The old seq 0 must survive it.
    follow!({ type: "snapshot", header: { createdAt: 1_000, cwd }, cursor: 2, records: [record(1, "user/message", { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] }), record(2, "turn/end", { turn: 1, reason: { kind: "completed" } })], hasMore: false, projections: { asOfSeq: 2, values: {} }, assistantStream: { revision: 0 } });
    runtime.dispatchCommand("dsh:web-reconnect", "sync", { type: "session.sync", sessionId: "dsh:web-reconnect", syncId: "sync", range: "preview" });
    await vi.waitFor(() => expect(events.some(event => event.type === "session.snapshot" && event.syncId === "sync")).toBe(true));
    const snapshot = [...events].reverse().find(event => event.type === "session.snapshot");
    expect(snapshot?.type === "session.snapshot" ? snapshot.entries.map(entry => entry.entryId) : []).toEqual([
      "dsh:web-reconnect:web:0", "dsh:web-reconnect:web:1", "dsh:web-reconnect:web:2",
    ]);
  });

  it("uses the empty-session cursor when syncing a new session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-empty" } } : method === "session/create"
      ? { sessionId: "web-empty" }
      : method === "session/page" ? { records: [] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: requestMock as unknown as DshWebConnection["request"],
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => {}; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    follow!({ type: "snapshot", header: { createdAt: 1_000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });
    runtime.dispatchCommand("dsh:web-empty", "sync", { type: "session.sync", sessionId: "dsh:web-empty", syncId: "sync", range: "preview" });
    await vi.waitFor(() => expect(events.some(event => event.type === "session.snapshot" && event.syncId === "sync")).toBe(true));
    expect(requestMock).toHaveBeenCalledWith("session/page", { request: expect.objectContaining({ throughSeq: -1 }) });
  });

  it("presents DSH questions, replays once, and retains failed submissions for retry", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const waterfall = { type: "waterfall" as const, event: "user-questions/request", eventId: "questions-1", agentId: "browser",
      request: { questions: [{ id: "mode", question: "选择模式", options: [{ label: "开发" }, { label: "发布" }] }, { id: "detail", question: "补充内容" }] } };
    f.client.onEvent?.(waterfall); f.client.onEvent?.(waterfall);
    expect(f.events.filter(({ event }) => event.type === "interaction.requested")).toHaveLength(1);
    f.runtime.announce();
    expect(f.events.filter(({ event }) => event.type === "interaction.snapshot").at(-1)?.event).toMatchObject({ requests: [expect.objectContaining({ kind: "questionnaire", requestId: "questions-1" })] });
    const response = { kind: "questionnaire" as const, answers: [{ id: "mode", values: ["0"] }, { id: "detail", values: [], other: "本地验证" }] };
    const respond = (commandId: string) => f.runtime.dispatchCommand("dsh:browser", commandId, { type: "interaction.respond", requestId: "questions-1", extensionId: "dsh", response });
    vi.mocked(f.client.respondEvent).mockRejectedValueOnce(new Error("transport unavailable"));
    respond("failed");
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "command.result", commandId: "failed", ok: false }) })));
    expect(f.events.some(({ event }) => event.type === "interaction.resolved")).toBe(false);
    respond("retry");
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ event: { type: "interaction.resolved", requestId: "questions-1", source: "remote" } })));
    expect(f.client.respondEvent).toHaveBeenLastCalledWith("questions-1", { kind: "result", value: { answers: [{ id: "mode", selected: ["开发"] }, { id: "detail", selected: [], custom: "本地验证" }] } });
  });

  it("claims timed questions before presenting them and releases claims on replay and timeout", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    vi.useFakeTimers();
    try {
      const waterfall = { type: "waterfall" as const, event: "user-questions/request", eventId: "timed-1", agentId: "browser",
        request: { questions: [{ id: "q", question: "继续？", options: [{ label: "继续" }] }], wait: { callId: "call-1", timed: true } } };
      f.client.onEvent?.(waterfall);
      const first = f.subscriptions.find(item => item.method === "userQuestions/attachWait")!;
      expect(first.args).toEqual({ agentId: "browser", callId: "call-1" });
      expect(f.events.some(({ event }) => event.type === "interaction.requested")).toBe(false);
      first.frame({ remainingMs: 1000 });
      expect(f.events.filter(({ event }) => event.type === "interaction.requested")).toHaveLength(1);
      f.client.onEvent?.(waterfall);
      expect(first.closed).toBe(true);
      const second = f.subscriptions.filter(item => item.method === "userQuestions/attachWait").at(-1)!;
      first.frame({ remainingMs: 1 }); second.frame({ remainingMs: 2000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.client.respondEvent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(second.closed).toBe(true);
      expect(f.client.respondEvent).toHaveBeenCalledWith("timed-1", { kind: "rejected", error: { name: "AbortError", message: "timeout", code: "ASK_TIMED_OUT" } });
    } finally { vi.useRealTimers(); }
  });

  it("cancels question UI with the native waterfall and delegates unsupported requests", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    f.client.onEvent?.({ type: "waterfall", event: "user-questions/request", eventId: "q", agentId: "browser", request: { questions: [{ id: "q", question: "输入" }] } });
    f.client.onEvent?.({ type: "cancel", eventId: "q" });
    expect(f.events).toContainEqual(expect.objectContaining({ event: { type: "interaction.cancelled", requestId: "q", reason: "cancelled" } }));
    f.client.onEvent?.({ type: "waterfall", event: "user-questions/request", eventId: "bad", agentId: "browser", request: { questions: [] } });
    expect(f.client.respondEvent).toHaveBeenCalledWith("bad", { kind: "next" });
  });

  it("publishes the durable log as a history tree and forks a branch from a chosen record", async () => {
    const f = discoveryFixture(); f.list([f.live("busy", true)]); await f.runtime.start();
    const follow = f.follows()[0]!;
    const record = (seq: number, type: string, data: unknown) => ({ type: "event", event: { seq, type, time: seq + 1000, data } });
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 3, records: [
      record(0, "turn/start", { turn: 1 }),
      record(1, "user/message", { id: "u1", content: [{ type: "text", text: "第一个问题" }] }),
      record(2, "assistant/message", { message: { id: "a1", content: [{ type: "text", text: "回答一" }] } }),
      record(3, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ] });
    const capabilities = () => f.events.flatMap(({ event }) => event.type === "runtime.capabilities" ? [event.capabilities] : []).at(-1)!;
    const tree = () => capabilities().commands.find(command => command.name === "tree");
    expect(tree()?.argument?.kind).toBe("tree");
    expect(tree()?.argument?.options?.map(option => option.value)).toEqual([
      "dsh:busy:web:0", "dsh:busy:web:1", "dsh:busy:web:2", "dsh:busy:web:3",
    ]);
    expect(tree()?.argument?.options?.find(option => option.tree?.role === "user")).toMatchObject({ label: "第一个问题" });
    expect(tree()?.argument?.options?.at(-1)?.tree).toMatchObject({ isCurrent: true, isOnActivePath: true, entryType: "turn/end", defaultHidden: true });

    // The tree rides on capabilities: an unchanged baseline must not re-send the whole thing.
    const count = () => f.events.filter(({ event }) => event.type === "runtime.capabilities").length;
    const unchanged = count();
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 3, records: [
      record(0, "turn/start", { turn: 1 }), record(1, "user/message", { id: "u1", content: [] }),
      record(2, "assistant/message", { message: { id: "a1", content: [] } }), record(3, "turn/end", { turn: 1 }),
    ] });
    f.runtime.dispatchCommand("dsh:busy", "sync-1", { type: "session.sync", sessionId: "dsh:busy", syncId: "sync-1", range: "catchup" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "command.result" && event.commandId === "sync-1")).toBe(true));
    expect(count()).toBe(unchanged);
    // A durable record that changes the log changes the tree.
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 4, records: [
      record(0, "turn/start", { turn: 1 }), record(1, "user/message", { id: "u1", content: [] }),
      record(2, "assistant/message", { message: { id: "a1", content: [] } }), record(3, "turn/end", { turn: 1 }),
      record(4, "user/message", { id: "u2", content: [{ type: "text", text: "第二个问题" }] }),
    ] });
    await vi.waitFor(() => expect(count()).toBeGreaterThan(unchanged));

    const base = f.request.getMockImplementation()!;
    const forkAt = (child: string) => f.request.mockImplementation((method, args) => method === "session/fork"
      ? Promise.resolve({ sessionId: child }) : base(method, args));
    const result = (commandId: string) => f.events.find(({ event }) => event.type === "command.result" && event.commandId === commandId)?.event;

    // A user message is edited before it: the branch inherits the prefix and the text goes back to the phone.
    forkAt("child-user");
    f.runtime.dispatchCommand("dsh:busy", "tree-user", { type: "slash.execute", name: "tree", args: "dsh:busy:web:1" });
    await vi.waitFor(() => expect(result("tree-user")).toMatchObject({ ok: true }));
    expect(result("tree-user")).toMatchObject({ result: { sessionId: "dsh:child-user", editorText: "第一个问题" } });
    expect(f.request).toHaveBeenCalledWith("session/fork", { request: { sessionId: "busy", atSeq: 0 } });
    // The branch is attached here so the phone's resume cannot race the native session directory.
    await vi.waitFor(() => expect(f.follows().some(item => (item.args.request as { address: { sessionId: string } }).address.sessionId === "child-user")).toBe(true));

    // Any other record continues from itself.
    forkAt("child-assistant");
    f.runtime.dispatchCommand("dsh:busy", "tree-assistant", { type: "slash.execute", name: "tree", args: "dsh:busy:web:2" });
    await vi.waitFor(() => expect(result("tree-assistant")).toMatchObject({ ok: true }));
    expect(result("tree-assistant")).toMatchObject({ result: { sessionId: "dsh:child-assistant" } });
    expect((result("tree-assistant") as { result: Record<string, unknown> }).result).not.toHaveProperty("editorText");
    expect(f.request).toHaveBeenCalledWith("session/fork", { request: { sessionId: "busy", atSeq: 2 } });

    f.runtime.dispatchCommand("dsh:busy", "tree-missing", { type: "slash.execute", name: "tree", args: "dsh:busy:web:99" });
    await vi.waitFor(() => expect(result("tree-missing")).toMatchObject({ ok: false, error: "找不到这条记录，请刷新会话后重试" }));
  });

  it("deduplicates a replayed approval after the Web carrier reconnects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-approval" } } : method === "session/create" ? { sessionId: "web-approval" } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: requestMock as unknown as DshWebConnection["request"],
      subscribe: vi.fn(() => () => {}),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    const waterfall = { type: "waterfall" as const, event: "approval/request", eventId: "approval-1", agentId: "web-approval", request: {} };
    client.onEvent?.(waterfall);
    client.onEvent?.(waterfall);
    expect(events.filter(event => event.type === "interaction.requested")).toHaveLength(1);
    runtime.dispatchCommand("dsh:web-approval", "answer", {
      type: "interaction.respond", requestId: "approval-1", extensionId: "dsh", response: { kind: "select", value: "allowed-once" },
    });
    await vi.waitFor(() => expect(client.respondEvent).toHaveBeenCalledOnce());
  });
});
