import { isAbsolute } from "node:path";
import { z } from "zod";

export const nativeId = z.string().regex(/^session_[A-Za-z0-9_-]{1,70}$/u);
const date = z.iso.datetime({ offset: true }).transform(value => Date.parse(value));
export const cwd = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0"));
export const markerKey = "orbis_launch_marker";
export const PAGE_SIZE = 100;

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
export const desktopSession = desktopSessionRow.transform((row): KimiSession => ({
  id: row.id, workspace_id: row.workspace_id, title: row.title, created_at: row.created_at, updated_at: row.updated_at,
  archived: row.archived, busy: row.activity !== "idle", main_turn_active: row.activity === "turn",
  agent_config: { model: "" }, // Only the authenticated main-agent frame reports the model in 2.8.1.
  metadata: { ...row.metadata, cwd: row.cwd },
}));
export const desktopPage = z.object({ items: z.array(desktopSessionRow).max(PAGE_SIZE), has_more: z.boolean(),
  next_page_token: z.string().min(1).max(4096).optional(), unavailable_hosts: z.array(z.string()).optional() });
export const kimiDesktopSessionEvent = z.object({ change: z.enum(["created", "updated", "archived", "restored", "deleted"]),
  session: desktopSessionRow.pick({ id: true, title: true, activity: true, environment_id: true, host_id: true }) });
export const catalogPage = z.object({ items: z.array(z.object({
  id: nativeId, workspace: z.object({ cwd }),
  meta: z.object({ title: z.string().nullable(), created_at: z.number().int().nonnegative(), updated_at: z.number().int().nonnegative(), archived: z.boolean() }),
})).max(PAGE_SIZE), has_more: z.boolean(), next_page_token: z.string().min(1).max(4096).nullable() });
