import { describe, expect, it } from "vitest";
import { SubscriptionQuotaSchema } from "./subscription-quota.js";

describe("bounded subscription quota", () => {
  const windows = [
    { name: "five_hour" as const, remainingPercent: 50, resetsAt: 100 },
    { name: "seven_day" as const, remainingPercent: null, resetsAt: null },
  ];
  it("keeps provider-pool readings additive to the legacy aggregate windows", () => {
    expect(SubscriptionQuotaSchema.parse({ checkedAt: 1, windows, pools: [{ id: "gemini-pro", label: "Gemini", windows }] }))
      .toMatchObject({ windows, pools: [{ id: "gemini-pro", label: "Gemini" }] });
    expect(SubscriptionQuotaSchema.parse({ checkedAt: 1, windows })).toMatchObject({ windows });
  });
  it("rejects unbounded or malformed provider-pool facts", () => {
    expect(SubscriptionQuotaSchema.safeParse({ checkedAt: 1, windows, pools: [{ id: "", label: "Gemini", windows }] }).success).toBe(false);
    expect(SubscriptionQuotaSchema.safeParse({ checkedAt: 1, windows, pools: Array.from({ length: 33 }, (_, i) => ({ id: String(i), label: "Gemini", windows })) }).success).toBe(false);
  });
});
