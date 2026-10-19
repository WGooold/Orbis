import { z } from "zod";

// Public Host projections only: credentials, native configuration and private receipts never enter these values.
const kind = z.enum(["pi", "codex", "codexDesktop", "dsh"]);
const id = z.string().min(1).max(1_024);
const count = z.number().int().nonnegative();
const availability = z.enum(["ready", "unknown", "unavailable"]);

export const HostIdentityStateSchema = z.strictObject({
  hostId: id, hostName: z.string().max(256), protocolVersion: z.number().int().positive(),
});
export type HostIdentityState = z.infer<typeof HostIdentityStateSchema>;

export const HostBackendsStateSchema = z.strictObject({
  backends: z.array(z.strictObject({
    kind, ready: z.boolean(), launchable: z.boolean().nullable(), runtimeCount: count,
    reason: z.string().max(500).nullable(),
  })).max(16),
  agents: z.array(kind).max(16).optional(),
  launchableAgents: z.array(kind).max(16).optional(),
  codexDesktop: z.strictObject({
    state: z.enum(["unsupported", "notInstalled", "closed", "attached", "error"]), reason: z.string().min(1).max(256),
  }).nullable().optional(),
});
export type HostBackendsState = z.infer<typeof HostBackendsStateSchema>;

export const HostWorkspacesStateSchema = z.strictObject({
  workspaces: z.array(z.strictObject({
    workspaceId: id, cwd: z.string().min(1).max(4_096), sessionCount: count,
    git: z.strictObject({
      availability, branch: z.string().max(1_024).nullable(), head: z.string().max(128).nullable(),
      repoRoot: z.string().max(4_096).nullable(),
    }),
  })).max(256),
  truncated: z.boolean(),
});
export type HostWorkspacesState = z.infer<typeof HostWorkspacesStateSchema>;

export const HostFilesStateSchema = z.strictObject({
  files: z.array(z.strictObject({
    fileId: id, runtimeId: id, fileName: z.string().min(1).max(512), size: count,
    mimeType: z.string().max(256).nullable(), sha256: z.string().max(128).nullable(), availability,
  })).max(500),
  truncated: z.boolean(),
});
export type HostFilesState = z.infer<typeof HostFilesStateSchema>;

export const HostSharedOperationSchema = z.strictObject({
  operationId: id, kind: z.enum(["session.activate", "session.archive", "provider.change"]),
  state: z.enum(["accepted", "running", "succeeded", "failed", "cancelled", "unknown"]),
  agentKind: kind.nullable(), sessionId: id.nullable(), startedAt: count, updatedAt: count,
});
export type HostSharedOperation = z.infer<typeof HostSharedOperationSchema>;

export const HostOperationsStateSchema = z.strictObject({
  activationsPending: count, commandsPending: count,
  sync: z.strictObject({ records: count, pending: count, active: count, reservedBytes: count }),
  transfers: z.strictObject({ uploads: count, downloads: count }),
  retentionMs: z.number().int().positive(),
  items: z.array(HostSharedOperationSchema).max(256).optional(),
  truncated: z.boolean().optional(),
});
export type HostOperationsState = z.infer<typeof HostOperationsStateSchema>;

export const HostConnectionsStateSchema = z.strictObject({
  pairedDevices: count, connectedDevices: count,
  paths: z.array(z.strictObject({
    kind: z.enum(["lan", "p2p", "relay"]), attachedDevices: count, activeDevices: count,
  })).max(3),
  relayState: z.string().min(1).max(64), sequenceChannels: count,
});
export type HostConnectionsState = z.infer<typeof HostConnectionsStateSchema>;

export const HostManagementStateSchema = z.strictObject({
  lifecycle: z.enum(["starting", "running", "stopping", "stopped"]),
  platform: z.string().min(1).max(64), nodeVersion: z.string().min(1).max(64),
  backends: z.array(z.strictObject({ kind, installed: z.boolean().nullable(), version: z.string().max(128).nullable() })).max(16),
});
export type HostManagementState = z.infer<typeof HostManagementStateSchema>;

/** Credential presence/binding is not a successful remote authentication probe. */
export const HostProviderAuthenticationSchema = z.strictObject({
  availability, method: z.enum(["managed_account", "native_oauth", "api_key", "none", "unknown"]),
  credentialPresent: z.boolean().nullable(), bindingReady: z.boolean().nullable(),
  verified: z.boolean().nullable(),
});
export type HostProviderAuthentication = z.infer<typeof HostProviderAuthenticationSchema>;

/** Only the numeric quota contract is public; arbitrary script output is never forwarded. */
export const HostProviderUsageSchema = z.strictObject({
  availability: z.enum(["ready", "unknown"]), detail: z.string().max(256).nullable(),
  rows: z.array(z.strictObject({
    remaining: z.number().finite().nullable(), used: z.number().finite().nullable(), total: z.number().finite().nullable(),
  })).max(32).optional(),
  updatedAt: count.nullable().optional(), attemptedAt: count.nullable().optional(),
  error: z.enum(["query_failed"]).nullable().optional(),
});
export type HostProviderUsage = z.infer<typeof HostProviderUsageSchema>;

export const HostProviderHealthSchema = z.strictObject({
  availability, circuits: z.array(z.strictObject({
    providerId: id, state: z.enum(["closed", "open", "half_open"]), failures: count,
    lastSuccessAt: count.nullable(), lastFailureAt: count.nullable(),
  })).max(64),
});
export type HostProviderHealth = z.infer<typeof HostProviderHealthSchema>;

export const HostProviderRoutingSchema = z.strictObject({
  availability, enabled: z.boolean().nullable(), running: z.boolean().nullable(),
  failoverEnabled: z.boolean().nullable(), queue: z.array(id).max(64),
  activeRequests: count.nullable(), lastProviderId: id.nullable(),
  totalRequests: count.nullable(), successfulRequests: count.nullable(), failoverCount: count.nullable(),
  // Each request captures its provider once selected. Switching the default never rewrites that binding.
  requests: z.array(z.strictObject({
    requestId: id, providerId: id.nullable(), startedAt: count,
    routeProviderIds: z.array(id).max(64),
  })).max(32),
});
export type HostProviderRouting = z.infer<typeof HostProviderRoutingSchema>;
