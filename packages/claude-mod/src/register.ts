import type { Hook, Register } from "claude-code";

type Api = Parameters<Hook<"session.start">>[0];
type Connection = { runtimeId: string; generation: string; sessionId: string; descriptor: Descriptor };
type Descriptor = { url: string; token: string };
type HelloReply = { ok: true; runtimeId: string; generation: string } | { ok: false; error: string };
type PollReply = { ok: true; commands: { commandId: string; command: RemoteCommand }[]; pendingInteractions?: number } | { ok: false; error: string };
type BridgeEvent = Record<string, unknown>;
type RemoteCommand = { type: "user_message"; text: string; messageId?: string } | { type: "slash"; name: string; args: string } | { type: "stop" };
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
let connection: Connection | undefined;
let connecting: Promise<Connection | undefined> | undefined;
let activeTurnId: string | undefined;
let polling = false;
let pollingTimer: ReturnType<Api["clock"]["every"]> | undefined;
let polls = 0;
let reportedState: { connection: Connection; encoded: string } | undefined;
let reporting = false;
let rejected: { error: string; until: number; descriptor: Descriptor } | undefined;
let status: string | undefined;

export const register: Register = on => {
  on("session.start", async ($, event, next) => {
    const result = await next(event);
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

  // The Host reads the row from the native transcript; announcing its identity is enough.
  on("session.append", async ($, event, next) => {
    const stored = await next(event);
    if (!("message" in stored) || stored.message === undefined || stored.uuid === undefined) return stored;
    await emit($, { type: "session.append", uuid: stored.uuid, door: event.door });
    return stored;
  }).catch(($, event, next) => next(event));

  on("session.compact", async ($, event, next) => {
    await emit($, { type: "compaction", phase: "running" });
    try {
      const result = await next(event);
      await emit($, { type: "compaction", phase: "idle" });
      return result;
    } catch (error) {
      await emit($, { type: "compaction", phase: "failed" });
      throw error;
    }
  });

  on("turn.start", async ($, event, next) => {
    const result = await next(event);
    if (event.agentId === undefined) {
      activeTurnId = event.turnId;
      await emit($, { type: "turn.start", turnId: event.turnId, startedAt: await $.clock.now() });
    }
    return result;
  }).catch(($, event, next) => next(event));

  on("turn.step", async function* ($, event, next) {
    const stream = next(event);
    let pending: { blockIndex: number; contentType: "text" | "thinking"; delta: string }[] = [];
    let pendingChars = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0 || event.agentId !== undefined) return;
      const chunks = pending;
      pending = [];
      pendingChars = 0;
      await emit($, { type: "turn.step.chunks", turnId: event.turnId, stepIndex: event.index, chunks });
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
    const result = await next(event);
    if (event.agentId === undefined) {
      if (activeTurnId === event.turnId) activeTurnId = undefined;
      const nativeEvent = { type: "turn.complete", turnId: event.turnId, durationMs: event.durationMs,
        answer: clipText(event.answer, 64_000), reason: event.reason, isAborted: event.isAborted } satisfies BridgeEvent;
      const stopCommandIds = [...commands].flatMap(([commandId, cached]) =>
        cached.state === "running" && cached.commandType === "stop" && cached.turnId === event.turnId ? [commandId] : []);
      const delivered = await emit($, nativeEvent);
      for (const commandId of stopCommandIds) {
        if (delivered) commands.delete(commandId);
        else commands.set(commandId, { state: "result", event: nativeEvent });
      }
      // Context fill and the model can change with every turn.
      void reportState($, true);
    }
    return result;
  }).catch(($, event, next) => next(event));

  on("tool.call", async ($, event, next) => {
    const toolName = event.tool;
    const toolCallId = event.tool_use_id;
    // The tool's own input, as a Hook's `tool_input` carries it: the engine's reserved fields left out.
    const argumentsValue = Object.fromEntries(Object.entries(event).filter(([key]) => !RESERVED_TOOL_FIELDS.has(key)));
    await emit($, { type: "tool.started", toolCallId, toolName, arguments: boundedValue(argumentsValue, 24_000) });
    const result = await next(event);
    const resultRecord = result as { deny?: unknown; result?: unknown; text?: unknown; isError?: unknown };
    await emit($, { type: "tool.finished", toolCallId, toolName,
      result: boundedValue(resultRecord.result ?? resultRecord.text ?? resultRecord.deny ?? null, 24_000),
      isError: resultRecord.isError === true || typeof resultRecord.deny === "string" });
    return result;
  }).catch(($, event, next) => next(event));
};

async function poll($: Api): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const current = await connect($);
    if (current === undefined) return;
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
    if (++polls % STATE_EVERY === 0) void reportState($, false);
  } catch {
    // Keep a generation across a transient request failure. The next poll still
    // rediscovers the Host, whose port and token change after a restart.
    showStatus($, "Orbis：Host 连接已断开，正在自动重连…");
  } finally {
    polling = false;
  }
}

async function connect($: Api): Promise<Connection | undefined> {
  if (connecting !== undefined) return connecting;
  const pending = connectOnce($);
  connecting = pending;
  try { return await pending; }
  finally { if (connecting === pending) connecting = undefined; }
}

async function connectOnce($: Api): Promise<Connection | undefined> {
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
  const response = await request<HelloReply>($, "/v1/claude/mods/hello", {
    type: "hello", instanceId: INSTANCE_ID, sessionId, cwd,
    ...(configDir === undefined || configDir.length === 0 ? {} : { configDir }),
    ...(launchId === undefined || launchId.length === 0 ? {} : { launchId }),
    claudeVersion: version.version, bridgeVersion: "1",
    capabilities: ["prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call"],
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
    if (typeof settings?.effortLevel === "string" && settings.effortLevel.length > 0) state.effort = settings.effortLevel;
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
  const root = stateDir ?? (home === undefined ? undefined : `${home}${home.includes("\\") ? "\\.orbis" : "/.orbis"}`);
  if (root === undefined) return undefined;
  const path = `${root.replace(/[\\/]+$/u, "")}${root.includes("\\") ? "\\" : "/"}loopback.json`;
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path));
    if (!isRecord(parsed) || typeof parsed.url !== "string" || typeof parsed.token !== "string" ||
        !/^ws:\/\/127\.0\.0\.1:\d+$/u.test(parsed.url) || parsed.token.length < 16) return undefined;
    return { url: parsed.url.replace(/^ws:/u, "http:"), token: parsed.token };
  } catch { return undefined; }
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
  commands.set(commandId, command.type === "stop" && activeTurnId !== undefined
    ? { state: "running", commandType: "stop", turnId: activeTurnId }
    : { state: "running", commandType: command.type === "slash" ? "slash" : "user_message" });
  trimCommands();
  if (command.type === "user_message") {
    try {
      const result = await $.prompt.submit({ text: command.text, asUser: true });
      const denied = "drop" in result && typeof result.drop === "string";
      await finishCommand($, target, commandId, {
        type: "command.result", commandId, ok: !denied, status: denied ? "failure" : "success",
        ...(denied ? { error: clipText(result.drop, 4_000) } : {}),
        ...(command.messageId === undefined ? {} : { result: { messageId: command.messageId } }),
      });
    } catch (error) {
      await finishCommand($, target, commandId, { type: "command.result", commandId, ok: false,
        status: "failure", error: errorText(error) });
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
        output = `Model set to ${command.args.trim()}`;
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
