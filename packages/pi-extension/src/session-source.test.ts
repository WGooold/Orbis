import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RuntimeEventSchema, type RuntimeCommand, type RuntimeEvent } from "@pi-remote/protocol";
import type { RuntimeBridgeTransport } from "@pi-remote/runtime-bridge";

const fixture = vi.hoisted(() => ({ events: [] as RuntimeEvent[], handlers: undefined as Parameters<RuntimeBridgeTransport["start"]>[1] | undefined }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ SessionManager: { listAll: async () => [] } }));
vi.mock("./config.js", () => ({ loadRemoteControlConfig: async () => ({}) }));
vi.mock("./runtime-log.js", () => ({ logPiExtensionRuntimeEvent: () => {}, createPiExtensionRuntimeDiagnostic: () => () => {} }));
vi.mock("./loopback.js", () => ({
  resolveRuntimeTransport: async (): Promise<RuntimeBridgeTransport> => ({
    start: async (_metadata, handlers) => { fixture.handlers = handlers; handlers.connected(); },
    publish: event => { RuntimeEventSchema.parse(event); fixture.events.push(structuredClone(event)); }, close: () => {},
  }),
}));
vi.mock("./slash-commands.js", () => ({ INTERNAL_SLASH_COMMAND: "test-internal", PiSlashCommandAdapter: class {
  close() {} async commands() { return []; } onCompletionAvailable() {} takeCompletions() { return []; }
} }));
import piRemoteControl from "./index.js";

const active = Symbol.for("@pi-remote/pi-remote-extension-active");
const scope = globalThis as typeof globalThis & { [active]?: boolean };
afterEach(() => { delete scope[active]; fixture.events.length = 0; fixture.handlers = undefined; });

async function session(idleAtStart = true) {
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => Promise<void>) => hooks.set(name, handler),
    registerCommand: () => {}, events: { on: () => {} }, getSessionName: () => undefined } as unknown as ExtensionAPI;
  let idle = idleAtStart;
  const entries: { type: "message"; id: string; parentId: string | null; timestamp: string; message: unknown }[] = [];
  const ctx = { cwd: "D:/work", isIdle: () => idle, ui: { setTitle: () => {}, setWorkingMessage: () => {}, notify: () => {} },
    sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "pi-session", getLeafId: () => entries.at(-1)?.id ?? null,
      getSessionFile: () => undefined, getCwd: () => "D:/work", getSessionName: () => undefined } } as unknown as ExtensionContext;
  piRemoteControl(pi);
  const emit = async (name: string, event: unknown = {}) => { await hooks.get(name)!(event as never, ctx); };
  await emit("session_start", { reason: "startup" });
  const sync = async (syncId: string, extra: Partial<Extract<RuntimeCommand, { type: "session.sync" }>> = {}) => {
    fixture.handlers!.command(syncId, "" + (globalThis as Record<symbol, unknown>)[Symbol.for("@pi-remote/pi-runtime-id")], {
      type: "session.sync", sessionId: "pi-session", syncId, range: "preview", ...extra,
    });
    await vi.waitFor(() => expect(fixture.events.some(event => event.type === "session.snapshot" && event.syncId === syncId)).toBe(true));
    const result = fixture.events.find(event => event.type === "session.snapshot" && event.syncId === syncId)!;
    if (result.type !== "session.snapshot") throw new Error("missing snapshot");
    return result;
  };
  return { emit, sync, entries, idle: (value: boolean) => { idle = value; } };
}

describe("Pi recoverable session integration", () => {
  it("recovers cumulative text across transport loss and removes the live twin even without turn-end delivery", async () => {
    const f = await session();
    try {
      const baseline = await f.sync("baseline");
      f.idle(false);
      await f.emit("turn_start", { turnIndex: 0, timestamp: 1 });
      await f.emit("message_start", { message: { role: "assistant", content: [], timestamp: 2 } });
      const final = { role: "assistant", content: [{ type: "text", text: "complete answer" }], timestamp: 2 };
      await f.emit("message_update", { message: { ...final }, assistantMessageEvent: { type: "text_delta", delta: "answer", contentIndex: 0 } });
      fixture.events.length = 0; // Simulate all streamed patches being lost on the wire.
      fixture.handlers!.disconnected?.();
      fixture.handlers!.connected();
      const during = await f.sync("during");
      expect(during.live?.messages[0]).toMatchObject({ contentComplete: true, message: { content: final.content } });
      await f.emit("message_end", { message: final });
      const ended = await f.sync("ended");
      expect(ended.live?.messages).toMatchObject([{ finished: true }]);
      f.entries.push({ type: "message", id: "canonical", parentId: null, timestamp: new Date(2).toISOString(), message: final });
      f.idle(true);
      // No turn_end event: periodic/native reconciliation still discovers the exact object identity.
      const recovered = await f.sync("recovered");
      expect(recovered.entries.map(entry => entry.entryId)).toEqual(["canonical"]);
      expect(recovered.live?.messages).toEqual([]);
      expect(recovered.source?.epoch).toBe(baseline.source?.epoch);
      const unchanged = await f.sync("unchanged", { knownState: { epoch: recovered.source!.epoch, seq: recovered.source!.seq, head: recovered.checkpoint!.head } });
      expect(unchanged.selection).toBe("unchanged");
      f.idle(false);
      await f.emit("message_start", { message: { role: "assistant", content: [], timestamp: 3 } });
      await f.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "second par" }], timestamp: 3 }, assistantMessageEvent: { type: "text_delta", delta: "second par" } });
      // The adapter itself misses message_end, so object mapping cannot identify this live twin.
      f.entries.push({ type: "message", id: "second", parentId: "canonical", timestamp: new Date(3).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "second complete" }], timestamp: 3 } });
      f.idle(true);
      const nativeIdle = await f.sync("native-idle");
      expect(nativeIdle.live?.messages).toEqual([]);
      expect(nativeIdle.live?.turn).toBeNull();
      expect(nativeIdle.entries.at(-1)?.entryId).toBe("second");
    } finally { await f.emit("session_shutdown", { reason: "quit" }); }
  });

  it("does not declare an unknown running reload inventory empty and authoritative", async () => {
    const f = await session(false);
    try {
      const unknown = await f.sync("unknown");
      expect(unknown.live?.complete).toBe(false);
      expect(unknown.checkpoint?.inventoryComplete).toBe(false);
      f.idle(true);
      await f.emit("agent_settled");
      const settled = await f.sync("settled");
      expect(settled.live).toMatchObject({ complete: true, turn: null, messages: [] });
    } finally { await f.emit("session_shutdown", { reason: "quit" }); }
  });
});
