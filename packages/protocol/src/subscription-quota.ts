import { z } from "zod";

/** Only bounded quota facts cross the paired channel; never credentials or raw responses. */
export const SubscriptionQuotaWindowSchema = z.strictObject({
  name: z.enum(["five_hour", "seven_day"]),
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});
export const SubscriptionQuotaPoolSchema = z.strictObject({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(128),
  windows: z.array(SubscriptionQuotaWindowSchema).length(2),
});
export const SubscriptionQuotaSchema = z.strictObject({
  checkedAt: z.number().int().nonnegative(),
  windows: z.array(SubscriptionQuotaWindowSchema).length(2),
  /** Provider-specific counters, used by Antigravity's separate Gemini/third-party pools. */
  pools: z.array(SubscriptionQuotaPoolSchema).max(32).optional(),
});
export type SubscriptionQuotaWindow = z.infer<typeof SubscriptionQuotaWindowSchema>;
export type SubscriptionQuotaPool = z.infer<typeof SubscriptionQuotaPoolSchema>;
export type SubscriptionQuota = z.infer<typeof SubscriptionQuotaSchema>;
