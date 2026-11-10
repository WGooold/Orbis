import { describe, expect, it } from "vitest";
import { APNsSender } from "./apns.js";

const sender = () => new APNsSender({ keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", bundleId: "com.example.app", privateKey: "not-used", environment: "sandbox" });

describe("APNsSender", () => {
  it("rejects invalid provider identity before opening a connection", () => {
    expect(() => new APNsSender({ keyId: "bad", teamId: "KLMNOPQRST", bundleId: "com.example.app", privateKey: "", environment: "sandbox" })).toThrow("Key ID");
    expect(() => new APNsSender({ keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", bundleId: "bad bundle", privateKey: "", environment: "sandbox" })).toThrow("bundle ID");
  });

  it("validates token and event identity before attempting APNs", async () => {
    await expect(sender().send("not-a-token", { category: "task-completed", eventId: "event-1", hostId: "host-1" })).rejects.toThrow("device token");
    await expect(sender().send("a".repeat(64), { category: "task-completed", eventId: "with spaces", hostId: "host-1" })).rejects.toThrow("event ID");
  });
});
