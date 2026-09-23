import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
  PiMessageStream,
  mergeTurnTimings,
  messageToRemote,
  processRuntimeId,
  runtimeContextSnapshot,
  runtimeHostname,
  sessionCatalogFromInfos,
  sessionEntriesFromEntries,
  sessionGraphFromEntries,
  turnTimingsFromEntries,
} from "./pi-adapter.js";

describe("Pi event adapter", () => {
  it("keeps one runtime id across extension reloads in the same Pi process", () => {
    const processScope = {};
    expect(processRuntimeId(processScope)).toBe(processRuntimeId(processScope));
  });

  it("reports the OS hostname as the runtime device identity", () => {
    const expected = hostname().trim();
    expect(runtimeHostname()).toBe(expected.length > 0 ? expected : undefined);
  });

  it("includes provider and diagnostic details in assistant failures", () => {
    const message = messageToRemote("failed", {
      role: "assistant",
      content: [],
      provider: "openai",
      model: "gpt-5",
      stopReason: "error",
      errorMessage: "Connection error",
      diagnostics: [{
        type: "provider_transport_failure",
        error: { name: "APIConnectionError", message: "Connection error", code: "ECONNRESET", stack: "secret stack" },
        details: {
          url: "https://api.example.test/v1/responses",
          phase: "after_message_stream_start",
          requestId: "req-123",
          body: "must not be sent",
        },
      }],
      timestamp: 10,
    });

    expect(message.content).toEqual([{
      type: "text",
      text: "Connection error\nprovider=openai, model=gpt-5\nprovider_transport_failure; APIConnectionError; code=ECONNRESET; url=https://api.example.test/v1/responses; phase=after_message_stream_start; requestId=req-123",
    }]);

    // The failure reason is appended after whatever the model already streamed.
    expect(messageToRemote("failed", {
      role: "assistant",
      content: [{ type: "text", text: "partial response" }],
      provider: "anthropic",
      model: "claude-sonnet",
      stopReason: "error",
      errorMessage: "Connection error",
      timestamp: 10,
    }).content).toEqual([
      { type: "text", text: "partial response" },
      { type: "text", text: "Connection error\nprovider=anthropic, model=claude-sonnet" },
    ]);
  });

  it("maps SessionInfo records to a lightweight catalog without including history bodies", () => {
    expect(sessionCatalogFromInfos([{
      id: "session-1",
      name: "API work",
      cwd: "/work/api",
      firstMessage: "Review the API",
      created: new Date("2026-01-01T00:00:00.000Z"),
      modified: new Date("2026-01-02T00:00:00.000Z"),
      messageCount: 7,
      allMessagesText: "a large body that must not cross this boundary",
    }])).toEqual([{
      sessionId: "session-1",
      name: "API work",
      cwd: "/work/api",
      firstMessage: "Review the API",
      createdAt: 1_767_225_600_000,
      modifiedAt: 1_767_312_000_000,
      messageCount: 7,
    }]);
  });

  it("maps Session entries into the transport graph and replaces circular values", () => {
    const entries = [
      { type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "root" } },
      { type: "message", id: "a", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "A" } },
      { type: "message", id: "b", parentId: "root", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "B" } },
    ];
    const graph = sessionEntriesFromEntries(entries);

    expect(graph).toEqual([
      { entryId: "root", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00.000Z", data: { message: { role: "user", content: "root" } } },
      { entryId: "a", parentId: "root", type: "message", timestamp: "2026-01-01T00:00:01.000Z", data: { message: { role: "assistant", content: "A" } } },
      { entryId: "b", parentId: "root", type: "message", timestamp: "2026-01-01T00:00:02.000Z", data: { message: { role: "assistant", content: "B" } } },
    ]);

    const data: Record<string, unknown> = { label: "custom" };
    data.self = data;
    const circularGraph = sessionEntriesFromEntries([{
      type: "custom",
      id: "circular-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data,
    }]);

    expect(circularGraph[0]?.data).toEqual({
      data: { label: "custom", self: "[Circular]" },
    });
    expect(() => JSON.stringify(circularGraph)).not.toThrow();
  });

  it("does not overflow the call stack when a Session entry contains deeply nested JSON", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 20_000; index += 1) nested = { nested };

    expect(() => sessionGraphFromEntries([{
      type: "custom",
      id: "deep-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: nested,
    }], "session-1", "deep-entry", {
      sessionId: "session-1",
      syncId: "sync-deep",
      range: "catchup",
      knownLeafId: null,
    })).not.toThrow(/Maximum call stack size exceeded/);
  });


  it("returns only the latest bounded branch for a preview", () => {
    const entries = [
      { type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "one", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "message", id: "two", parentId: "one", timestamp: "2026-01-01T00:00:02.000Z" },
    ];
    const sync = sessionGraphFromEntries(entries, "session-1", "two", {
      sessionId: "session-1",
      syncId: "preview-1",
      range: "preview",
      maxEntries: 2,
    });

    expect(sync.entries.map((entry) => entry.entryId)).toEqual(["one", "two"]);
    expect(sync.hasOlder).toBe(true);
    expect(sync.complete).toBe(false);
    expect(sync.range).toBe("preview");
  });

  it("rejects unbounded requests without a range", () => {
    const entries = Array.from({ length: 101 }, (_, index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
    }));
    expect(() => sessionGraphFromEntries(entries, "session-1", "entry-100", {
      sessionId: "session-1", syncId: "missing-range",
    })).toThrow("session_sync_range_required");
  });

  it("reports malformed branch paths instead of marking them complete", () => {
    const missingParent = sessionGraphFromEntries([{
      type: "message",
      id: "leaf",
      parentId: "missing",
      timestamp: "2026-01-01T00:00:00.000Z",
    }], "session-1", "leaf", {
      sessionId: "session-1",
      syncId: "bad-1",
      range: "preview",
    });
    expect(missingParent.complete).toBe(false);
    expect(missingParent.rangeStatus).toBe("missing_parent");

    const cycle = sessionGraphFromEntries([
      { type: "message", id: "a", parentId: "b", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:01.000Z" },
    ], "session-1", "a", {
      sessionId: "session-1",
      syncId: "bad-2",
      range: "catchup",
    });
    expect(cycle.complete).toBe(false);
    expect(cycle.rangeStatus).toBe("cycle_detected");
  });

  it("returns only entries older than the history boundary", () => {
    const entries = [
      { type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "one", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "message", id: "two", parentId: "one", timestamp: "2026-01-01T00:00:02.000Z" },
      { type: "message", id: "three", parentId: "two", timestamp: "2026-01-01T00:00:03.000Z" },
    ];
    const sync = sessionGraphFromEntries(entries, "session-1", "three", {
      sessionId: "session-1",
      syncId: "history-1",
      range: "history",
      beforeEntryId: "two",
      maxEntries: 10,
    });

    expect(sync.mode).toBe("prepend");
    expect(sync.entries.map((entry) => entry.entryId)).toEqual(["root", "one"]);
    expect(sync.beforeEntryId).toBe("two");
  });

  it("chunks current branch catch-up while keeping the target leaf fixed", () => {
    const entries = [
      { type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "one", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "message", id: "two", parentId: "one", timestamp: "2026-01-01T00:00:02.000Z" },
    ];
    const sync = sessionGraphFromEntries(entries, "session-1", "two", {
      sessionId: "session-1",
      syncId: "catchup-1",
      range: "catchup",
      knownLeafId: "root",
      maxEntries: 1,
    });

    expect(sync.entries.map((entry) => entry.entryId)).toEqual(["one"]);
    expect(sync.targetLeafId).toBe("two");
    expect(sync.complete).toBe(false);
    expect(sync.rangeStatus).toBe("limit_reached");
  });

  it("appends only the missing suffix when the known leaf is an ancestor", () => {
    const entries = [
      { type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "root" } },
      { type: "message", id: "child", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "child" } },
      { type: "message", id: "new", parentId: "child", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "new" } },
    ];

    const oneChild = sessionGraphFromEntries(entries.slice(0, 2), "session-1", "child", {
      sessionId: "session-1",
      syncId: "sync-1",
      range: "catchup",
      knownLeafId: "root",
    });
    expect(oneChild.mode).toBe("append");
    expect(oneChild.entries.map((entry) => entry.entryId)).toEqual(["child"]);
    expect(oneChild.cursor.leafId).toBe("child");

    const grown = sessionGraphFromEntries(entries, "session-1", "new", {
      sessionId: "session-1",
      syncId: "sync-1",
      range: "catchup",
      knownLeafId: "child",
    });
    expect(grown.mode).toBe("append");
    expect(grown.entries.map((entry) => entry.entryId)).toEqual(["new"]);
  });

  it("sends the new branch suffix after a shared ancestor", () => {
    const entries = [
      { type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "root" } },
      { type: "message", id: "old", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "old" } },
      { type: "message", id: "new", parentId: "root", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "new" } },
    ];
    const sync = sessionGraphFromEntries(entries, "session-1", "new", {
      sessionId: "session-1",
      syncId: "sync-branch",
      range: "catchup",
      knownLeafId: "old",
    });

    expect(sync.mode).toBe("append");
    expect(sync.entries.map((entry) => entry.entryId)).toEqual(["new"]);
  });

  it("merges sidecar timings into the Session sync snapshot", () => {
    const sidecarTiming = {
      turnId: "sidecar-turn",
      startedAt: 3_000,
      durationMs: 500,
      messageId: "assistant-1",
    };
    const entries = [{
      type: "message",
      id: "assistant-1",
      timestamp: "2026-09-21T00:00:00.000Z",
      message: { role: "assistant", content: "done", timestamp: 2_000 },
    }];

    expect(sessionGraphFromEntries(entries, "session-1", "assistant-1", {
      sessionId: "session-1",
      syncId: "sync-1",
      range: "preview",
    }, [sidecarTiming]).turnTimings).toEqual([sidecarTiming]);
    expect(mergeTurnTimings([sidecarTiming], [sidecarTiming])).toEqual([sidecarTiming]);
  });

  it("reads persisted turn timings from legacy custom entries", () => {
    expect(turnTimingsFromEntries([
      {
        type: "custom",
        id: "timing-entry",
        customType: "pi_remote_turn_timing",
        data: {
          turnId: "turn-1",
          startedAt: 1_000,
          durationMs: 250,
          turnIndex: 0,
          messageId: "assistant-1",
        },
      },
    ])).toEqual([{
      turnId: "turn-1",
      startedAt: 1_000,
      durationMs: 250,
      turnIndex: 0,
      messageId: "assistant-1",
    }]);
  });

  it("preserves assistant failures as visible error messages", () => {
    const stream = new PiMessageStream(() => "failed-message");
    stream.started({ role: "assistant", content: [], timestamp: 25 });

    expect(stream.finished({
      role: "assistant",
      content: [],
      timestamp: 25,
      stopReason: "error",
      errorMessage: "provider unavailable",
    })).toMatchObject({
      message: {
        messageId: "failed-message",
        isError: true,
        content: [{ type: "text", text: "provider unavailable" }],
      },
    });
  });

  it("persists the same failure text the APP streams, so a failed turn survives a reload", () => {
    const stream = new PiMessageStream(() => "failed-message");
    stream.started({ role: "assistant", content: [], timestamp: 25 });
    const message = {
      role: "assistant",
      content: [],
      timestamp: 25,
      stopReason: "error",
      errorMessage: "provider unavailable",
      provider: "linkbus",
      model: "gpt-5.6-terra",
    };
    const streamed = stream.finished(message);

    const entries = sessionEntriesFromEntries([
      { type: "message", id: "failed-entry", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message },
    ]);

    const liveText = (streamed.message.content as { text: string }[]).at(-1)?.text;
    expect(entries[0]?.data.remoteFailure).toBe(liveText);
    expect(liveText).toContain("provider unavailable");
  });

  it("keeps one generated message id from stream start through deltas and completion", () => {
    const stream = new PiMessageStream(() => "generated-message-id");
    const partial = { role: "assistant", content: [], timestamp: 30 };
    // Pi emits `{ ...partialMessage }` on message_start and on every message_update,
    // so the message object identity is never shared between them.
    const firstUpdate = { ...partial, content: [{ type: "text", text: "hel" }] };
    const secondUpdate = { ...firstUpdate, content: [{ type: "text", text: "hello" }] };
    const finalMessage = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 30 };

    const started = stream.started(partial);
    const firstDelta = stream.updated({ type: "text_delta", delta: "hel" }, firstUpdate);
    const secondDelta = stream.updated({ type: "text_delta", delta: "lo" }, secondUpdate);
    const finished = stream.finished(finalMessage);

    expect(started).toMatchObject({ type: "message.started", message: { messageId: "generated-message-id" } });
    expect(firstDelta).toEqual({
      type: "message.delta",
      messageId: "generated-message-id",
      contentType: "text",
      delta: "hel",
    });
    expect(secondDelta).toMatchObject({ type: "message.delta", messageId: "generated-message-id", delta: "lo" });
    expect(finished).toMatchObject({ type: "message.finished", message: { messageId: "generated-message-id" } });
    expect(stream.messageIdFor(finalMessage)).toBe("generated-message-id");
    expect(stream.messageIdFor({ ...finalMessage })).toBeUndefined();
    expect(stream.messageIdFor(partial)).toBeUndefined();
  });

  it("keeps one id when message_end arrives as a fresh copy behind an unfinished message", () => {
    let nextId = 0;
    const stream = new PiMessageStream(() => `generated-${++nextId}`);
    const userStart = { role: "user", content: [], timestamp: 1 };
    const assistantStart = { role: "assistant", content: [], timestamp: 2 };

    // A user message whose end carries no copy at all: its start copy can never be retired by
    // identity, which is what used to make the next assistant end look ambiguous.
    expect(stream.started(userStart).message.messageId).toBe("generated-1");
    expect(stream.finished(undefined).message.messageId).toBe("generated-1");

    // Pi then streams the reply and hands message_end a fresh shallow copy of the partial message.
    expect(stream.started(assistantStart).message.messageId).toBe("generated-2");
    expect(stream.updated({ type: "text_delta", delta: "hi" }, assistantStart)?.messageId).toBe("generated-2");
    const finalAssistant = { ...assistantStart, content: [{ type: "text", text: "hi" }] };
    expect(stream.finished(finalAssistant).message.messageId).toBe("generated-2");
    expect(stream.messageIdFor(finalAssistant)).toBe("generated-2");
  });

  it("keeps overlapping message lifecycles correlated by their own message object", () => {
    let nextId = 0;
    const stream = new PiMessageStream(() => `generated-${++nextId}`);
    const assistant = { role: "assistant", content: [], timestamp: 1 };
    const tool = { role: "toolResult", content: [], timestamp: 2 };

    expect(stream.started(assistant).message.messageId).toBe("generated-1");
    expect(stream.started(tool).message.messageId).toBe("generated-2");
    expect(stream.updated({ type: "text_delta", delta: "first" }, assistant)?.messageId).toBe("generated-1");
    expect(stream.updated({ type: "text_delta", delta: "second" }, tool)?.messageId).toBe("generated-2");

    expect(stream.finished(assistant).message.messageId).toBe("generated-1");
    expect(stream.finished(tool).message.messageId).toBe("generated-2");
    expect(stream.messageIdFor(assistant)).toBe("generated-1");
    expect(stream.messageIdFor(tool)).toBe("generated-2");
  });

  it("pairs every streamed id of a turn with the entry id it was persisted under", () => {
    let nextId = 0;
    const stream = new PiMessageStream(() => `generated-${++nextId}`);
    const userMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
    const assistantMessage = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 };

    stream.started(userMessage);
    stream.finished(userMessage);
    stream.started(assistantMessage);
    stream.finished(assistantMessage);

    const branch = [
      { type: "message", id: "a1b2c3d4", message: userMessage },
      { type: "model_change", id: "ffffffff" },
      { type: "message", id: "e5f6a7b8", message: assistantMessage },
      // A message this stream never finished cannot be paired, so it stays unmapped.
      { type: "message", id: "11223344", message: { role: "assistant", content: [] } },
    ];

    expect(stream.persistedMessageMappings(branch)).toEqual([
      { messageId: "generated-1", entryId: "a1b2c3d4" },
      { messageId: "generated-2", entryId: "e5f6a7b8" },
    ]);
    // Entries are announced once, so a later turn does not replay the whole history.
    expect(stream.persistedMessageMappings(branch)).toEqual([]);
  });

  it("resolves the entry id from the object Pi stored, not the streamed copy", () => {
    const stream = new PiMessageStream(() => "generated-id");
    // Pi streams `{ ...partialMessage }` but persists the finalized object it passes to message_end.
    const streamedCopy = { role: "assistant", content: [], timestamp: 7 };
    const persisted = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 7 };

    stream.started(streamedCopy);
    stream.finished(persisted);

    expect(stream.persistedMessageMappings([{ type: "message", id: "9966aabb", message: persisted }]))
      .toEqual([{ messageId: "generated-id", entryId: "9966aabb" }]);
    expect(stream.persistedMessageMappings([{ type: "message", id: "deadbeef", message: streamedCopy }]))
      .toEqual([]);
  });
});

describe("Remote context snapshot", () => {
  it("reports the active model and context utilization to the APP composer", () => {
    expect(runtimeContextSnapshot({
      model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      thinkingLevel: "high",
      getContextUsage: () => ({ tokens: 24_600, contextWindow: 200_000, percent: 12.3 }),
    })).toEqual({
      model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      thinkingLevel: "high",
      contextUsage: { tokens: 24_600, contextWindow: 200_000, percent: 12.3 },
    });
  });

  it("derives the percentage when Pi only reports token counts", () => {
    expect(runtimeContextSnapshot({
      getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000, percent: null }),
    })).toEqual({
      contextUsage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
    });
  });

  it("keeps an unknown token estimate instead of inventing a percentage", () => {
    expect(runtimeContextSnapshot({
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    })).toEqual({
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    });
  });

  it("omits status that Pi cannot supply yet", () => {
    // No model selected and no usage callback: the metadata message must stay unchanged.
    expect(runtimeContextSnapshot({})).toEqual({});
    expect(runtimeContextSnapshot({ getContextUsage: () => undefined })).toEqual({});
    expect(runtimeContextSnapshot({ model: null, getContextUsage: () => null })).toEqual({});
    // A window of 0 cannot produce a meaningful percentage.
    expect(runtimeContextSnapshot({
      getContextUsage: () => ({ tokens: 100, contextWindow: 0, percent: 5 }),
    })).toEqual({});
  });

  it("accepts a catalogue model without a display name", () => {
    expect(runtimeContextSnapshot({
      model: { provider: "llama.cpp", id: "local-qwen" },
    })).toEqual({
      model: { provider: "llama.cpp", id: "local-qwen" },
    });
  });

  it("clamps an overshooting estimate and ignores malformed model identity", () => {
    expect(runtimeContextSnapshot({
      getContextUsage: () => ({ tokens: 210_000, contextWindow: 200_000, percent: 105 }),
    })).toEqual({
      contextUsage: { tokens: 210_000, contextWindow: 200_000, percent: 100 },
    });
    expect(runtimeContextSnapshot({ model: { provider: "openai" } })).toEqual({});
    expect(runtimeContextSnapshot({ model: { provider: "  ", id: "gpt-5" } })).toEqual({});
  });
});
