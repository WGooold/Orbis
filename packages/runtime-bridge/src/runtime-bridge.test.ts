import { describe, expect, it, vi } from "vitest";
import {
  type ChatMessage,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeMetadata,
} from "@pi-remote/protocol";
import {
  RuntimeBridge,
  type RuntimeBridgeTransport,
  type RuntimePort,
} from "./index.js";


class FakeTransport implements RuntimeBridgeTransport {
  metadata?: RuntimeMetadata;
  events: RuntimeEvent[] = [];
  commandHandler?: (commandId: string, runtimeId: string, command: RuntimeCommand) => void;
  connectedHandler?: () => void;
  disconnectedHandler?: (() => void) | undefined;
  resyncHandler?: (reason: string) => void;
  closed = false;

  async start(
    metadata: RuntimeMetadata,
    handlers: {
      connected: () => void;
      disconnected?: () => void;
      resync: (reason: string) => void;
      command: (commandId: string, runtimeId: string, command: RuntimeCommand) => void;
    },
  ): Promise<void> {
    this.metadata = metadata;
    this.connectedHandler = handlers.connected;
    this.disconnectedHandler = handlers.disconnected;
    this.resyncHandler = handlers.resync;
    this.commandHandler = handlers.command;
    handlers.connected();
  }

  publish(event: RuntimeEvent): void {
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
  }
}

const makeRuntime = (overrides: Partial<RuntimePort> = {}): RuntimePort => ({
  metadata: () => ({
    runtimeId: "runtime-a",
    name: "remote work",
    cwd: "/work/app",
    status: "idle",
    sessionId: "session-shared",
  }),
  isIdle: () => true,
  sendUserMessage: vi.fn(),
  abort: vi.fn(),
  ...overrides,
});

describe("RuntimeBridge", () => {
  it("publishes a correlated session graph snapshot without changing the legacy chat path", async () => {
    const transport = new FakeTransport();
    const syncSession = vi.fn(async () => ({
      sessionId: "session-1",
      cursor: { leafId: "entry-2" },
      mode: "append" as const,
      entries: [{
        entryId: "entry-2",
        parentId: "entry-1",
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        data: { message: { role: "user", content: "new" } },
      }],
    }));
    const bridge = new RuntimeBridge(makeRuntime({ syncSession }), transport);

    await bridge.start();
    transport.commandHandler?.("session-sync-1", "runtime-a", {
      type: "session.sync",
      sessionId: "session-1",
      syncId: "sync-1",
      knownLeafId: "entry-1",
    });

    await vi.waitFor(() => expect(syncSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      syncId: "sync-1",
      knownLeafId: "entry-1",
    }));
    expect(transport.events).toEqual([{
      type: "session.snapshot",
      sessionId: "session-1",
      syncId: "sync-1",
      cursor: { leafId: "entry-2" },
      mode: "append",
      entries: [{
        entryId: "entry-2",
        parentId: "entry-1",
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        data: { message: { role: "user", content: "new" } },
      }],
    }]);
  });

  it("publishes lightweight Session catalog metadata on connection", async () => {
    const transport = new FakeTransport();
    const sessionCatalog = vi.fn(async () => [{
      sessionId: "session-1",
      name: "API work",
      cwd: "/work/api",
      firstMessage: "Review the API",
      createdAt: 1,
      modifiedAt: 2,
      messageCount: 3,
    }]);
    const bridge = new RuntimeBridge(makeRuntime({ sessionCatalog }), transport);

    await bridge.start();
    await vi.waitFor(() => expect(sessionCatalog).toHaveBeenCalledTimes(1));
    expect(transport.events).toEqual([{
      type: "session.catalog",
      sessions: [{
        sessionId: "session-1",
        name: "API work",
        cwd: "/work/api",
        firstMessage: "Review the API",
        createdAt: 1,
        modifiedAt: 2,
        messageCount: 3,
      }],
    }]);
  });

  it("does not publish a session snapshot on the initial connection or session replacement", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime(), transport);

    await bridge.start();
    for (let index = 0; index < 5; index += 1) {
      bridge.sessionStarted();
    }

    transport.resyncHandler?.("device_connected");

    expect(transport.events).toEqual([]);
  });

  it("rejects a download addressed to a runtime instead of the Host", async () => {
    // 下载由 Host 独家服务（spec §9.4）：命令投到某个 Pi runtime 就是寻址错了。
    // 如实回一条失败，别让它掉进后面的 interaction 分支或被说成 runtime_offline。
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime(), transport);
    await bridge.start();

    transport.commandHandler?.("download-1", "runtime-a", {
      type: "artifact.download",
      artifactId: "00000000-0000-4000-8000-000000000002",
      offset: 0,
    });
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "download-1",
      ok: false,
      status: "failure",
      error: "download_served_by_host",
    }));

    transport.commandHandler?.("download-2", "runtime-a", {
      type: "file.download",
      path: "C:\\work\\report.zip",
      offset: 0,
    });
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "download-2",
      ok: false,
      status: "failure",
      error: "download_served_by_host",
    }));
  });

  it("forwards message and tool lifecycle events without changing their ids or order", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime(), transport);
    await bridge.start();
    transport.events.length = 0;
    const assistant: ChatMessage = {
      messageId: "assistant-9",
      role: "assistant",
      content: [],
      timestamp: 2,
    };

    bridge.publish({ type: "message.started", message: assistant });
    bridge.publish({ type: "message.delta", messageId: "assistant-9", delta: "hel" });
    bridge.publish({ type: "message.delta", messageId: "assistant-9", delta: "lo" });
    bridge.publish({ type: "message.finished", message: { ...assistant, content: [{ type: "text", text: "hello" }] } });
    bridge.publish({ type: "tool.started", toolCallId: "tool-3", toolName: "bash", arguments: { command: "pwd" } });
    bridge.publish({ type: "tool.updated", toolCallId: "tool-3", toolName: "bash", partialResult: "working" });
    bridge.publish({ type: "tool.finished", toolCallId: "tool-3", toolName: "bash", result: "done", isError: false });

    expect(transport.events.map((event) => event.type)).toEqual([
      "message.started",
      "message.delta",
      "message.delta",
      "message.finished",
      "tool.started",
      "tool.updated",
      "tool.finished",
    ]);
    expect(transport.events[2]).toMatchObject({ messageId: "assistant-9", delta: "lo" });
    expect(transport.events[6]).toMatchObject({ toolCallId: "tool-3", isError: false });
  });

  it("reports metadata construction failures as runtime errors", async () => {
    const transport = new FakeTransport();
    const diagnostics = vi.fn();
    let metadataCalls = 0;
    const bridge = new RuntimeBridge(makeRuntime({
      metadata: () => {
        metadataCalls += 1;
        if (metadataCalls > 1) throw new Error("metadata_failed");
        return makeRuntime().metadata();
      },
    }), transport, undefined, diagnostics);
    await bridge.start();
    transport.events.length = 0;

    bridge.refreshMetadata();

    expect(transport.events).toEqual([{
      type: "runtime.error",
      message: "metadata_failed",
      recoverable: true,
    }]);
    expect(diagnostics).toHaveBeenCalledWith("bridge.metadata.failed", { message: "metadata_failed" });
  });

  it("does not implicitly turn an ordinary message into follow-up while the agent is running", async () => {
    const sendUserMessage = vi.fn();
    const abort = vi.fn();
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ sendUserMessage, abort, isIdle: () => false }), transport);
    await bridge.start();
    transport.events.length = 0;

    transport.commandHandler?.("wrong-command", "runtime-b", { type: "user_message", text: "not yours" });
    transport.commandHandler?.("message-command", "runtime-a", {
      type: "user_message",
      text: "continue with the next task",
    });
    transport.commandHandler?.("stop-command", "runtime-a", { type: "stop" });

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "wrong-command",
      ok: false,
      error: "runtime_mismatch",
    });
    expect(transport.events).toContainEqual({ type: "command.result", commandId: "stop-command", ok: true });
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "message-command",
      ok: false,
      error: "runtime_busy",
    }));
    expect(transport.events.some((event) => event.type === "message.queued")).toBe(false);
  });

  it("publishes accepted only after the Pi enqueue call returns", async () => {
    let resolveSend: (() => void) | undefined;
    const sendUserMessage = vi.fn(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ sendUserMessage, isIdle: () => false }), transport);
    await bridge.start();

    transport.commandHandler?.("message-command", "runtime-a", {
      type: "user_message",
      text: "queued request",
      messageId: "queue-1",
      delivery: "followUp",
    });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledWith("queued request", "followUp", "queue-1", undefined));
    expect(transport.events.some((event) => event.type === "message.queued")).toBe(false);

    resolveSend?.();
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "message.queued",
      queueId: "queue-1",
      text: "queued request",
      delivery: "followUp",
      state: "accepted",
    }));
    expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "message-command",
      ok: true,
    });
  });

  // 附件不再拼进用户正文：bridge 把路径经端口单独交给 runtime（Pi 把它作为独立 text part
  // 发给 agent）。这条钉的是「正文逐字不变、路径经第四参完整可达」——重名歧义由上传端
  // 的 sha256 落盘目录解决，不靠改写消息文本。
  it("hands attachment paths to the runtime port separately and leaves plain messages untouched", async () => {
    const sendUserMessage = vi.fn(async () => {});
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ sendUserMessage }), transport);
    await bridge.start();

    transport.commandHandler?.("plain", "runtime-a", { type: "user_message", text: "普通消息" });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
    expect(sendUserMessage).toHaveBeenLastCalledWith("普通消息", undefined, undefined, undefined);

    transport.commandHandler?.("with-files", "runtime-a", {
      type: "user_message",
      text: "看下这两个文件",
      attachments: ["/work/.pi-remote-uploads/aa/a.png", "/work/.pi-remote-uploads/bb/b.pdf"],
    });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(2));
    expect(sendUserMessage).toHaveBeenLastCalledWith(
      "看下这两个文件",
      undefined,
      undefined,
      ["/work/.pi-remote-uploads/aa/a.png", "/work/.pi-remote-uploads/bb/b.pdf"],
    );
  });

  it("deduplicates a repeated queue request while enqueuing and after it completes", async () => {
    let resolveSend: (() => void) | undefined;
    const sendUserMessage = vi.fn(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ sendUserMessage, isIdle: () => false }), transport);
    await bridge.start();

    const command = {
      type: "user_message" as const,
      text: "one command",
      messageId: "queue-command-id",
      delivery: "followUp" as const,
    };
    transport.commandHandler?.("same-command-id", "runtime-a", command);
    transport.commandHandler?.("same-command-id", "runtime-a", command);
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
    expect(transport.events.some((event) => event.type === "message.queued")).toBe(false);

    resolveSend?.();
    await vi.waitFor(() => expect(transport.events.filter((event) =>
      event.type === "command.result" && event.commandId === "same-command-id",
    )).toHaveLength(2));
    expect(transport.events.filter((event) =>
      event.type === "message.queued" && event.queueId === "queue-command-id" && event.state === "accepted",
    )).toHaveLength(1);

    // A replay after completion is served from the retained result without enqueueing again.
    transport.events.length = 0;
    transport.commandHandler?.("completed-duplicate", "runtime-a", command);
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "completed-duplicate",
      ok: true,
    }));
    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-command-id", state: "accepted",
    }));
  });

  it("retains a rejected queue operation for idempotent replay", async () => {
    const sendUserMessage = vi.fn(async () => {
      throw new Error("pi_rejected");
    });
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ sendUserMessage, isIdle: () => false }), transport);
    await bridge.start();

    const command = {
      type: "user_message" as const,
      text: "will fail",
      messageId: "queue-rejected",
      delivery: "followUp" as const,
    };
    transport.commandHandler?.("message-command-1", "runtime-a", command);
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "message.queued",
      queueId: "queue-rejected",
      text: "will fail",
      delivery: "followUp",
      state: "rejected",
      error: "pi_rejected",
    }));

    transport.events.length = 0;
    transport.commandHandler?.("message-command-2", "runtime-a", command);
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "message-command-2",
      ok: false,
      error: "pi_rejected",
    }));
    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-rejected", state: "rejected",
    }));
  });

  it("delivers a queued message deterministically even before the enqueue promise resolves", async () => {
    let resolveSend: (() => void) | undefined;
    const sendUserMessage = vi.fn(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ sendUserMessage, isIdle: () => false }), transport);
    await bridge.start();

    transport.commandHandler?.("message-command", "runtime-a", {
      type: "user_message",
      text: "early lifecycle",
      messageId: "queue-early",
      delivery: "followUp",
    });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());

    // 队列接管：delivered 由扩展出队时亲手回执，可以早于 enqueue promise 落定。
    bridge.deliverQueued("queue-early");
    expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-early", state: "delivered",
    }));

    resolveSend?.();
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "command.result", commandId: "message-command", ok: true,
    }));
    expect(transport.events.filter((event) =>
      event.type === "message.queued" && event.queueId === "queue-early" && event.state === "accepted",
    )).toHaveLength(0);
  });

  it("delivers a queued message by explicit id and ignores unknown or settled ids", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ isIdle: () => false }), transport);
    await bridge.start();
    transport.commandHandler?.("message-command", "runtime-a", {
      type: "user_message",
      text: "correlate me",
      messageId: "queue-2",
      delivery: "steer",
    });
    await vi.waitFor(() => expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-2", state: "accepted",
    })));

    transport.events.length = 0;

    bridge.deliverQueued("queue-unknown");
    expect(bridge.deliverQueued("queue-2")).toBeUndefined();
    expect(bridge.deliverQueued("queue-2")).toBeUndefined();
    expect(transport.events).toEqual([expect.objectContaining({
      type: "message.queued", queueId: "queue-2", state: "delivered",
    })]);
  });

  it("fails a queued message with a terminal rejected state when enqueue fails", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ isIdle: () => false }), transport);
    await bridge.start();
    transport.commandHandler?.("message-command", "runtime-a", {
      type: "user_message",
      text: "will fail on dequeue",
      messageId: "queue-fail",
      delivery: "followUp",
    });
    await vi.waitFor(() => expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-fail", state: "accepted",
    })));

    bridge.failQueued("queue-fail", "compaction_in_progress");
    expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-fail", state: "rejected", error: "compaction_in_progress",
    }));
    // 已终态的条目再收到回执不能改写状态。
    bridge.deliverQueued("queue-fail");
    expect(transport.events.filter((event) =>
      event.type === "message.queued" && event.queueId === "queue-fail",
    )).toHaveLength(2);
  });

  it("rejects a queue id reused with different message data", async () => {
    const sendUserMessage = vi.fn(async () => undefined);
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ sendUserMessage, isIdle: () => false }), transport);
    await bridge.start();

    const original = {
      type: "user_message" as const,
      text: "original text",
      messageId: "queue-conflict",
      delivery: "followUp" as const,
    };
    transport.commandHandler?.("message-command-1", "runtime-a", original);
    await vi.waitFor(() => expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-conflict", state: "accepted",
    })));

    transport.commandHandler?.("message-command-2", "runtime-a", {
      ...original,
      text: "different text",
    });
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "command.result",
      commandId: "message-command-2",
      ok: false,
      status: "message_id_conflict",
      error: "message_id_conflict",
    }));
    expect(sendUserMessage).toHaveBeenCalledOnce();
  });

  it("delivers each queued id independently regardless of duplicate text", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ isIdle: () => false }), transport);
    await bridge.start();

    for (const [commandId, messageId, delivery] of [
      ["follow-up-command", "follow-up-id", "followUp"],
      ["steer-command", "steer-id", "steer"],
      ["second-steer-command", "second-steer-id", "steer"],
    ] as const) {
      transport.commandHandler?.(commandId, "runtime-a", {
        type: "user_message", text: "same text", messageId, delivery,
      });
    }
    await vi.waitFor(() => expect(transport.events.filter((event) =>
      event.type === "message.queued" && event.state === "accepted",
    )).toHaveLength(3));

    transport.events.length = 0;
    for (const messageId of ["steer-id", "second-steer-id", "follow-up-id"]) {
      bridge.deliverQueued(messageId);
    }
    expect(transport.events.filter((event) =>
      event.type === "message.queued" && event.state === "delivered",
    )).toHaveLength(3);
  });

  it("re-publishes retained queue state after transport reconnect", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ isIdle: () => false }), transport);
    await bridge.start();
    transport.commandHandler?.("message-command", "runtime-a", {
      type: "user_message",
      text: "survive reconnect",
      messageId: "queue-reconnect",
      delivery: "followUp",
    });
    await vi.waitFor(() => expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-reconnect", state: "accepted",
    })));

    transport.events.length = 0;
    transport.disconnectedHandler?.();
    transport.connectedHandler?.();

    expect(transport.events).toContainEqual({
      type: "message.queued",
      queueId: "queue-reconnect",
      text: "survive reconnect",
      delivery: "followUp",
      state: "accepted",
    });
  });

  it("keeps cancellation scoped to one queued message", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ isIdle: () => false }), transport);
    await bridge.start();
    for (const [commandId, messageId, text] of [
      ["message-1", "queue-1", "first"],
      ["message-2", "queue-2", "second"],
    ] as const) {
      transport.commandHandler?.(commandId, "runtime-a", {
        type: "user_message", text, messageId, delivery: "followUp",
      });
    }
    await vi.waitFor(() => expect(transport.events.filter((event) => event.type === "message.queued" && event.state === "accepted")).toHaveLength(2));
    transport.commandHandler?.("cancel-1", "runtime-a", { type: "user_message.cancel", messageId: "queue-1" });
    await vi.waitFor(() => expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-1", state: "not_cancelable",
    })));
    bridge.deliverQueued("queue-2");
    expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-2", state: "delivered",
    }));
  });

  it("publishes cancelled and drops the ledger entry when the runtime queue removes the message", async () => {
    const cancelQueuedMessage = vi.fn(() => ({ ok: true as const }));
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ isIdle: () => false, cancelQueuedMessage }), transport);
    await bridge.start();
    transport.commandHandler?.("message-command", "runtime-a", {
      type: "user_message", text: "cancel me", messageId: "queue-cancel", delivery: "followUp",
    });
    await vi.waitFor(() => expect(transport.events).toContainEqual(expect.objectContaining({
      type: "message.queued", queueId: "queue-cancel", state: "accepted",
    })));

    transport.commandHandler?.("cancel-command", "runtime-a", { type: "user_message.cancel", messageId: "queue-cancel" });
    await vi.waitFor(() => expect(transport.events).toContainEqual({
      type: "message.queued",
      queueId: "queue-cancel",
      text: "cancel me",
      delivery: "followUp",
      state: "cancelled",
    }));
    expect(cancelQueuedMessage).toHaveBeenCalledWith("queue-cancel");
    expect(transport.events).toContainEqual({
      type: "command.result", commandId: "cancel-command", ok: true, status: "cancelled",
    });
    // 账本条目已删：之后迟到一条 delivered 回执不得凭空复活状态。
    bridge.deliverQueued("queue-cancel");
    expect(transport.events.filter((event) =>
      event.type === "message.queued" && event.state === "delivered",
    )).toHaveLength(0);
  });

  it("honors an explicit delivery mode while running and ignores a stale one when idle", async () => {
    const runningSend = vi.fn();
    const runningTransport = new FakeTransport();
    const running = new RuntimeBridge(makeRuntime({ sendUserMessage: runningSend, isIdle: () => false }), runningTransport);
    await running.start();

    runningTransport.commandHandler?.("steer-command", "runtime-a", {
      type: "user_message",
      text: "interrupt now",
      delivery: "steer",
    });
    // 队列接管：忙时端口拿到的是账本生成的 queueId（命令没带 messageId 也会生成），
    // 扩展出队时靠它回执 delivered。
    expect(runningSend).toHaveBeenCalledWith("interrupt now", "steer", expect.any(String), undefined);

    const idleSend = vi.fn();
    const idleTransport = new FakeTransport();
    const idle = new RuntimeBridge(makeRuntime({ sendUserMessage: idleSend, isIdle: () => true }), idleTransport);
    await idle.start();

    idleTransport.commandHandler?.("idle-command", "runtime-a", {
      type: "user_message",
      text: "start a new turn",
      messageId: "idle-message",
      delivery: "followUp",
    });

    await vi.waitFor(() => expect(idleSend).toHaveBeenCalledWith("start a new turn", undefined, "idle-message", undefined));
    expect(idleTransport.events.some((event) => event.type === "message.queued")).toBe(false);
  });

  it("executes a selected slash command through the runtime port", async () => {
    const transport = new FakeTransport();
    const executeSlashCommand = vi.fn(async (name: string, args: string) => ({ name, args }));
    const bridge = new RuntimeBridge(makeRuntime({ executeSlashCommand }), transport);
    await bridge.start();
    transport.events.length = 0;

    transport.commandHandler?.("slash-1", "runtime-a", {
      type: "slash.execute",
      name: "skill:review",
      args: "current changes",
    });

    await vi.waitFor(() => {
      expect(executeSlashCommand).toHaveBeenCalledWith("skill:review", "current changes");
      expect(transport.events).toContainEqual({
        type: "command.result",
        commandId: "slash-1",
        ok: true,
        status: "success",
        result: { name: "skill:review", args: "current changes" },
      });
    });
  });

  it("records a slash completion when session replacement closes the old bridge", async () => {
    let resolveCommand: ((value: unknown) => void) | undefined;
    const executeSlashCommand = vi.fn(() => new Promise((resolve) => { resolveCommand = resolve; }));
    const recordSlashCommandCompletion = vi.fn();
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime({ executeSlashCommand, recordSlashCommandCompletion }), transport);
    await bridge.start();

    transport.commandHandler?.("slash-reload", "runtime-a", {
      type: "slash.execute",
      name: "reload",
      args: "",
    });
    await vi.waitFor(() => expect(executeSlashCommand).toHaveBeenCalledOnce());
    bridge.close();
    resolveCommand?.({ reloaded: true });

    await vi.waitFor(() => expect(recordSlashCommandCompletion).toHaveBeenCalledWith({
      commandId: "slash-reload",
      ok: true,
      status: "success",
      result: { reloaded: true },
    }));
  });

  it("reports unsupported SDK interaction commands without fabricating a response", async () => {
    const transport = new FakeTransport();
    const bridge = new RuntimeBridge(makeRuntime(), transport);
    await bridge.start();
    transport.events.length = 0;

    transport.commandHandler?.("response-command", "runtime-a", {
      type: "interaction.respond",
      requestId: "unknown",
      extensionId: "third-party",
      response: { kind: "confirm", value: true },
    });

    expect(transport.events).toEqual([{
      type: "command.result",
      commandId: "response-command",
      ok: false,
      error: "interaction_not_available",
    }]);
  });
});
