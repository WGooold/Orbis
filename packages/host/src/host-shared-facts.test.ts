import { describe, expect, it } from "vitest";
import type { HostWorkspacesState } from "@pi-remote/protocol";
import { AgentStateRegistry } from "./agent-state-registry.js";
import { HostStateFacts } from "./host-state-facts.js";

describe("Host shared model services", () => {
  it("rechecks all service domains without advancing unchanged content revisions", () => {
    let now = 10;
    const registry = new AgentStateRegistry({ modelEpoch: "one", now: () => ++now });
    const facts = new HostStateFacts({ registry, now: () => ++now });
    const publish = () => {
      facts.identity({ hostId: "host", hostName: "Host", protocolVersion: 13 });
      facts.backends({ backends: [{ kind: "pi", ready: true, launchable: true, runtimeCount: 1, reason: null }] });
      facts.workspaces({ workspaces: [], truncated: false }); facts.files({ files: [], truncated: false });
      facts.operations({ activationsPending: 0, commandsPending: 1, sync: { records: 0, pending: 0, active: 0, reservedBytes: 0 }, transfers: { uploads: 0, downloads: 0 }, retentionMs: 300_000 });
      facts.connections({ pairedDevices: 2, connectedDevices: 1, paths: [{ kind: "lan", attachedDevices: 1, activeDevices: 1 }], relayState: "connected", sequenceChannels: 2 });
      facts.management({ lifecycle: "running", platform: "win32", nodeVersion: "v22", backends: [{ kind: "pi", installed: null, version: null }] });
      facts.catalog({ totalSessions: 0, truncated: false, backends: [] });
      facts.providers({ providers: [{ agentKind: "pi", current: null, profiles: [], authenticated: null, switching: null, usage: { availability: "unknown", detail: null } }] });
      facts.diagnostics({ records: 0, dropped: 0, persistFailures: 0, oldestAt: null, newestAt: null });
    };
    publish(); const first = registry.snapshot({ kind: "host" }); publish();
    const second = registry.snapshot({ kind: "host" });
    expect(second.map(entry => entry.domain).sort()).toEqual(["backends", "catalog", "connections", "diagnostics", "files", "identity", "management", "operations", "providers", "workspaces"]);
    for (const entry of second) {
      const previous = first.find(candidate => candidate.domain === entry.domain)!;
      expect(entry.state.revision).toBe(previous.state.revision);
      expect(entry.state.checkedAt).toBeGreaterThan(previous.state.checkedAt);
      expect(entry.state.source.sourceRevision).toBe(previous.state.source.sourceRevision);
    }
  });

  it("partial inventories and failed reads retain last confirmed members; complete inventories remove absences", () => {
    const registry = new AgentStateRegistry(); const facts = new HostStateFacts({ registry });
    const workspace = (workspaceId: string): HostWorkspacesState["workspaces"][number] => ({ workspaceId, cwd: `D:/${workspaceId}`, sessionCount: 1,
      git: { availability: "unknown", branch: null, head: null, repoRoot: null } });
    facts.workspaces({ workspaces: [workspace("a")], truncated: false });
    facts.workspaces({ workspaces: [workspace("b")], truncated: true });
    expect(facts.readDomain<HostWorkspacesState>("workspaces")?.workspaces.map(value => value.workspaceId)).toEqual(["a", "b"]);
    facts.unknown("workspaces");
    expect(registry.read({ kind: "host" }, "workspaces")).toMatchObject({ availability: "unknown", completeness: "unknown", value: { workspaces: [workspace("a"), workspace("b")] } });
    facts.workspaces({ workspaces: [workspace("b")], truncated: false });
    expect(facts.readDomain<HostWorkspacesState>("workspaces")?.workspaces.map(value => value.workspaceId)).toEqual(["b"]);
  });

  it("rejects private or unbounded fields without changing the current service projection", () => {
    const registry = new AgentStateRegistry(); const facts = new HostStateFacts({ registry });
    facts.identity({ hostId: "h", hostName: "Host", protocolVersion: 13 });
    expect(facts.identity({ hostId: "h", hostName: "Host", protocolVersion: 13, privateRaw: "secret" } as never)).toMatchObject({ ok: false, code: "invalid_fact" });
    expect(facts.readDomain("identity")).toEqual({ hostId: "h", hostName: "Host", protocolVersion: 13 });
    expect(facts.backends({ backends: Array.from({ length: 17 }, () => ({ kind: "pi", ready: true, launchable: true, runtimeCount: 0, reason: null })) })).toMatchObject({ ok: false, code: "invalid_fact" });
  });
});
