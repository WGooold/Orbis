import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { AgentSessionSummary } from "@orbis/protocol";
import { localHostname } from "./sessions.js";
import { ActivationError } from "./spawner.js";
import type { KimiWebClient } from "./kimi-web-client.js";

export const KIMI_KIND = "kimiCode";
export const KIMI_PREFIX = "kimi-code:";
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
const environment = z.object({ environment_id: z.string(), workspace_id: z.string(), cwd: cwd.optional() });
const catalogPage = z.object({ items: z.array(z.object({
  id: nativeId, workspace: z.object({ cwd }),
  meta: z.object({ title: z.string().nullable(), created_at: z.number().int().nonnegative(), updated_at: z.number().int().nonnegative(), archived: z.boolean() }),
})).max(PAGE_SIZE), has_more: z.boolean(), next_page_token: z.string().min(1).max(4096).nullable() });
const recoveryPage = z.object({ items: z.array(KimiSessionSchema).max(PAGE_SIZE), has_more: z.boolean() });
export class KimiLaunchBlocked extends ActivationError {}
export function isKimiId(value: unknown): value is string { return typeof value === "string" && value.startsWith(KIMI_PREFIX); }
export const kimiSessionPath = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`;

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
  constructor(readonly client: Pick<KimiWebClient, "requestJson">, readonly key: string) {}
  publicId(id: string): string { return `${KIMI_PREFIX}${this.key}:${id}`; }
  nativeId(publicId: string): string {
    const prefix = this.publicId("");
    const id = publicId.startsWith(prefix) ? nativeId.safeParse(publicId.slice(prefix.length)) : undefined;
    if (!id?.success) throw new ActivationError("session_not_found", "此会话不属于当前 Kimi Code 数据源");
    return id.data;
  }

  async read(id: string): Promise<KimiSession> {
    return KimiSessionSchema.parse(await this.client.requestJson(kimiSessionPath(id)));
  }
  async requireLocal(session: KimiSession): Promise<string> {
    const binding = environment.safeParse(await this.client.requestJson(`${kimiSessionPath(session.id)}/environment`));
    if (!binding.success || binding.data.environment_id !== "local" || binding.data.workspace_id !== session.workspace_id) {
      throw new ActivationError("agent_unsupported", "未确认 Kimi Code 会话在本机执行");
    }
    return kimiLocalDirectory(binding.data.cwd ?? session.metadata.cwd);
  }
  async create(path: string, marker: string): Promise<KimiSession> {
    const directory = await kimiLocalDirectory(path);
    const auth = z.object({ models_ready: z.boolean() }).parse(await this.client.requestJson("/api/v1/auth"));
    if (!auth.models_ready) throw new KimiLaunchBlocked("agent_unsupported", "请先在 Kimi Code 配置默认模型");
    const result = KimiSessionSchema.parse(await this.client.requestJson("/api/v1/sessions", {
      method: "POST", body: { metadata: { cwd: directory, [markerKey]: marker }, environment_id: "local" },
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
    await this.client.requestJson(`${kimiSessionPath(id)}:${archived ? "archive" : "restore"}`, { method: "POST", body: {} });
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
        const page: z.infer<typeof catalogPage> = catalogPage.parse(await this.client.requestJson(`/api/v2/sessions?${params}`, { signal }));
        for (const row of page.items) {
          if (row.meta.archived !== archived || sessions.has(row.id)) return { sessions: [...sessions.values()], complete: false };
          sessions.set(row.id, { agentKind: KIMI_KIND, sessionId: this.publicId(row.id), cwd: row.workspace.cwd,
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

  /** v1 includes our creation marker. v2 deliberately omits arbitrary metadata. */
  async findLaunch(marker: string, path: string): Promise<string | undefined> {
    const directory = await kimiLocalDirectory(path);
    const signal = AbortSignal.timeout(6000);
    const seen = new Set<string>();
    let found: string | undefined;
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({ page_size: String(PAGE_SIZE), include_archive: "true" });
      if (cursor !== undefined) params.set("before_id", cursor);
      const page: z.infer<typeof recoveryPage> = recoveryPage.parse(await this.client.requestJson(`/api/v1/sessions?${params}`, { signal }));
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
      cursor = page.items.at(-1)?.id;
      if (!cursor) break;
    }
    return undefined;
  }
}
