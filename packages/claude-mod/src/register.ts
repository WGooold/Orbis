import type { Hook, Register } from "claude-code";

type Api = Parameters<Hook<"session.start">>[0];
type Connection = { runtimeId: string; generation: string; sessionId: string };
type Descriptor = { url: string; token: string };
type HelloReply = { ok: true; runtimeId: string; generation: string } | { ok: false; error: string };
type PollReply = { ok: true; commands: { commandId: string; command: RemoteCommand }[] } | { ok: false; error: string };
type BridgeEvent = Record<string, unknown>;
type RemoteCommand = { type: "user_message"; text: string; messageId?: string } | { type: "stop" };
type CachedCommand = { state: "running"; commandType: "user_message" } |
  { state: "running"; commandType: "stop"; turnId: string } | { state: "result"; event: BridgeEvent };

const INSTANCE_ID = crypto.randomUUID();
const COMMAND_CACHE_LIMIT = 128;
const MAX_HTTP_BODY = 240_000;
const commands = new Map<string, CachedCommand>();
let connection: Connection | undefined;
let descriptorCache: Descriptor | undefined;
let activeTurnId: string | undefined;
let polling = false;
let pollingTimer: ReturnType<Api["clock"]["every"]> | undefined;

export const register: Register = on => {
  on("session.start", async ($, event, next) => {
    const result = await next(event);
    void poll($);
    if (pollingTimer === undefined) pollingTimer = $.clock.every(750, () => { void poll($); });
    return result;
  });

  // The Host reads the row from the native transcript; announcing its identity is enough.
  on("session.append", async ($, event, next) => {
    const stored = await next(event);
    if (!("message" in stored) || stored.message === undefined || stored.uuid === undefined) return stored;
    await emit($, { type: "session.append", uuid: stored.uuid, door: event.door });
    return stored;
  }).catch(($, event, next) => next(event));

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
    }
    return result;
  }).catch(($, event, next) => next(event));

  on("tool.call", async ($, event, next) => {
    const toolName = event.tool;
    const toolCallId = event.tool_use_id;
    const argumentsValue = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "tool" && key !== "tool_use_id"));
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
    });
    const body = response.body;
    if (!response.ok || body === undefined || body.ok !== true) {
      const error = body !== undefined && "error" in body ? body.error : undefined;
      if (response.status === 401 || error === "stale_generation" || error === "bridge_offline") {
        connection = undefined;
        descriptorCache = undefined;
      }
      return;
    }
    for (const item of body.commands) await runCommand($, current, item.commandId, item.command);
  } catch {
    // Keep the current generation across transient HTTP failures. The Host lease
    // expires independently; a stale-generation response triggers a fresh hello.
  } finally {
    polling = false;
  }
}

async function connect($: Api): Promise<Connection | undefined> {
  const sessionId = await $.session.id();
  if (connection?.sessionId === sessionId) return connection;
  const version = await $.session.version();
  const cwd = await $.session.cwd();
  const descriptor = await readDescriptor($);
  if (descriptor === undefined) return undefined;
  descriptorCache = descriptor;
  const configDir = await $.env.get("CLAUDE_CONFIG_DIR");
  const response = await request<HelloReply>($, "/v1/claude/mods/hello", {
    type: "hello", instanceId: INSTANCE_ID, sessionId, cwd,
    ...(configDir === undefined || configDir.length === 0 ? {} : { configDir }),
    claudeVersion: version.version, bridgeVersion: "1",
    capabilities: ["prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call"],
  }, descriptor);
  if (!response.ok || response.body?.ok !== true) return undefined;
  const next = { runtimeId: response.body.runtimeId, generation: response.body.generation, sessionId };
  if (connection?.generation !== next.generation) commands.clear();
  connection = next;
  return next;
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
  const cached = commands.get(commandId);
  if (cached?.state === "result") {
    if (await postEvent($, target, cached.event)) commands.delete(commandId);
    return;
  }
  if (cached?.state === "running") return;
  commands.set(commandId, command.type === "stop" && activeTurnId !== undefined
    ? { state: "running", commandType: "stop", turnId: activeTurnId }
    : { state: "running", commandType: "user_message" });
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
  let response: { ok: boolean; status: number; body?: { result?: string } };
  try {
    response = await request<{ result?: string }>($, "/v1/claude/mods/event", {
      runtimeId: target.runtimeId, generation: target.generation, event,
    });
  } catch {
    return false;
  }
  const accepted = response.ok && response.body?.result === "accepted";
  if (accepted && event.type === "command.result" && typeof event.commandId === "string") commands.delete(event.commandId);
  if (!response.ok && (response.body?.result === "stale" || response.body?.result === "offline")) connection = undefined;
  return accepted;
}

async function request<T>($: Api, path: string, body: unknown, supplied?: Descriptor): Promise<{ ok: boolean; status: number; body?: T }> {
  const descriptor = supplied ?? descriptorCache ?? await readDescriptor($);
  if (descriptor === undefined) return { ok: false, status: 0 };
  const response = await $.http.fetch(`${descriptor.url}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.text.length > MAX_HTTP_BODY) return { ok: false, status: response.status };
  try { return { ok: response.ok, status: response.status, body: JSON.parse(response.text) as T }; }
  catch { return { ok: response.ok, status: response.status }; }
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
