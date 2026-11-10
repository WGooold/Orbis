import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { SessionConfigurationValuesSchema, type AgentKind, type ConfiguredSessionLaunch, type SessionConfigurationCatalog,
  type SessionConfigurationValues, type SessionLaunchResult } from "@orbis/protocol";

const preference = z.object({ revision: z.number().int().nonnegative(), values: SessionConfigurationValuesSchema });
const launch = z.object({
  deviceId: z.string(), fingerprint: z.string(), launchId: z.string(), agentKind: z.enum(["pi", "codex", "codexDesktop", "dsh", "claude"]),
  cwd: z.string(), binding: z.string(), revision: z.number().int().nonnegative(), values: SessionConfigurationValuesSchema,
  phase: z.enum(["preparing", "created", "configuring", "ready", "failed", "unknown"]),
  sessionId: z.string().optional(), spawnMode: z.enum(["tui", "headless"]).optional(), error: z.string().optional(),
});
type Launch = z.infer<typeof launch>;
const fileSchema = z.object({ version: z.literal(1), preferences: z.record(z.string(), preference), launches: z.record(z.string(), launch) });
type File = z.infer<typeof fileSchema>;

export class SessionConfigurationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export const configurationKey = (kind: AgentKind, cwd: string, binding: string): string => JSON.stringify([kind, cwd, binding]);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** A selected value must still belong to the current native catalog at the side-effect boundary. */
export function validateSessionConfiguration(catalog: SessionConfigurationCatalog, values: SessionConfigurationValues): void {
  const model = catalog.models.find(item => item.value === values.model);
  if (values.model !== undefined && !model) throw new SessionConfigurationError("configuration_stale", "模型选项已变化，请刷新后重新选择");
  if (values.thinking !== undefined && !model?.thinking.some(item => item.value === values.thinking))
    throw new SessionConfigurationError("configuration_stale", "当前模型不支持这个思考深度，请重新选择");
  for (const [id, value] of Object.entries(values.permissions ?? {})) {
    const setting = catalog.permissions.find(item => item.id === id);
    if (!setting || setting.disabledReason || !setting.options.some(item => item.value === value))
      throw new SessionConfigurationError("configuration_stale", "权限选项不可用，请刷新后重新选择");
  }
  if (values.permissions?.sandbox === "dangerFullAccess" && values.permissions?.network === "restricted")
    throw new SessionConfigurationError("configuration_invalid", "完全访问模式不支持限制网络，请调整权限组合");
}

/** ADR-0072: durable before side effects. Missing native identity after a crash remains unknown. */
export class SessionConfigurationStore {
  readonly #path: string;
  #data: File | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #active = new Set<string>();
  constructor(path: string) { this.#path = path; }
  #key(deviceId: string, launchId: string): string { return JSON.stringify([deviceId, launchId]); }
  async #load(): Promise<File> {
    if (this.#data) return this.#data;
    let data: File;
    try { data = fileSchema.parse(JSON.parse(await readFile(this.#path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SessionConfigurationError("configuration_store_unavailable", "会话配置记录无法读取，已停止启动；请检查电脑端记录");
      data = { version: 1, preferences: {}, launches: {} };
    }
    this.#data = data;
    return data;
  }
  async #commit(data: File): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.#path);
      // Windows does not allow opening a directory as a regular fs handle.
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.#path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.#data = data;
    } finally { await unlink(temp).catch(() => undefined); }
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.#chain.then(fn);
    this.#chain = operation.catch(() => undefined);
    return operation;
  }
  read(kind: AgentKind, cwd: string, binding: string): Promise<{ revision: number; values: SessionConfigurationValues }> {
    return this.#serial(async () => structuredClone((await this.#load()).preferences[configurationKey(kind, cwd, binding)] ?? { revision: 0, values: {} }));
  }
  save(kind: AgentKind, cwd: string, binding: string, revision: number, values: SessionConfigurationValues): Promise<{ revision: number; values: SessionConfigurationValues }> {
    return this.#serial(async () => {
      const data = structuredClone(await this.#load()); const key = configurationKey(kind, cwd, binding);
      const prior = data.preferences[key] ?? { revision: 0, values: {} };
      // A lost save receipt can be recovered by reading the same value, without creating another revision.
      if (fingerprint(prior.values) === fingerprint(values)) return prior;
      if (prior.revision !== revision) throw new SessionConfigurationError("configuration_conflict", "配置已在其他操作中更新，请刷新后重试");
      const next = { revision: revision + 1, values: structuredClone(values) }; data.preferences[key] = next;
      await this.#commit(data); return next;
    });
  }
  begin(deviceId: string, request: ConfiguredSessionLaunch): Promise<{ record: Launch; execute: boolean }> {
    return this.#serial(async () => {
      const data = structuredClone(await this.#load()); const key = this.#key(deviceId, request.launchId);
      const hash = fingerprint([request.agentKind, request.cwd, request.binding, request.values, request.spawnMode ?? "tui"]);
      const prior = data.launches[key];
      if (prior) {
        if (prior.fingerprint !== hash) throw new SessionConfigurationError("launch_id_conflict", "启动身份与已有配置冲突，请先核对原启动");
        return { record: prior, execute: false };
      }
      if (Object.keys(data.launches).length >= 4096) throw new SessionConfigurationError("launch_capacity", "启动记录已达上限，请在电脑端检查保留记录");
      const prefKey = configurationKey(request.agentKind, request.cwd, request.binding);
      const pref = data.preferences[prefKey] ?? { revision: 0, values: {} };
      if (pref.revision !== request.revision && fingerprint(pref.values) !== fingerprint(request.values))
        throw new SessionConfigurationError("configuration_conflict", "启动配置已变化，请刷新后重试");
      const revision = fingerprint(pref.values) === fingerprint(request.values) ? pref.revision : pref.revision + 1;
      data.preferences[prefKey] = { revision, values: request.values };
      const record: Launch = { deviceId, fingerprint: hash, launchId: request.launchId, agentKind: request.agentKind,
        cwd: request.cwd, binding: request.binding, revision, values: request.values, phase: "preparing" };
      data.launches[key] = record; await this.#commit(data); this.#active.add(key);
      return { record, execute: true };
    });
  }
  /** A final preflight refusal is also idempotent, even if the catalog later changes. */
  reject(deviceId: string, request: ConfiguredSessionLaunch, error: string): Promise<void> {
    return this.#serial(async () => {
      const data = structuredClone(await this.#load()); const key = this.#key(deviceId, request.launchId);
      if (data.launches[key]) return;
      if (Object.keys(data.launches).length >= 4096) throw new SessionConfigurationError("launch_capacity", "启动记录已达上限，请在电脑端检查保留记录");
      data.launches[key] = { deviceId, fingerprint: fingerprint([request.agentKind, request.cwd, request.binding, request.values, request.spawnMode ?? "tui"]),
        launchId: request.launchId, agentKind: request.agentKind, cwd: request.cwd, binding: request.binding,
        revision: request.revision, values: request.values, phase: "failed", error };
      await this.#commit(data);
    });
  }
  update(deviceId: string, launchId: string, patch: Partial<Pick<Launch, "phase" | "sessionId" | "spawnMode" | "error">>): Promise<Launch> {
    return this.#serial(async () => {
      const data = structuredClone(await this.#load()); const key = this.#key(deviceId, launchId); const prior = data.launches[key];
      if (!prior) throw new Error("Unknown launch");
      if (prior.sessionId !== undefined && patch.sessionId !== undefined && prior.sessionId !== patch.sessionId)
        throw new SessionConfigurationError("launch_identity_conflict", "恢复返回了不同会话身份，已停止发送");
      const next = { ...prior, ...patch }; data.launches[key] = next;
      await this.#commit(data);
      if (["ready", "failed", "unknown"].includes(next.phase)) this.#active.delete(key);
      return next;
    });
  }
  /** Claim only the original native identity. No recovery path may call native create. */
  recover(deviceId: string, launchId: string): Promise<Launch | undefined> {
    return this.#serial(async () => {
      const key = this.#key(deviceId, launchId); const record = (await this.#load()).launches[key];
      if (!record?.sessionId || record.phase === "failed" || this.#active.has(key)) return undefined;
      this.#active.add(key);
      return structuredClone(record);
    });
  }
  result(deviceId: string, launchId: string, requestId: string): Promise<SessionLaunchResult | undefined> {
    return this.#serial(async () => {
      const key = this.#key(deviceId, launchId); const record = (await this.#load()).launches[key];
      if (!record) return undefined;
      const { agentKind, cwd, revision, values, phase, sessionId, spawnMode, error } = record;
      const orphaned = !this.#active.has(key) && !["ready", "failed", "unknown"].includes(record.phase);
      return { type: "session.launch.result", requestId, launchId, agentKind, cwd, revision, values, phase,
        ...(sessionId === undefined ? {} : { sessionId }), ...(spawnMode === undefined ? {} : { spawnMode }),
        ...(error === undefined ? {} : { error }),
        ...(orphaned ? { phase: "unknown" as const, error: "电脑端已重启，原启动结果待核对；不会自动重复创建会话" } : {}) };
    });
  }
  async blocks(sessionId: string): Promise<boolean> {
    return this.#serial(async () => Object.values((await this.#load()).launches).some(item => item.sessionId === sessionId && item.phase !== "ready"));
  }
}
