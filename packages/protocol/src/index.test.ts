import { describe, expect, it } from "vitest";
import {
  DeviceClientMessageSchema,
  DeviceE2ePayloadSchema,
  RuntimeClientMessageSchema,
  RuntimeCommandSchema,
  RuntimeEventSchema,
  RuntimeCapabilitiesSchema,
  RelayToDeviceMessageSchema,
  ARTIFACT_CHUNK_BYTES,
  decodeArtifactChunkFrame,
  encodeArtifactChunkFrame,
  PROTOCOL_VERSION,
  MAX_UPLOAD_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
} from "./index.js";

describe("runtime command protocol", () => {

  it("carries session provider ownership and current backend providers, including an empty catalog", () => {
    const message = {
      type: "session.list.result", requestId: "providers", sessions: [],
      currentProviders: [{ agentKind: "codex", provider: "custom" }],
    };
    expect(RelayToDeviceMessageSchema.safeParse(message).success).toBe(true);
    const session = {
      sessionId: "thread", cwd: "D:/repo", hostname: "host", agentKind: "codex",
      createdAt: 1, modifiedAt: 2, messageCount: 0, modelProvider: "other",
    };
    expect(RelayToDeviceMessageSchema.safeParse({ ...message, sessions: [session] }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({ ...message, sessions: [{ ...session, modelProvider: "" }] }).success).toBe(false);
    expect(RelayToDeviceMessageSchema.safeParse({ ...message, currentProviders: [{ agentKind: "codex", provider: "" }] }).success).toBe(false);
  });

  it("accepts a lightweight Session catalog and correlates graph syncs", () => {
    expect(RuntimeEventSchema.safeParse({
      type: "session.catalog",
      sessions: [{
        sessionId: "session-1",
        name: "API work",
        cwd: "/work/api",
        firstMessage: "Review the API",
        createdAt: 1_767_225_600_000,
        modifiedAt: 1_767_312_000_000,
        messageCount: 7,
      }],
    }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "session.catalog",
      sessions: [{ sessionId: "session-1", cwd: "/work", createdAt: -1, modifiedAt: 1, messageCount: 0 }],
    }).success).toBe(false);

    const request = {
      type: "session.sync" as const,
      sessionId: "session-1",
      syncId: "sync-1",
      knownLeafId: "leaf-1",
      targetLeafId: "leaf-9",
      beforeEntryId: "entry-7",
      maxEntries: 100,
      range: "history" as const,
    };
    expect(RuntimeCommandSchema.safeParse(request).success).toBe(true);
    expect(RuntimeCommandSchema.safeParse({ ...request, syncId: "" }).success).toBe(false);

    expect(RuntimeEventSchema.safeParse({
      type: "session.snapshot",
      sessionId: "session-1",
      syncId: "sync-1",
      cursor: { leafId: "leaf-1" },
      mode: "append",
      range: "history",
      targetLeafId: "leaf-9",
      beforeEntryId: "entry-7",
      hasOlder: true,
      complete: false,
      entries: [{
        entryId: "leaf-1",
        parentId: "root-1",
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        data: { message: { role: "user", content: "hello" } },
      }],
    }).success).toBe(true);
  });

  it("keeps ordinary user messages separate from slash command execution", () => {
    expect(RuntimeCommandSchema.safeParse({
      type: "user_message",
      text: "Review the current changes",
      messageId: "queue-1",
      delivery: "steer",
    }).success).toBe(true);
    expect(RuntimeCommandSchema.safeParse({
      type: "user_message.cancel",
      messageId: "queue-1",
    }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "message.queued",
      queueId: "queue-1",
      text: "Review the current changes",
      delivery: "followUp",
      state: "accepted",
    }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "turn.finished",
      turnId: "turn-1",
      startedAt: 1_000,
      durationMs: 250,
      messageId: "live-assistant",
      persistedMessageId: "assistant-entry",
      persistedMessages: [
        { messageId: "live-user", entryId: "user-entry" },
        { messageId: "live-assistant", entryId: "assistant-entry" },
      ],
    }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "turn.finished",
      turnId: "turn-1",
      startedAt: 1_000,
      durationMs: 250,
      persistedMessages: [{ messageId: "live-assistant" }],
    }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({
      type: "slash.execute",
      name: "reload",
      args: "",
    }).success).toBe(true);
    expect(RuntimeCommandSchema.safeParse({
      type: "user_message",
      text: "/reload",
    }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({
      type: "slash.execute",
      name: "reload\n/user-message",
      args: "",
    }).success).toBe(false);
    expect(RuntimeCapabilitiesSchema.safeParse({
      commands: [{
        name: "model",
        description: "Select model",
        source: "builtin",
        argument: {
          kind: "select",
          required: true,
          options: [{ value: "openai/gpt-5", label: "GPT-5" }],
        },
      }],
    }).success).toBe(true);
  });

  it("requires the current protocol version on both authenticated socket types", () => {
    expect(RuntimeClientMessageSchema.safeParse({
      type: "runtime.authenticate",
      protocolVersion: PROTOCOL_VERSION,
      credential: "runtime-secret",
      role: "agent",
      runtime: {
        runtimeId: "runtime-a",
        name: "legacy name",
        cwd: "D:\\work",
        status: "idle",
        hostname: "devbox",
        sessionName: "API refactor",
      },
    }).success).toBe(true);
    expect(RuntimeClientMessageSchema.safeParse({
      type: "runtime.authenticate",
      protocolVersion: 1,
      credential: "runtime-secret",
      runtime: { runtimeId: "runtime-a", name: "A", cwd: "/work", status: "idle" },
    }).success).toBe(false);
    expect(RuntimeClientMessageSchema.safeParse({
      type: "runtime.authenticate",
      credential: "runtime-secret",
      runtime: { runtimeId: "runtime-a", name: "A", cwd: "/work", status: "idle" },
    }).success).toBe(false);
    expect(DeviceClientMessageSchema.safeParse({
      type: "device.authenticate",
      credential: "device-secret",
    }).success).toBe(false);
  });

  it("accepts explicit and path-addressed files without a file-size limit", () => {
    const artifact = {
      artifactId: "00000000-0000-4000-8000-000000000002",
      fileName: "report.zip",
      mimeType: "application/zip",
      size: 100 * 1024 * 1024,
      sha256: "0".repeat(64),
    };
    expect(RuntimeEventSchema.safeParse({
      type: "artifact.started", artifact, commandId: "download-1", transferId: "download-1", offset: 0,
    }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "artifact.chunk", artifactId: artifact.artifactId, offset: 0, length: 3, data: "YWJj",
    }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({
      type: "artifact.download", artifactId: artifact.artifactId,
    }).success).toBe(true);
    expect(RuntimeCommandSchema.safeParse({
      type: "file.download", path: "C:\\work\\report.zip", offset: 65_536,
    }).success).toBe(true);

    const frame = encodeArtifactChunkFrame({
      runtimeId: "runtime-a",
      transferId: "download-1",
      offset: 3,
      data: new Uint8Array([97, 98, 99]),
    });
    const decoded = decodeArtifactChunkFrame(frame);
    expect(decoded).toMatchObject({ runtimeId: "runtime-a", transferId: "download-1", offset: 3 });
    expect([...decoded.data]).toEqual([97, 98, 99]);
  });

  it("validates turn lifecycle and command result events", () => {
    expect(RuntimeEventSchema.safeParse({
      type: "turn.started", turnId: "turn-1", startedAt: 1_700_000_000_000, turnIndex: 0,
    }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "turn.finished", turnId: "turn-1", startedAt: 1_700_000_000_000,
      durationMs: 250, turnIndex: 0,
    }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "turn.finished", turnId: "turn-1", startedAt: 1_700_000_000_000, durationMs: -1,
    }).success).toBe(false);

    for (const status of ["pending", "success", "failure", "cancelled"] as const) {
      expect(RuntimeEventSchema.safeParse({
        type: "command.result",
        commandId: "command-1",
        ok: status === "pending" || status === "success",
        status,
      }).success).toBe(true);
    }
  });

  it("carries a multi-select interaction request and its values array", () => {
    const request = {
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "ask-user-question",
      kind: "multi-select" as const,
      title: "Pick targets",
      description: "Choose one or more",
      options: [
        { value: "api", label: "API" },
        { value: "worker", label: "Worker", description: "Background jobs" },
      ],
      minSelections: 1,
      maxSelections: 2,
      expiresAt: 5_000,
    };
    const event = { type: "interaction.requested" as const, request };
    expect(RuntimeEventSchema.safeParse(event).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({ type: "interaction.snapshot", requests: [request] }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "interaction.cancelled",
      requestId: "request-1",
      reason: "owner_closed",
    }).success).toBe(true);
    expect(RuntimeCommandSchema.safeParse({
      type: "interaction.respond",
      requestId: "request-1",
      extensionId: "ask-user-question",
      response: { kind: "multi-select", values: ["api", "worker"] },
    }).success).toBe(true);

    // A multi-select request must carry at least one option and cannot use the
    // scalar `select` response shape.
    expect(RuntimeEventSchema.safeParse({
      ...event,
      request: { ...request, options: [] },
    }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({
      type: "interaction.respond",
      requestId: "request-1",
      extensionId: "ask-user-question",
      response: { kind: "multi-select", value: "api" },
    }).success).toBe(false);
  });

  it("keeps the composer model and context status optional in runtime metadata", () => {
    const runtime = {
      runtimeId: "runtime-1",
      name: "api",
      cwd: "/work/api",
      status: "idle" as const,
    };
    const authenticate = (candidate: unknown) => RuntimeClientMessageSchema.safeParse({
      type: "runtime.authenticate",
      protocolVersion: PROTOCOL_VERSION,
      credential: "credential",
      role: "agent",
      runtime: candidate,
    }).success;

    // `model` / `contextUsage` 可选是因为 Pi 可能没选模型、压缩后 token 估计未知——不是兼容位。
    expect(authenticate(runtime)).toBe(true);
    expect(authenticate({
      ...runtime,
      model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      thinkingLevel: "high",
      contextUsage: { tokens: 24_600, contextWindow: 200_000, percent: 12.3 },
    })).toBe(true);
    // Pi cannot estimate tokens right after compaction, so both usage numbers may be null.
    expect(authenticate({
      ...runtime,
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    })).toBe(true);
    expect(RuntimeEventSchema.safeParse({
      type: "runtime.metadata",
      metadata: {
        ...runtime,
        model: { provider: "openai", id: "gpt-5" },
      },
    }).success).toBe(true);

    // A model without provider/id, a negative token count, an out-of-range percentage, and a
    // zero window are all rejected instead of reaching the APP as nonsense status.
    expect(authenticate({ ...runtime, model: { provider: "", id: "gpt-5" } })).toBe(false);
    expect(authenticate({ ...runtime, model: { provider: "openai", id: "" } })).toBe(false);
    expect(authenticate({
      ...runtime,
      contextUsage: { tokens: -1, contextWindow: 200_000, percent: 1 },
    })).toBe(false);
    expect(authenticate({
      ...runtime,
      contextUsage: { tokens: 1, contextWindow: 200_000, percent: 100.1 },
    })).toBe(false);
    expect(authenticate({
      ...runtime,
      contextUsage: { tokens: 1, contextWindow: 0, percent: 1 },
    })).toBe(false);
  });
});

describe("receiver-driven range download", () => {
  const artifact = {
    artifactId: "00000000-0000-4000-8000-000000000001",
    fileName: "big.apk",
    mimeType: "application/vnd.android.package-archive",
    size: 1024,
    sha256: "0".repeat(64),
  };

  it("downloads 只有 range 一种模式（ADR-0008）", () => {
    const command = { type: "file.download" as const, path: "/tmp/big.apk" };
    expect(RuntimeCommandSchema.safeParse(command).success).toBe(true);
    // 旧的 `mode` 字段已删：带上它就是未知键，strict 拒绝。
    expect(RuntimeCommandSchema.safeParse({ ...command, mode: "pull" }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ ...command, mode: "stream" }).success).toBe(false);

    expect(RuntimeEventSchema.safeParse({ type: "artifact.started", commandId: "c1", transferId: "t1", artifact }).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({ type: "artifact.started", commandId: "c1", transferId: "t1", mode: "pull", artifact }).success).toBe(false);
  });

  it("bounds a read request to exactly one chunk and requires identity fields", () => {
    const read = { type: "artifact.read" as const, protocolVersion: PROTOCOL_VERSION, transferId: "t1", requestId: "r1", offset: 0, length: ARTIFACT_CHUNK_BYTES };
    expect(DeviceE2ePayloadSchema.safeParse(read).success).toBe(true);
    // 超过一个 chunk 的请求不该被接受：重传粒度与窗口都以 chunk 为单位。
    expect(DeviceE2ePayloadSchema.safeParse({ ...read, length: ARTIFACT_CHUNK_BYTES + 1 }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...read, length: 0 }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...read, offset: -1 }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...read, requestId: "" }).success).toBe(false);
  });

  it("parses done and read.failed", () => {
    expect(DeviceE2ePayloadSchema.safeParse({ type: "artifact.done", protocolVersion: PROTOCOL_VERSION, transferId: "t1" }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({ type: "artifact.read.failed", protocolVersion: PROTOCOL_VERSION, transferId: "t1", requestId: "r1", reason: "artifact_changed" }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({ type: "artifact.read.failed", protocolVersion: PROTOCOL_VERSION, transferId: "t1", requestId: "r1", reason: "" }).success).toBe(false);
  });
});

describe("phone file upload", () => {
  const init = {
    type: "file.upload.init" as const,
    protocolVersion: PROTOCOL_VERSION,
    requestId: "r1",
    runtimeId: "runtime-a",
    directory: "/work/.pi-remote-uploads",
    fileName: "shot.png",
    size: 1024,
    sha256: "a".repeat(64),
  };

  it("bounds the upload request fields the receiver relies on", () => {
    expect(DeviceE2ePayloadSchema.safeParse(init).success).toBe(true);
    // 上限之外要么由 schema 拦，要么由手机 UI 拦；这里钉住 schema 这一侧。
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, size: MAX_UPLOAD_BYTES }).success).toBe(true);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, size: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, size: -1 }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, sha256: "A".repeat(64) }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, sha256: "a".repeat(63) }).success).toBe(false);
    // 文件名必须只是一个名字：拼成路径就等于把落地位置交给手机随便写。
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, fileName: "../escape.png" }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, fileName: "a/b.png" }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, fileName: "a\b.png" }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, fileName: ".." }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ ...init, fileName: "" }).success).toBe(false);
  });

  it("never reports a durable prefix past the declared size", () => {
    const ready = { type: "file.upload.ready" as const, protocolVersion: PROTOCOL_VERSION, requestId: "r1", uploadId: "u1", chunkSize: ARTIFACT_CHUNK_BYTES, receivedBytes: 0 };
    expect(RelayToDeviceMessageSchema.safeParse(ready).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({ ...ready, receivedBytes: MAX_UPLOAD_BYTES }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({ ...ready, receivedBytes: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
    expect(RelayToDeviceMessageSchema.safeParse({ ...ready, chunkSize: ARTIFACT_CHUNK_BYTES + 1 }).success).toBe(false);
    expect(RelayToDeviceMessageSchema.safeParse({ ...ready, chunkSize: 0 }).success).toBe(false);

    // 接收方驱动（ADR-0012）：Host 按持久前缀发 read，手机只应答不推送——done 已不存在。
    expect(DeviceE2ePayloadSchema.safeParse({ type: "file.upload.done", protocolVersion: PROTOCOL_VERSION, uploadId: "u1" }).success).toBe(false);
    expect(RelayToDeviceMessageSchema.safeParse({
      type: "file.upload.read",
      protocolVersion: PROTOCOL_VERSION,
      uploadId: "u1",
      offset: 0,
      length: ARTIFACT_CHUNK_BYTES,
    }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({
      type: "file.upload.read",
      protocolVersion: PROTOCOL_VERSION,
      uploadId: "u1",
      offset: 0,
      length: ARTIFACT_CHUNK_BYTES + 1,
    }).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ type: "file.upload.cancel", protocolVersion: PROTOCOL_VERSION, uploadId: "u1" }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({ type: "file.upload.progress", protocolVersion: PROTOCOL_VERSION, uploadId: "u1", receivedBytes: 4096 }).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse({
      type: "file.upload.finished",
      protocolVersion: PROTOCOL_VERSION,
      uploadId: "u1",
      path: "/work/.pi-remote-uploads/shot.png",
      fileName: "shot.png",
      size: 1024,
      sha256: "a".repeat(64),
    }).success).toBe(true);
    // 用了就一定要说清是谁失败了：手机侧要靠它把原因挂到对应的任务上。
    expect(RelayToDeviceMessageSchema.safeParse({ type: "file.upload.failed", protocolVersion: PROTOCOL_VERSION, code: "hash_mismatch", message: "校验失败" }).success).toBe(true);
  });

  it("carries attachments as plain paths, and only when the runtime advertises the capability", () => {
    const path = "/work/.pi-remote-uploads/shot.png";
    const message = { type: "user_message" as const, text: "看一下这张图", attachments: [path] };
    expect(RuntimeCommandSchema.safeParse(message).success).toBe(true);
    expect(RuntimeCommandSchema.safeParse({ ...message, attachments: Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 1 }, () => path) }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ ...message, attachments: [""] }).success).toBe(false);
    // 附件只是路径：描述符那套字段不该再被接受（它们已经不存在了）。
    expect(RuntimeCommandSchema.safeParse({ ...message, attachments: [{ path }] }).success).toBe(false);

    // 回退契约：缺省 attachments 必须逐字段等于从前的消息形状（附件本身仍可选，
    // 因为一条消息可以没有附件）。
    const plain = RuntimeCommandSchema.parse({ type: "user_message", text: "hi", messageId: "q1", delivery: "steer" });
    expect(plain).toEqual({ type: "user_message", text: "hi", messageId: "q1", delivery: "steer" });
    // 能力位已删（ADR-0008）：附件无条件支持，未知键被 strict 拒绝。
    expect(RuntimeCapabilitiesSchema.safeParse({ commands: [] }).success).toBe(true);
    expect(RuntimeCapabilitiesSchema.safeParse({ commands: [], messageAttachments: true }).success).toBe(false);
  });

  // ADR-0008 的全部机制就是这一条：版本不匹配当场拒绝。它同时也是 "只有最新的两端能互连" 的锁——
  // 如果哪天为了兼容又允许旧版本号，这条会红。
  it("rejects any protocol version other than the current one", () => {
    const runtime = { runtimeId: "r1", name: "R", cwd: "/w", status: "idle" as const };
    const authenticate = (protocolVersion: number) => RuntimeClientMessageSchema.safeParse({
      type: "runtime.authenticate", protocolVersion, credential: "c", role: "agent", runtime,
    }).success;
    expect(authenticate(PROTOCOL_VERSION)).toBe(true);
    expect(authenticate(PROTOCOL_VERSION - 1)).toBe(false);
    expect(authenticate(PROTOCOL_VERSION + 1)).toBe(false);
  });

  // 中继看得见的明文面上**没有命令通道**：命令只能存在于 E2E 密文里（ADR-0008）。
  // 这是安全边界（中继不应当能看懂手机上发的命令），不是性能选项——推送删掉后
  // 那条"只允许推送进度"的收窄也随之消失，明文 `runtime.command` 整条不再存在。
  it("设备明文面没有命令通道", () => {
    const plaintext = (command: unknown) => DeviceClientMessageSchema.safeParse({
      type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "r1", commandId: "c1", command,
    }).success;
    for (const command of [
      { type: "artifact.ack", transferId: "t1", receivedOffset: 4 },
      { type: "artifact.cancel", transferId: "t1" },
      { type: "stop" },
      { type: "user_message", text: "hi" },
      { type: "file.download", path: "/tmp/x" },
      { type: "session.sync", sessionId: "s1", syncId: "y1" },
    ]) expect(plaintext(command)).toBe(false);
  });
});
