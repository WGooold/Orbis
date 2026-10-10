import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationSource, RuntimeEventSchema, type NotificationInput, type NotificationSourceEvent } from "@pi-remote/protocol";
import { NotificationStore } from "./notification-store.js";

const condition = (code: string, occurrenceId = "one"): NotificationInput => ({ code, occurrenceId,
  scope: { turnId: "turn" }, severity: "warning", lifecycle: "condition", message: code });
const source = (revision: number, notifications: NotificationInput[], extra: Partial<NotificationSourceEvent> = {}): NotificationSourceEvent =>
  ({ type: "notification.source", producerEpoch: "producer", sessionId: "session", revision, complete: true, notifications, ...extra });
const stores: NotificationStore[] = [];
const make = () => { let time = 1000; const changed = vi.fn();
  const store = new NotificationStore(changed, () => time); stores.push(store);
  store.attach("runtime", "session"); changed.mockClear();
  return { store, changed, advance: (ms: number) => { time += ms; store.expire(); },
    items: (device = "a") => store.snapshot("runtime", device).notifications };
};
afterEach(() => stores.splice(0).forEach(store => store.close()));

describe("Host notification lifecycle", () => {
  it("recovers a lost resolution with a full inventory without clearing another condition", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry"), condition("sandbox")]));
    const sandbox = h.items()[1]?.notificationId;
    h.store.apply("runtime", source(8, [condition("sandbox")]));
    expect(h.items().map(item => item.code)).toEqual(["sandbox"]); expect(h.items()[0]?.notificationId).toBe(sandbox);
    h.store.apply("runtime", source(2, [condition("retry")])); expect(h.items()[0]?.code).toBe("sandbox");
  });
  it("does not use a partial newer inventory or an older success as recovery", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry")]));
    h.store.apply("runtime", source(3, [], { complete: false }));
    h.store.apply("runtime", source(2, [])); expect(h.items()).toHaveLength(1);
    expect(h.store.snapshot("runtime", "a")).toMatchObject({ complete: false, verification: "unknown" });
    h.store.apply("runtime", source(3, [])); expect(h.items()).toEqual([]);
  });
  it("rejects unbound producer replacement and ends closed owners before reconnecting", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry")]));
    expect(h.store.apply("runtime", source(99, [], { producerEpoch: "old" }))).toBe(false);
    h.store.end("runtime"); expect(h.store.apply("runtime", source(2, [condition("retry")]))).toBe(false);
    h.store.attach("runtime", "session"); h.store.apply("runtime", source(0, [], { producerEpoch: "new" }));
    expect(h.items()).toEqual([]); expect(h.store.apply("runtime", source(100, [condition("retry")]))).toBe(false);
  });
  it("duplicates are idempotent and repeated revisions cannot replace a newer fact", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry")])); const before = h.store.snapshot("runtime", "a");
    h.store.apply("runtime", source(1, [condition("other")])); expect(h.store.snapshot("runtime", "a")).toEqual(before);
    expect(h.changed).toHaveBeenCalledTimes(1);
  });
  it("Host expires results once and replay cannot renew their duration", () => {
    const h = make(); const outcome = { ...condition("done"), lifecycle: "outcome" as const, displayMs: 8000 };
    h.store.apply("runtime", source(1, [condition("sandbox")], { outcomes: [outcome] }));
    h.advance(7000); h.store.apply("runtime", source(1, [], { outcomes: [outcome] }));
    expect(h.items().find(item => item.code === "done")?.expiresAt).toBe(9000);
    h.advance(1001); h.store.apply("runtime", source(1, [], { outcomes: [outcome] }));
    expect(h.items().map(item => item.code)).toEqual(["sandbox"]);
  });
  it("a persistent source baseline cannot delete an unexpired outcome", () => {
    const h = make(); h.store.apply("runtime", source(1, [], { outcomes: [{ ...condition("done"), lifecycle: "outcome", displayMs: 8000 }] }));
    h.store.apply("runtime", source(2, [condition("sandbox")])); expect(h.items()).toHaveLength(2);
  });
  it("expired Host and source outcomes cannot reappear on duplicate terminal reports", () => {
    const h = make(); const outcome = { ...condition("done"), lifecycle: "outcome" as const, displayMs: 8000 };
    h.store.outcome("runtime", outcome, "a");
    h.store.apply("runtime", source(1, [], { outcomes: [outcome] }));
    h.advance(9000);
    h.store.outcome("runtime", outcome, "a");
    h.store.apply("runtime", source(2, [], { outcomes: [outcome] }));
    expect(h.items()).toEqual([]);
  });
  it("reclaims ended runtimes without permitting an old producer to recreate its owner", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry")]));
    const revision = h.store.snapshot("runtime", "a").revision;
    h.store.end("runtime");
    for (let i = 0; i < 2048; i++) expect(h.store.attach(`r-${i}`, "session")).toBe(true);
    expect(h.store.has("runtime")).toBe(false);
    expect(h.store.apply("runtime", source(2, [condition("retry")]))).toBe(false);
    expect(h.store.attach("too-many", "session")).toBe(false);
    h.store.end("r-0"); expect(h.store.attach("runtime", "session")).toBe(true);
    h.store.apply("runtime", source(0, [], { producerEpoch: "new" }));
    expect(h.store.snapshot("runtime", "a").revision).toBeGreaterThan(revision);
    expect(h.items()).toEqual([]);
  });
  it("closing a condition is device-local and a new occurrence is visible again", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry")]));
    h.store.dismiss("runtime", "a", h.items()[0]!.notificationId); expect(h.items()).toEqual([]); expect(h.items("b")).toHaveLength(1);
    h.store.apply("runtime", source(2, [])); h.store.apply("runtime", source(3, [condition("retry", "two")]));
    expect(h.items()).toHaveLength(1);
  });
  it("request submission outcomes are isolated to the initiating device", () => {
    const h = make(); h.store.apply("runtime", source(0, []));
    h.store.outcome("runtime", { ...condition("submission"), scope: { commandId: "c", requestId: "r" }, lifecycle: "outcome" }, "a");
    expect(h.items()).toHaveLength(1); expect(h.items("b")).toEqual([]);
    h.store.dismiss("runtime", "b", h.items()[0]!.notificationId); expect(h.items()).toHaveLength(1);
  });
  it("temporary source loss marks existing conditions unknown without ending them", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry")])); h.store.offline("runtime");
    expect(h.items()[0]?.verification).toBe("unknown");
    h.store.apply("runtime", source(1, [condition("retry")])); expect(h.items()[0]?.verification).toBe("confirmed");
  });
  it("a different Session cannot clear the original Session's notices", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("retry")]));
    expect(h.store.apply("runtime", source(2, [], { sessionId: "other" }))).toBe(false);
    expect(h.items()).toHaveLength(1);
  });
  it("over-capacity batches are atomic and do not report health", () => {
    const h = make(); h.store.apply("runtime", source(1, [condition("original")]));
    expect(h.store.apply("runtime", source(2, Array.from({ length: 65 }, (_, i) => condition(`problem-${i}`))))).toBe(false);
    expect(h.items().map(item => item.code)).toEqual(["original"]);
    expect(h.store.snapshot("runtime", "a").complete).toBe(false);
    h.store.apply("runtime", source(1, [])); expect(h.items()).toHaveLength(1);
  });
  it("Host restart has an independent epoch and cannot revive a past transient result", () => {
    const h = make(); const next = make(); const events: NotificationSourceEvent[] = [];
    const producer = new NotificationSource("producer", "session", event => events.push(event));
    producer.outcome({ ...condition("done"), severity: "info" }); h.store.apply("runtime", events[0]!);
    producer.announce(); next.store.apply("runtime", events[1]!);
    expect(next.items()).toEqual([]); expect(next.store.hostEpoch).not.toBe(h.store.hostEpoch);
  });
  it("schema rejects condition expiration, duplicate identities, legacy diagnostics and oversized UTF-8", () => {
    expect(RuntimeEventSchema.safeParse(source(1, [{ ...condition("retry"), displayMs: 1000 }])).success).toBe(false);
    expect(RuntimeEventSchema.safeParse(source(1, [condition("retry"), condition("retry")])).success).toBe(false);
    expect(RuntimeEventSchema.safeParse(source(1, [{ ...condition("retry"), message: "错".repeat(2000) }])).success).toBe(false);
    expect(RuntimeEventSchema.safeParse({ type: "session.patch", diagnostics: {} }).success).toBe(false);
  });
  it("bounds native text on code points and treats producer overflow as unknown", () => {
    const events: NotificationSourceEvent[] = [];
    const producer = new NotificationSource("producer", "session", event => events.push(event));
    producer.upsert({ ...condition("large"), message: "😄错".repeat(1000) });
    expect(new TextEncoder().encode(events.at(-1)!.notifications[0]!.message).length).toBeLessThanOrEqual(4096);
    expect(events.at(-1)!.notifications[0]!.message.endsWith("…")).toBe(true);
    for (let i = 0; i < 64; i++) producer.upsert(condition(`code-${i}`));
    expect(events.at(-1)).toMatchObject({ complete: false, notifications: expect.any(Array) });
    expect(events.at(-1)!.notifications).toHaveLength(64);
  });
});
