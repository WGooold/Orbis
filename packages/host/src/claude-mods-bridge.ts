import { randomUUID } from "node:crypto";
import {
  ChatMessageSchema,
  RuntimeEventSchema,
  type ChatMessage,
  type RuntimeEvent,
  type RuntimeMetadata,
  type RemoteContent,
  type RuntimeCommandStatus,
} from "@orbis/protocol";

/** The bridge contract is deliberately independent of the TUI's internal API. */
export const CLAUDE_BRIDGE_VERSION = "1";
export const CLAUDE_MIN_VERSION = "2.1.287";
export const CLAUDE_BRIDGE_CAPABILITIES = [
  "prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call",
] as const;
export type ClaudeBridgeCapability = typeof CLAUDE_BRIDGE_CAPABILITIES[number];

export type ClaudeModsHello = {
  type: "hello";
  sessionId: string;
  instanceId: string;
  cwd: string;
  claudeVersion: string;
  bridgeVersion: string;
  capabilities: readonly string[];
};

export type ClaudeModsCommand =
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "stop" };

export type ClaudeModsNativeEvent =
  | { type: "prompt.submit"; text: string; origin: string; turnId?: string; wait?: boolean }
  | { type: "session.append"; uuid: string; door: string; message: { type: string; role?: string; content: unknown } }
  | { type: "turn.start"; turnId: string; startedAt?: number; turnIndex?: number }
  | { type: "turn.step.chunks"; turnId: string; stepIndex: number; chunks: readonly { blockIndex: number; contentType: "text" | "thinking"; delta: string }[] }
  | { type: "turn.complete"; turnId: string; durationMs?: number; turnIndex?: number; answer?: string; reason?: string; isAborted?: boolean }
  | { type: "tool.started"; toolCallId: string; toolName: string; arguments: unknown }
  | { type: "tool.finished"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "command.result"; commandId: string; ok: boolean; status?: RuntimeCommandStatus; error?: string; result?: unknown };

export type ClaudeModsPoll = {
  ok: true;
  generation: string;
  commands: readonly { commandId: string; command: ClaudeModsCommand }[];
} | {
  ok: false;
  error: string;
};

export type ClaudeModsCommandResult = "accepted" | "offline" | "queue_full" | "id_conflict" | "not_cancelable";

type Session = {
  runtime: RuntimeMetadata;
  instanceId: string;
  claudeVersion: string;
  bridgeVersion: string;
  capabilities: ReadonlySet<string>;
  generation: string;
  commands: Map<string, { commandId: string; command: ClaudeModsCommand }>;
  lastSeenAt: number;
  activeTurn?: {
    turnId: string;
    startedAt: number;
    messages: Map<string, { blocks: Map<number, { type: "text" | "thinking"; text: string }> }>;
    appendedAssistant: { uuid: string; content: RemoteContent[] }[];
  };
  pendingStopId?: string;
  completedStops: Map<string, { turnId: string; event: Extract<RuntimeEvent, { type: "command.result" }> }>;
  completedTurns: Set<string>;
};

export type ClaudeModsBridgeOptions = {
  minClaudeVersion?: string;
  requiredCapabilities?: readonly ClaudeBridgeCapability[];
  onRuntimeOnline?: (runtime: RuntimeMetadata) => void;
  onRuntimeOffline?: (runtimeId: string, reason: string) => void;
  onEvent?: (runtimeId: string, event: RuntimeEvent) => void;
};

/**
 * Host side of the Claude Code Mods bridge.
 *
 * Mods has no server or websocket primitive. The production transport therefore
 * calls `hello`, `poll`, and `receiveEvent` over the authenticated loopback HTTP
 * endpoint. This class owns connection generations and the bounded command queue;
 * a successful HTTP request is never treated as a completed native command.
 */
export class ClaudeModsBridge {
  readonly #options: ClaudeModsBridgeOptions;
  readonly #sessions = new Map<string, Session>();

  constructor(options: ClaudeModsBridgeOptions = {}) { this.#options = options; }

  runtimeIds(): readonly string[] { return [...this.#sessions.keys()]; }
  isOnline(runtimeId: string): boolean { return this.#sessions.has(runtimeId); }

  runtimeMetadata(): RuntimeMetadata[] { return [...this.#sessions.values()].map(session => session.runtime); }
  isHookCommandId(runtimeId: string, commandId: string): boolean { return this.#sessions.get(runtimeId)?.commands.has(commandId) ?? false; }

  hello(input: unknown): { ok: true; runtimeId: string; generation: string; capabilities: readonly string[] } | { ok: false; error: string } {
    const parsed = parseHello(input);
    if (parsed === undefined) return { ok: false, error: "invalid_hello" };
    if (parsed.bridgeVersion !== CLAUDE_BRIDGE_VERSION) return { ok: false, error: `bridge_version_unsupported:${CLAUDE_BRIDGE_VERSION}` };
    const minimum = this.#options.minClaudeVersion ?? CLAUDE_MIN_VERSION;
    if (compareVersion(parsed.claudeVersion, minimum) < 0) return { ok: false, error: `claude_version_too_old:${minimum}` };
    const required = this.#options.requiredCapabilities ?? CLAUDE_BRIDGE_CAPABILITIES;
    const capabilities = new Set(parsed.capabilities);
    const missing = required.find(capability => !capabilities.has(capability));
    if (missing !== undefined) return { ok: false, error: `missing_capability:${missing}` };
    const runtimeId = `claude:${parsed.sessionId}`;
    for (const [otherRuntimeId, session] of this.#sessions) {
      if (otherRuntimeId !== runtimeId && session.instanceId === parsed.instanceId) {
        this.disconnect(otherRuntimeId, session.generation, "session_changed");
      }
    }
    const previous = this.#sessions.get(runtimeId);
    if (previous !== undefined) this.#options.onRuntimeOffline?.(runtimeId, "replaced_by_new_bridge");
    const generation = randomUUID();
    const runtime: RuntimeMetadata = { runtimeId, name: "Claude Code", cwd: parsed.cwd, status: "idle", sessionId: parsed.sessionId };
    this.#sessions.set(runtimeId, { runtime, instanceId: parsed.instanceId, claudeVersion: parsed.claudeVersion, bridgeVersion: parsed.bridgeVersion,
      capabilities, generation, commands: new Map(), completedStops: new Map(), completedTurns: new Set(), lastSeenAt: Date.now() });
    this.#options.onRuntimeOnline?.(runtime);
    return { ok: true, runtimeId, generation, capabilities: [...capabilities] };
  }

  pollRequest(input: unknown): ClaudeModsPoll {
    if (!isRecord(input) || !text(input.runtimeId, 128) || !text(input.generation, 128)) return { ok: false, error: "invalid_poll" };
    return this.poll(input.runtimeId, input.generation);
  }

  receiveRequest(input: unknown): "accepted" | "invalid" | "stale" | "offline" {
    if (!isRecord(input) || !text(input.runtimeId, 128) || !text(input.generation, 128) || input.event === undefined) return "invalid";
    return this.receiveEvent(input.runtimeId, input.generation, input.event);
  }

  poll(runtimeId: string, generation: string): ClaudeModsPoll {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined) return { ok: false, error: "bridge_offline" };
    if (session.generation !== generation) return { ok: false, error: "stale_generation" };
    session.lastSeenAt = Date.now();
    // Keep commands outstanding until a native result arrives. Mods caches command IDs
    // and replays that result if the HTTP response carrying it was lost.
    const commands = [...session.commands.values()];
    return { ok: true, generation, commands };
  }

  sendCommand(runtimeId: string, commandId: string, command: ClaudeModsCommand): ClaudeModsCommandResult {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined) return "offline";
    const previous = session.commands.get(commandId);
    if (previous !== undefined) return JSON.stringify(previous.command) === JSON.stringify(command) ? "accepted" : "id_conflict";
    if (command.type === "stop" && (session.activeTurn === undefined || session.pendingStopId !== undefined)) return "not_cancelable";
    if (session.commands.size >= 64) return "queue_full";
    session.commands.set(commandId, { commandId, command });
    if (command.type === "stop") session.pendingStopId = commandId;
    return "accepted";
  }

  receiveEvent(runtimeId: string, generation: string, input: unknown): "accepted" | "invalid" | "stale" | "offline" {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined) return "offline";
    if (session.generation !== generation) return "stale";
    const parsed = parseNativeEvent(input);
    if (parsed === undefined) return "invalid";
    session.lastSeenAt = Date.now();
    if (parsed.type === "turn.complete" && session.completedTurns.has(parsed.turnId)) {
      for (const completed of session.completedStops.values()) {
        if (completed.turnId === parsed.turnId) this.#options.onEvent?.(runtimeId, completed.event);
      }
      return "accepted";
    }
    if (parsed.type === "turn.start") {
      const startedAt = finiteTime(parsed.startedAt) ?? Date.now();
      session.activeTurn = { turnId: parsed.turnId, startedAt, messages: new Map(), appendedAssistant: [] };
      this.#status(runtimeId, "running");
    } else if (parsed.type === "turn.complete") {
      const stopCommandId = session.pendingStopId;
      delete session.pendingStopId;
      this.#status(runtimeId, "idle");
      if (stopCommandId !== undefined) {
        const stopped = parsed.isAborted === true;
        const event: RuntimeEvent = { type: "command.result", commandId: stopCommandId, ok: stopped,
          status: stopped ? "success" : "not_cancelable", ...(stopped ? {} : { error: "claude_turn_completed_before_stop" }) };
        session.commands.delete(stopCommandId);
        session.completedStops.set(stopCommandId, { turnId: parsed.turnId, event });
        while (session.completedStops.size > 64) session.completedStops.delete(session.completedStops.keys().next().value!);
        this.#options.onEvent?.(runtimeId, event);
      }
    } else if (parsed.type === "command.result") {
      const pending = session.commands.get(parsed.commandId);
      // Stop completion is owned by the native turn.complete event observed above.
      // A Mods callback or an HTTP response cannot claim that the turn stopped.
      if (pending === undefined || pending.command.type === "stop") return "invalid";
      if (parsed.status !== "pending") {
        session.commands.delete(parsed.commandId);
        if (session.pendingStopId === parsed.commandId) delete session.pendingStopId;
      }
    }
    const events = normalizeNativeEvent(runtimeId, parsed, session);
    if (!events.every(event => RuntimeEventSchema.safeParse(event).success)) return "invalid";
    for (const event of events) this.#options.onEvent?.(runtimeId, event);
    if (parsed.type === "turn.complete") {
      delete session.activeTurn;
      session.completedTurns.add(parsed.turnId);
      while (session.completedTurns.size > 128) session.completedTurns.delete(session.completedTurns.values().next().value!);
    }
    return "accepted";
  }

  disconnect(runtimeId: string, generation?: string, reason = "bridge_disconnected"): void {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined || (generation !== undefined && session.generation !== generation)) return;
    this.#sessions.delete(runtimeId);
    this.#options.onRuntimeOffline?.(runtimeId, reason);
  }

  generationOf(runtimeId: string): string | undefined { return this.#sessions.get(runtimeId)?.generation; }

  expireStale(now = Date.now(), leaseMs = 15_000): number {
    let expired = 0;
    for (const [runtimeId, session] of this.#sessions) {
      if (now - session.lastSeenAt <= leaseMs) continue;
      this.disconnect(runtimeId, session.generation, "bridge_lease_expired");
      expired++;
    }
    return expired;
  }

  close(): void {
    for (const [runtimeId, session] of this.#sessions) this.disconnect(runtimeId, session.generation, "host_shutdown");
  }

  #status(runtimeId: string, status: RuntimeMetadata["status"]): void {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined || session.runtime.status === status) return;
    session.runtime = { ...session.runtime, status };
    this.#options.onEvent?.(runtimeId, { type: "runtime.status", status });
  }
}

function parseHello(value: unknown): ClaudeModsHello | undefined {
  if (!isRecord(value) || value.type !== "hello" || !text(value.sessionId, 256) || !text(value.instanceId, 128) || !text(value.cwd, 4096) ||
      !text(value.claudeVersion, 64) || !text(value.bridgeVersion, 64) || !Array.isArray(value.capabilities) ||
      !validVersion(value.claudeVersion) || value.capabilities.length > 64 || !value.capabilities.every(item => typeof item === "string" && text(item, 128))) return undefined;
  return { type: "hello", sessionId: value.sessionId, instanceId: value.instanceId, cwd: value.cwd, claudeVersion: value.claudeVersion,
    bridgeVersion: value.bridgeVersion, capabilities: value.capabilities };
}

function parseNativeEvent(value: unknown): ClaudeModsNativeEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "prompt.submit" && text(value.text, 100_000) && text(value.origin, 128)) return { type: value.type, text: value.text, origin: value.origin, ...(text(value.turnId, 256) ? { turnId: value.turnId } : {}), ...(typeof value.wait === "boolean" ? { wait: value.wait } : {}) };
  if (value.type === "session.append" && text(value.uuid, 256) && text(value.door, 64) && isRecord(value.message) && text(value.message.type, 64)) return { type: value.type, uuid: value.uuid, door: value.door, message: { type: value.message.type, ...(text(value.message.role, 32) ? { role: value.message.role } : {}), content: value.message.content } };
  if (value.type === "turn.start" && text(value.turnId, 256)) {
    const startedAt = finiteTime(value.startedAt); const turnIndex = integer(value.turnIndex);
    return { type: value.type, turnId: value.turnId, ...(startedAt === undefined ? {} : { startedAt }), ...(turnIndex === undefined ? {} : { turnIndex }) };
  }
  if (value.type === "turn.complete" && text(value.turnId, 256)) {
    const durationMs = finiteTime(value.durationMs); const turnIndex = integer(value.turnIndex);
    return { type: value.type, turnId: value.turnId, ...(durationMs === undefined ? {} : { durationMs }), ...(turnIndex === undefined ? {} : { turnIndex }), ...(text(value.messageId, 256) ? { messageId: value.messageId } : {}), ...(typeof value.answer === "string" ? { answer: value.answer.slice(0, 100_000) } : {}), ...(text(value.reason, 64) ? { reason: value.reason } : {}), ...(typeof value.isAborted === "boolean" ? { isAborted: value.isAborted } : {}) };
  }
  if (value.type === "turn.step.chunks" && text(value.turnId, 256)) {
    const stepIndex = integer(value.stepIndex);
    if (stepIndex === undefined || !Array.isArray(value.chunks) || value.chunks.length > 128 ||
        !value.chunks.every(chunk => isRecord(chunk) && integer(chunk.blockIndex) !== undefined &&
          (chunk.contentType === "text" || chunk.contentType === "thinking") && typeof chunk.delta === "string" && chunk.delta.length <= 32_000)) return undefined;
    return { type: value.type, turnId: value.turnId, stepIndex,
      chunks: value.chunks.map(chunk => {
        const item = chunk as Record<string, unknown>;
        return { blockIndex: item.blockIndex as number, contentType: item.contentType as "text" | "thinking", delta: item.delta as string };
      }) };
  }
  if (value.type === "tool.started" && text(value.toolCallId, 256) && text(value.toolName, 256)) return { type: value.type, toolCallId: value.toolCallId, toolName: value.toolName, arguments: value.arguments };
  if (value.type === "tool.finished" && text(value.toolCallId, 256) && text(value.toolName, 256)) return { type: value.type, toolCallId: value.toolCallId, toolName: value.toolName, result: value.result, ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}) };
  if (value.type === "command.result" && text(value.commandId, 256) && typeof value.ok === "boolean") return { type: value.type, commandId: value.commandId, ok: value.ok, ...(value.status === "pending" || value.status === "success" || value.status === "failure" || value.status === "cancelled" || value.status === "not_cancelable" || value.status === "already_delivered" || value.status === "message_id_conflict" ? { status: value.status } : {}), ...(text(value.error, 4_000) ? { error: value.error } : {}), ...(value.result === undefined ? {} : { result: value.result }) };
  return undefined;
}

function normalizeNativeEvent(runtimeId: string, native: ClaudeModsNativeEvent, session: Session): RuntimeEvent[] {
  switch (native.type) {
    case "prompt.submit": {
      // The native prompt.submit observer is not emitted for a Mods API submission in
      // the tested build, and composer prompts are persisted again by session.append.
      // Treating this observation as a message would create duplicates.
      return [];
    }
    case "session.append": {
      const role = native.message.role === "assistant" ? "assistant" : native.message.role === "user" ? "user" : native.message.type === "system" ? "system" : undefined;
      if (role === undefined) return [];
      const content = contentOf(native.message.content);
      if (content.length === 0) return [];
      if (role === "assistant" && session.activeTurn !== undefined) {
        session.activeTurn.appendedAssistant.push({ uuid: native.uuid, content });
        return [];
      }
      const message = messageOf(native.uuid, role, content);
      return [{ type: "message.started", message }, { type: "message.finished", message }];
    }
    case "turn.start": return [{ type: "turn.started", turnId: native.turnId, startedAt: native.startedAt ?? Date.now(), ...(native.turnIndex === undefined ? {} : { turnIndex: native.turnIndex }) }];
    case "turn.step.chunks": {
      const active = session.activeTurn;
      if (active === undefined || active.turnId !== native.turnId) return [];
      const messageId = `${native.turnId}:${native.stepIndex}`;
      let message = active.messages.get(messageId);
      const events: RuntimeEvent[] = [];
      if (message === undefined) {
        message = { blocks: new Map() };
        active.messages.set(messageId, message);
        events.push({ type: "message.started", message: messageOf(messageId, "assistant", []) });
      }
      for (const chunk of native.chunks) {
        const block = message.blocks.get(chunk.blockIndex);
        if (block === undefined) message.blocks.set(chunk.blockIndex, { type: chunk.contentType, text: chunk.delta });
        else if (block.type === chunk.contentType) block.text += chunk.delta;
        events.push({ type: "message.delta", messageId, contentType: chunk.contentType, contentIndex: chunk.blockIndex, delta: chunk.delta });
      }
      return events;
    }
    case "turn.complete": {
      const startedAt = session.activeTurn?.startedAt ?? Date.now();
      const active = session.activeTurn?.turnId === native.turnId ? session.activeTurn : undefined;
      const appended = [...(active?.appendedAssistant ?? [])];
      const persistedMessages: { messageId: string; entryId: string }[] = [];
      const events: RuntimeEvent[] = [];
      for (const [messageId, live] of active?.messages ?? []) {
        const content = [...live.blocks.entries()].sort(([a], [b]) => a - b)
          .map(([, block]) => ({ type: block.type, text: block.text } satisfies RemoteContent));
        const textKey = contentKey(content);
        const matchIndex = appended.findIndex(entry => contentKey(entry.content) === textKey && textKey !== "[]");
        if (matchIndex >= 0) persistedMessages.push({ messageId, entryId: appended.splice(matchIndex, 1)[0]!.uuid });
        const message = messageOf(messageId, "assistant", content);
        events.push({ type: "message.finished", message });
      }
      for (const entry of appended) {
        const message = messageOf(entry.uuid, "assistant", entry.content);
        events.push({ type: "message.started", message }, { type: "message.finished", message });
      }
      events.push({ type: "turn.finished", turnId: native.turnId, startedAt,
        durationMs: native.durationMs ?? Math.max(0, Date.now() - startedAt),
        ...(native.turnIndex === undefined ? {} : { turnIndex: native.turnIndex }),
        ...(persistedMessages.length === 0 ? {} : { persistedMessages }) });
      return events;
    }
    case "tool.started": return [{ type: "tool.started", toolCallId: native.toolCallId, toolName: native.toolName, arguments: native.arguments }];
    case "tool.finished": return [{ type: "tool.finished", toolCallId: native.toolCallId, toolName: native.toolName, result: native.result, isError: native.isError === true }];
    case "command.result": return [{ type: "command.result", commandId: native.commandId, ok: native.ok, ...(native.status === undefined ? {} : { status: native.status }), ...(native.error === undefined ? {} : { error: native.error }), ...(native.result === undefined ? {} : { result: native.result }) }];
  }
}

function messageOf(messageId: string, role: ChatMessage["role"], content: readonly RemoteContent[]): ChatMessage {
  const result = ChatMessageSchema.parse({ messageId, role, content, timestamp: Date.now() });
  return result;
}

function contentOf(value: unknown): RemoteContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): RemoteContent[] => {
    if (!isRecord(item) || typeof item.type !== "string") return [];
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
    if (item.type === "thinking" && typeof item.thinking === "string") return [{ type: "thinking", text: item.thinking }];
    if (item.type === "tool_use" && text(item.id, 256) && text(item.name, 256)) return [{ type: "tool_call", toolCallId: item.id, toolName: item.name, arguments: item.input }];
    return [];
  });
}

function contentKey(content: readonly RemoteContent[]): string {
  return JSON.stringify(content.filter(item => item.type === "text" || item.type === "thinking"));
}

function compareVersion(a: string, b: string): number {
  const left = a.match(/\d+/g)?.map(Number) ?? [];
  const right = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function validVersion(value: string): boolean { return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value); }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function finiteTime(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined; }
