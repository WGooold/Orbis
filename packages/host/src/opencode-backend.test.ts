import type { OpenCodeEvent } from "@opencode/client";
import { RuntimeEventSchema, type RuntimeEvent, type SessionSyncRequest } from "@orbis/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeBackend } from "./opencode-backend.js";
import { OpenCodeServiceConnection, type OpenCodeClient } from "./opencode-service-connection.js";
import type { NativeForm, NativeMessage, NativePermission } from "./opencode-projection.js";

const fixtureSessions = ["s1", "s2"];
const sessionInfo = (id: string, time: { busy?: number; idle?: number } = {}) => ({ id, title: `OpenCode ${id}`,
  location: { directory: `D:\\work\\${id}` }, time: { created: 1_000, updated: 2_000, ...time } });
const userMessage = (id: string, text = id): Extract<NativeMessage, { type: "user" }> => ({ id, type: "user", time: { created: 3_000 }, text });
const partialAssistant = (text: string): Extract<NativeMessage, { type: "assistant" }> => ({ id: "assistant", type: "assistant", agent: "build",
  model: { providerID: "provider", id: "model" }, time: { created: 3_530 }, content: [
    { type: "text", text }, { type: "tool", id: "tool-1", name: "read_file", time: { created: 3_550 },
      state: { status: "running", input: { path: "PRIVATE_INPUT" }, metadata: { value: "PRIVATE_META" } }, native: { sensitive: "PRIVATE_TOOL_META" } as never },
  ] });

type EventArgs = { id?: string; type: string; data: unknown; created?: number };
function eventStream(signal: AbortSignal) {
  let pending: { resolve: (result: IteratorResult<OpenCodeEvent>) => void; reject: (error: Error) => void } | undefined;
  const buffer: OpenCodeEvent[] = [{ id: "hello", type: "server.connected", data: {} }];
  let ended = false;
  let failure: Error | undefined;
  const close = () => {
    ended = true;
    buffer.length = 0;
    pending?.resolve({ done: true, value: undefined });
    pending = undefined;
  };
  signal.addEventListener("abort", close, { once: true });
  const iterable: AsyncIterable<OpenCodeEvent> = { [Symbol.asyncIterator]: () => ({
    next: async () => {
      if (failure) throw failure;
      if (ended) return { done: true, value: undefined };
      const value = buffer.shift();
      if (value) return { done: false, value };
      return new Promise<IteratorResult<OpenCodeEvent>>((resolve, reject) => { pending = { resolve, reject }; });
    },
    return: async () => { close(); signal.removeEventListener("abort", close); return { done: true, value: undefined }; },
  }) };
  return {
    iterable, get closed() { return ended; },
    push(event: EventArgs) {
      const value = event as OpenCodeEvent;
      if (pending) { pending.resolve({ done: false, value }); pending = undefined; }
      else buffer.push(value);
    },
    fail() { failure = new Error("simulated overflow with PRIVATE_ERROR"); pending?.reject(failure); pending = undefined; },
  };
}

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function harness(args: { active?: boolean; messages?: NativeMessage[] } = {}) {
  type InboxUser = Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>;
  const locations = new Map<string, string>();
  const archived = new Set<string>();
  const native = { active: args.active ?? false, messages: args.messages ?? [], permissions: [] as NativePermission[], forms: [] as NativeForm[], online: true,
    createdIds: [] as string[], inbox: [] as InboxUser[], selectedModels: new Map<string, { id: string; providerID: string; variant?: string }>(),
    selectedAgents: new Map<string, string>(), permissionReplies: [] as Array<{ requestID: string; decision: string }>,
    formReplies: [] as Array<{ formID: string; answer: Record<string, string | number | boolean | string[]> }>,
    nextInboxId: 0, interrupted: args.active ?? false, onCancel: undefined as (() => void | Promise<void>) | undefined,
    mismatchModelReadback: false };
  const streams: Array<ReturnType<typeof eventStream>> = [];
  const events: RuntimeEvent[] = [];
  const onRuntimeOnline = vi.fn(), onRuntimeOffline = vi.fn(), onCatalogChange = vi.fn();
  const client = {
    server: { info: vi.fn(async () => ({ version: "2.3.2", pid: 1 })) },
    session: {
      active: vi.fn(async (): Promise<Record<string, { type: "running" }>> => native.active ? { s1: { type: "running" } } : {}),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
        if (!fixtureSessions.includes(sessionID) && !native.createdIds.includes(sessionID)) throw new Error("not found");
        return { ...sessionInfo(sessionID, { busy: 3500, ...(native.active ? {} : { idle: 4200 }) }),
          location: { directory: locations.get(sessionID) ?? sessionInfo(sessionID).location.directory },
          model: native.selectedModels.get(sessionID) ?? { id: "model", providerID: "provider" },
          ...(native.active ? {} : { outcome: "succeeded" }), agent: native.selectedAgents.get(sessionID) ?? "build" };
      }),
      create: vi.fn(async ({ location, model }: { location: { directory: string }; model?: { id: string; providerID: string; variant?: string } }) => {
        const id = "created-" + (native.createdIds.length + 1); native.createdIds.push(id);
        if (model) native.selectedModels.set(id, model);
        locations.set(id, location.directory);
        return { ...sessionInfo(id, { busy: 3500 }), location, ...(model ? { model } : {}) };
      }),
      update: vi.fn(async ({ sessionID, archived: isArchived }: { sessionID: string; archived: boolean }) => {
        if (isArchived) archived.add(sessionID); else archived.delete(sessionID);
      }),
      switchModel: vi.fn(async ({ sessionID, model }: { sessionID: string; model: { id: string; providerID: string; variant?: string } }) => {
        if (!native.mismatchModelReadback) native.selectedModels.set(sessionID, model);
      }),
      switchAgent: vi.fn(async ({ sessionID, agent }: { sessionID: string; agent: string }) => { native.selectedAgents.set(sessionID, agent); }),
      prompt: vi.fn(async ({ sessionID, text, delivery, metadata }: { sessionID: string; text: string; delivery?: string; metadata?: InboxUser["payload"]["metadata"] }) => {
        const item: InboxUser = { id: "inbox-" + (++native.nextInboxId), sessionID, time: { created: 5000 }, type: "user",
          payload: { text, ...(metadata === undefined ? {} : { metadata }) }, delivery: delivery === "steer" ? "steer" : "queue" };
        native.inbox.push(item); return item;
      }),
      interrupt: vi.fn(async () => ({ interrupted: native.interrupted })),
      inbox: {
        list: vi.fn(async () => native.inbox),
        cancel: vi.fn(async ({ inboxID }: { inboxID: string }) => {
          native.inbox = native.inbox.filter(item => item.id !== inboxID); await native.onCancel?.();
        }),
      },
      list: vi.fn(async ({ cursor, order }: { cursor?: string; order?: string } = {}) => {
        if (cursor && order) throw new Error("Cursor cannot be combined with order");
        return { data: [sessionInfo(cursor === "second" ? "s2" : "s1")], cursor: { next: cursor ? null : "second" as string | null } };
      }),
      message: { get: vi.fn(async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
        const message = native.messages.find(item => item.id === messageID);
        if (!message) throw { _tag: "MessageNotFoundError", sessionID, messageID, message: "not found" };
        return message;
      }) },
      form: {
        list: vi.fn(async () => native.forms), get: vi.fn(async ({ formID }: { formID: string }) => native.forms.find(form => form.id === formID)),
        reply: vi.fn(async ({ formID, answer }: { formID: string; answer: Record<string, string | number | boolean | string[]> }) => {
          native.formReplies.push({ formID, answer }); native.forms = native.forms.filter(form => form.id !== formID);
        }),
        cancel: vi.fn(async ({ formID }: { formID: string }) => { native.forms = native.forms.filter(form => form.id !== formID); }),
      },
    },
    message: { list: vi.fn(async ({ cursor, order }: { cursor?: string; order?: string } = {}) => {
      if (cursor && order) throw new Error("Cursor cannot be combined with order");
      const offset = cursor ? Number(cursor) : 0;
      const data = native.messages.slice(offset, offset + 200);
      return { data, cursor: { next: data.length ? String(offset + data.length) : null } };
    }) },
    permission: {
      list: vi.fn(async () => native.permissions),
      reply: vi.fn(async ({ requestID, decision }: { requestID: string; decision: string }) => {
        native.permissionReplies.push({ requestID, decision }); native.permissions = native.permissions.filter(item => item.id !== requestID);
      }),
    },
    model: {
      list: vi.fn(async () => ({ data: [{ id: "model", providerID: "provider", enabled: true, name: "Test model", variants: [{ id: "high" }] }] })),
      default: vi.fn(async () => ({ data: { id: "model", providerID: "provider" } })),
    },
    agent: { list: vi.fn(async () => ({ data: [{ id: "build", name: "Build", hidden: false, mode: "primary" }] })) },
    event: { subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => {
      const stream = eventStream(signal); streams.push(stream); return stream.iterable;
    }) },
  };
  const connection = new OpenCodeServiceConnection({ discover: async () => native.online ? { url: "http://127.0.0.1:4096" } : undefined,
    createClient: () => client as unknown as OpenCodeClient });
  const backend = new OpenCodeBackend({ connection, hostId: "host-test", onRuntimeOnline, onRuntimeOffline, onCatalogChange,
    onEvent: (_id, event) => events.push(RuntimeEventSchema.parse(event)), onAvailabilityChange: vi.fn(), reconnectMs: 1 });
  cleanup.push(() => { backend.close(); connection.close(); });
  backend.start();
  await connection.refresh();
  await vi.waitFor(() => expect(backend.isReady()).toBe(true));
  const sync = (request: Partial<Omit<SessionSyncRequest, "type" | "sessionId" | "syncId">> = {}) => {
    const syncId = `sync-${events.length}`;
    expect(backend.dispatchCommand("opencode:s1", syncId, { type: "session.sync", sessionId: "s1", syncId, range: "preview", ...request })).toBe("handled");
    const snapshot = events.find(item => item.type === "session.snapshot" && item.syncId === syncId);
    if (snapshot?.type !== "session.snapshot") throw new Error("missing snapshot");
    return snapshot;
  };
  const dispatch = async (commandId: string, command: Parameters<typeof backend.dispatchCommand>[2], runtimeId = "opencode:s1") => {
    expect(backend.dispatchCommand(runtimeId, commandId, command)).toBe("handled");
    await vi.waitFor(() => expect(events.some(item => item.type === "command.result" && item.commandId === commandId)).toBe(true));
    return events.find(item => item.type === "command.result" && item.commandId === commandId)!;
  };
  return { connection, backend, client, native, events, streams, onRuntimeOnline, onRuntimeOffline, onCatalogChange, sync, dispatch, archived };
}

describe("OpenCode catalog and Agent state", () => {
  it("loads every catalog page and bounds a repeated cursor", async () => {
    const h = await harness();
    await expect(h.backend.catalog(true)).resolves.toMatchObject([{ sessionId: "s1", archived: true }, { sessionId: "s2", archived: true }]);
    expect(h.client.session.list.mock.calls.map(([arg]) => arg?.cursor)).toEqual([undefined, "second"]);
    h.client.session.list.mockResolvedValue({ data: [], cursor: { next: "repeat" } });
    await expect(h.backend.catalog()).rejects.toThrow("repeated cursor");
  });

  it("pages long history without re-reading native history for each window", async () => {
    const h = await harness({ messages: Array.from({ length: 660 }, (_, i) => userMessage(`m${i}`)) });
    await expect(h.backend.activate({ type: "resume", sessionId: "s1" })).resolves.toEqual({ sessionId: "s1", spawnMode: "headless" });
    const first = h.sync({ maxEntries: 17 });
    expect(first.cursor.leafId).toBe("m659");
    const entries = [...first.entries];
    let page = first;
    while (page.hasOlder) {
      page = h.sync({ range: "history", targetLeafId: first.cursor.leafId, beforeEntryId: page.entries[0]!.entryId, maxEntries: 30 });
      expect(page.entries.length).toBeGreaterThan(0);
      entries.unshift(...page.entries);
    }
    expect(entries.map(entry => entry.entryId)).toEqual(h.native.messages.map(message => message.id));
    expect(h.client.message.list.mock.calls.map(([arg]) => arg?.cursor)).toEqual([undefined, "200", "400", "600", "660"]);
    await expect(h.backend.readSessionEntry("opencode:s1", "s1", "m42")).resolves.toMatchObject({ parentId: "m41" });
    expect(h.sync({ knownState: { epoch: first.source!.epoch, seq: first.source!.seq, head: first.cursor } }).selection).toBe("unchanged");
  });

  it("refreshes live text and tool summaries, and preserves turn identity on completion", async () => {
    const h = await harness({ active: true, messages: [userMessage("user"), partialAssistant("pending")] });
    const initial = h.sync();
    expect(initial.cursor.leafId).toBe("user");
    expect(initial.live?.messages[0]?.message.messageId).toBe("assistant");
    expect(initial.live?.tools[0]?.summary?.phase).toBe("running");
    const turnId = initial.live?.turn?.turnId;
    const listReads = h.client.message.list.mock.calls.length;
    h.native.messages = [userMessage("user"), partialAssistant("updated")];
    h.streams[0]!.push({ type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "assistant", delta: "not reapplied" } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "session.patch" && item.live.messages[0]?.message.content[0]?.type === "text" &&
      item.live.messages[0].message.content[0].text === "updated")).toBe(true));
    expect(h.client.message.list).toHaveBeenCalledTimes(listReads);
    const final = partialAssistant("complete");
    final.time.completed = 4_200;
    const tool = final.content[1];
    if (tool?.type !== "tool") throw new Error("fixture tool missing");
    tool.state = { status: "completed", input: { path: "PRIVATE_INPUT" }, content: [{ type: "text", text: "PRIVATE_OUTPUT" } as never] };
    h.native.active = false;
    h.native.messages = [userMessage("user"), final];
    h.streams[0]!.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "session.patch" && item.live.turn?.outcome === "completed")).toBe(true));
    const snapshot = h.sync();
    expect(snapshot.live?.turn).toMatchObject({ turnId, outcome: "completed" });
    expect(snapshot.cursor.leafId).toBe("assistant");
    const wire = JSON.stringify(h.events);
    expect(wire).not.toMatch(/PRIVATE|not reapplied/);
    expect(wire).toContain('"readCapability":"none"');
  });

  it("retires the old source and reads native state again after an event overflow", async () => {
    const h = await harness({ active: true, messages: [userMessage("before")] });
    const old = h.sync();
    h.native.active = false;
    h.native.messages.push(userMessage("during-disconnect"));
    h.streams[0]!.fail();
    await vi.waitFor(() => {
      expect(h.streams).toHaveLength(2);
      expect(h.onRuntimeOffline).toHaveBeenCalledWith("opencode:s1", "event_stream_disconnected");
      expect(h.backend.isReady()).toBe(true);
    });
    const recovered = h.sync();
    expect(recovered.source?.epoch).not.toBe(old.source?.epoch);
    expect(recovered.cursor.leafId).toBe("during-disconnect");
    expect(recovered.live?.turn?.outcome).toBe("completed");
    expect(h.streams[0]!.closed).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain("PRIVATE_ERROR");
  });

  it("publishes pending permission and supported form facts from native state, then removes them", async () => {
    const h = await harness({ active: true });
    h.native.permissions = [{ id: "p1", sessionID: "s1", action: "read", resources: ["PRIVATE_PATH"], metadata: { key: "PRIVATE_META" } }];
    h.native.forms = [{ id: "f1", sessionID: "s1", state: { status: "pending" }, title: "Continue?",
      fields: [{ key: "proceed", type: "boolean" }] }];
    h.streams[0]!.push({ type: "permission.asked", data: { sessionID: "s1" } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "interaction.snapshot" && item.requests.length === 2)).toBe(true));
    expect(JSON.stringify(h.events)).not.toMatch(/PRIVATE_PATH|PRIVATE_META/);
    h.native.permissions = [];
    h.native.forms = [];
    h.streams[0]!.push({ type: "form.replied", data: { id: "f1", sessionID: "s1", answer: { proceed: true } } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "interaction.snapshot" && !item.requests.length)).toBe(true));
  });

  it("creates with a validated native model, resumes the exact session, and confirms later model and agent selections", async () => {
    const h = await harness();
    const cwd = process.cwd();
    const catalog = await h.backend.sessionConfiguration(cwd);
    const model = catalog.models[0]!;
    const created: Array<{ sessionId: string; spawnMode?: string }> = [];
    const activation = await h.backend.activate({ type: "new", cwd }, {
      configuration: { model: model.value, thinking: "high" }, onCreated: async result => { if (result.sessionId) created.push({ sessionId: result.sessionId, spawnMode: result.spawnMode }); },
    });
    expect(activation.sessionId).toBe("created-1");
    expect(created).toEqual([{ sessionId: "created-1", spawnMode: "headless" }]);
    expect(h.client.session.create).toHaveBeenCalledWith(expect.objectContaining({ location: { directory: cwd },
      model: { id: "model", providerID: "provider", variant: "high" } }), expect.anything());
    const createdSessionId = activation.sessionId;
    if (!createdSessionId) throw new Error("OpenCode create returned no session ID");
    await expect(h.backend.activate({ type: "resume", sessionId: createdSessionId }, { configuration: { model: model.value } }))
      .resolves.toEqual({ sessionId: "created-1", spawnMode: "headless" });
    expect(h.client.session.create).toHaveBeenCalledTimes(1);
    await h.backend.setArchived(createdSessionId, true);
    expect(h.archived.has(createdSessionId)).toBe(true);
    await h.backend.setArchived(createdSessionId, false);
    expect(h.archived.has(createdSessionId)).toBe(false);

    const switchedModel = await h.dispatch("select-model", { type: "slash.execute", name: "model", args: model.value }, "opencode:created-1");
    expect(switchedModel).toMatchObject({ ok: true, status: "success" });
    const switchedAgent = await h.dispatch("select-agent", { type: "slash.execute", name: "agent", args: "build" }, "opencode:created-1");
    expect(switchedAgent).toMatchObject({ ok: true, status: "success" });
    expect(h.client.session.switchAgent).toHaveBeenCalledWith({ sessionID: "created-1", agent: "build" }, expect.anything());
    expect(h.events.some(item => item.type === "runtime.capabilities" && item.capabilities.commands.some(command => command.name === "thinking"))).toBe(true);
  });

  it("preserves App message identity and distinguishes cancellation from a concurrent native delivery", async () => {
    const h = await harness();
    await h.backend.activate({ type: "resume", sessionId: "s1" });
    const accepted = await h.dispatch("send-1", { type: "user_message", text: "hello", delivery: "followUp", messageId: "app-message-1" });
    expect(accepted).toMatchObject({ ok: true, status: "success" });
    const inbox = h.native.inbox[0]!;
    expect(inbox.payload.metadata?.["orbis.clientMessageId"]).toBe("app-message-1");
    expect(h.events).toContainEqual(expect.objectContaining({ type: "message.queued", state: "accepted", queueId: "app-message-1", text: "hello" }));
    // The API returns 204 for a delivery conflict before SSE necessarily arrives.
    h.native.onCancel = () => {
      h.native.messages.push({ ...userMessage(inbox.id, inbox.payload.text), metadata: { ...inbox.payload.metadata } });
    };
    const raced = await h.dispatch("cancel-raced", { type: "user_message.cancel", messageId: "app-message-1" });
    expect(raced).toMatchObject({ ok: false, status: "already_delivered", error: "message_already_delivered" });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "message.queued", state: "delivered", queueId: "app-message-1" }));
    await vi.waitFor(async () => expect(await h.backend.readSessionEntry("opencode:s1", "s1", inbox.id)).toMatchObject({
      data: { message: { messageId: inbox.id, clientMessageId: "app-message-1" } },
    }));

    h.native.onCancel = undefined;
    await h.dispatch("send-2", { type: "user_message", text: "remove", messageId: "app-message-2" });
    const cancelled = await h.dispatch("cancel-2", { type: "user_message.cancel", messageId: "app-message-2" });
    expect(cancelled).toMatchObject({ ok: true, status: "cancelled" });
    expect(h.events.some(item => item.type === "message.queued" && item.state === "cancelled")).toBe(true);
  });

  it("reports stop as not-cancelable when native interrupt confirms no running turn", async () => {
    const h = await harness();
    await h.backend.activate({ type: "resume", sessionId: "s1" });
    h.native.interrupted = false;
    const idle = await h.dispatch("stop-idle", { type: "stop" });
    expect(idle).toMatchObject({ ok: false, status: "not_cancelable", error: "turn_not_running" });
    h.native.interrupted = true;
    const running = await h.dispatch("stop-running", { type: "stop" });
    expect(running).toMatchObject({ ok: true, status: "success" });
    expect(h.client.session.interrupt).toHaveBeenCalledTimes(2);
  });

  it("maps one-time permission replies and validates questionnaire values before native writes", async () => {
    const h = await harness({ active: true });
    h.native.permissions = [
      { id: "p-once", sessionID: "s1", action: "read", resources: [] },
      { id: "p-remote", sessionID: "s1", action: "write", resources: [] },
      { id: "p-reject", sessionID: "s1", action: "write", resources: [] },
    ] as NativePermission[];
    const form = (id: string, fields: unknown[]) => ({ id, sessionID: "s1", state: { status: "pending" }, title: "Answer", fields }) as unknown as NativeForm;
    h.native.forms = [
      form("f-valid", [
        { key: "confirm", title: "Confirm", type: "boolean", required: true },
        { key: "count", title: "Count", type: "integer", minimum: 1, maximum: 5, required: true },
        { key: "tags", title: "Tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], minItems: 1, maxItems: 2 },
      ]),
      form("f-invalid", [{ key: "count", title: "Count", type: "integer", minimum: 1, maximum: 5, required: true }]),
      form("f-cancel", [{ key: "proceed", title: "Proceed", type: "boolean" }]),
    ];
    h.streams[0]!.push({ type: "permission.asked", data: { sessionID: "s1" } });
    h.streams[0]!.push({ type: "form.created", data: { form: { id: "f-valid", sessionID: "s1" } } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "interaction.snapshot" && item.requests.length === 6)).toBe(true));

    await expect(h.dispatch("allow-once", { type: "interaction.respond", requestId: "p-once", extensionId: "opencode.permission",
      response: { kind: "confirm", value: true } })).resolves.toMatchObject({ ok: true, status: "success" });
    expect(h.native.permissionReplies).toContainEqual({ requestID: "p-once", decision: "once" });
    await expect(h.dispatch("reject", { type: "interaction.respond", requestId: "p-reject", extensionId: "opencode.permission",
      response: { kind: "confirm", value: false } })).resolves.toMatchObject({ ok: true, status: "success" });
    expect(h.native.permissionReplies).toContainEqual({ requestID: "p-reject", decision: "reject" });
    await expect(h.dispatch("answer-valid", { type: "interaction.respond", requestId: "f-valid", extensionId: "opencode.form",
      response: { kind: "questionnaire", answers: [
        { id: "confirm", values: ["true"] }, { id: "count", values: ["3"] }, { id: "tags", values: ["a", "b"] },
      ] } })).resolves.toMatchObject({ ok: true, status: "success" });
    expect(h.native.formReplies).toContainEqual({ formID: "f-valid", answer: { confirm: true, count: 3, tags: ["a", "b"] } });
    await expect(h.dispatch("answer-invalid", { type: "interaction.respond", requestId: "f-invalid", extensionId: "opencode.form",
      response: { kind: "questionnaire", answers: [{ id: "count", values: ["999"] }] } }))
      .resolves.toMatchObject({ ok: false, status: "failure", error: "invalid_interaction_response" });
    expect(h.native.formReplies.some(item => item.formID === "f-invalid")).toBe(false);
    await expect(h.dispatch("cancel-form", { type: "interaction.respond", requestId: "f-cancel", extensionId: "opencode.form",
      response: { kind: "cancel" } })).resolves.toMatchObject({ ok: true, status: "cancelled" });

    h.native.permissions = h.native.permissions.filter(item => item.id !== "p-remote");
    h.streams[0]!.push({ type: "permission.replied", data: { sessionID: "s1", requestID: "p-remote", reply: { decision: "reject" } } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "interaction.resolved" && item.requestId === "p-remote" && item.source === "local")).toBe(true));
  });

  it("publishes explicit cancellation and resolution events from OpenCode", async () => {
    const h = await harness({ active: true });
    h.native.forms = [
      { id: "f-replied", sessionID: "s1", state: { status: "pending" }, title: "Reply", fields: [{ key: "x", type: "boolean" }] },
      { id: "f-cancelled", sessionID: "s1", state: { status: "pending" }, title: "Cancel", fields: [{ key: "x", type: "boolean" }] },
    ] as NativeForm[];
    h.streams[0]!.push({ type: "form.created", data: { form: { id: "f-replied", sessionID: "s1" } } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "interaction.snapshot" && item.requests.length === 2)).toBe(true));
    h.native.forms = h.native.forms.filter(item => item.id !== "f-replied");
    h.streams[0]!.push({ type: "form.replied", data: { id: "f-replied", sessionID: "s1", answer: { x: true } } });
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: "interaction.resolved", requestId: "f-replied", source: "local" })));
    h.native.forms = h.native.forms.filter(item => item.id !== "f-cancelled");
    h.streams[0]!.push({ type: "form.cancelled", data: { id: "f-cancelled", sessionID: "s1" } });
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: "interaction.cancelled", requestId: "f-cancelled", reason: "cancelled" })));
  });

  it("marks native configuration readback mismatches unconfirmed and rejects stale selections", async () => {
    const h = await harness();
    await h.backend.activate({ type: "resume", sessionId: "s1" });
    h.native.mismatchModelReadback = true;
    const mismatch = await h.dispatch("switch-mismatch", { type: "slash.execute", name: "thinking", args: "high" });
    expect(mismatch).toMatchObject({ ok: false, status: "unconfirmed", error: "configuration_unconfirmed" });
    const stale = await h.dispatch("switch-stale", { type: "slash.execute", name: "model", args: "removed-model" });
    expect(stale).toMatchObject({ ok: false, status: "failure", error: "configuration_stale" });
  });

  it("reprojects pending inbox on reconnect and uses live events to clear a native cancellation", async () => {
    const h = await harness({ active: true });
    await h.dispatch("send", { type: "user_message", text: "waiting", messageId: "to-cancel" });
    const item = h.native.inbox[0]!;
    h.streams[0]!.fail();
    await vi.waitFor(() => {
      expect(h.streams).toHaveLength(2);
      expect(h.backend.isReady()).toBe(true);
      expect(h.events.filter(event => event.type === "message.queued" && event.queueId === "to-cancel" && event.state === "accepted")).toHaveLength(2);
    });
    h.native.inbox = [];
    h.streams[1]!.push({ type: "session.inbox.cancelled", data: { sessionID: "s1", inboxID: item.id } });
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: "message.queued", state: "cancelled", queueId: "to-cancel" })));
  });

  it("leaves an interrupted prompt unconfirmed and never resends it", async () => {
    const h = await harness({ active: true });
    h.client.session.prompt.mockImplementationOnce(async () => {
      h.streams[0]!.fail();
      throw new Error("PRIVATE_TRANSPORT_ERROR");
    });
    await expect(h.dispatch("lost", { type: "user_message", text: "on uncertain network", messageId: "lost-message" }))
      .resolves.toMatchObject({ ok: false, status: "unconfirmed", error: "opencode_result_unconfirmed" });
    await vi.waitFor(() => expect(h.streams).toHaveLength(2));
    expect(h.client.session.prompt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.events)).not.toContain("PRIVATE_TRANSPORT_ERROR");
  });

  it("does not advertise commands without matching native options", async () => {
    const h = await harness();
    h.client.model.list.mockResolvedValue({ data: [] });
    h.client.agent.list.mockResolvedValue({ data: [] });
    await h.backend.activate({ type: "resume", sessionId: "s1" });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "runtime.capabilities", capabilities: { commands: [expect.objectContaining({ name: "orbis-exit-view" })] } }));
    expect(h.backend.dispatchCommand("opencode:s1", "unsupported", { type: "slash.execute", name: "compact", args: "" })).toBe("unsupported");
  });

  it("detaches only the OpenCode view and allows an explicit re-open", async () => {
    const h = await harness();
    await h.backend.activate({ type: "resume", sessionId: "s1" });
    const capability = [...h.events].reverse().find(event => event.type === "runtime.capabilities") as Extract<RuntimeEvent, { type: "runtime.capabilities" }>;
    const close = capability.capabilities.commands.find(command => command.name === "orbis-exit-view");
    expect(close?.closeGeneration).toBeTruthy();
    await expect(h.dispatch("close", { type: "session.close", sessionId: "s1", confirmed: true, closeGeneration: close!.closeGeneration })).resolves
      .toMatchObject({ ok: true, status: "success" });
    expect(h.onRuntimeOffline).toHaveBeenCalledWith("opencode:s1", "view_closed");
    expect(h.backend.directoryEntries()).toEqual([]);
    await expect(h.backend.activate({ type: "resume", sessionId: "s1" })).resolves.toEqual({ sessionId: "s1", spawnMode: "headless" });
    expect(h.onRuntimeOnline).toHaveBeenCalledTimes(2);
    expect(h.backend.directoryEntries()).toHaveLength(1);
  });

});
