import { describe, expect, it } from "vitest";
import { AgentTaskInventorySchema } from "@orbis/protocol";
import { dshAgentTasks } from "./dsh-agent-tasks.js";

const child = (id: string, parentSessionId = "root", running = true) => ({ sessionId: id, origin: "subagent", parentSessionId, agentAvailable: true, running });
const rows = (...items: ReturnType<typeof child>[]) => new Map(items.map(item => [item.sessionId, item]));

// S33 / SC52: use registry evidence only, without leaking prompts or inventing outcomes.
describe("DSH task projection", () => {
  it("projects nested children into their root and excludes siblings and cycles", () => {
    const tasks = dshAgentTasks("root", rows(child("a"), child("b", "a", false), child("other", "elsewhere"), child("cycle", "cycle")));
    expect(tasks).toEqual({ availability: "unknown", truncated: true, items: [
      { id: "a", title: "Subagent", kind: "subagent", status: "running" },
      { id: "b", parentId: "a", title: "Subagent", kind: "subagent", status: "idle" },
    ] });
    expect(AgentTaskInventorySchema.safeParse(tasks).success).toBe(true);
  });
  it("keeps removed children as unknown and never interprets idle as completed", () => {
    const previous = dshAgentTasks("root", rows(child("a")));
    expect(dshAgentTasks("root", rows(), previous).items[0]?.status).toBe("unknown");
    expect(dshAgentTasks("root", rows(child("a", "root", false)), previous).items[0]?.status).toBe("idle");
    expect(dshAgentTasks("root", rows()).availability).toBe("unknown");
  });
  it("sends only short display fields even if native rows contain prompts and outputs", () => {
    const row = { ...child("a"), prompt: "private prompt", output: "private output" };
    const tasks = dshAgentTasks("root", new Map([[row.sessionId, row]]), undefined, () => "x".repeat(500));
    expect(Object.keys(tasks.items[0]!).sort()).toEqual(["id", "kind", "status", "title"]);
    expect(tasks.items[0]?.title).toHaveLength(80);
    expect(JSON.stringify(tasks)).not.toContain("private");
  });
});
