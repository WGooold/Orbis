import { describe, expect, it } from "vitest";
import { PushWakeReceipts } from "./push-wake.js";

// Repeated terminal patches, replayed approvals, and going offline after an
// already-observed event must not create fresh push notifications.
describe("push wake occurrence receipts", () => {
  it("claims each semantic event once even when no phone needed a wake at observation time", () => {
    const receipts = new PushWakeReceipts();
    expect(receipts.observe("task-completed", "turn-one")).toBe(true);
    expect(receipts.observe("task-completed", "turn-one")).toBe(false);
    expect(receipts.observe("approval-requested", "request-one")).toBe(true);
    expect(receipts.observe("approval-requested", "request-one")).toBe(false);
    expect(receipts.observe("task-completed", "turn-two")).toBe(true);
  });
  it("keeps category identities separate and bounds retained history", () => {
    const receipts = new PushWakeReceipts(2);
    expect(receipts.observe("task-completed", "same")).toBe(true);
    expect(receipts.observe("approval-requested", "same")).toBe(true);
    expect(receipts.observe("approval-requested", "same")).toBe(false);
    receipts.observe("task-completed", "new");
    expect(receipts.observe("approval-requested", "same")).toBe(false);
    expect(receipts.observe("task-completed", "same")).toBe(true);
  });
});
