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
  const native = { active: args.active ?? false, messages: args.messages ?? [], permissions: [] as NativePermission[], forms: [] as NativeForm[], online: true };
  const streams: Array<ReturnType<typeof eventStream>> = [];
  const events: RuntimeEvent[] = [];
  const onRuntimeOnline = vi.fn(), onRuntimeOffline = vi.fn(), onCatalogChange = vi.fn();
  const client = {
    server: { info: vi.fn(async () => ({ version: "2.3.2", pid: 1 })) },
    session: {
      active: vi.fn(async (): Promise<Record<string, { type: "running" }>> => native.active ? { s1: { type: "running" } } : {}),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
        if (!fixtureSessions.includes(sessionID)) throw new Error("not found");
        return { ...sessionInfo(sessionID, { busy: 3500, ...(native.active ? {} : { idle: 4200 }) }),
          ...(native.active ? {} : { outcome: "succeeded" }) };
      }),
      list: vi.fn(async ({ cursor }: { cursor?: string } = {}) => ({ data: [sessionInfo(cursor === "second" ? "s2" : "s1")],
        cursor: { next: cursor ? null : "second" as string | null } })),
      message: { get: vi.fn(async ({ messageID }: { messageID: string }) => native.messages.find(message => message.id === messageID)) },
      form: { list: vi.fn(async () => native.forms), get: vi.fn(async ({ formID }: { formID: string }) => native.forms.find(form => form.id === formID)) },
    },
    message: { list: vi.fn(async ({ cursor }: { cursor?: string } = {}) => {
      const offset = cursor ? Number(cursor) : 0;
      return { data: native.messages.slice(offset, offset + 200), cursor: { next: offset + 200 < native.messages.length ? String(offset + 200) : null } };
    }) },
    permission: { list: vi.fn(async () => native.permissions) },
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
  return { connection, backend, client, native, events, streams, onRuntimeOnline, onRuntimeOffline, onCatalogChange, sync };
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
    expect(h.client.message.list.mock.calls.map(([arg]) => arg?.cursor)).toEqual([undefined, "200", "400", "600"]);
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
    h.native.messages = [userMessage("user"), partialAssistant("updated")];
    h.streams[0]!.push({ type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "assistant", delta: "not reapplied" } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "session.patch" && item.live.messages[0]?.message.content[0]?.type === "text" &&
      item.live.messages[0].message.content[0].text === "updated")).toBe(true));
    expect(h.client.message.list).toHaveBeenCalledTimes(1);
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
    h.streams[0]!.push({ type: "form.replied", data: { id: "f1" } });
    await vi.waitFor(() => expect(h.events.some(item => item.type === "interaction.snapshot" && !item.requests.length)).toBe(true));
  });
});


