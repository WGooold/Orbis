import { randomUUID } from "node:crypto";
import type { ToolContentStore } from "@orbis/runtime-bridge";
import {
  ChatMessageSchema,
  RuntimeEventSchema,
  type ChatMessage,
  type PermissionManagement,
  type RuntimeCapabilities,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeMetadata,
  type RemoteContent,
  type RuntimeCommandStatus,
  type RuntimeSlashCommand,
  type ToolContentPage,
  type ToolContentReadRequest,
} from "@orbis/protocol";
import { ClaudeSessionHistory } from "./claude-session-history.js";
import { claudeConfigDir, type ClaudeTranscriptFacts } from "./claude-transcript.js";
import { localHostname } from "./sessions.js";
import { LocalClaudeProcessControl, type ClaudeProcessControl, type ClaudeProcessIdentity } from "./claude-process.js";

/** The bridge contract is deliberately independent of the TUI's internal API. */
export const CLAUDE_BRIDGE_VERSION = "1";
export const CLAUDE_MIN_VERSION = "2.1.287";
export const CLAUDE_BRIDGE_CAPABILITIES = [
  "prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call",
] as const;
export type ClaudeBridgeCapability = typeof CLAUDE_BRIDGE_CAPABILITIES[number];

/** Claude's `/effort` levels; a model that lacks one says so in the command's output. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ClaudeModsHello = {
  type: "hello";
  sessionId: string;
  instanceId: string;
  cwd: string;
  claudeVersion: string;
  bridgeVersion: string;
  capabilities: readonly string[];
  /** `CLAUDE_CONFIG_DIR` of the TUI process, when set; locates the native transcript. */
  configDir?: string;
  /** Set when the Host opened this TUI for a phone (`ORBIS_CLAUDE_LAUNCH_ID`). */
  launchId?: string;
  processId?: number;
};

export type ClaudeModsCommand =
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "slash"; name: string; args: string }
  | { type: "stop" };

/** What the TUI reports about itself; each field present replaces the previous value. */
export type ClaudeSessionState = {
  model?: string;
  /** Claude's own display name of the model (`Opus 5.5`). */
  modelName?: string;
  /** The `/config` model row: its choices and the current one. */
  modelOptions?: readonly string[];
  modelSetting?: string;
  effort?: string;
  context?: { tokens?: number; window: number; percent?: number };
  commands?: readonly { name: string; description?: string; source: string }[];
};

export type ClaudeModsNativeEvent =
  | { type: "prompt.submit"; text: string; origin: string; turnId?: string; wait?: boolean }
  | { type: "session.append"; uuid: string; door: string }
  | { type: "session.state"; state: ClaudeSessionState }
  | { type: "compaction"; phase: "running" | "idle" | "failed" }
  | { type: "interactions.local" }
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
  /** Hook interactions of this Session waiting for a phone; the TUI shows how to take them back. */
  pendingInteractions?: number;
} | {
  ok: false;
  error: string;
};

export type ClaudeModsCommandResult = "accepted" | "offline" | "queue_full" | "id_conflict" | "not_cancelable";

type Session = {
  process?: ClaudeProcessIdentity;
  closing?: Promise<void>;
  runtime: RuntimeMetadata;
  instanceId: string;
  claudeVersion: string;
  bridgeVersion: string;
  capabilities: ReadonlySet<string>;
  generation: string;
  commands: Map<string, { commandId: string; command: ClaudeModsCommand }>;
  lastSeenAt: number;
  history: ClaudeSessionHistory;
  state: ClaudeSessionState;
  facts: ClaudeTranscriptFacts;
  compaction: "running" | "idle" | "failed";
  published: { metadata: string; capabilities: string };
  activeTurn?: {
    turnId: string;
    startedAt: number;
    messages: Map<string, { blocks: Map<number, { type: "text" | "thinking"; text: string }> }>;
    /** Transcript rows announced by `session.append` during the turn. */
    announced: string[];
  };
  /** Arguments of running tools, so a finished one can be matched to a pending Hook. */
  runningTools: Map<string, { toolName: string; arguments: unknown }>;
  pendingStopId?: string;
  completedStops: Map<string, { turnId: string; event: Extract<RuntimeEvent, { type: "command.result" }> }>;
  completedTurns: Set<string>;
};

export type ClaudeModsBridgeOptions = {
  processControl?: ClaudeProcessControl;
  minClaudeVersion?: string;
  requiredCapabilities?: readonly ClaudeBridgeCapability[];
  onRuntimeOnline?: (runtime: RuntimeMetadata) => void;
  onRuntimeOffline?: (runtimeId: string, reason: string) => void;
  onEvent?: (runtimeId: string, event: RuntimeEvent) => void;
  /** A hello the Host refused; the reason belongs in diagnostics, not only in the TUI. */
  onRejected?: (reason: string, hello: Partial<ClaudeModsHello>) => void;
  /** A native tool finished: any Hook asking about it was answered in the TUI. */
  onToolFinished?: (runtimeId: string, toolName: string, input: unknown) => void;
  /** A main turn ended: nothing of it can still be waiting for permission. */
  onTurnFinished?: (runtimeId: string) => void;
  /** The person at the computer asked to answer pending interactions there. */
  onLocalInteractions?: (runtimeId: string) => void;
  pendingInteractions?: (runtimeId: string) => number;
  hostId?: () => string;
  createHistory?: (sessionId: string, configDir: string, publish: (event: Extract<RuntimeEvent, { type: "session.patch" | "session.tools.produced" }>) => void,
    onFacts: (facts: ClaudeTranscriptFacts) => void) => ClaudeSessionHistory;
};

/**
 * Host side of the Claude Code Mods bridge.
 *
 * Mods has no server or websocket primitive. The production transport therefore
 * calls `hello`, `poll`, and `receiveEvent` over the authenticated loopback HTTP
 * endpoint. This class owns connection generations and the bounded command queue;
 * a successful HTTP request is never treated as a completed native command.
 *
 * Conversation state is published through a versioned session source: the native
 * transcript is canonical history, streamed turn output is live state.
 */
export class ClaudeModsBridge {
  readonly #options: ClaudeModsBridgeOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #launches = new Map<string, { resolve: (runtime: RuntimeMetadata) => void; timer: ReturnType<typeof setTimeout> }>();
  #toolStore: ToolContentStore | undefined;
  readonly #processControl: ClaudeProcessControl;

  constructor(options: ClaudeModsBridgeOptions = {}) {
    this.#options = options;
    this.#processControl = options.processControl ?? new LocalClaudeProcessControl();
  }

  runtimeIds(): readonly string[] { return [...this.#sessions.keys()]; }
  isOnline(runtimeId: string): boolean { return this.#sessions.has(runtimeId); }
  statusOf(runtimeId: string): RuntimeMetadata["status"] | undefined { return this.#sessions.get(runtimeId)?.runtime.status; }
  runtimeMetadata(): RuntimeMetadata[] { return [...this.#sessions.values()].map(session => session.runtime); }
  configDirs(): string[] { return [...new Set([...this.#sessions.values()].map(session => session.history.configDir))]; }
  capabilities(runtimeId: string): RuntimeCapabilities | undefined {
    const session = this.#sessions.get(runtimeId);
    return session === undefined ? undefined : claudeCapabilities(session.state, session.process !== undefined);
  }
  hasCommand(runtimeId: string, name: string): boolean {
    return this.capabilities(runtimeId)?.commands.some(command => command.name === name) ?? false;
  }
  /** Claude reports compaction through Mods; it has no visible retry state. */
  activity(runtimeId: string): Extract<RuntimeEvent, { type: "execution.activity" }> | undefined {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined) return undefined;
    const turnId = session.activeTurn?.turnId;
    return { type: "execution.activity", retry: "unavailable", compaction: { phase: session.compaction, ...(turnId === undefined ? {} : { turnId }) } };
  }

  attachToolStore(store: ToolContentStore): void {
    this.#toolStore = store;
    for (const session of this.#sessions.values()) session.history.attachToolStore(store);
  }

  readTool(owner: string, request: ToolContentReadRequest, signal?: AbortSignal): Promise<ToolContentPage> | undefined {
    return this.#sessions.get(request.runtimeId)?.history.readTool(owner, request, signal);
  }

  /** Resolves with the runtime of the TUI that reports `launchId`, or undefined on timeout. */
  waitForLaunch(launchId: string, timeoutMs: number): Promise<RuntimeMetadata | undefined> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.#launches.delete(launchId); resolve(undefined); }, timeoutMs);
      timer.unref?.();
      this.#launches.set(launchId, { resolve: runtime => { clearTimeout(timer); this.#launches.delete(launchId); resolve(runtime); }, timer });
    });
  }

  hello(input: unknown): { ok: true; runtimeId: string; generation: string; capabilities: readonly string[] } | { ok: false; error: string } {
    const parsed = parseHello(input);
    const reject = (error: string) => {
      this.#options.onRejected?.(error, parsed ?? (isRecord(input) ? input as Partial<ClaudeModsHello> : {}));
      return { ok: false as const, error };
    };
    if (parsed === undefined) return reject("invalid_hello");
    if (parsed.bridgeVersion !== CLAUDE_BRIDGE_VERSION) return reject(`bridge_version_unsupported:${CLAUDE_BRIDGE_VERSION}`);
    const minimum = this.#options.minClaudeVersion ?? CLAUDE_MIN_VERSION;
    if (compareVersion(parsed.claudeVersion, minimum) < 0) return reject(`claude_version_too_old:${minimum}`);
    const required = this.#options.requiredCapabilities ?? CLAUDE_BRIDGE_CAPABILITIES;
    const capabilities = new Set(parsed.capabilities);
    const missing = required.find(capability => !capabilities.has(capability));
    if (missing !== undefined) return reject(`missing_capability:${missing}`);
    const runtimeId = `claude:${parsed.sessionId}`;
    for (const [otherRuntimeId, session] of this.#sessions) {
      if (otherRuntimeId !== runtimeId && session.instanceId === parsed.instanceId) {
        this.disconnect(otherRuntimeId, session.generation, "session_changed");
      }
    }
    const previous = this.#sessions.get(runtimeId);
    if (previous !== undefined) {
      this.#abandonCommands(runtimeId, previous);
      previous.history.close();
      this.#options.onRuntimeOffline?.(runtimeId, "replaced_by_new_bridge");
    }
    const generation = randomUUID();
    const publish = (event: Extract<RuntimeEvent, { type: "session.patch" | "session.tools.produced" }>): void => {
      if (this.#sessions.get(runtimeId)?.generation === generation) this.#options.onEvent?.(runtimeId, event);
    };
    const onFacts = (facts: ClaudeTranscriptFacts): void => {
      const session = this.#sessions.get(runtimeId);
      if (session?.generation !== generation) return;
      session.facts = facts;
      this.#publishMetadata(runtimeId, session);
    };
    const configDir = claudeConfigDir(parsed.configDir);
    const history = this.#options.createHistory?.(parsed.sessionId, configDir, publish, onFacts) ??
      new ClaudeSessionHistory(parsed.sessionId, configDir, publish, {
        onFacts, ...(this.#options.hostId === undefined ? {} : { hostId: this.#options.hostId }),
        ...(this.#toolStore === undefined ? {} : { toolStore: this.#toolStore }),
      });
    const session: Session = {
      runtime: { runtimeId, name: "Claude Code", cwd: parsed.cwd, status: "idle", sessionId: parsed.sessionId, hostname: localHostname() },
      instanceId: parsed.instanceId, claudeVersion: parsed.claudeVersion, bridgeVersion: parsed.bridgeVersion,
      capabilities, generation, commands: new Map(), completedStops: new Map(), completedTurns: new Set(), runningTools: new Map(),
      lastSeenAt: Date.now(), history, state: {}, facts: {}, compaction: "idle", published: { metadata: "", capabilities: "" },
    };
    this.#sessions.set(runtimeId, session);
    if (parsed.processId !== undefined) {
      void this.#processControl.capture(parsed.processId).then(identity => {
        if (identity === undefined || this.#sessions.get(runtimeId) !== session) return;
        session.process = identity;
        this.#publishCapabilities(runtimeId, session);
      }).catch(() => undefined);
    }
    session.runtime = this.#metadata(session);
    session.published.metadata = JSON.stringify(session.runtime);
    this.#options.onRuntimeOnline?.(session.runtime);
    void history.refresh().catch(() => undefined);
    if (parsed.launchId !== undefined) this.#launches.get(parsed.launchId)?.resolve(session.runtime);
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
    const pending = this.#options.pendingInteractions?.(runtimeId) ?? 0;
    return { ok: true, generation, commands, ...(pending > 0 ? { pendingInteractions: pending } : {}) };
  }

  /** Answers a device `session.sync` from the transcript and the current live state. */
  async sync(runtimeId: string, request: Extract<RuntimeCommand, { type: "session.sync" }>): Promise<Extract<RuntimeEvent, { type: "session.snapshot" }> | undefined> {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined || request.sessionId !== session.runtime.sessionId) return undefined;
    const snapshot = await session.history.sync(request);
    return this.#sessions.get(runtimeId) === session ? snapshot : undefined;
  }

  sendCommand(runtimeId: string, commandId: string, command: ClaudeModsCommand): ClaudeModsCommandResult {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined) return "offline";
    const previous = session.commands.get(commandId);
    if (previous !== undefined) return JSON.stringify(previous.command) === JSON.stringify(command) ? "accepted" : "id_conflict";
    if (command.type === "stop" && (session.activeTurn === undefined || session.pendingStopId !== undefined)) return "not_cancelable";
    if (session.commands.size >= 64) return "queue_full";
    session.commands.set(commandId, { commandId, command });
    if (command.type === "user_message" && command.messageId !== undefined) session.history.expectPrompt(command.messageId, command.text);
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
    if (parsed.type === "session.append") {
      session.activeTurn?.announced.push(parsed.uuid);
      void session.history.refresh().catch(() => undefined);
      return "accepted";
    }
    if (parsed.type === "session.state") {
      session.state = { ...session.state, ...parsed.state };
      this.#publishMetadata(runtimeId, session);
      this.#publishCapabilities(runtimeId, session);
      return "accepted";
    }
    if (parsed.type === "compaction") {
      session.compaction = parsed.phase;
      this.#options.onEvent?.(runtimeId, this.activity(runtimeId)!);
      return "accepted";
    }
    if (parsed.type === "interactions.local") {
      this.#options.onLocalInteractions?.(runtimeId);
      return "accepted";
    }
    if (parsed.type === "turn.start") {
      const startedAt = finiteTime(parsed.startedAt) ?? Date.now();
      session.activeTurn = { turnId: parsed.turnId, startedAt, messages: new Map(), announced: [] };
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
    } else if (parsed.type === "tool.started") {
      session.runningTools.set(parsed.toolCallId, { toolName: parsed.toolName, arguments: parsed.arguments });
      while (session.runningTools.size > 256) session.runningTools.delete(session.runningTools.keys().next().value!);
    } else if (parsed.type === "tool.finished") {
      const started = session.runningTools.get(parsed.toolCallId);
      session.runningTools.delete(parsed.toolCallId);
      this.#options.onToolFinished?.(runtimeId, parsed.toolName, started?.arguments);
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
    const events = normalizeNativeEvent(parsed, session);
    if (!events.every(event => RuntimeEventSchema.safeParse(event).success)) return "invalid";
    for (const event of events) if (!session.history.observe(event)) this.#options.onEvent?.(runtimeId, event);
    if (parsed.type === "turn.complete") {
      if (session.activeTurn?.turnId === parsed.turnId) void session.history.settleTurn(session.activeTurn.announced).catch(() => undefined);
      delete session.activeTurn;
      session.runningTools.clear();
      session.completedTurns.add(parsed.turnId);
      while (session.completedTurns.size > 128) session.completedTurns.delete(session.completedTurns.values().next().value!);
      this.#options.onTurnFinished?.(runtimeId);
    }
    return "accepted";
  }

  disconnect(runtimeId: string, generation?: string, reason = "bridge_disconnected"): void {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined || (generation !== undefined && session.generation !== generation)) return;
    this.#abandonCommands(runtimeId, session);
    session.history.close();
    this.#sessions.delete(runtimeId);
    this.#options.onRuntimeOffline?.(runtimeId, reason);
  }

  generationOf(runtimeId: string): string | undefined { return this.#sessions.get(runtimeId)?.generation; }

  /** Host-owned /quit: keep the row online until the exact native process has exited. */
  async quit(runtimeId: string): Promise<void> {
    const session = this.#sessions.get(runtimeId);
    if (session?.process === undefined) throw new Error("无法核对 Claude Code 进程，请更新插件并重新打开会话。");
    session.closing ??= this.#processControl.terminate(session.process, () => this.#sessions.get(runtimeId) === session);
    try { await session.closing; }
    catch (error) { delete session.closing; throw error; }
  }

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
    for (const launch of this.#launches.values()) clearTimeout(launch.timer);
    this.#launches.clear();
  }

  /** Re-announces metadata and commands, e.g. after a device reconnects or syncs. */
  announce(runtimeId: string): void {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined) return;
    this.#options.onEvent?.(runtimeId, { type: "runtime.metadata", metadata: session.runtime });
    this.#options.onEvent?.(runtimeId, { type: "runtime.capabilities", capabilities: claudeCapabilities(session.state, session.process !== undefined) });
  }

  /**
   * The Mods side drops its command cache with the generation, so queued commands
   * can never report a native result. Retire them explicitly; delivery is unknown,
   * because a submit may have run before the result was lost.
   */
  #abandonCommands(runtimeId: string, session: Session): void {
    for (const { commandId } of session.commands.values()) {
      this.#options.onEvent?.(runtimeId, { type: "command.result", commandId, ok: false, status: "failure",
        error: "claude_bridge_disconnected_result_unknown" });
    }
    session.commands.clear();
    delete session.pendingStopId;
  }

  #metadata(session: Session): RuntimeMetadata {
    const { state, facts } = session;
    const model = state.model ?? facts.model;
    const context = state.context;
    const permissions = claudePermissionManagement(facts.permissionMode);
    return {
      runtimeId: session.runtime.runtimeId, name: "Claude Code", cwd: session.runtime.cwd, status: session.runtime.status,
      sessionGraphSync: true,
      ...(session.runtime.sessionId === undefined ? {} : { sessionId: session.runtime.sessionId }), hostname: localHostname(),
      ...(facts.title === undefined ? {} : { sessionName: facts.title }),
      ...(model === undefined ? {} : { model: { provider: "claude-code", id: model.slice(0, 256),
        ...(state.modelName === undefined || state.model === undefined ? {} : { name: state.modelName.slice(0, 256) }) } }),
      ...(state.effort === undefined ? {} : { thinkingLevel: state.effort.slice(0, 64) }),
      ...(context === undefined || !(context.window > 0) ? {} : { contextUsage: {
        tokens: context.tokens === undefined ? null : Math.max(0, Math.round(context.tokens)),
        contextWindow: Math.round(context.window),
        percent: context.percent === undefined ? null : Math.min(100, Math.max(0, context.percent)),
      } }),
      ...(permissions === undefined ? {} : { permissionManagement: permissions }),
    };
  }

  #publishMetadata(runtimeId: string, session: Session): void {
    session.runtime = this.#metadata(session);
    const encoded = JSON.stringify(session.runtime);
    if (encoded === session.published.metadata) return;
    session.published.metadata = encoded;
    this.#options.onEvent?.(runtimeId, { type: "runtime.metadata", metadata: session.runtime });
  }

  #publishCapabilities(runtimeId: string, session: Session): void {
    const capabilities = claudeCapabilities(session.state, session.process !== undefined);
    const encoded = JSON.stringify(capabilities);
    if (encoded === session.published.capabilities) return;
    session.published.capabilities = encoded;
    this.#options.onEvent?.(runtimeId, { type: "runtime.capabilities", capabilities });
  }

  #status(runtimeId: string, status: RuntimeMetadata["status"]): void {
    const session = this.#sessions.get(runtimeId);
    if (session === undefined || session.runtime.status === status) return;
    session.runtime = { ...session.runtime, status };
    session.published.metadata = JSON.stringify(session.runtime);
    this.#options.onEvent?.(runtimeId, { type: "runtime.status", status });
  }
}

/**
 * Built-in commands that open a TUI panel, act on the terminal or the account, leave the
 * Session, or bill a cloud run. From the phone they would only change the computer's screen.
 */
const HIDDEN_BUILTINS = new Set([
  "add-dir", "advisor", "agents", "artifacts", "autocompact", "background", "branch", "btw", "bug", "cd", "chrome", "claim-credit", "clear",
  "color", "config", "context", "copy", "design-consent", "design-login", "design-revoke", "desktop", "exit", "export", "extra-usage",
  "feedback", "focus", "fork", "heapdump", "help", "hooks", "ide", "import", "install-github-app", "install-slack-app", "keybindings",
  "limit-reset", "list-agents", "login", "logout", "low-priority", "mcp", "memory", "mobile", "output-style", "passes", "permissions",
  "plugin", "powerup", "privacy-settings", "pro-trial-expired", "radio", "rate-limit-options", "release-notes", "reload-plugins",
  "remote-control", "remote-env", "resume", "rewind", "sandbox", "scroll-speed", "setup-bedrock", "setup-vertex", "skill-doctor", "skills",
  "statusline", "status", "stickers", "tasks", "teleport", "terminal-setup", "theme", "tui", "ultrareview", "upgrade", "usage",
  "usage-credits", "voice", "web-setup", "workflow-launch-exec", "__remote-workflow",
]);

const SOURCES: Record<string, RuntimeSlashCommand["source"]> = { builtin: "builtin", plugin: "extension", user: "prompt", mcp: "mcp" };

/** The slash menu the phone can use: model and effort as choices, then what runs headless. */
export function claudeCapabilities(state: ClaudeSessionState, canQuit = false): RuntimeCapabilities {
  const commands: RuntimeSlashCommand[] = canQuit ? [{ name: "quit", description: "关闭这个 Claude Code 会话（保留历史）", source: "builtin" }] : [];
  const models = (state.modelOptions ?? []).filter(option => text(option, 256));
  if (models.length > 0) {
    commands.push({ name: "model", description: `切换模型${state.modelName === undefined ? "" : `（当前 ${state.modelName}）`}`, source: "builtin",
      argument: { kind: "select", required: true, options: models.map(option => ({ value: option, label: option,
        ...(option === state.modelSetting ? { description: "当前设置" } : {}) })) } });
  }
  commands.push({ name: "effort", description: `设置思考强度${state.effort === undefined ? "" : `（当前 ${state.effort}）`}`, source: "builtin",
    argument: { kind: "select", required: true, options: CLAUDE_EFFORT_LEVELS.map(level => ({ value: level, label: level })) } });
  for (const command of state.commands ?? []) {
    if (command.name === "quit" || command.name === "model" || command.name === "effort" || command.name.startsWith("orbis-")) continue;
    if (command.source === "builtin" && HIDDEN_BUILTINS.has(command.name)) continue;
    if (!/^[^\s/]{1,256}$/u.test(command.name) || commands.some(item => item.name === command.name)) continue;
    commands.push({ name: command.name, ...(command.description ? { description: command.description.slice(0, 4_000) } : {}),
      source: SOURCES[command.source] ?? "prompt", argument: { kind: "text", required: false } });
  }
  return { commands: commands.slice(0, 256) };
}

const PERMISSION_MODES: Record<string, { label: string; tone: PermissionManagement["tone"]; description: string }> = {
  default: { label: "默认（需要时询问）", tone: "restricted", description: "编辑文件和运行命令前会请求权限" },
  acceptEdits: { label: "自动接受编辑", tone: "restricted", description: "文件编辑直接执行，其他操作仍会询问" },
  plan: { label: "计划模式", tone: "restricted", description: "只读分析并给出计划，不修改文件" },
  auto: { label: "自动模式", tone: "restricted", description: "由分类器批准或拒绝权限请求" },
  dontAsk: { label: "不询问", tone: "restricted", description: "未预先允许的操作直接拒绝" },
  bypassPermissions: { label: "跳过权限检查", tone: "full", description: "所有操作都不再询问" },
};

/** The Session's mode as the transcript records it; Claude offers no API to change it remotely. */
export function claudePermissionManagement(mode: string | undefined): PermissionManagement | undefined {
  if (mode === undefined) return undefined;
  const known = PERMISSION_MODES[mode];
  return {
    summary: known?.label ?? mode,
    details: known?.description ?? "Claude Code 报告的权限模式",
    tone: known?.tone ?? "unknown",
    settings: [{ id: "mode", label: "权限模式", currentValue: mode,
      disabledReason: "当前会话的权限模式只能在电脑上按 Shift+Tab 切换；计划模式也可以用 /plan 进入",
      options: Object.entries(PERMISSION_MODES).map(([value, item]) => ({ value, label: item.label, description: item.description })) }],
  };
}

function parseHello(value: unknown): ClaudeModsHello | undefined {
  if (!isRecord(value) || value.type !== "hello" || !text(value.sessionId, 256) || !text(value.instanceId, 128) || !text(value.cwd, 4096) ||
      !text(value.claudeVersion, 64) || !text(value.bridgeVersion, 64) || !Array.isArray(value.capabilities) ||
      !validVersion(value.claudeVersion) || value.capabilities.length > 64 || !value.capabilities.every(item => typeof item === "string" && text(item, 128))) return undefined;
  if (value.configDir !== undefined && !text(value.configDir, 4096)) return undefined;
  if (value.launchId !== undefined && !text(value.launchId, 128)) return undefined;
  if (value.processId !== undefined && (typeof value.processId !== "number" || !Number.isSafeInteger(value.processId) || value.processId <= 1)) return undefined;
  return { type: "hello", sessionId: value.sessionId, instanceId: value.instanceId, cwd: value.cwd, claudeVersion: value.claudeVersion,
    bridgeVersion: value.bridgeVersion, capabilities: value.capabilities, ...(value.configDir === undefined ? {} : { configDir: value.configDir }),
    ...(value.launchId === undefined ? {} : { launchId: value.launchId }),
    ...(value.processId === undefined ? {} : { processId: value.processId as number }) };
}

function parseState(value: unknown): ClaudeSessionState | undefined {
  if (!isRecord(value)) return undefined;
  const state: ClaudeSessionState = {};
  if (value.model !== undefined) { if (!text(value.model, 256)) return undefined; state.model = value.model; }
  if (value.modelName !== undefined) { if (!text(value.modelName, 256)) return undefined; state.modelName = value.modelName; }
  if (value.modelSetting !== undefined) { if (!text(value.modelSetting, 256)) return undefined; state.modelSetting = value.modelSetting; }
  if (value.effort !== undefined) { if (!text(value.effort, 64)) return undefined; state.effort = value.effort; }
  if (value.modelOptions !== undefined) {
    if (!Array.isArray(value.modelOptions) || value.modelOptions.length > 64 || !value.modelOptions.every(item => text(item, 256))) return undefined;
    state.modelOptions = value.modelOptions;
  }
  if (value.context !== undefined) {
    const context = value.context;
    if (!isRecord(context) || typeof context.window !== "number" || !Number.isFinite(context.window) || context.window < 0) return undefined;
    state.context = { window: context.window,
      ...(typeof context.tokens === "number" && Number.isFinite(context.tokens) ? { tokens: context.tokens } : {}),
      ...(typeof context.percent === "number" && Number.isFinite(context.percent) ? { percent: context.percent } : {}) };
  }
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands) || value.commands.length > 512) return undefined;
    const commands = value.commands.flatMap(item => isRecord(item) && text(item.name, 256) && text(item.source, 32)
      ? [{ name: item.name, source: item.source, ...(typeof item.description === "string" ? { description: item.description.slice(0, 4_000) } : {}) }] : []);
    if (commands.length !== value.commands.length) return undefined;
    state.commands = commands;
  }
  return state;
}

function parseNativeEvent(value: unknown): ClaudeModsNativeEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "prompt.submit" && text(value.text, 100_000) && text(value.origin, 128)) return { type: value.type, text: value.text, origin: value.origin, ...(text(value.turnId, 256) ? { turnId: value.turnId } : {}), ...(typeof value.wait === "boolean" ? { wait: value.wait } : {}) };
  // The row itself is read from the transcript; the event only announces its identity.
  if (value.type === "session.append" && text(value.uuid, 256) && text(value.door, 64)) return { type: value.type, uuid: value.uuid, door: value.door };
  if (value.type === "session.state") {
    const state = parseState(value.state);
    return state === undefined ? undefined : { type: value.type, state };
  }
  if (value.type === "compaction" && (value.phase === "running" || value.phase === "idle" || value.phase === "failed")) return { type: value.type, phase: value.phase };
  if (value.type === "interactions.local") return { type: value.type };
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

function normalizeNativeEvent(native: ClaudeModsNativeEvent, session: Session): RuntimeEvent[] {
  switch (native.type) {
    // The native prompt.submit observer is not emitted for a Mods API submission in the
    // tested build, and every prompt reaches the transcript. Treating it as a message
    // would create duplicates. Transcript rows are handled before normalization.
    case "prompt.submit":
    case "session.append":
    case "session.state":
    case "compaction":
    case "interactions.local": return [];
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
      const events: RuntimeEvent[] = [];
      // Streamed messages stay live until the transcript rows of this turn replace them.
      for (const [messageId, live] of active?.messages ?? []) {
        const content = [...live.blocks.entries()].sort(([a], [b]) => a - b)
          .map(([, block]) => ({ type: block.type, text: block.text } satisfies RemoteContent));
        events.push({ type: "message.finished", message: messageOf(messageId, "assistant", content) });
      }
      events.push({ type: "turn.finished", turnId: native.turnId, startedAt,
        durationMs: native.durationMs ?? Math.max(0, Date.now() - startedAt),
        ...(native.turnIndex === undefined ? {} : { turnIndex: native.turnIndex }) });
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
