import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { AgentSessionSummary } from "@orbis/protocol";
import type { NativeRunningSession } from "./agent-backend.js";
import { localHostname } from "./sessions.js";
import { ActivationError } from "./spawner.js";
import type { KimiSessionContract, KimiWebClient } from "./kimi-web-client.js";

export const KIMI_KIND = "kimiCode";
export const KIMI_DESKTOP_KIND = "kimiCodeDesktop";
export type KimiKind = typeof KIMI_KIND | typeof KIMI_DESKTOP_KIND;
export const KIMI_PREFIX = "kimi-code:";
export const KIMI_DESKTOP_PREFIX = "kimi-code-desktop:";
const KIMI_LEGACY_DESKTOP_PREFIX = "kimi-code:desktop-";
const nativeId = z.string().regex(/^session_[A-Za-z0-9_-]{1,70}$/u);
const date = z.iso.datetime({ offset: true }).transform(value => Date.parse(value));
const cwd = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0"));
const markerKey = "orbis_launch_marker";
const PAGE_SIZE = 100;
const MAX_PAGES = 12;

export const KimiSessionSchema = z.object({
  id: nativeId, workspace_id: z.string(), title: z.string(), created_at: date, updated_at: date,
  archived: z.boolean(), busy: z.boolean(), main_turn_active: z.boolean(),
  agent_config: z.object({ model: z.string() }),
  metadata: z.object({ cwd, [markerKey]: z.string().optional() }),
});
export type KimiSession = z.infer<typeof KimiSessionSchema>;
const desktopSessionRow = z.object({
  id: nativeId, workspace_id: z.string(), title: z.string(), created_at: date, updated_at: date,
  archived: z.boolean().default(false), activity: z.enum(["idle", "turn", "background"]), cwd,
  environment_id: z.string().optional(), host_id: z.string().optional(),
  metadata: z.object({ [markerKey]: z.string().optional() }).optional(),
});
const desktopSession = desktopSessionRow.transform((row): KimiSession => ({
  id: row.id, workspace_id: row.workspace_id, title: row.title, created_at: row.created_at, updated_at: row.updated_at,
  archived: row.archived, busy: row.activity !== "idle", main_turn_active: row.activity === "turn",
  agent_config: { model: "" }, // Only the authenticated main-agent frame reports the model in 2.8.1.
  metadata: { ...row.metadata, cwd: row.cwd },
}));
const desktopPage = z.object({ items: z.array(desktopSessionRow).max(PAGE_SIZE), has_more: z.boolean(),
  next_page_token: z.string().min(1).max(4096).optional(), unavailable_hosts: z.array(z.string()).optional() });
export const kimiDesktopSessionEvent = z.object({ change: z.enum(["created", "updated", "archived", "restored", "deleted"]),
  session: desktopSessionRow.pick({ id: true, title: true, activity: true, environment_id: true, host_id: true }) });
const environment = z.object({ environment_id: z.string(), workspace_id: z.string(), cwd: cwd.optional() });
const desktopEnvironment = environment.extend({ environment_cwd: cwd.optional() });
const catalogPage = z.object({ items: z.array(z.object({
  id: nativeId, workspace: z.object({ cwd }),
  meta: z.object({ title: z.string().nullable(), created_at: z.number().int().nonnegative(), updated_at: z.number().int().nonnegative(), archived: z.boolean() }),
})).max(PAGE_SIZE), has_more: z.boolean(), next_page_token: z.string().min(1).max(4096).nullable() });
const runningSession = KimiSessionSchema.pick({ id: true, archived: true, main_turn_active: true }).extend({ title: z.string().optional() });
const runningPage = z.object({ items: z.array(z.unknown()).max(PAGE_SIZE), has_more: z.boolean() });
const recoveryPage = z.object({ items: z.array(KimiSessionSchema).max(PAGE_SIZE), has_more: z.boolean() });
export class KimiLaunchBlocked extends ActivationError {}
export function kimiKindFromId(value: unknown): typeof KIMI_KIND | typeof KIMI_DESKTOP_KIND | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith(KIMI_DESKTOP_PREFIX)) return KIMI_DESKTOP_KIND;
  // Before Kimi had a separate AgentKind, Desktop sessions used a desktop- source key
  // under the shared prefix. Keep routing those already-created native sessions to Desktop.
  if (value.startsWith(KIMI_LEGACY_DESKTOP_PREFIX)) return KIMI_DESKTOP_KIND;
  if (value.startsWith(KIMI_PREFIX)) return KIMI_KIND;
  return undefined;
}
export function isKimiId(value: unknown): value is `${typeof KIMI_PREFIX | typeof KIMI_DESKTOP_PREFIX}${string}` {
  return kimiKindFromId(value) !== undefined;
}
export const kimiSessionPath = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`;
export function kimiNativeSessionId(publicId: string, key: string): string {
  const kind = kimiKindFromId(publicId);
  const prefixes = kind === KIMI_DESKTOP_KIND ? [`${KIMI_DESKTOP_PREFIX}${key}:`, `${KIMI_PREFIX}${key}:`] : [`${KIMI_PREFIX}${key}:`];
  const prefix = prefixes.find(candidate => publicId.startsWith(candidate)) ?? prefixes[0]!;
  const id = publicId.startsWith(prefix) ? nativeId.safeParse(publicId.slice(prefix.length)) : undefined;
  if (!id?.success) throw new ActivationError("session_not_found", "此会话不属于当前 Kimi Code 数据源");
  return id.data;
}

/** Identity persists through Web restarts and changes when the data root is replaced. */
export async function kimiSourceKey(home: string): Promise<string> {
  const path = await realpath(home);
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("Kimi Code 数据根不是目录");
  return createHash("sha256").update(JSON.stringify([path, info.dev, info.ino, info.birthtimeMs])).digest("base64url").slice(0, 24);
}

export async function kimiLocalDirectory(path: string): Promise<string> {
  try {
    if (!cwd.safeParse(path).success) throw new Error();
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) throw new Error();
    return cwd.parse(resolved);
  } catch { throw new KimiLaunchBlocked("cwd_missing", "请选择电脑上存在的绝对工作目录"); }
}

export class KimiSessions {
  constructor(readonly client: Pick<KimiWebClient, "requestJson">, readonly key: string,
    readonly kind: KimiKind = KIMI_KIND, readonly contract: KimiSessionContract = "legacy") {}
  publicId(id: string): string { return `${this.kind === KIMI_DESKTOP_KIND ? KIMI_DESKTOP_PREFIX : KIMI_PREFIX}${this.key}:${id}`; }
  nativeId(publicId: string): string {
    if (kimiKindFromId(publicId) !== this.kind) throw new ActivationError("session_not_found", "此会话不属于当前 Kimi Code 数据源");
    return kimiNativeSessionId(publicId, this.key);
  }

  async read(id: string): Promise<KimiSession> {
    return this.#parseSession(await this.client.requestJson(kimiSessionPath(id)));
  }
  #parseSession(value: unknown): KimiSession {
    return (this.contract === "desktop-2.8.1" ? desktopSession : KimiSessionSchema).parse(value);
  }
  async #desktopPage(archived: boolean | "all", signal: AbortSignal, token?: string, turnsOnly = false) {
    const query = new URLSearchParams({ page_size: String(PAGE_SIZE), archived: String(archived) });
    if (turnsOnly) query.set("activity", "turn");
    if (token !== undefined) query.set("page_token", token);
    return desktopPage.parse(await this.client.requestJson(`/api/v1/sessions?${query}`, { signal }));
  }
  async requireLocal(session: KimiSession): Promise<string> {
    const binding = (this.contract === "desktop-2.8.1" ? desktopEnvironment : environment).safeParse(await this.client.requestJson(`${kimiSessionPath(session.id)}/environment`));
    if (!binding.success || binding.data.environment_id !== "local" || binding.data.workspace_id !== session.workspace_id) {
      throw new ActivationError("agent_unsupported", "未确认 Kimi Code 会话在本机执行");
    }
    return kimiLocalDirectory(("environment_cwd" in binding.data ? binding.data.environment_cwd as string | undefined : undefined) ?? binding.data.cwd ?? session.metadata.cwd);
  }
  async create(path: string, marker: string, requireCurrent?: () => void): Promise<KimiSession> {
    const directory = await kimiLocalDirectory(path);
    const auth = z.object({ models_ready: z.boolean() }).parse(await this.client.requestJson("/api/v1/auth"));
    if (!auth.models_ready) throw new KimiLaunchBlocked("agent_unsupported", "请先在 Kimi Code 配置默认模型");
    requireCurrent?.();
    const result = this.#parseSession(await this.client.requestJson("/api/v1/sessions", {
      method: "POST", body: this.contract === "desktop-2.8.1"
        ? { workspace_root: directory, environment_id: "local", metadata: { [markerKey]: marker } }
        : { metadata: { cwd: directory, [markerKey]: marker }, environment_id: "local" },
    }));
    if (result.archived || result.metadata[markerKey] !== marker || result.metadata.cwd !== directory) {
      throw new Error("Kimi Code 未确认新会话身份，不会重新创建");
    }
    return result;
  }
  async setArchived(publicId: string, archived: boolean): Promise<void> {
    const id = this.nativeId(publicId);
    const current = await this.read(id);
    if (current.id !== id) throw new Error("Kimi Code 会话身份不一致");
    if (current.archived === archived) return;
    await this.requireLocal(current);
    if (this.contract === "desktop-2.8.1" && !archived) {
      await this.client.requestJson("/api/v1/sessions:restore", { method: "POST", body: { ids: [id] } });
    } else {
      await this.client.requestJson(`${kimiSessionPath(id)}:${archived ? "archive" : "restore"}`, { method: "POST", body: {} });
    }
    const updated = await this.read(id);
    if (updated.id !== id || updated.archived !== archived) throw new Error("Kimi Code 未确认归档状态");
  }

  async catalog(archived: boolean): Promise<{ sessions: AgentSessionSummary[]; complete: boolean }> {
    const sessions = new Map<string, AgentSessionSummary>();
    const seen = new Set<string>();
    const signal = AbortSignal.timeout(6000);
    let token: string | null = null;
    try {
      for (let count = 0; count < MAX_PAGES; count++) {
        const params = new URLSearchParams({ page_size: String(PAGE_SIZE), "meta.archived": String(archived) });
        if (token !== null) params.set("page_token", token);
        const page: z.infer<typeof catalogPage> = this.contract === "desktop-2.8.1"
          ? await this.#desktopPage(archived, signal, token ?? undefined).then(page => ({
            items: page.items.filter(row => row.environment_id === "local" && !row.host_id).map(row => ({
              id: row.id, workspace: { cwd: row.cwd },
              meta: { title: row.title, created_at: row.created_at, updated_at: row.updated_at, archived: row.archived },
            })), has_more: page.has_more || !!page.unavailable_hosts?.length, next_page_token: page.next_page_token ?? null,
          }))
          : catalogPage.parse(await this.client.requestJson(`/api/v2/sessions?${params}`, { signal }));
        for (const row of page.items) {
          if (row.meta.archived !== archived || sessions.has(row.id)) return { sessions: [...sessions.values()], complete: false };
          sessions.set(row.id, { agentKind: this.kind, sessionId: this.publicId(row.id), cwd: row.workspace.cwd,
            hostname: localHostname() ?? "localhost", ...(row.meta.title ? { name: row.meta.title.slice(0, 256) } : {}),
            createdAt: row.meta.created_at, modifiedAt: row.meta.updated_at, archived, messageCount: 0 });
        }
        if (!page.has_more) return { sessions: [...sessions.values()], complete: true };
        token = page.next_page_token;
        if (!token || seen.has(token)) break;
        seen.add(token);
      }
    } catch { /* Partial observations are not authoritative absence. */ }
    return { sessions: [...sessions.values()], complete: false };
  }

  /** Desktop presence only: v2 catalog rows do not include main-turn state. */
  async runningSessions(): Promise<NativeRunningSession[]> {
    const signal = AbortSignal.timeout(4_000);
    const sessions = new Map<string, NativeRunningSession>();
    let before: string | undefined;
    if (this.contract === "desktop-2.8.1") {
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const page = await this.#desktopPage(false, signal, before, true);
        for (const row of page.items) {
          if (row.archived || row.activity !== "turn" || row.environment_id !== "local" || row.host_id) continue;
          const sessionId = this.publicId(row.id);
          sessions.set(sessionId, { sessionId, ...(row.title ? { name: row.title.slice(0, 256) } : {}) });
        }
        before = page.next_page_token;
        if (!page.has_more || !before || seen.has(before)) break;
        seen.add(before);
      }
      return [...sessions.values()];
    }
    for (let i = 0; i < 3; i++) {
      const query = new URLSearchParams({ page_size: String(PAGE_SIZE), include_archive: "false", busy: "true" });
      if (before) query.set("before_id", before);
      const page = runningPage.parse(await this.client.requestJson(`/api/v1/sessions?${query}`, { signal }));
      for (const value of page.items) {
        const parsed = runningSession.safeParse(value);
        if (!parsed.success || parsed.data.archived || !parsed.data.main_turn_active) continue;
        const { id, title } = parsed.data;
        const sessionId = this.publicId(id);
        sessions.set(sessionId, { sessionId, ...(title ? { name: title.slice(0, 256) } : {}) });
      }
      const tail = z.object({ id: nativeId }).safeParse(page.items.at(-1));
      const next = tail.data?.id;
      if (!page.has_more || !next || next === before) break;
      before = next;
    }
    return [...sessions.values()];
  }

  /** v1 includes our creation marker. v2 deliberately omits arbitrary metadata. */
  async findLaunch(marker: string, path: string): Promise<string | undefined> {
    const directory = await kimiLocalDirectory(path);
    const signal = AbortSignal.timeout(6000);
    const seen = new Set<string>();
    const tokens = new Set<string>();
    let found: string | undefined;
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({ page_size: String(PAGE_SIZE), include_archive: "true" });
      if (cursor !== undefined) params.set("before_id", cursor);
      const page = this.contract === "desktop-2.8.1"
        ? await this.#desktopPage("all", signal, cursor).then(page => ({ ...page,
          items: page.items.map(row => ({ id: row.id, archived: row.archived,
            metadata: { ...row.metadata, cwd: row.cwd } })),
        }))
        : recoveryPage.parse(await this.client.requestJson(`/api/v1/sessions?${params}`, { signal }));
      if ("unavailable_hosts" in page && page.unavailable_hosts?.length) return undefined;
      for (const session of page.items) {
        if (seen.has(session.id)) return undefined;
        seen.add(session.id);
        if (session.metadata[markerKey] !== marker) continue;
        if (found || session.metadata.cwd !== directory || session.archived) return undefined;
        found = session.id;
      }
      if (!page.has_more) {
        if (!found) return undefined;
        const current = await this.read(found);
        if (current.id !== found || current.archived || current.metadata[markerKey] !== marker || current.metadata.cwd !== directory) return undefined;
        await this.requireLocal(current);
        return this.publicId(found);
      }
      cursor = "next_page_token" in page ? page.next_page_token : page.items.at(-1)?.id;
      if (!cursor || tokens.has(cursor)) break;
      tokens.add(cursor);
    }
    return undefined;
  }
}
