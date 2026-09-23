import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PI_EXTENSION_RUNTIME_LOG_ENV = "PI_REMOTE_RUNTIME_LOG";
const PI_EXTENSION_RUNTIME_LOG_LEVEL_ENV = "PI_REMOTE_RUNTIME_LOG_LEVEL";
const DEFAULT_PI_EXTENSION_RUNTIME_LOG = join("data", "pi-extension-runtime.log");

type PiExtensionRuntimeLogLevel = "off" | "error" | "warn" | "info" | "debug";
type PiExtensionRuntimeLogFields = Record<string, string | number | boolean | undefined>;
type PersistedLogLevel = Exclude<PiExtensionRuntimeLogLevel, "off">;

type RuntimeLogOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  pid?: number;
  level?: PersistedLogLevel;
};

type PendingWrite = {
  path: string;
  line: string;
  resolve: () => void;
};

type RuntimeLogWriter = {
  queue: PendingWrite[];
  flushing: boolean;
};

type RuntimeLogScope = { [key: symbol]: unknown };
const RUNTIME_LOG_WRITER = Symbol.for("@pi-remote/runtime-log-writer");
const MAX_PENDING_WRITES = 1_024;

const LOG_LEVEL_PRIORITY: Record<PiExtensionRuntimeLogLevel, number> = {
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// The default info set is intentionally limited to lifecycle and reload events.
// Per-message and adapter details remain available with PI_REMOTE_RUNTIME_LOG_LEVEL=debug.
const INFO_EVENTS = new Set([
  "extension_loaded",
  "extension_reloaded",
  "session_started",
  "session_shutdown",
  "bridge.starting",
  "bridge.transport.connected",
  "bridge.transport.disconnected",
  "bridge.session.started",
  "bridge.command.received",
  "bridge.command.result",
  "bridge.session_sync.request",
  "bridge.session_sync.response",
  // 手机端「运行中」角标的生命周期。它只有增量事件可依，出现「状态卡住」时这一行是
  // 判断「电脑端就没发对」还是「发了但没到」的唯一分界点。
  "runtime.status.published",
  "slash.execute.pending",
  "slash.execute.started",
  "slash.execute.handler_resolved",
  "slash.execute.completed",
  "slash.adapter.requested",
  "slash.adapter.internal_command.dispatching",
  "slash.adapter.internal_command.received",
  "slash.adapter.builtin.started",
  "slash.adapter.builtin.completed",
  "pi.reload.requested",
  "pi.reload.resolved",
]);

const writer = (): RuntimeLogWriter => {
  const scope = globalThis as RuntimeLogScope;
  const existing = scope[RUNTIME_LOG_WRITER] as RuntimeLogWriter | undefined;
  if (existing?.queue instanceof Array && typeof existing.flushing === "boolean") return existing;
  const created: RuntimeLogWriter = { queue: [], flushing: false };
  scope[RUNTIME_LOG_WRITER] = created;
  return created;
};

export function piExtensionRuntimeLogPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env[PI_EXTENSION_RUNTIME_LOG_ENV];
  if (!configured) return join(cwd, DEFAULT_PI_EXTENSION_RUNTIME_LOG);
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

function piExtensionRuntimeLogLevel(
  env: NodeJS.ProcessEnv = process.env,
): PiExtensionRuntimeLogLevel {
  const configured = env[PI_EXTENSION_RUNTIME_LOG_LEVEL_ENV]?.trim().toLowerCase();
  return configured === "off" || configured === "error" || configured === "warn" ||
    configured === "info" || configured === "debug"
    ? configured
    : "info";
}

/** Keeps normal lifecycle/failure records at info and puts the detailed trace behind debug. */
function defaultPiExtensionRuntimeLogLevel(event: string): PersistedLogLevel {
  if (/(?:failed|error|rejected|dispatch_failed|timed_out)$/.test(event)) return "error";
  if (INFO_EVENTS.has(event)) return "info";
  return "debug";
}

const appendQueuedWrites = async (items: PendingWrite[]): Promise<void> => {
  const byPath = new Map<string, string[]>();
  for (const item of items) {
    const lines = byPath.get(item.path) ?? [];
    lines.push(item.line);
    byPath.set(item.path, lines);
  }
  await Promise.all([...byPath].map(async ([path, lines]) => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, lines.join(""), "utf8");
    } catch {
      // Runtime diagnostics must never prevent the extension from running.
    }
  }));
  for (const item of items) item.resolve();
};

const flush = async (state: RuntimeLogWriter): Promise<void> => {
  if (state.flushing) return;
  state.flushing = true;
  try {
    while (state.queue.length > 0) {
      const items = state.queue.splice(0, state.queue.length);
      await appendQueuedWrites(items);
    }
  } finally {
    state.flushing = false;
    if (state.queue.length > 0) void flush(state);
  }
};

const enqueue = (path: string, line: string): Promise<void> => {
  const state = writer();
  if (state.queue.length >= MAX_PENDING_WRITES) return Promise.resolve();
  const completion = new Promise<void>((resolve) => {
    state.queue.push({ path, line, resolve });
  });
  void flush(state);
  return completion;
};

type PiExtensionRuntimeLogSink = (
  event: string,
  fields: PiExtensionRuntimeLogFields,
  options: RuntimeLogOptions,
) => void | Promise<void>;

/** Creates a reload-safe callback that does not retain the stale ExtensionContext. */
export function createPiExtensionRuntimeDiagnostic(
  cwd: string,
  sink: PiExtensionRuntimeLogSink = logPiExtensionRuntimeEvent,
): (event: string, fields?: PiExtensionRuntimeLogFields) => void {
  return (event, fields = {}) => {
    try {
      void sink(event, fields, { cwd });
    } catch {
      // Diagnostics must never make the stale extension context observable.
    }
  };
}

/**
 * Appends one JSONL diagnostic record without blocking Pi's event loop.
 * Logging is best-effort and has a bounded in-memory queue.
 */
export async function logPiExtensionRuntimeEvent(
  event: string,
  fields: PiExtensionRuntimeLogFields = {},
  options: RuntimeLogOptions = {},
): Promise<void> {
  try {
    const level = options.level ?? defaultPiExtensionRuntimeLogLevel(event);
    const configuredLevel = piExtensionRuntimeLogLevel(options.env);
    if (LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY[configuredLevel]) return;

    const path = piExtensionRuntimeLogPath(options.env, options.cwd);
    const record = {
      timestamp: new Date((options.now ?? Date.now)()).toISOString(),
      level,
      event,
      pid: options.pid ?? process.pid,
      ...fields,
    };
    await enqueue(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Runtime diagnostics must never prevent the extension from loading.
  }
}
