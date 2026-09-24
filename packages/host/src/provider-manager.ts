import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isSeq, parseDocument } from "yaml";
import type { AgentKind } from "@pi-remote/protocol";

type ObjectValue = Record<string, unknown>;
export type ProviderProfile = { id: string; kind: AgentKind; name: string; config: ObjectValue };
export type ProviderSummary = { id: string; kind: AgentKind; name: string; enabled: boolean; mode: "exclusive" | "additive" };
type Store = { version: 1; providers: ProviderProfile[]; current: Partial<Record<AgentKind, string>> };
type FileChange = { path: string; before: string | null; after: string | null };
export type ProviderPaths = { codex: string; pi: string; dsh: string };
export type ProviderHooks = { beforeApply?: (kind: AgentKind) => Promise<void>; afterApply?: (kind: AgentKind) => Promise<void> };
export class ProviderError extends Error {}
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const kinds = ["pi", "codex", "dsh"] as const;
export function agentKind(value: unknown): AgentKind {
  if (!kinds.includes(value as AgentKind)) throw new ProviderError("未知 Agent");
  return value as AgentKind;
}
const missing = (error: unknown): boolean => object(error) && error.code === "ENOENT";
async function read(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (error) { if (missing(error)) return null; throw error; }
}
async function atomicWrite(path: string, text: string | null): Promise<void> {
  if (text === null) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600, flag: "wx" }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
function parseObject(text: string | null, label: string): ObjectValue {
  if (text === null) return {};
  try { const value: unknown = JSON.parse(text); if (object(value)) return value; } catch { /* Never include source text or credentials in errors. */ }
  throw new ProviderError(`${label} 必须是有效的 JSON 对象`);
}
function validateConfig(kind: AgentKind, config: unknown): asserts config is ObjectValue {
  if (!object(config) || Buffer.byteLength(json(config)) > 48_000) throw new ProviderError("配置必须是 JSON 对象，且不能超过 48 KB");
  if (kind === "codex") {
    if (!(config.auth === null || object(config.auth)) || typeof config.config !== "string") throw new ProviderError("Codex 配置需要 auth 对象（或 null）与 config TOML 文本");
    try { parseToml(config.config); } catch { throw new ProviderError("Codex config.toml 格式无效，请检查高级配置"); }
  } else if (kind === "pi") {
    if (config.models !== undefined && (!Array.isArray(config.models) || config.models.some(model => !object(model) || typeof model.id !== "string" || !model.id))) throw new ProviderError("Pi models 必须是包含模型 id 的数组");
  } else {
    if (typeof config.patch !== "string" || !object(config.env) || Object.entries(config.env).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string")) throw new ProviderError("DSH 配置需要 patch YAML 文本与 env 字符串映射");
    const doc = parseDocument(config.patch);
    if (doc.errors.length || (doc.contents !== null && !isSeq(doc.contents))) throw new ProviderError("DSH patch 必须是有效的 YAML 补丁数组");
  }
}

/** CC Switch semantics: Codex snapshots/backfill, Pi additive native nodes. No remote credentials. */
export class ProviderManager {
  readonly paths: ProviderPaths;
  readonly #file: string;
  readonly #journal: string;
  readonly #hooks: ProviderHooks;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(stateDir: string, paths?: ProviderPaths, hooks: ProviderHooks = {}) {
    this.paths = paths ?? {
      codex: process.env.CODEX_HOME || join(homedir(), ".codex"),
      pi: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      dsh: process.env.DSH_HOME || join(homedir(), ".dsh"),
    };
    this.#file = join(stateDir, "providers.json");
    this.#journal = join(stateDir, "providers-transaction.json");
    this.#hooks = hooks;
  }
  #run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const lock = await this.#lock();
      try { await this.#recover(); return await work(); }
      finally { await lock.close(); await rm(`${this.#file}.lock`, { force: true }); }
    });
    this.#queue = next.catch(() => {});
    return next;
  }
  async #lock(): Promise<Awaited<ReturnType<typeof open>>> {
    const path = `${this.#file}.lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lock = await open(path, "wx", 0o600);
        await lock.writeFile(json({ pid: process.pid })); return lock;
      } catch (error) {
        if (!object(error) || error.code !== "EEXIST") throw error;
        let pid: unknown;
        try { pid = parseObject(await read(path), "供应商锁").pid; } catch { /* Another process may still be writing the lock. */ }
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) break;
        try { process.kill(pid, 0); break; }
        catch (probe) {
          if (!object(probe) || probe.code !== "ESRCH") break;
          // Compare the owner again before recovering a crashed process's lock.
          if (parseObject(await read(path), "供应商锁").pid !== pid) break;
          await rm(path, { force: true });
        }
      }
    }
    throw new ProviderError("供应商配置正被另一个 Host 修改，请稍后重试");
  }
  async #recover(): Promise<void> {
    const raw = await read(this.#journal);
    if (raw === null) return;
    const changes = JSON.parse(raw) as FileChange[];
    // Do not erase an external edit made after a crash.
    for (const change of [...changes].reverse()) {
      const current = await read(change.path);
      if (current === change.before) continue;
      if (current !== change.after) throw new ProviderError("未完成的配置切换与外部修改冲突，请检查 providers-transaction.json");
      await atomicWrite(change.path, change.before);
    }
    await rm(this.#journal);
  }
  async #load(): Promise<Store> {
    const raw = await read(this.#file);
    if (raw === null) return { version: 1, providers: [], current: {} };
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.providers) || !object(value.current)) throw new ProviderError("供应商目录格式无效，未覆盖现有文件");
    return value as Store;
  }
  async #live(kind: AgentKind): Promise<ObjectValue> {
    if (kind === "codex") {
      const auth = await read(join(this.paths.codex, "auth.json"));
      const config = await read(join(this.paths.codex, "config.toml")) ?? "";
      const value = { auth: auth === null ? null : parseObject(auth, "Codex auth.json"), config };
      validateConfig(kind, value); return value;
    }
    if (kind === "pi") {
      const root = parseObject(await read(join(this.paths.pi, "models.json")), "Pi models.json");
      if (root.providers !== undefined && !object(root.providers)) throw new ProviderError("Pi providers 必须是对象");
      return root;
    }
    const patch = await read(join(this.paths.dsh, "cordis.patch.yml")) ?? "";
    const value = { patch, env: {} };
    validateConfig(kind, value); return value;
  }
  async #sync(store: Store, kind: AgentKind): Promise<ObjectValue> {
    const live = await this.#live(kind);
    if (kind === "pi") {
      for (const [id, config] of Object.entries(object(live.providers) ? live.providers : {})) {
        if (!object(config)) throw new ProviderError("Pi 供应商节点必须是对象");
        const existing = store.providers.find(p => p.kind === kind && p.id === id);
        if (existing) { existing.config = config; if (typeof config.name === "string" && config.name.trim()) existing.name = config.name; }
        else store.providers.push({ id, kind, name: typeof config.name === "string" ? config.name : id, config });
      }
    } else {
      const active = store.providers.find(p => p.kind === kind && p.id === store.current[kind]);
      if (active) active.config = kind === "dsh" ? { ...live, env: active.config.env } : live;
      else if ((kind === "codex" && (live.config !== "" || live.auth !== null)) || (kind === "dsh" && live.patch !== "")) {
        const profile = { id: randomUUID(), kind, name: "已导入的本机配置", config: live };
        store.providers.push(profile); store.current[kind] = profile.id;
      }
    }
    return live;
  }
  #summaries(store: Store, kind: AgentKind, live: ObjectValue): ProviderSummary[] {
    return store.providers.filter(p => p.kind === kind).map(p => ({
      id: p.id, kind, name: p.name,
      enabled: kind === "pi" ? Object.hasOwn(object(live.providers) ? live.providers : {}, p.id) : store.current[kind] === p.id,
      mode: kind === "pi" ? "additive" : "exclusive",
    }));
  }
  list(kind: AgentKind): Promise<ProviderSummary[]> {
    return this.#run(async () => {
      const store = await this.#load(); const live = await this.#sync(store, kind);
      await atomicWrite(this.#file, json(store)); return this.#summaries(store, kind, live);
    });
  }
  get(kind: AgentKind, id: string): Promise<ProviderProfile> {
    return this.#run(async () => {
      const store = await this.#load(); await this.#sync(store, kind);
      const item = store.providers.find(p => p.kind === kind && p.id === id);
      if (!item) throw new ProviderError("供应商不存在，请刷新列表");
      await atomicWrite(this.#file, json(store)); return structuredClone(item);
    });
  }
  save(kind: AgentKind, id: string, name: string, config: unknown, create = false): Promise<ProviderSummary[]> {
    validateConfig(kind, config);
    if (!id.trim() || id.length > 128 || !name.trim() || name.length > 80 || ["__proto__", "constructor", "prototype"].includes(id)) throw new ProviderError("请填写供应商标识（1–128 字符）与名称（1–80 字符）");
    return this.#run(async () => {
      const store = await this.#load(); const live = await this.#sync(store, kind);
      const existing = store.providers.find(p => p.kind === kind && p.id === id);
      if (create && existing) throw new ProviderError("供应商标识已存在");
      if (!create && !existing) throw new ProviderError("供应商不存在，请刷新列表");
      const active = this.#summaries(store, kind, live).find(p => p.id === id)?.enabled;
      const profile = { id, kind, name: name.trim(), config: structuredClone(config) };
      if (kind === "pi" && Object.hasOwn(profile.config, "name")) profile.config.name = name.trim();
      if (existing) Object.assign(existing, profile); else store.providers.push(profile);
      if (active) await this.#apply(store, profile, live, true);
      else await atomicWrite(this.#file, json(store));
      return this.#summaries(store, kind, await this.#live(kind));
    });
  }
  switch(kind: AgentKind, id: string, enabled = true): Promise<ProviderSummary[]> {
    return this.#run(async () => {
      const store = await this.#load(); const live = await this.#sync(store, kind);
      const profile = store.providers.find(p => p.kind === kind && p.id === id);
      if (!profile) throw new ProviderError("供应商不存在，请在 Host 配置后刷新");
      if (!enabled && kind !== "pi") throw new ProviderError("请切换到其他供应商后再删除当前配置");
      if (this.#summaries(store, kind, live).find(p => p.id === id)?.enabled !== enabled) await this.#apply(store, profile, live, enabled);
      else await atomicWrite(this.#file, json(store));
      return this.#summaries(store, kind, await this.#live(kind));
    });
  }
  remove(kind: AgentKind, id: string): Promise<ProviderSummary[]> {
    return this.#run(async () => {
      const store = await this.#load(); const live = await this.#sync(store, kind);
      if (this.#summaries(store, kind, live).find(p => p.id === id)?.enabled) throw new ProviderError("请先停用或切换，再删除供应商");
      store.providers = store.providers.filter(p => p.kind !== kind || p.id !== id);
      await atomicWrite(this.#file, json(store)); return this.#summaries(store, kind, live);
    });
  }
  async environment(kind: AgentKind): Promise<NodeJS.ProcessEnv> {
    const store = await this.#load();
    const env = store.providers.find(p => p.kind === kind && p.id === store.current[kind])?.config.env;
    return kind === "dsh" && object(env) ? { ...process.env, ...env as Record<string, string> } : { ...process.env };
  }
  async #apply(store: Store, profile: ProviderProfile, live: ObjectValue, enabled: boolean): Promise<void> {
    validateConfig(profile.kind, profile.config);
    await this.#hooks.beforeApply?.(profile.kind);
    const desired: { path: string; after: string | null }[] = [];
    if (profile.kind === "pi") {
      const providers = { ...(object(live.providers) ? live.providers : {}) };
      if (enabled) Object.defineProperty(providers, profile.id, { value: profile.config, enumerable: true, configurable: true, writable: true }); else delete providers[profile.id];
      desired.push({ path: join(this.paths.pi, "models.json"), after: json({ ...live, providers }) });
    } else if (profile.kind === "codex") {
      desired.push({ path: join(this.paths.codex, "auth.json"), after: profile.config.auth === null ? null : json(profile.config.auth) });
      desired.push({ path: join(this.paths.codex, "config.toml"), after: profile.config.config as string });
      store.current.codex = profile.id;
    } else {
      desired.push({ path: join(this.paths.dsh, "cordis.patch.yml"), after: profile.config.patch as string });
      store.current.dsh = profile.id;
    }
    desired.push({ path: this.#file, after: json(store) });
    const changes: FileChange[] = await Promise.all(desired.map(async item => ({ ...item, before: await read(item.path) })));
    await atomicWrite(this.#journal, json(changes));
    try {
      for (const change of changes) {
        if (await read(change.path) !== change.before) throw new ProviderError("配置已被外部修改，请刷新后重试");
        await atomicWrite(change.path, change.after);
      }
      await this.#hooks.afterApply?.(profile.kind);
      await rm(this.#journal);
    } catch (error) {
      await this.#recover();
      try { await this.#hooks.afterApply?.(profile.kind); } catch { throw new ProviderError("配置已回滚，但 Agent 重载失败，请重启 Host"); }
      throw error instanceof ProviderError ? error : new ProviderError("切换失败，已恢复原配置；请检查 Agent 安装与配置");
    }
  }
}
