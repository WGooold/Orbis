import { expect, it } from "vitest";
import { AgentEnablementUpdateSchema, AgentEnablementWriteSchema } from "./agent-enablement.js";
import { AgentKindSchema } from "./agent-state.js";

// Settings can present rows from newer Hosts without loosening strict session routing schemas.
it("allows new source labels in settings only", () => {
  const kind = "futureAgent";
  const update = { type: "agent.enablement.snapshot", snapshot: { revision: 0, agents: [{ kind, label: "Future Agent", enabled: false }] } };
  expect(AgentEnablementUpdateSchema.parse(update)).toEqual(update);
  expect(AgentKindSchema.safeParse(kind).success).toBe(false);
});

// The management action can only change a revisioned boolean, not edit credentials or install tools.
it("rejects writes without a safe revision or outside the boolean setting", () => {
  const write = { type: "agent.enablement.write", requestId: "mobile:1", kind: "openclaw", enabled: true, expectedRevision: 2 };
  expect(AgentEnablementWriteSchema.parse(write)).toEqual(write);
  for (const invalid of [{ expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { enabled: "true" }, { token: "unexpected" }]) {
    expect(AgentEnablementWriteSchema.safeParse({ ...write, ...invalid }).success).toBe(false);
  }
});
