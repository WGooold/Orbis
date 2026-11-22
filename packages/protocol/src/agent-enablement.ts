import { z } from "zod";

/** Advertise only when the corresponding reader/writer is wired to the paired transport. */
export const AGENT_ENABLEMENT_FEATURE = "agent.enablement.v1";
export const AGENT_ENABLEMENT_REVIEW_FEATURE = "agent.enablement.review.v1";
export const AgentEnablementRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// A management row is descriptive, not a routable session identity. Older settings clients
// can render a new source without expanding their strict session AgentKind enum.
const sourceId = z.string().min(1).max(64).regex(/^[a-z][A-Za-z0-9.-]*$/u);
const requestId = z.string().min(1).max(128);
export const AgentEnablementChoiceSchema = z.strictObject({
  kind: sourceId,
  enabled: z.boolean(),
  expectedRevision: AgentEnablementRevisionSchema,
  confirmDisable: z.literal(true).optional(),
  review: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});
export const AgentEnablementSnapshotSchema = z.strictObject({
  revision: AgentEnablementRevisionSchema,
  agents: z.array(z.strictObject({ kind: sourceId, label: z.string().min(1).max(128), enabled: z.boolean() })).max(128),
});
export const AgentEnablementReadSchema = z.strictObject({
  type: z.literal("agent.enablement.read"), requestId,
});
export const AgentEnablementWriteSchema = AgentEnablementChoiceSchema.extend({
  type: z.literal("agent.enablement.write"), requestId,
});
// Review is a separate, negotiated outcome. Old peers keep the original v1 wire shape.
export const AgentDisableReviewSchema = z.strictObject({
  kind: sourceId, revision: AgentEnablementRevisionSchema, token: z.string().regex(/^[a-f0-9]{64}$/u),
  sessions: z.array(z.string().min(1).max(256)).max(24),
  total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type AgentDisableReview = z.infer<typeof AgentDisableReviewSchema>;
export const AgentEnablementUpdateSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("agent.enablement.review"), requestId, review: AgentDisableReviewSchema }),
  z.strictObject({ type: z.literal("agent.enablement.snapshot"), requestId: requestId.optional(), snapshot: AgentEnablementSnapshotSchema }),
  z.strictObject({ type: z.literal("agent.enablement.result"), requestId,
    status: z.enum(["applied", "unchanged", "conflict"]), snapshot: AgentEnablementSnapshotSchema }),
]);
