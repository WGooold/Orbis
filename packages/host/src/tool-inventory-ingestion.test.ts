import { afterEach, describe, expect, it } from "vitest";
import { ToolInventorySource, createToolSummary, type ToolInventoryProduced } from "@orbis/protocol";
import { AgentStateRegistry } from "./agent-state-registry.js";
import { AgentToolInventory } from "./agent-tool-inventory.js";
import { ToolInventoryIngestion } from "./tool-inventory-ingestion.js";

const agent = { hostId: "host", agentKind: "codex" as const, sessionId: "s" };
const owners: AgentToolInventory[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); });
function setup() {
  const owner = new AgentToolInventory(new AgentStateRegistry()); owners.push(owner);
  const ingestion = new ToolInventoryIngestion(owner), pages: ToolInventoryProduced[] = [];
  const source = new ToolInventorySource(page => pages.push(page));
  return { owner, ingestion, source, pages };
}
const tool = (i: number) => createToolSummary({ tool: { agent, toolCallId: `t-${String(i).padStart(4, "0")}` },
  toolName: "read", order: i, phase: "finished", inputSummary: "中文".repeat(180), contents: [] });

describe("producer inventory ingestion", () => {
  it("assembles a multi-megabyte inventory privately and commits only the corresponding reference", () => {
    const { owner, source, ingestion, pages } = setup();
    const dependency = { epoch: "source", seq: 1, ready: true };
    const reference = source.prepare("runtime", dependency, Array.from({ length: 1400 }, (_, i) => tool(i)))!;
    expect(reference.summaryBytes).toBeGreaterThan(1024 * 1024);
    expect(pages.length).toBeGreaterThan(10);
    expect(() => ingestion.prepare("runtime", agent, dependency, reference)).toThrow("tool_inventory_baseline_required");
    for (const page of pages) expect(ingestion.accept("runtime", agent, page)).toBe(true);
    expect(owner.reference(agent)).toBeUndefined();
    const plan = ingestion.prepare("runtime", agent, dependency, reference);
    expect(owner.commit(plan).ok).toBe(true);
    expect(owner.reference(agent)).toEqual(reference);
    expect(owner.stats().tools).toBe(1400);
    expect(ingestion.prepare("runtime", agent, { ...dependency, seq: 2 }, reference).publication).toBeNull();
  });
  it("rejects cross-session, incomplete, duplicate and inconsistent pages without removing the committed inventory", () => {
    const { owner, source, ingestion, pages } = setup();
    const ref = source.prepare("r", { epoch: "e", seq: 1 }, [tool(0)])!;
    expect(ingestion.accept("r", { ...agent, sessionId: "other" }, pages[0]!)).toBe(false);
    expect(ingestion.accept("r", agent, pages[0]!)).toBe(true);
    expect(owner.commit(ingestion.prepare("r", agent, { epoch: "e", seq: 1 }, ref)).ok).toBe(true);
    pages.length = 0;
    const next = source.prepare("r", { epoch: "e", seq: 2 }, Array.from({ length: 200 }, (_, i) => tool(i)))!;
    expect(ingestion.accept("r", agent, pages[0]!)).toBe(true);
    expect(() => ingestion.prepare("r", agent, { epoch: "e", seq: 2 }, next)).toThrow();
    const bad = structuredClone(pages[1]!); bad.page.startIndex = 0;
    expect(ingestion.accept("r", agent, bad)).toBe(false);
    expect(owner.reference(agent)).toEqual(ref);
  });
});
