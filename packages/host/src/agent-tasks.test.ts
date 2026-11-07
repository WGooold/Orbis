import { describe, expect, it } from "vitest";
import { AgentTaskInventorySchema, type AgentTask } from "@orbis/protocol";
import { agentTaskInventory, mergeAgentTaskInventory } from "./agent-tasks.js";

const task = (id: string, status: AgentTask["status"] = "running"): AgentTask => ({ id, title: id, kind: "subagent", status });

// S33 / SC52: every native adapter shares identity, bounds and missing-evidence rules.
describe("Host agent task inventory", () => {
  it("deduplicates and sorts stable identities, with the latest explicit state winning", () => {
    expect(agentTaskInventory([task("b"), task("a"), task("b", "completed")])).toEqual({
      availability: "ready", truncated: false, items: [task("a"), task("b", "completed")],
    });
  });
  it("bounds inventory without declaring a truncated list complete", () => {
    const inventory = agentTaskInventory(Array.from({ length: 257 }, (_, i) => task(String(i))));
    expect(inventory).toMatchObject({ availability: "unknown", truncated: true });
    expect(inventory.items).toHaveLength(256);
    expect(AgentTaskInventorySchema.safeParse(inventory).success).toBe(true);
  });
  it("prioritizes new partial facts at the display bound and strips long display text", () => {
    const previous = agentTaskInventory(Array.from({ length: 256 }, (_, i) => task(`old-${i}`)));
    const incoming = agentTaskInventory([Object.assign({ ...task("zz-new", "failed"), title: "x".repeat(500), kind: "k".repeat(500) },
      { prompt: "private prompt", description: "private description", result: "private result" })], "unknown", true);
    const merged = mergeAgentTaskInventory(previous, incoming);
    expect(merged.items).toHaveLength(256);
    expect(JSON.stringify(merged)).not.toContain("private");
    expect(Object.keys(incoming.items[0]!).sort()).toEqual(["id", "kind", "status", "title"]);
    expect(merged.items.find(item => item.id === "zz-new")).toMatchObject({ status: "failed", title: "x".repeat(80), kind: "k".repeat(48) });
  });
  it("retains failed-read evidence but merges explicit incomplete updates and deletes only on complete snapshots", () => {
    const previous = agentTaskInventory([task("a"), task("b")]);
    expect(mergeAgentTaskInventory(previous, agentTaskInventory([], "unknown"))).toEqual({ ...previous, availability: "unknown" });
    expect(mergeAgentTaskInventory(previous, agentTaskInventory([task("b", "completed"), task("c")], "unknown", true))).toEqual({
      availability: "unknown", truncated: true, items: [task("a"), task("b", "completed"), task("c")],
    });
    expect(mergeAgentTaskInventory(previous, agentTaskInventory([])).items).toEqual([]);
    const stale = mergeAgentTaskInventory(previous, agentTaskInventory([], "unknown"));
    expect(mergeAgentTaskInventory(stale, agentTaskInventory([task("a")], "unknown", true)).items).toEqual([task("a"), task("b", "unknown")]);
    const partial = agentTaskInventory([task("a")], "unknown", true);
    expect(mergeAgentTaskInventory(partial, agentTaskInventory([], "unknown"))).toEqual({ ...partial, truncated: false });
  });
});
