import { z } from "zod";
import { AgentKeySchema } from "./agent-state.js";

/** ADR turn review: metadata is independent of chat coverage; text travels only on explicit reads. */
export const CHANGE_PAGE_MAX_BYTES = 60 * 1024;
export const CHANGE_DETAIL_MAX_BYTES = 48 * 1024;
export const CHANGE_PROJECTION_VERSION = 1 as const;
const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fits = (value: unknown): boolean => new TextEncoder().encode(JSON.stringify(value)).length <= CHANGE_PAGE_MAX_BYTES;
export const FileChangeMetadataSchema = z.strictObject({
  fileId: id, path: z.string().min(1).max(4096), oldPath: z.string().max(4096).optional(),
  changeKind: z.enum(["added", "modified", "deleted", "renamed", "type-changed", "unknown"]),
  fileKind: z.enum(["text", "binary", "symlink", "directory", "other", "unknown"]),
  additions: count.nullable(), deletions: count.nullable(),
  beforeBytes: count.nullable(), afterBytes: count.nullable(),
  contentVersion: id,
  detail: z.enum(["available", "binary", "too-large", "unsupported", "not-captured", "busy"]),
});
export type FileChangeMetadata = z.infer<typeof FileChangeMetadataSchema>;
export const TurnChangeSummarySchema = z.strictObject({
  projectionVersion: z.literal(CHANGE_PROJECTION_VERSION), agent: AgentKeySchema,
  reviewTurnId: id, sourceTurnIds: z.array(id).max(128), changeSetId: id, manifestVersion: count, revision: count,
  anchorEntryId: id.nullable(), startedAt: count, finishedAt: count.nullable(),
  state: z.enum(["collecting", "finalizing", "ready", "unavailable"]),
  outcome: z.enum(["completed", "failed", "cancelled", "unknown"]),
  coverage: z.enum(["complete", "partial", "unavailable"]),
  scope: z.enum(["git-visible-files", "bounded-directory", "unknown"]),
  attribution: z.literal("workspace-window"), reasons: z.array(z.string().max(128)).max(32),
  fileCount: count.nullable(), addedFiles: count.nullable(), modifiedFiles: count.nullable(), deletedFiles: count.nullable(),
  additions: count.nullable(), deletions: count.nullable(),
  preview: z.array(FileChangeMetadataSchema).max(4),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 12 * 1024, "change_summary_too_large");
export type TurnChangeSummary = z.infer<typeof TurnChangeSummarySchema>;
const scope = { requestId: id, runtimeId: id, agent: AgentKeySchema };
const version = { changeSetId: id, manifestVersion: count };
export const TurnChangesListRequestSchema = z.strictObject({
  type: z.literal("session.changes.list"), ...scope, entryIds: z.array(id).max(256), turnIds: z.array(id).max(128), cursor: id.nullable().optional(),
});
export const TurnChangesReadRequestSchema = z.strictObject({
  type: z.literal("session.changes.read"), ...scope, ...version, cursor: id.nullable(), maxItems: z.number().int().min(1).max(100),
});
export const FileChangeDetailReadRequestSchema = z.strictObject({
  type: z.literal("session.change.detail.read"), ...scope, ...version, fileId: id, contentVersion: id,
  viewerId: id, readId: id.nullable(), cursor: id.nullable(), maxBytes: z.number().int().min(256).max(CHANGE_DETAIL_MAX_BYTES),
});
export const FileChangeDetailCancelSchema = z.strictObject({
  type: z.literal("session.change.detail.cancel"), requestId: id, runtimeId: id, viewerId: id, readId: id.nullable(),
});
export const TurnChangesSummariesSchema = z.strictObject({
  type: z.literal("session.changes.summaries"), ...scope, summaries: z.array(TurnChangeSummarySchema).max(128), nextCursor: id.nullable(),
}).refine(fits, "change_page_too_large");
export const TurnChangesUpdatedSchema = z.strictObject({ type: z.literal("session.changes.updated"), summary: TurnChangeSummarySchema });
export const TurnChangesPageSchema = z.strictObject({
  type: z.literal("session.changes.page"), ...scope, ...version,
  files: z.array(FileChangeMetadataSchema).max(100), totalCount: count, nextCursor: id.nullable(),
}).refine(fits, "change_page_too_large");
export const FileChangeDetailPageSchema = z.strictObject({
  type: z.literal("session.change.detail.page"), ...scope, ...version, fileId: id, contentVersion: id,
  viewerId: id, readId: id, text: z.string(), nextCursor: id.nullable(), eof: z.boolean(),
}).refine(fits, "change_page_too_large");
export const TurnChangesFailedSchema = z.strictObject({
  type: z.literal("session.changes.failed"), requestId: id, runtimeId: id,
  reason: z.enum(["scope-mismatch", "not-captured", "expired", "version-mismatch", "invalid-cursor", "binary", "too-large", "unsupported", "busy", "unavailable"]),
});
export type TurnChangesListRequest = z.infer<typeof TurnChangesListRequestSchema>;
export type TurnChangesReadRequest = z.infer<typeof TurnChangesReadRequestSchema>;
export type FileChangeDetailReadRequest = z.infer<typeof FileChangeDetailReadRequestSchema>;
export type FileChangeDetailPage = z.infer<typeof FileChangeDetailPageSchema>;
export type TurnChangesRequest = TurnChangesListRequest | TurnChangesReadRequest | FileChangeDetailReadRequest | z.infer<typeof FileChangeDetailCancelSchema>;
export type TurnChangesEvent = z.infer<typeof TurnChangesSummariesSchema> | z.infer<typeof TurnChangesUpdatedSchema> |
  z.infer<typeof TurnChangesPageSchema> | FileChangeDetailPage | z.infer<typeof TurnChangesFailedSchema>;
