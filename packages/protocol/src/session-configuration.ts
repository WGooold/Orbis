import { z } from "zod";

// S51 / SC73: all native option values stay opaque to mobile clients.
const id = z.string().min(1).max(1024);
const option = z.strictObject({ value: z.string().max(1024), label: z.string().min(1).max(512), description: z.string().max(2000).optional() });
export const SessionConfigurationValuesSchema = z.strictObject({
  model: z.string().min(1).max(1024).optional(),
  thinking: z.string().max(64).optional(),
  permissions: z.record(z.string().min(1).max(128), z.string().max(1024)).optional(),
});
export type SessionConfigurationValues = z.infer<typeof SessionConfigurationValuesSchema>;

export const SessionConfigurationCatalogSchema = z.strictObject({
  binding: id,
  defaults: SessionConfigurationValuesSchema,
  models: z.array(z.strictObject({
    value: id, label: z.string().min(1).max(512), thinking: z.array(option).max(32),
    defaultThinking: z.string().max(64).optional(),
  })).max(1000),
  permissions: z.array(z.strictObject({
    id: z.string().min(1).max(128), label: z.string().min(1).max(512),
    currentValue: z.string().max(1024).optional(), options: z.array(option).max(128),
    disabledReason: z.string().max(2000).optional(),
  })).max(16),
  notice: z.string().max(2000).optional(),
});
export type SessionConfigurationCatalog = z.infer<typeof SessionConfigurationCatalogSchema>;

const kind = z.enum(["pi", "codex", "codexDesktop", "dsh", "claude", "dshDesktop"]);
const location = { agentKind: kind, cwd: z.string().min(1).max(4096) };
const selected = { ...location, binding: id, revision: z.number().int().nonnegative(), values: SessionConfigurationValuesSchema };
export const SessionConfigurationReadSchema = z.strictObject({ type: z.literal("session.configuration.read"), requestId: id, ...location });
export const SessionConfigurationSaveSchema = z.strictObject({ type: z.literal("session.configuration.save"), requestId: id, ...selected });
export const ConfiguredSessionLaunchSchema = z.strictObject({
  type: z.literal("session.launch"), requestId: id, launchId: id, ...selected,
  spawnMode: z.enum(["tui", "headless", "auto"]).optional(),
});
export const SessionLaunchReadSchema = z.strictObject({ type: z.literal("session.launch.read"), requestId: id, launchId: id });
export const SessionConfigurationResultSchema = z.strictObject({
  type: z.literal("session.configuration.result"), requestId: id, ...selected, catalog: SessionConfigurationCatalogSchema,
});
export const SessionLaunchResultSchema = z.strictObject({
  type: z.literal("session.launch.result"), requestId: id, launchId: id,
  phase: z.enum(["preparing", "created", "configuring", "ready", "failed", "unknown", "absent"]),
  agentKind: kind.optional(), cwd: z.string().min(1).max(4096).optional(),
  revision: z.number().int().nonnegative().optional(), values: SessionConfigurationValuesSchema.optional(),
  sessionId: id.optional(), spawnMode: z.enum(["tui", "headless"]).optional(), error: z.string().max(2000).optional(),
});
export type ConfiguredSessionLaunch = z.infer<typeof ConfiguredSessionLaunchSchema>;
export type SessionLaunchResult = z.infer<typeof SessionLaunchResultSchema>;
