import { describe, expect, it } from "vitest";

import { AgentStateRegistry } from "./agent-state-registry.js";
import { HostStateFacts } from "./host-state-facts.js";

const directory = (over: Partial<Parameters<HostStateFacts["diagnostics"]>[0]> = {}) => ({
  records: 3,
  dropped: 0,
  persistFailures: 0,
  oldestAt: 1_700_000_000_000,
  newestAt: 1_700_000_001_000,
  ...over,
});

describe("HostStateFacts.diagnostics", () => {
  it("把条数与保留窗口写进 HostState.diagnostics，并带上核对时点", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry, now: () => 1_700_000_002_000 });

    facts.diagnostics(directory());

    expect(facts.readDiagnostics()).toMatchObject({ records: 3, dropped: 0, checkedAt: 1_700_000_002_000 });
    expect(registry.read({ kind: "host" }, "diagnostics")?.availability).toBe("ready");
  });

  it("没有记录是事实：ready + complete，而不是 unknown", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry });

    facts.diagnostics(directory({ records: 0, oldestAt: null, newestAt: null }));

    const state = registry.read({ kind: "host" }, "diagnostics");
    expect(state?.availability).toBe("ready");
    expect(state?.completeness).toBe("complete");
  });

  it("淘汰过或落盘失败过就是 partial：手里那份不是全部历史", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry });

    facts.diagnostics(directory({ dropped: 1 }));
    expect(facts.readDiagnostics()).toMatchObject({ dropped: 1 });
    expect(registry.read({ kind: "host" }, "diagnostics")?.completeness).toBe("partial");

    facts.diagnostics(directory({ persistFailures: 2 }));
    expect(registry.read({ kind: "host" }, "diagnostics")?.completeness).toBe("partial");
  });

  it("计数不变时不推进领域版本", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry, now: () => 1 });
    const scope = { kind: "host" } as const;

    facts.diagnostics(directory());
    const first = registry.read(scope, "diagnostics")?.revision;
    facts.diagnostics(directory());

    expect(registry.read(scope, "diagnostics")?.revision).toBe(first);
  });
});
