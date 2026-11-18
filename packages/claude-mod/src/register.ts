import type { Hook, Register } from "claude-code";

type Api = Parameters<Hook<"session.start">>[0];
type Connection = { runtimeId: string; generation: string; sessionId: string; descriptor: Descriptor };
type Descriptor = { url: string; token: string };
type HelloReply = { ok: true; runtimeId: string; generation: string; resumed?: boolean } | { ok: false; error: string };
type PollReply = { ok: true; commands: { commandId: string; command: RemoteCommand }[]; pendingInteractions?: number;
  questionAnswers?: QuestionAnswer[] } | { ok: false; error: string };
type QuestionAnswer = { toolCallId: string; answers: Record<string, string> } | { toolCallId: string; deny: string };
type ToolCall = Parameters<Hook<"tool.call">>[1];
type ToolNext = Parameters<Hook<"tool.call">>[2];
type BridgeEvent = Record<string, unknown>;
type RemoteCommand = { type: "user_message"; text: string; messageId?: string; delivery?: "steer" | "followUp" } | { type: "slash"; name: string; args: string } | { type: "stop" };
type CachedCommand = { state: "running"; commandType: "user_message" | "slash" } |
  { state: "running"; commandType: "stop"; turnId: string } | { state: "result"; event: BridgeEvent };

const INSTANCE_ID = crypto.randomUUID();
const COMMAND_CACHE_LIMIT = 128;
const MAX_HTTP_BODY = 240_000;
/** Polls between unchanged state reports (750 ms each). */
const STATE_EVERY = 20;
/** A Host refusal is not retried at poll speed. */
const REJECTED_RETRY_MS = 60_000;
const RESERVED_TOOL_FIELDS = new Set(["tool", "tool_use_id", "agentId", "requestMeta", "consent"]);
const commands = new Map<string, CachedCommand>();
/** Native AskUserQuestion calls also shown on the phone, by tool call, until either side answers. */
const questionWaiters = new Map<string, (answer: QuestionAnswer) => void>();
let connection: Connection | undefined;
let connecting: Promise<Connection | undefined> | undefined;
let activeTurnId: string | undefined;
const activeCompactions = new Set<symbol>();
// Main-loop response rows belong to the native step until its next request or turn completion.
// A step can append several UUIDs; neither text equality nor row order identifies a message.
let activeStep: { turnId: string; stepIndex: number; uuids: string[]; target: Connection | undefined } | undefined;
let polling = false;
let pollingTimer: ReturnType<Api["clock"]["every"]> | undefined;
let polls = 0;
let reportedState: { connection: Connection; encoded: string } | undefined;
let reporting = false;
let rejected: { error: string; until: number; descriptor: Descriptor } | undefined;
let status: string | undefined;
let interactiveSession = false;
let readingTasks = false;
let reportedTasks: { connection: Connection; encoded: string; at: number } | undefined;
type TaskStatus = "pending" | "running" | "waiting" | "idle" | "completed" | "failed" | "killed" | "unknown";
type InventoryItem = { id: string; parentId?: string; title: string; kind: string; status: TaskStatus };
const TASK_STATUSES = new Set<string>(["pending", "running", "waiting", "idle", "completed", "failed", "killed", "unknown"]);
/**
 * S60: background shells and Monitors of one native session. `agent.list` does not hold them.
 * A Bash / Monitor result adds one as it starts and a TaskStop result marks it stopped; the
 * session's own in-flight list on Stop / SubagentStop replaces the ledger, which is how an
 * ended task leaves. A Claude Code without that list (`supported: false`) reports none.
 */
let backgroundWork: { sessionId: string; items: Map<string, InventoryItem>; supported?: boolean } | undefined;
let permissionMode: string | undefined;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
let selectedEffort: Effort | undefined;
// settings.read() excludes --effort and native model defaults. Retain the first
// main request's resolved effort only while its native selection inputs agree.
let observedEffort: { sessionId: string; model: string; modelSetting: unknown; setting: unknown; value?: string } | undefined;
let turnSelection: { turnId: string; model?: string; selectedModel?: string; effort?: Effort | number; captured: boolean } | undefined;
let currentTurnConfiguration: { turnId: string; requestIndex?: number; model?: { provider: string; id: string }; thinkingLevel?: string | null } | null = null;

export const register: Register = on => {
  // Native classic events include the effective mode even before the first prompt.
  on("classic.*", async ($, event, next) => {
    if ("permission_mode" in event && typeof event.permission_mode === "string" && !("agent_id" in event && event.agent_id)) {
      permissionMode = event.permission_mode;
      void reportState($, true);
    }
    if ("hook_event_name" in event && (event.hook_event_name === "Stop" || event.hook_event_name === "SubagentStop")) {
      reconcileBackgroundWork($, event.session_id, event.background_tasks);
    }
    return await next(event);
  });
  on("session.start", async ($, event, next) => {
    interactiveSession = event.isInteractive && event.surface === "terminal";
    const result = await next(event);
    if (!interactiveSession) return result;
    // Lets the person at the computer take back interactions that were sent to a phone.
    void $.command.register({ name: "orbis-local", description: "把已发到手机的权限请求和问题收回到电脑上回答",
      immediate: true }).catch(() => undefined);
    void poll($);
    if (pollingTimer === undefined) pollingTimer = $.clock.every(750, () => { void poll($); });
    return result;
  });

  on("command.run", { command: "orbis-local" }, async $ => {
    const delivered = await emit($, { type: "interactions.local" });
    return { text: delivered ? "Orbis：待回答的请求已交回电脑。" : "Orbis：没有连上 Host，请直接在电脑上回答。" };
  });

  on("session.append", async ($, event, next) => {
    if (event.agentId !== undefined) return await next(event);
    const step = event.agentId === undefined && event.door === "response" && event.message.type === "assistant"
      ? activeStep : undefined;
    // Reserve before native storage: a sync triggered by another event must not publish the row
    // while its streaming twin is still live. The UUID is pinned by the public append contract.
    if (step?.target !== undefined) {
      const reservation = { type: "turn.step.row", turnId: step.turnId, stepIndex: step.stepIndex, uuid: event.uuid } as const;
      let reserved = await postEvent($, step.target, reservation);
      if (!reserved && connection === step.target) {
        // Reconnect before storage is announced; an unacknowledged reservation cannot safely
        // share a generation with the canonical append. Keep old-step chunks on their target.
        connection = undefined;
        const replacement = await connect($);
        if (replacement !== undefined) {
          step.target = replacement;
          reserved = await postEvent($, replacement, reservation);
        }
      }
      if (!reserved) throw new Error("Orbis Host 未确认 Claude 步骤身份，已阻止无身份交接。");
    }
    const stored = await next(event);
    if (!("message" in stored) || stored.message === undefined || stored.uuid === undefined) return stored;
    if (step !== undefined) step.uuids.push(stored.uuid);
    await emit($, { type: "session.append", uuid: stored.uuid, door: event.door });
    return stored;
  });

  on("session.compact", async ($, event, next) => {
    const owner = Symbol("compaction");
    activeCompactions.add(owner);
    const target = connection ?? await connect($);
    if (target) await postEvent($, target, { type: "compaction", phase: "running" });
    try {
      const result = await next(event);
      if (target) await postEvent($, target, { type: "compaction", phase: "idle" });
      return result;
    } catch (error) {
      if (target) await postEvent($, target, { type: "compaction", phase: "failed" });
      throw error;
    } finally { activeCompactions.delete(owner); }
  });

  on("turn.start", async ($, event, next) => {
    if (event.agentId === undefined) {
      activeTurnId = event.turnId;
      currentTurnConfiguration = { turnId: event.turnId };
      turnSelection = { turnId: event.turnId, ...(selectedEffort === undefined ? {} : { effort: selectedEffort }), captured: false };
      // The authenticated HTTP acknowledgement is the capture barrier. Never replay next().
      await emit($, { type: "turn.start", turnId: event.turnId, startedAt: await $.clock.now() }).catch(() => false);
    }
    return await next(event);
  });

  on("turn.step", async function* ($, event, next) {
    if (event.agentId === undefined) {
      await finishStep($);
      activeStep = { turnId: event.turnId, stepIndex: event.index, uuids: [], target: connection ?? await connect($) };
    }
    const step = event.agentId === undefined ? activeStep : undefined;
    if (event.agentId === undefined && turnSelection?.turnId === event.turnId) {
      if (!turnSelection.captured) {
        turnSelection.model = event.model;
        turnSelection.effort ??= event.effort;
        turnSelection.captured = true;
        const [sessionId, model, rows, settings] = await Promise.all([
          $.session.id().catch(() => undefined), $.session.model().catch(() => undefined), $.config.list().catch(() => undefined),
          $.settings.read().catch(() => undefined),
        ]);
        // A fallback model (or a failed getter) cannot establish the selected session's effort.
        observedEffort = sessionId !== undefined && model === event.model && rows !== undefined && settings !== undefined
          ? { sessionId, model, modelSetting: rows.find(row => row.key === "model")?.value, setting: settings.effortLevel,
            ...(event.effort === undefined ? {} : { value: String(event.effort) }) } : undefined;
      }
      // Native turn.step is the documented per-request setter. Pin a turn's
      // values so a phone change during streaming affects the next turn only.
      event = { ...event, ...(turnSelection.selectedModel !== undefined && event.model === turnSelection.selectedModel && turnSelection.model !== undefined
        ? { model: turnSelection.model } : {}),
        ...(turnSelection.effort === undefined ? {} : { effort: turnSelection.effort }) };
    }
    if (event.agentId === undefined && activeTurnId === event.turnId) {
      currentTurnConfiguration = { turnId: event.turnId, requestIndex: event.index, model: { provider: "claude-code", id: event.model },
        thinkingLevel: event.effort === undefined ? null : String(event.effort) };
      // Publish the effective request after pinning, including native fallback models.
      await emit($, { type: "session.state", state: { currentTurnConfiguration } });
    }
    const stream = next(event);
    let pending: { blockIndex: number; contentType: "text" | "thinking"; delta: string }[] = [];
    let pendingChars = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0 || event.agentId !== undefined) return;
      const chunks = pending;
      pending = [];
      pendingChars = 0;
      if (step?.target !== undefined) await postEvent($, step.target,
        { type: "turn.step.chunks", turnId: event.turnId, stepIndex: event.index, chunks });
    };
    for await (const chunk of stream) {
      if (event.agentId === undefined && (chunk.kind === "text" || chunk.kind === "thinking")) {
        pending.push({ blockIndex: chunk.index, contentType: chunk.kind, delta: chunk.text });
        pendingChars += chunk.text.length;
        if (pending.length >= 8 || pendingChars >= 768) await flush();
      }
      yield chunk;
    }
    await flush();
    return await stream.result;
  });

  on("turn.complete", async ($, event, next) => {
    const childTarget = event.agentId === undefined ? undefined : connection;
    if (event.agentId === undefined && activeStep?.turnId === event.turnId) await finishStep($);
    const result = await next(event);
    if (event.agentId !== undefined && childTarget) {
      await postEvent($, childTarget, { type: "task.turn.finished", agentId: event.agentId });
    }
    if (event.agentId === undefined) {
      const nativeEvent = { type: "turn.complete", turnId: event.turnId, durationMs: event.durationMs,
        answer: clipText(event.answer, 64_000), reason: event.reason, isAborted: event.isAborted } satisfies BridgeEvent;
      const stopCommandIds = [...commands].flatMap(([commandId, cached]) =>
        cached.state === "running" && cached.commandType === "stop" && cached.turnId === event.turnId ? [commandId] : []);
      const delivered = await emit($, nativeEvent);
      for (const commandId of stopCommandIds) {
        if (delivered) commands.delete(commandId);
        else commands.set(commandId, { state: "result", event: nativeEvent });
      }
      // Keep submissions deferred through the completion acknowledgement/capture barrier.
      if (activeTurnId === event.turnId) { activeTurnId = undefined; currentTurnConfiguration = null; }
      // Context fill and the model can change with every turn.
      void reportState($, true);
    }
    return result;
  });

  on("tool.call", async ($, event, next) => {
    // Children have their own task identity. Their tool output is not a main-loop reply.
    if (event.agentId !== undefined) {
      const target = connection;
      const result = await runTool($, event, next);
      await noteBackgroundWork($, event, result).catch(() => undefined);
      if (target) await postEvent($, target, { type: "task.tool.finished", agentId: event.agentId,
        toolName: event.tool, toolCallId: event.tool_use_id,
        arguments: boundedValue(Object.fromEntries(Object.entries(event).filter(([key]) => !RESERVED_TOOL_FIELDS.has(key))), 24_000) });
      return result;
    }
    const toolName = event.tool;
    const toolCallId = event.tool_use_id;
    // The tool's own input, as a Hook's `tool_input` carries it: the engine's reserved fields left out.
    const argumentsValue = Object.fromEntries(Object.entries(event).filter(([key]) => !RESERVED_TOOL_FIELDS.has(key)));
    await emit($, { type: "tool.started", toolCallId, toolName, arguments: boundedValue(argumentsValue, 24_000) });
    const result = await runTool($, event, next);
    await noteBackgroundWork($, event, result).catch(() => undefined);
    const resultRecord = result as { deny?: unknown; result?: unknown; text?: unknown; isError?: unknown };
    await emit($, { type: "tool.finished", toolCallId, toolName,
      result: boundedValue(resultRecord.result ?? resultRecord.text ?? resultRecord.deny ?? null, 24_000),
      isError: resultRecord.isError === true || typeof resultRecord.deny === "string" });
    return result;
  }).catch(($, event, next) => next(event));
};

/**
 * AskUserQuestion stays answerable on both sides. The Host shows the question on the phone first,
 * then the native dialog opens; the first answer wins, and returning while the dialog is open
 * closes it. Without that acknowledgement (no Host, or an older one) only the native call runs.
 */
async function runTool($: Api, event: ToolCall, next: ToolNext): ReturnType<ToolNext> {
  if (event.tool !== "AskUserQuestion" || !interactiveSession || event.tool_use_id === undefined) return await next(event);
  const toolCallId = event.tool_use_id;
  const target = connection ?? await connect($);
  const shown = target !== undefined && await postEvent($, target, { type: "question.requested", toolCallId,
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }), questions: event.questions });
  if (!shown) return await next(event);
  let answered!: (answer: QuestionAnswer) => void;
  const remote = new Promise<QuestionAnswer>(resolve => { answered = resolve; });
  questionWaiters.set(toolCallId, answered);
  const native = next(event);
  try {
    const first = await Promise.race([native.then(result => ({ result })), remote.then(answer => ({ answer }))]);
    if ("result" in first) return first.result;
    // The closed dialog settles the native call as declined; the phone answer replaces it.
    native.catch(() => undefined);
    return "deny" in first.answer ? { deny: first.answer.deny }
      : { result: { questions: event.questions, answers: first.answer.answers } };
  } finally { questionWaiters.delete(toolCallId); }
}

async function poll($: Api): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const current = await connect($);
    if (current === undefined) return;
    void reportTasks($, current).catch(() => undefined);
    if (connection !== current) return;
    const response = await request<PollReply>($, "/v1/claude/mods/poll", {
      runtimeId: current.runtimeId, generation: current.generation,
    }, current.descriptor);
    if (connection !== current) return;
    const body = response.body;
    if (!response.ok || body === undefined || body.ok !== true) {
      const error = body !== undefined && "error" in body ? body.error : undefined;
      if (connection === current && (response.status === 401 || error === "stale_generation" || error === "bridge_offline")) {
        connection = undefined;
        showStatus($, "Orbis：Host 连接已断开，正在自动重连…");
      }
      return;
    }
    const pending = body.pendingInteractions ?? 0;
    showStatus($, pending > 0 ? `Orbis：${pending} 个请求已发到手机等待回答；要在电脑上回答，输入 /orbis-local` : undefined);
    // Never awaited here: a submit or command can wait for the turn, and polling must go on
    // or the Host lease lapses. The command cache keeps a repeated poll from running it twice.
    for (const item of body.commands) void runCommand($, current, item.commandId, item.command);
    // The Host repeats an answer until the call finishes; a call already answered has no waiter.
    for (const answer of body.questionAnswers ?? []) questionWaiters.get(answer.toolCallId)?.(answer);
    if (++polls % STATE_EVERY === 0) void reportState($, false);
  } catch {
    // Keep a generation across a transient request failure. The next poll still
    // rediscovers the Host, whose port and token change after a restart.
    showStatus($, "Orbis：Host 连接已断开，正在自动重连…");
  } finally {
    polling = false;
  }
}

/** Full native inventory, independent of main turn boundaries; old reads cannot cross sessions. */
async function reportTasks($: Api, target: Connection): Promise<void> {
  if (readingTasks) return;
  readingTasks = true;
  try {
    const started = await $.clock.now();
    let tasks: { availability: "ready" | "unknown"; items: { id: string; parentId?: string; title: string; kind: string; status: string }[]; truncated: boolean };
    try {
      const agents = await $.agent.list();
      const agentItems = agents.map(agent => ({
        id: agent.id, ...(agent.parentId ? { parentId: agent.parentId } : {}),
        title: clipText(agent.description || agent.name || agent.type, 256), kind: clipText(agent.type, 128),
        // A pane teammate has no loop here: its roster may survive the process. Do not claim liveness.
        status: agent.teammateId === agent.id && !["completed", "failed", "killed"].includes(agent.status) ? "unknown" : agent.status,
      }));
      // One sender for the whole inventory: agents stay agent.list's, the ledger adds the rest by its own ids.
      const agentIds = new Set(agentItems.map(item => item.id));
      const work = backgroundWork?.sessionId === target.sessionId && backgroundWork.supported !== false
        ? [...backgroundWork.items.values()].filter(item => !agentIds.has(item.id)) : [];
      const items = [...agentItems, ...work];
      if (items.length > 256) tasks = { availability: "unknown", items: [], truncated: true };
      else tasks = { availability: "ready", truncated: false, items: items.sort((a, b) => a.id.localeCompare(b.id)) };
    } catch { tasks = { availability: "unknown", items: [], truncated: false }; }
    if (connection !== target || await $.session.id() !== target.sessionId) return;
    const at = await $.clock.now();
    // A slow source read cannot renew liveness with an old snapshot.
    if (at - started > 3_000) tasks = { availability: "unknown", items: [], truncated: false };
    const encoded = JSON.stringify(tasks);
    if (reportedTasks?.connection === target && reportedTasks.encoded === encoded && at - reportedTasks.at < 3_000) return;
    if (await postEvent($, target, { type: "tasks.snapshot", tasks })) reportedTasks = { connection: target, encoded, at };
  } finally { readingTasks = false; }
}

async function workLedger($: Api): Promise<NonNullable<typeof backgroundWork>> {
  const sessionId = await $.session.id();
  if (backgroundWork?.sessionId !== sessionId) backgroundWork = { sessionId, items: new Map() };
  return backgroundWork;
}

/** A started or stopped task, read from the tool's own result record, never its text. */
async function noteBackgroundWork($: Api, event: ToolCall, result: unknown): Promise<void> {
  const record = isRecord(result) ? result.result : undefined;
  if (!isRecord(record)) return;
  const id = event.tool === "Bash" ? record.backgroundTaskId : event.tool === "Monitor" ? record.taskId : undefined;
  const stopped = event.tool === "TaskStop" ? record.task_id : undefined;
  if (!validTaskId(id) && !validTaskId(stopped)) return;
  const ledger = await workLedger($);
  if (ledger.supported === false) return;
  if (validTaskId(id)) {
    const description = (event as Record<string, unknown>).description;
    // The description names the task; a raw command line can carry credentials.
    ledger.items.set(id, { id, ...(event.agentId === undefined ? {} : { parentId: event.agentId }),
      title: typeof description === "string" ? clipText(description, 120) : "",
      kind: event.tool === "Bash" ? "shell" : "monitor", status: "running" });
  } else {
    const known = ledger.items.get(stopped as string);
    if (known === undefined) return;
    ledger.items.set(known.id, { ...known, status: "killed" });
  }
  if (connection !== undefined) void reportTasks($, connection).catch(() => undefined);
}

/** The session's in-flight list replaces the ledger; agents in it remain agent.list's. */
function reconcileBackgroundWork($: Api, sessionId: unknown, inFlight: unknown): void {
  if (typeof sessionId !== "string" || sessionId === "") return;
  if (backgroundWork?.sessionId !== sessionId) backgroundWork = { sessionId, items: new Map() };
  const ledger = backgroundWork;
  if (!Array.isArray(inFlight)) {
    ledger.supported = false;
    ledger.items.clear();
  } else {
    ledger.supported = true;
    const items = new Map<string, InventoryItem>();
    for (const task of inFlight) {
      if (!isRecord(task) || !validTaskId(task.id) || task.type === "subagent") continue;
      const known = ledger.items.get(task.id);
      // Without a description of its own, a shell's falls back to its command line, credentials included.
      const description = typeof task.description === "string" && task.description !== "" &&
        !(typeof task.command === "string" && task.command.startsWith(task.description)) ? task.description : undefined;
      items.set(task.id, { id: task.id, ...(known?.parentId === undefined ? {} : { parentId: known.parentId }),
        title: description === undefined ? known?.title ?? "" : clipText(description, 120),
        // The list labels a Monitor's command as a shell; the call that started it knows better.
        kind: known?.kind ?? (typeof task.type === "string" && task.type !== "" ? clipText(task.type, 40) : "task"),
        status: typeof task.status === "string" && TASK_STATUSES.has(task.status) ? task.status as TaskStatus : "unknown" });
    }
    ledger.items = items;
  }
  if (connection !== undefined) void reportTasks($, connection).catch(() => undefined);
}

function validTaskId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256;
}

async function connect($: Api): Promise<Connection | undefined> {
  if (connecting !== undefined) return connecting;
  const pending = connectOnce($);
  connecting = pending;
  try { return await pending; }
  finally { if (connecting === pending) connecting = undefined; }
}

async function connectOnce($: Api): Promise<Connection | undefined> {
  if (!interactiveSession) return undefined;
  const sessionId = await $.session.id();
  // A cached endpoint can stay unreachable forever: Host restarts on a random
  // port and with a new token. Read discovery even while we have a generation.
  const descriptor = await readDescriptor($);
  if (descriptor === undefined) {
    showStatus($, "Orbis：正在等待本机 Host，启动后会自动连接…");
    return undefined;
  }
  if (connection?.sessionId === sessionId && sameDescriptor(connection.descriptor, descriptor)) return connection;
  if (rejected !== undefined && sameDescriptor(rejected.descriptor, descriptor) && rejected.until > Date.now()) return undefined;
  const version = await $.session.version();
  const cwd = await $.session.cwd();
  const configDir = await $.env.get("CLAUDE_CONFIG_DIR");
  const launchId = await $.env.get("ORBIS_CLAUDE_LAUNCH_ID");
  // process.run uses argv without a shell, so this child's parent is the native TUI.
  // A missing Node helper only disables remote close; the bridge still connects.
  const processId = await $.process.run(["node", "-e", "process.stdout.write(String(process.ppid))"], { timeoutMs: 3000 })
    .then(result => result.exitCode === 0 ? Number(result.stdout.trim()) : undefined, () => undefined);
  const response = await request<HelloReply>($, "/v1/claude/mods/hello", {
    type: "hello", instanceId: INSTANCE_ID, sessionId, cwd,
    ...(Number.isSafeInteger(processId) && processId! > 1 ? { processId } : {}),
    ...(configDir === undefined || configDir.length === 0 ? {} : { configDir }),
    ...(launchId === undefined || launchId.length === 0 ? {} : { launchId }),
    interactive: true, claudeVersion: version.version, bridgeVersion: "4",
    capabilities: ["prompt.submit", "prompt.sendNow", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call", "turn.step.identity", "agent.list", "configuration.turn", "configuration.observed", "configuration.effort.snapshot"],
  }, descriptor);
  if (!response.ok || response.body?.ok !== true) {
    const error = response.body !== undefined && "error" in response.body ? response.body.error : undefined;
    if (error !== undefined) {
      rejected = { error, until: Date.now() + REJECTED_RETRY_MS, descriptor };
      showStatus($, `Orbis：这个 Claude Code 会话无法连接 Host（${error}）`);
    }
    return undefined;
  }
  rejected = undefined;
  showStatus($, undefined);
  const next = { runtimeId: response.body.runtimeId, generation: response.body.generation, sessionId, descriptor };
  if (connection?.generation !== next.generation) commands.clear();
  connection = next;
  // Only an explicit Host acknowledgement can transfer an in-flight native step. A different
  // Session or a fresh Host must not receive old-generation chunks or command results.
  if (response.body.resumed === true && activeStep?.target?.sessionId === sessionId
    && activeStep.target.runtimeId === next.runtimeId) activeStep.target = next;
  void reportState($, true);
  return next;
}

/** Model, context fill, slash commands and effort: sent when they change, or forced. */
async function reportState($: Api, force: boolean): Promise<void> {
  if (reporting) return;
  reporting = true;
  try {
    const target = connection;
    if (target === undefined) return;
    const state: Record<string, unknown> = {};
    if (permissionMode !== undefined) state.permissionMode = permissionMode;
    const model = await $.session.model().catch(() => undefined);
    if (typeof model === "string" && model.length > 0) state.model = model.slice(0, 256);
    const usage = await $.session.usage().catch(() => undefined);
    if (usage?.context !== undefined && usage.context.window > 0) {
      state.context = { window: usage.context.window,
        ...(usage.context.tokens === undefined ? {} : { tokens: usage.context.tokens }),
        ...(usage.context.percent === undefined ? {} : { percent: usage.context.percent }) };
    }
    const listed = await $.command.list().catch(() => undefined);
    if (listed !== undefined) {
      state.commands = listed.slice(0, 512).map(command => ({ name: command.name, source: command.source,
        description: clipText(command.description, 300) }));
      // `/model`'s own line names the model as Claude shows it: "(currently Opus 5.5)".
      const current = /\(currently ([^)]+)\)\s*$/u.exec(listed.find(command => command.name === "model")?.description ?? "")?.[1];
      if (current !== undefined) state.modelName = current.slice(0, 256);
    }
    const rows = await $.config.list().catch(() => undefined);
    const modelRow = rows?.find(row => row.key === "model");
    if (modelRow?.options !== undefined) state.modelOptions = modelRow.options.slice(0, 64);
    if (typeof modelRow?.value === "string" && modelRow.value.length > 0) state.modelSetting = modelRow.value;
    const settings = await $.settings.read().catch(() => undefined) as Record<string, unknown> | undefined;
    if (observedEffort !== undefined && (target.sessionId !== observedEffort.sessionId
      || model !== observedEffort.model || rows === undefined || settings === undefined
      || modelRow?.value !== observedEffort.modelSetting || settings.effortLevel !== observedEffort.setting)) observedEffort = undefined;
    if (selectedEffort !== undefined) state.effort = selectedEffort;
    else if (observedEffort !== undefined) {
      if (observedEffort.value !== undefined) state.effort = observedEffort.value;
    } else if (typeof settings?.effortLevel === "string" && settings.effortLevel.length > 0) state.effort = settings.effortLevel;
    // Read after asynchronous getters so a completed/replaced turn cannot be re-published.
    state.currentTurnConfiguration = currentTurnConfiguration;
    const encoded = JSON.stringify(state);
    if (!force && reportedState?.connection === target && reportedState.encoded === encoded) return;
    if (await postEvent($, target, { type: "session.state", state })) reportedState = { connection: target, encoded };
  } catch {
    // Reported again on the next turn or interval.
  } finally {
    reporting = false;
  }
}

async function readDescriptor($: Api): Promise<Descriptor | undefined> {
  const stateDir = await $.env.get("ORBIS_STATE_DIR");
  const home = await $.env.get("USERPROFILE") ?? await $.env.get("HOME");
  const at = (root: string): string =>
    `${root.replace(/[\\/]+$/u, "")}${root.includes("\\") ? "\\" : "/"}loopback.json`;
  // Same rule as the Host's resolveStateDir: a branding upgrade keeps the existing
  // ~/.pi-remote records, so ~/.orbis does not exist on an upgraded machine.
  const roots = stateDir !== undefined && stateDir.length > 0 ? [stateDir]
    : home === undefined ? [] : [`${home}${home.includes("\\") ? "\\" : "/"}.orbis`,
      `${home}${home.includes("\\") ? "\\" : "/"}.pi-remote`];
  for (const root of roots) {
    try {
      const parsed: unknown = JSON.parse(await $.fs.read(at(root)));
      if (!isRecord(parsed) || typeof parsed.url !== "string" || typeof parsed.token !== "string" ||
          !/^ws:\/\/127\.0\.0\.1:\d+$/u.test(parsed.url) || parsed.token.length < 16) continue;
      return { url: parsed.url.replace(/^ws:/u, "http:"), token: parsed.token };
    } catch { /* try the next state directory */ }
  }
  return undefined;
}

async function submitNativePrompt($: Api, command: Extract<RemoteCommand, { type: "user_message" }>) {
  const turnId = command.delivery === "steer" ? activeTurnId : undefined;
  if (turnId === undefined) return await $.prompt.submit({ text: command.text, asUser: true });
  if (command.text.trim().length === 0) return { drop: "claude_steer_invalid_text" };
  if (command.text.trimStart().startsWith("/")) return { drop: "claude_steer_slash_not_supported" };
  // Both calls run inside the native TUI. The composer and its Bash mode are
  // untouched; foreground work stops before the next user prompt is submitted.
  await $.turn.abort({ turnId });
  try {
    const result = await $.prompt.submit({ text: command.text, asUser: true });
    if ("drop" in result) return { drop: `claude_steer_stopped_but_not_submitted: 当前轮已停止，消息未提交：${result.drop}` };
    return result;
  } catch (error) {
    throw new Error(`claude_steer_stopped_but_not_submitted: 当前轮已停止，消息未提交：${errorText(error)}`);
  }
}

async function runCommand($: Api, target: Connection, commandId: string,
  command: RemoteCommand): Promise<void> {
  if (connection !== target) return;
  const cached = commands.get(commandId);
  if (cached?.state === "result") {
    if (await postEvent($, target, cached.event)) commands.delete(commandId);
    return;
  }
  if (cached?.state === "running") return;
  // prompt.submit waits for native idle. Leave the command on the Host until
  // the next idle poll instead of starting an idle-waiting Mods call during
  // native execution. Reserve one submission at a time so
  // a batch cannot start several idle-waiting calls before turn.start arrives.
  const submitting = [...commands.values()].some(item => item.state === "running" && item.commandType !== "stop");
  if (command.type === "user_message" && command.delivery === "steer" && (activeCompactions.size > 0 || submitting)) {
    await finishCommand($, target, commandId, { type: "command.result", commandId, ok: false,
      status: "failure", error: "runtime_busy" });
    return;
  }
  if (command.type === "user_message" && command.delivery !== "steer" &&
      (activeTurnId !== undefined || activeCompactions.size > 0 || submitting)) return;
  if (command.type === "slash" && ((!['model', 'effort'].includes(command.name) && (activeTurnId !== undefined || activeCompactions.size > 0)) ||
      [...commands.values()].some(item => item.state === "running" && item.commandType !== "stop"))) {
    await finishCommand($, target, commandId, { type: "command.result", commandId, ok: false,
      status: "failure", error: "runtime_busy" });
    return;
  }
  commands.set(commandId, command.type === "stop" && activeTurnId !== undefined
    ? { state: "running", commandType: "stop", turnId: activeTurnId }
    : { state: "running", commandType: command.type === "slash" ? "slash" : "user_message" });
  trimCommands();
  if (command.type === "user_message") {
    try {
      const result = await submitNativePrompt($, command);
      const denied = "drop" in result && typeof result.drop === "string";
      await finishCommand($, target, commandId, {
        type: "command.result", commandId, ok: !denied, status: denied ? "failure" : "success",
        ...(denied ? { error: clipText(result.drop, 4_000) } : {}),
        ...(command.messageId === undefined ? {} : { result: { messageId: command.messageId } }),
      });
    } catch (error) {
      await finishCommand($, target, commandId, { type: "command.result", commandId, ok: false,
        status: "unconfirmed", error: errorText(error) });
    }
    return;
  }
  if (command.type === "slash") {
    try {
      let output: string | undefined;
      if (command.name === "model") {
        // The `/config` model row, as the settings menu changes it; `/model` alone opens a picker.
        const set = await $.config.set({ key: "model", value: command.args.trim() });
        if ("deny" in set && typeof set.deny === "string") throw new Error(set.deny);
        if (activeTurnId !== undefined && turnSelection?.turnId === activeTurnId)
          turnSelection.selectedModel = await $.session.model();
        output = `Model set to ${command.args.trim()}`;
      } else if (command.name === "effort") {
        const effort = command.args.trim();
        if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("effort_not_available");
        selectedEffort = effort as Effort;
        output = `Effort selected for subsequent turns: ${effort}`;
      } else {
        const ran = await $.command.run({ command: command.name, args: command.args });
        output = ran.text;
      }
      await finishCommand($, target, commandId, { type: "command.result", commandId, ok: true, status: "success",
        ...(output === undefined || output.length === 0 ? {} : { result: { text: clipText(output, 16_000) } }) });
    } catch (error) {
      await finishCommand($, target, commandId, { type: "command.result", commandId, ok: false,
        status: "failure", error: errorText(error) });
    }
    void reportState($, true);
    return;
  }
  if (command.type === "stop") {
    if (activeTurnId === undefined) {
      await finishCommand($, target, commandId, { type: "command.result", commandId, ok: false,
        status: "not_cancelable", error: "claude_turn_not_running" });
      return;
    }
    try { await $.turn.abort({ turnId: activeTurnId }); }
    catch (error) {
      await finishCommand($, target, commandId, { type: "command.result", commandId, ok: false,
        status: "not_cancelable", error: errorText(error) });
    }
  }
}

async function finishCommand($: Api, target: Connection, commandId: string, event: BridgeEvent): Promise<void> {
  // A result from the previous Host must not enter the new generation's cache.
  if (connection !== target) return;
  commands.set(commandId, { state: "result", event });
  trimCommands();
  await postEvent($, target, event);
}

async function finishStep($: Api): Promise<void> {
  const step = activeStep;
  activeStep = undefined;
  if (step?.target === undefined) return;
  await postEvent($, step.target, { type: "turn.step.finished", turnId: step.turnId,
    stepIndex: step.stepIndex, uuids: step.uuids });
}

async function emit($: Api, event: BridgeEvent): Promise<boolean> {
  const target = connection ?? await connect($);
  if (target === undefined) return false;
  return await postEvent($, target, event);
}

async function postEvent($: Api, target: Connection, event: BridgeEvent): Promise<boolean> {
  if (connection !== target) return false;
  let response: { ok: boolean; status: number; body?: { result?: string } };
  try {
    response = await request<{ result?: string }>($, "/v1/claude/mods/event", {
      runtimeId: target.runtimeId, generation: target.generation, event,
    }, target.descriptor);
  } catch {
    return false;
  }
  if (connection !== target) return false;
  const accepted = response.ok && response.body?.result === "accepted";
  if (accepted && event.type === "command.result" && typeof event.commandId === "string") commands.delete(event.commandId);
  if (connection === target && !response.ok && (response.status === 401 || response.body?.result === "stale" || response.body?.result === "offline")) connection = undefined;
  return accepted;
}

async function request<T>($: Api, path: string, body: unknown, descriptor: Descriptor): Promise<{ ok: boolean; status: number; body?: T }> {
  const response = await $.http.fetch(`${descriptor.url}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.text.length > MAX_HTTP_BODY) return { ok: false, status: response.status };
  try { return { ok: response.ok, status: response.status, body: JSON.parse(response.text) as T }; }
  catch { return { ok: response.ok, status: response.status }; }
}

function sameDescriptor(left: Descriptor, right: Descriptor): boolean {
  return left.url === right.url && left.token === right.token;
}

/** One pinned line under the prompt; only redrawn when it changes. */
function showStatus($: Api, text: string | undefined): void {
  if (text === status) return;
  status = text;
  $.ui.status(text);
}

function boundedValue(value: unknown, maximum: number): unknown {
  let encoded: string;
  try { encoded = JSON.stringify(value) ?? "null"; } catch { return { unavailable: true }; }
  if (encoded.length <= maximum) return value;
  return { truncated: true, preview: encoded.slice(0, maximum) };
}

function clipText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}… [truncated]`;
}

function trimCommands(): void {
  while (commands.size > COMMAND_CACHE_LIMIT) {
    const removable = [...commands].find(([, value]) => value.state === "result");
    if (removable === undefined) return;
    commands.delete(removable[0]);
  }
}

function errorText(error: unknown): string {
  return clipText(error instanceof Error ? error.message : String(error), 4_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
