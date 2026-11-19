import { z } from "zod";
import { AgentKeySchema, agentKeyId } from "./agent-state.js";

// ADR-0045 §8：限制完整 JSON 字节；身份超限必须拒绝，不能截断身份冒充原项。
export const TOOL_PROJECTION_VERSION = 1 as const;
export const TOOL_SUMMARY_MAX_BYTES = 4 * 1024;
export const TOOL_SUMMARY_TEXT_MAX_BYTES = 1024;
export const TOOL_PAGE_MAX_BYTES = 64 * 1024;
export const TOOL_ENVELOPE_RESERVE_BYTES = 4096;
export const TOOL_PAGE_BODY_MAX_BYTES = TOOL_PAGE_MAX_BYTES - TOOL_ENVELOPE_RESERVE_BYTES;
export const TOOL_INVENTORY_PAGE_MAX_ITEMS = 128;
export const TOOL_DETAIL_MAX_CONCURRENT_PER_DEVICE = 2;
export const TOOL_DETAIL_MAX_CONCURRENT_PER_VIEWER = 1;
export const TOOL_DETAIL_PENDING_WIRE_MAX_BYTES = 256 * 1024;
export const TOOL_SUMMARY_COALESCE_MS = 100;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1).max(256).refine(value =>
  value.trim().length > 0 && encoder.encode(value).byteLength <= 256, "invalid tool identifier");
const textBytes = (value: string): number => encoder.encode(value).byteLength;
export const toolJsonBytes = (value: unknown): number => textBytes(JSON.stringify(value));
const fits = (maximum: number) => (value: unknown): boolean => toolJsonBytes(value) <= maximum;

/** Raw UTF-8 prefix. Never use this on identities or serialized structured arguments. */
function utf8Prefix(text: string, maximum: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maximum) return text;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export const ToolSummaryTextSchema = z.strictObject({
  text: z.string().refine(value => textBytes(value) <= TOOL_SUMMARY_TEXT_MAX_BYTES, "summary text too large"),
  omitted: z.boolean(),
  originalBytes: integer,
}).refine(value => value.omitted ? value.originalBytes > textBytes(value.text) :
  value.originalBytes === textBytes(value.text), "inconsistent summary omission");
export type ToolSummaryText = z.infer<typeof ToolSummaryTextSchema>;

export function toolSummaryText(text: string, maximum = TOOL_SUMMARY_TEXT_MAX_BYTES): ToolSummaryText {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > TOOL_SUMMARY_TEXT_MAX_BYTES) {
    throw new Error("invalid_tool_summary_budget");
  }
  const originalBytes = textBytes(text);
  const value = utf8Prefix(text, maximum);
  return { text: value, omitted: originalBytes > textBytes(value), originalBytes };
}

export const ToolIdentitySchema = z.strictObject({ agent: AgentKeySchema, toolCallId: identity });
export type ToolIdentity = z.infer<typeof ToolIdentitySchema>;
export const toolIdentityId = (tool: ToolIdentity): string =>
  JSON.stringify([agentKeyId(tool.agent), tool.toolCallId]);
export const ToolContentPartSchema = z.enum(["arguments", "output", "result"]);
export const ToolContentFormatSchema = z.enum(["text", "json", "media-references"]);
export const ToolContentLocatorSchema = z.strictObject({
  projectionVersion: z.literal(TOOL_PROJECTION_VERSION),
  tool: ToolIdentitySchema,
  part: ToolContentPartSchema,
});
export type ToolContentLocator = z.infer<typeof ToolContentLocatorSchema>;
export const toolContentLocatorId = (locator: ToolContentLocator): string =>
  JSON.stringify([locator.projectionVersion, toolIdentityId(locator.tool), locator.part]);

export const ToolContentDescriptorSchema = z.strictObject({
  part: ToolContentPartSchema,
  format: ToolContentFormatSchema,
  availability: z.enum(["absent", "pending", "readable", "temporarily-unavailable", "unrecoverable"]),
  readCapability: z.enum(["range", "whole-source", "none"]),
}).refine(value => value.availability !== "readable" || value.readCapability !== "none",
  "readable content needs a read capability");

/** Current byte counts/TTL/readId are deliberately absent from immutable historical summaries. */
export const ToolSummarySchema = z.strictObject({
  projectionVersion: z.literal(TOOL_PROJECTION_VERSION),
  tool: ToolIdentitySchema,
  toolName: identity,
  phase: z.enum(["started", "running", "finished", "cancelled"]),
  isError: z.boolean().optional(),
  turnId: identity.optional(),
  messageId: identity.optional(),
  entryId: identity.optional(),
  order: integer,
  exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  durationMs: integer.optional(),
  inputSummary: ToolSummaryTextSchema.optional(),
  resultSummary: ToolSummaryTextSchema.optional(),
  errorSummary: ToolSummaryTextSchema.optional(),
  contents: z.array(ToolContentDescriptorSchema).max(3),
}).refine(value => new Set(value.contents.map(part => part.part)).size === value.contents.length,
  "duplicate content part").refine(fits(TOOL_SUMMARY_MAX_BYTES), "tool_summary_too_large");
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

/** Only verified adapter facts are accepted; never summarize an arbitrary JSON payload by stringifying it. */
export function createToolSummary(
  facts: Omit<ToolSummary, "projectionVersion" | "inputSummary" | "resultSummary" | "errorSummary"> & {
    inputSummary?: string; resultSummary?: string; errorSummary?: string;
  },
): ToolSummary {
  const { inputSummary, resultSummary, errorSummary, ...identityAndFacts } = facts;
  // Validate identity/structure before shrinking text. A too-large identity must stay an error.
  ToolSummarySchema.parse({ ...identityAndFacts, projectionVersion: TOOL_PROJECTION_VERSION });
  for (let budget = TOOL_SUMMARY_TEXT_MAX_BYTES; ; budget = Math.floor(budget / 2)) {
    const summary = { ...identityAndFacts, projectionVersion: TOOL_PROJECTION_VERSION,
      ...(inputSummary === undefined ? {} : { inputSummary: toolSummaryText(inputSummary, budget) }),
      ...(resultSummary === undefined ? {} : { resultSummary: toolSummaryText(resultSummary, budget) }),
      ...(errorSummary === undefined ? {} : { errorSummary: toolSummaryText(errorSummary, budget) }),
    };
    if (fits(TOOL_SUMMARY_MAX_BYTES)(summary) || budget === 0) return ToolSummarySchema.parse(summary);
  }
}

export const ToolSourceDependencySchema = z.strictObject({ epoch: identity, seq: integer });
export const ToolInventoryVersionSchema = z.strictObject({ epoch: identity, revision: integer });
export type ToolInventoryVersion = z.infer<typeof ToolInventoryVersionSchema>;
export const ToolInventorySnapshotSchema = z.strictObject({
  snapshotId: identity,
  agent: AgentKeySchema,
  version: ToolInventoryVersionSchema,
  source: ToolSourceDependencySchema,
  totalCount: integer.nullable(),
});
export type ToolInventorySnapshot = z.infer<typeof ToolInventorySnapshotSchema>;
export const ToolInventoryReadRequestSchema = z.strictObject({
  type: z.literal("session.tools.read"),
  requestId: identity,
  runtimeId: identity,
  snapshot: ToolInventorySnapshotSchema,
  cursor: identity.nullable(),
  maxItems: z.number().int().min(1).max(TOOL_INVENTORY_PAGE_MAX_ITEMS),
});
export type ToolInventoryReadRequest = z.infer<typeof ToolInventoryReadRequestSchema>;

/** Registry stores this bounded reference; summaries live in the inventory owner's bounded records. */
export const ToolInventoryReferenceSchema = z.strictObject({
  projectionVersion: z.literal(TOOL_PROJECTION_VERSION),
  agent: AgentKeySchema,
  version: ToolInventoryVersionSchema,
  source: ToolSourceDependencySchema,
  totalCount: integer,
  summaryBytes: integer,
});
export type ToolInventoryReference = z.infer<typeof ToolInventoryReferenceSchema>;
export const ToolInventoryOpenRequestSchema = z.strictObject({
  type: z.literal("session.tools.open"), requestId: identity, runtimeId: identity, reference: ToolInventoryReferenceSchema,
});
export const ToolInventoryOpenedSchema = z.strictObject({
  type: z.literal("session.tools.opened"), requestId: identity, runtimeId: identity, snapshot: ToolInventorySnapshotSchema,
});

/** A transaction too large for one delta requires a new baseline, never a truncated mutation. */
export const ToolInventoryChangedSchema = z.strictObject({
  type: z.literal("session.tools.changed"), runtimeId: identity,
  agent: AgentKeySchema, version: ToolInventoryVersionSchema, source: ToolSourceDependencySchema,
}).refine(fits(TOOL_PAGE_BODY_MAX_BYTES), "tool_inventory_notice_too_large");
export type ToolInventoryChanged = z.infer<typeof ToolInventoryChangedSchema>;
export const ToolInventoryPageSchema = z.strictObject({
  type: z.literal("session.tools.page"),
  requestId: identity,
  runtimeId: identity,
  snapshot: ToolInventorySnapshotSchema,
  startIndex: integer,
  endIndex: integer,
  tools: z.array(ToolSummarySchema).max(TOOL_INVENTORY_PAGE_MAX_ITEMS),
  nextCursor: identity.nullable(),
}).refine(page => page.endIndex - page.startIndex === page.tools.length, "inventory_range_mismatch")
  .refine(page => page.tools.length > 0 || page.nextCursor === null, "empty_nonterminal_page")
  .refine(page => page.snapshot.totalCount === null || (page.endIndex <= page.snapshot.totalCount &&
    (page.nextCursor === null ? page.endIndex === page.snapshot.totalCount : page.endIndex < page.snapshot.totalCount)),
  "inventory_coverage_mismatch")
  .refine(page => page.tools.every(tool => agentKeyId(tool.tool.agent) === agentKeyId(page.snapshot.agent)),
    "inventory_agent_mismatch")
  .refine(page => new Set(page.tools.map(tool => toolIdentityId(tool.tool))).size === page.tools.length,
    "duplicate_tool_identity")
  .refine(fits(TOOL_PAGE_BODY_MAX_BYTES), "tool_inventory_page_too_large");
export type ToolInventoryPage = z.infer<typeof ToolInventoryPageSchema>;
/** Producer → Host only; Host consumes these pages before the corresponding chat transaction. */
export const ToolInventoryProducedSchema = z.strictObject({
  type: z.literal("session.tools.produced"), reference: ToolInventoryReferenceSchema, page: ToolInventoryPageSchema,
}).refine(fits(TOOL_PAGE_MAX_BYTES), "tool_inventory_produced_too_large");
export type ToolInventoryProduced = z.infer<typeof ToolInventoryProducedSchema>;

export const ToolInventoryPatchSchema = z.strictObject({
  type: z.literal("session.tools.patch"),
  runtimeId: identity,
  agent: AgentKeySchema,
  version: ToolInventoryVersionSchema,
  baseRevision: integer,
  source: ToolSourceDependencySchema,
  upserts: z.array(ToolSummarySchema).max(TOOL_INVENTORY_PAGE_MAX_ITEMS),
  removes: z.array(identity).max(TOOL_INVENTORY_PAGE_MAX_ITEMS),
}).refine(patch => patch.version.revision === patch.baseRevision + 1, "inventory_revision_gap")
  .refine(patch => patch.upserts.length + patch.removes.length > 0, "empty_tool_mutation")
  .refine(patch => patch.upserts.every(tool => agentKeyId(tool.tool.agent) === agentKeyId(patch.agent)),
    "inventory_agent_mismatch")
  .refine(patch => new Set([...patch.upserts.map(tool => tool.tool.toolCallId), ...patch.removes]).size ===
    patch.upserts.length + patch.removes.length, "duplicate_tool_mutation")
  .refine(fits(TOOL_PAGE_BODY_MAX_BYTES), "tool_inventory_patch_too_large");
export type ToolInventoryPatch = z.infer<typeof ToolInventoryPatchSchema>;

export const ToolContentReadIdentitySchema = z.strictObject({
  readId: identity, contentEpoch: identity, throughOffset: integer,
});
export type ToolContentReadIdentity = z.infer<typeof ToolContentReadIdentitySchema>;
export const ToolContentReadRequestSchema = z.strictObject({
  type: z.literal("session.tool.content.read"),
  requestId: identity,
  runtimeId: identity,
  viewerId: identity,
  locator: ToolContentLocatorSchema,
  read: ToolContentReadIdentitySchema.nullable(),
  offset: integer,
  maxBytes: z.number().int().min(4).max(TOOL_PAGE_BODY_MAX_BYTES),
}).refine(value => value.read === null || value.offset <= value.read.throughOffset, "content_range_mismatch");
export type ToolContentReadRequest = z.infer<typeof ToolContentReadRequestSchema>;
export const ToolContentGapSchema = z.strictObject({
  fromOffset: integer, throughOffset: integer,
  reason: z.enum(["quota", "expired", "source-missing"]),
}).refine(gap => gap.fromOffset < gap.throughOffset, "empty_content_gap");
export type ToolContentGap = z.infer<typeof ToolContentGapSchema>;

/** Text fragments are not independently parseable JSON, even when format is json. */
export const ToolContentPageSchema = z.strictObject({
  type: z.literal("session.tool.content.page"),
  requestId: identity,
  runtimeId: identity,
  locator: ToolContentLocatorSchema,
  read: ToolContentReadIdentitySchema,
  format: ToolContentFormatSchema,
  representation: z.literal("utf8-fragment"),
  fromOffset: integer,
  throughOffset: integer,
  availableFromOffset: integer,
  availableThroughOffset: integer,
  observedThroughOffset: integer,
  contentFinal: z.boolean(),
  text: z.string(),
  nextCursor: integer.nullable(),
  gaps: z.array(ToolContentGapSchema).max(32),
}).refine(page => page.throughOffset - page.fromOffset === textBytes(page.text), "content_byte_range_mismatch")
  .refine(page => page.availableFromOffset <= page.fromOffset && page.throughOffset <= page.read.throughOffset &&
    page.read.throughOffset <= page.availableThroughOffset && page.availableThroughOffset <= page.observedThroughOffset,
  "content_coverage_mismatch")
  .refine(page => page.nextCursor === (page.throughOffset < page.read.throughOffset ? page.throughOffset : null) &&
    (page.nextCursor === null || page.throughOffset > page.fromOffset), "content_cursor_mismatch")
  .refine(page => page.gaps.every((gap, index) => gap.throughOffset <= page.observedThroughOffset &&
    (gap.throughOffset <= page.availableFromOffset || gap.fromOffset >= page.availableThroughOffset) &&
    (index === 0 || page.gaps[index - 1]!.throughOffset <= gap.fromOffset)), "content_gap_mismatch")
  .refine(page => {
    let cursor = 0;
    for (const gap of page.gaps) {
      if (cursor === page.availableFromOffset) cursor = page.availableThroughOffset;
      if (gap.fromOffset !== cursor) return false;
      cursor = gap.throughOffset;
    }
    if (cursor === page.availableFromOffset) cursor = page.availableThroughOffset;
    return cursor === page.observedThroughOffset;
  }, "undeclared_content_gap")
  .refine(fits(TOOL_PAGE_BODY_MAX_BYTES), "tool_content_page_too_large");
export type ToolContentPage = z.infer<typeof ToolContentPageSchema>;

// ADR-0045 §6/§8：先测量完整 JSON，转义膨胀时缩小文本范围，不截断 JSON 或 UTF-8 字符。
export function createToolContentPage(
  metadata: Omit<ToolContentPage, "text" | "throughOffset" | "nextCursor">, text: string,
): ToolContentPage {
  const candidate = (maximum: number): ToolContentPage => {
    const fragment = utf8Prefix(text, maximum);
    const throughOffset = metadata.fromOffset + textBytes(fragment);
    return { ...metadata, text: fragment, throughOffset,
      nextCursor: throughOffset < metadata.read.throughOffset ? throughOffset : null };
  };
  let low = 0;
  let high = textBytes(text);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(TOOL_PAGE_BODY_MAX_BYTES)(candidate(middle))) low = middle;
    else high = middle - 1;
  }
  return ToolContentPageSchema.parse(candidate(low));
}

export const ToolReadFailureSchema = z.strictObject({
  type: z.literal("session.tool.read.failed"),
  requestId: identity,
  runtimeId: identity,
  reason: z.enum(["content_expired", "content_unavailable", "content_version_invalid",
    "content_range_unavailable", "invalid_utf8_offset", "snapshot_expired", "scope_mismatch",
    "tool_identity_unrepresentable", "tool_response_too_large", "busy", "cancelled"]),
  retryAfterMs: z.number().int().min(100).max(60_000).optional(),
  gaps: z.array(ToolContentGapSchema).max(32),
}).refine(value => (value.reason === "busy") === (value.retryAfterMs !== undefined), "invalid_busy_retry")
  .refine(fits(TOOL_PAGE_BODY_MAX_BYTES), "tool_read_failure_too_large");
export const ToolContentCancelSchema = z.strictObject({
  type: z.literal("session.tool.content.cancel"),
  requestId: identity, runtimeId: identity, viewerId: identity, readId: identity,
});

/** Validate correlation in addition to validating each schema independently. */
export function toolContentPageMatchesRequest(request: ToolContentReadRequest, page: ToolContentPage): boolean {
  return request.requestId === page.requestId && request.runtimeId === page.runtimeId &&
    toolContentLocatorId(request.locator) === toolContentLocatorId(page.locator) && request.offset === page.fromOffset &&
    page.throughOffset - page.fromOffset <= request.maxBytes && (request.read === null ||
      (request.read.readId === page.read.readId && request.read.contentEpoch === page.read.contentEpoch &&
        request.read.throughOffset === page.read.throughOffset));
}

export function toolInventoryPageMatchesSnapshot(snapshot: ToolInventorySnapshot, page: ToolInventoryPage): boolean {
  const actual = page.snapshot;
  return agentKeyId(snapshot.agent) === agentKeyId(actual.agent) && snapshot.snapshotId === actual.snapshotId &&
    snapshot.version.epoch === actual.version.epoch && snapshot.version.revision === actual.version.revision &&
    snapshot.source.epoch === actual.source.epoch && snapshot.source.seq === actual.source.seq &&
    snapshot.totalCount === actual.totalCount;
}

/** Run after adding protocolVersion, runtime.event or other transport wrapping. */
export function assertToolWireBudget(envelope: unknown): void {
  if (toolJsonBytes(envelope) > TOOL_PAGE_MAX_BYTES) throw new Error("tool_response_too_large");
}
