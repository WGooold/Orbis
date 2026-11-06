import { describe, expect, it, vi } from "vitest";
import { BulkSendBudget } from "./bulk-send-budget.js";

describe("NQ-15 shared Relay bulk credit", () => {
  // New sockets must share the existing allowance, and waiting downloads must
  // alternate rather than letting the first busy socket starve its peers.
  it("shares one burst and rate across senders and rotates waiting frames", () => {
    let now = 0;
    const budget = new BulkSendBudget(65_536, () => now);
    const a = {}, b = {};
    expect(budget.delayMs(a, 65_536)).toBe(0);
    expect(budget.delayMs(a, 32_768)).toBe(500);
    expect(budget.delayMs(b, 32_768)).toBe(500);
    now = 500;
    expect(budget.delayMs(b, 32_768)).toBeGreaterThan(0);
    expect(budget.delayMs(a, 32_768)).toBe(0);
    expect(budget.delayMs(a, 32_768)).toBe(500);
    now = 1000;
    expect(budget.delayMs(a, 32_768)).toBeGreaterThan(0);
    expect(budget.delayMs(b, 32_768)).toBe(0);
    budget.cancel(a);
    budget.cancel(b);
    now = 100_000;
    expect(budget.delayMs(a, 65_536)).toBe(0);
    expect(budget.delayMs(b, 65_536)).toBe(1000);
  });

  // Disconnect or a new key exchange must remove a waiting owner immediately.
  it("releases a cancelled head without replenishing the global bucket", () => {
    let now = 0;
    const budget = new BulkSendBudget(65_536, () => now);
    const a = {}, b = {};
    budget.delayMs(a, 65_536);
    expect(budget.delayMs(a, 65_536)).toBe(1000);
    expect(budget.delayMs(b, 65_536)).toBe(1000);
    budget.cancel(a);
    expect(budget.delayMs(b, 65_536)).toBe(1000);
    now = 1000;
    expect(budget.delayMs(b, 65_536)).toBe(0);
  });

  // A phone can become backpressured after queuing for tokens. Its place in the
  // global rotation must not create head-of-line blocking for other downloads.
  it("skips a waiting sender whose socket is no longer writable", () => {
    let now = 0, writable = true;
    const budget = new BulkSendBudget(65_536, () => now);
    const a = {}, b = {};
    budget.delayMs(a, 65_536);
    expect(budget.delayMs(a, 65_536, () => writable)).toBe(1000);
    expect(budget.delayMs(b, 65_536)).toBe(1000);
    writable = false;
    now = 1000;
    expect(budget.delayMs(b, 65_536)).toBe(0);
  });

  // Smaller frames behind a large waiter must sleep for its credit deadline,
  // rather than wake repeatedly while the first sender cannot make progress.
  it("uses the first waiter's deadline for differently sized frames", () => {
    const budget = new BulkSendBudget(65_536, () => 0);
    const a = {}, b = {};
    budget.delayMs(a, 65_536);
    expect(budget.delayMs(a, 65_536)).toBe(1000);
    expect(budget.delayMs(b, 1024)).toBe(1000);
  });

  // Removing a large head changes the next sender's deadline. Its mux must
  // recalculate immediately rather than sleep until that obsolete deadline.
  it.each(["cancel", "send"] as const)("wakes the next sender after a head %s", async action => {
    let now = 0;
    const budget = new BulkSendBudget(65_536, () => now);
    const a = {}, b = {}, wake = vi.fn();
    budget.delayMs(a, 65_536);
    budget.delayMs(a, 65_536);
    expect(budget.delayMs(b, 1024, () => true, wake)).toBe(1000);
    if (action === "cancel") budget.cancel(a);
    else { now = 1000; expect(budget.delayMs(a, 65_536)).toBe(0); }
    await Promise.resolve();
    expect(wake).toHaveBeenCalledOnce();
    expect(budget.delayMs(b, 1024)).toBe(16);
  });

  // Existing peers can send a valid unsliced envelope larger than our normal
  // burst. It must eventually pass, with its full size charged before more bulk.
  it("accounts for an indivisible legacy frame without deadlocking or forgiving its debt", () => {
    let now = 0;
    const budget = new BulkSendBudget(65_536, () => now);
    const a = {}, b = {};
    expect(budget.delayMs(a, 131_072)).toBe(0);
    expect(budget.delayMs(b, 65_536)).toBe(2000);
    now = 1999;
    expect(budget.delayMs(b, 65_536)).toBe(1);
    now = 2000;
    expect(budget.delayMs(b, 65_536)).toBe(0);
  });

  it("supports an explicit unlimited budget and rejects invalid configuration", () => {
    const budget = new BulkSendBudget(0, () => 0);
    expect(budget.delayMs({}, 10_000_000)).toBe(0);
    expect(budget.delayMs({}, 10_000_000)).toBe(0);
    for (const rate of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new BulkSendBudget(rate)).toThrow("bulkBytesPerSecond");
    }
  });
});
