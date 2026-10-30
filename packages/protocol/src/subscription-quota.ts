import { z } from "zod";

/** Only bounded quota facts cross the paired channel; never credentials or raw responses. */
export const SubscriptionQuotaSchema = z.strictObject({
  checkedAt: z.number().int().nonnegative(),
  windows: z.array(z.strictObject({
    name: z.enum(["five_hour", "seven_day"]),
    remainingPercent: z.number().min(0).max(100).nullable(),
    resetsAt: z.number().int().nonnegative().nullable(),
  })).length(2),
});
export type SubscriptionQuota = z.infer<typeof SubscriptionQuotaSchema>;
