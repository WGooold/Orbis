import { describe, expect, it } from "vitest";
import type { RelayToDeviceMessage } from "@pi-remote/protocol";
import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { AgentStateSubscriptions } from "./agent-state-subscriptions.js";
import { buildAgentStateSnapshot } from "./agent-state-snapshot.js";

const scope: StateScope = { kind: "agent", key: { hostId: "h", agentKind: "pi", sessionId: "s" } };
const fact = (value: unknown, revision = 1) => ({ source: { producer: "adapter" as const, sourceId: "s", sourceEpoch: "e", sourceRevision: revision }, availability: "ready" as const, completeness: "complete" as const, value });

describe("model subscriptions", () => {
  it("publishes a committed cross-domain transaction once, scoped to its device and selected domains", async () => {
    const registry = new AgentStateRegistry();
    const received: Array<{ device: string; message: RelayToDeviceMessage }> = [];
    const subscriptions = new AgentStateSubscriptions(registry, (device, message) => received.push({ device, message }));
    subscriptions.register("a", scope, { type: "agent.state.request", requestId: "r", subscribe: true, domains: ["execution", "interactions"] });
    subscriptions.register("b", { kind: "device", key: { hostId: "h", deviceId: "b" } }, { type: "agent.state.request", requestId: "private", subscribe: true });
    registry.commitTransaction([
      { kind: "value", scope, domain: "execution", fact: fact({ phase: "idle" }) },
      { kind: "value", scope, domain: "interactions", fact: fact({}) },
      { kind: "value", scope, domain: "model", fact: fact({ id: "model" }) },
    ]);
    expect(received).toEqual([]);
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0]?.device).toBe("a");
    expect(received[0]?.message).toMatchObject({ requestId: "r", update: true,
      domains: [{ domain: "execution", projectionComplete: true }, { domain: "interactions", projectionComplete: true }] });
    subscriptions.clearDevice("a");
    registry.commitValue(scope, "execution", fact({ phase: "running" }, 2));
    await Promise.resolve();
    expect(received).toHaveLength(1);
    subscriptions.close();
  });
  it("keeps other scopes isolated and bounds subscriptions", () => {
    const registry = new AgentStateRegistry();
    const subscriptions = new AgentStateSubscriptions(registry, () => {});
    for (let i = 0; i < 8; i++) expect(subscriptions.register("a", { kind: "agent", key: { hostId: "h", agentKind: "pi", sessionId: `s${i}` } },
      { type: "agent.state.request", requestId: `r${i}`, subscribe: true })).toBe(true);
    expect(subscriptions.register("a", { kind: "host" }, { type: "agent.state.request", requestId: "full", subscribe: true })).toBe(false);
    expect(subscriptions.register("b", { kind: "host" }, { type: "agent.state.request", requestId: "other", subscribe: true })).toBe(true);
    subscriptions.close();
  });
  it("answers applied domain versions without changing content revisions", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model" });
    registry.commitValue(scope, "execution", fact({ phase: "idle" }));
    const snapshot = buildAgentStateSnapshot({ registry, scope, requestId: "read", known: [{ domain: "execution", modelEpoch: "model", revision: 1 }] });
    expect(snapshot.domains).toEqual([]);
    expect(snapshot.unchanged).toEqual(["execution"]);
    expect(registry.read(scope, "execution")?.revision).toBe(1);
  });
});
