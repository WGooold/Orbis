import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LIVE_ACTIVITY_AGENT_KINDS, type AgentExecutionState, type AgentKey, type AgentKind } from "@orbis/protocol";

import { AgentStateRegistry, type RegistryMutation } from "./agent-state-registry.js";
import { LiveActivityPublisher, liveActivityFocusKey, type LiveActivityUpdateRequest } from "./live-activity.js";

const hostId = "host-1";
const key = (sessionId: string, agentKind: AgentKind = "codex"): AgentKey => ({ hostId, sessionId, agentKind });
const execution = (phase: AgentExecutionState["phase"], turnId = "turn-1", startedAt = 1_800_000_000_000,
  waitingFor: string[] = []): AgentExecutionState => ({ phase, waitingFor, retry: "unavailable", compaction: "unavailable", turn: { turnId, startedAt } });

function setup(over: { send?: (request: LiveActivityUpdateRequest, signal: AbortSignal) => Promise<number> } = {}) {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
  const registry = new AgentStateRegistry();
  const sent: LiveActivityUpdateRequest[] = [];
  const sessions: number[] = [];
  const publisher = new LiveActivityPublisher({ registry, hostId, relayUrl: "wss://relay.test", credential: "host-secret", producerId: "producer-1",
    send: async (request, signal, sessionCount) => { sent.push(structuredClone(request)); sessions.push(sessionCount); return over.send?.(request, signal) ?? 200; } });
  let revision = 0;
  const write = (agent: AgentKey, value: AgentExecutionState, availability: "ready" | "unknown" = "ready", outcome?: "completed" | "failed" | "cancelled" | "unknown") => {
    const scope = { kind: "agent" as const, key: agent };
    const source = { producer: "adapter" as const, sourceId: "live-test", sourceEpoch: "epoch-1", sourceRevision: ++revision };
    const changes: RegistryMutation[] = [
      { kind: "value", scope, domain: "availability", fact: { source, availability, completeness: "complete", value: { connected: true, runtimeId: "runtime-private" } } },
      { kind: "value", scope, domain: "execution", fact: { source, availability, completeness: "complete", value } },
    ];
    if (outcome) changes.push({ kind: "value", scope, domain: "live", fact: { source, availability: "ready", completeness: "complete",
      value: { complete: true, turn: { ...value.turn, outcome }, messages: [{ text: "private response" }], tools: [] } } });
    expect(registry.commitTransaction(changes).ok).toBe(true);
  };
  const flush = async (ms = 0) => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(ms); };
  return { registry, sent, sessions, publisher, write, flush };
}

afterEach(() => { vi.useRealTimers(); });

describe("Host Live Activity summary", () => {
  // LA-H01: iOS can reproduce this exact opaque routing key without disclosing titles,
  // paths, raw session IDs, or text to Relay/APNs; include UTF-8 and unescaped slashes.
  it("uses a deterministic compact JSON tuple for opaque focus identities", () => {
    expect(liveActivityFocusKey(key("session-1"))).toBe("9b186ae3903a7fca4b329f0c5c8212c19ca73aac965585a0630ce9a6322e63ea");
    expect(liveActivityFocusKey({ hostId: "host/一", agentKind: "claude", sessionId: "会话/\"1" }))
      .toBe("1a11052bd1a0f438e5415cac6707b763bf61dc9698fd9f0134610f9f4d212a4c");
    expect(liveActivityFocusKey(key("session-1", "codexDesktop"))).not.toBe(liveActivityFocusKey(key("session-1")));
  });

  // LA-H02: count sessions, not subtasks; approvals take focus and their request count
  // cannot be confused with running sessions. Publishing is independent of phone links.
  it("aggregates committed sessions and prioritizes pending requests without private content", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    h.write(key("s1"), execution("running"));
    h.write(key("s2", "claude"), { ...execution("running"), tasks: { availability: "ready", truncated: false,
      items: [{ id: "private-child", title: "private title", kind: "agent", status: "running" }] } });
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.contentState).toMatchObject({ phase: "running", runningCount: 2, pendingCount: 0, outcome: null });
    h.write(key("s3", "pi"), execution("waiting_local_interaction", "t3", 1_800_000_000_000, ["secret-request-a", "secret-request-b"]));
    await h.flush();
    expect(h.sent.at(-1)?.contentState).toMatchObject({ phase: "attention", runningCount: 2, pendingCount: 2,
      agentKind: "pi", focusKey: liveActivityFocusKey(key("s3", "pi")) });
    const serialized = JSON.stringify(h.sent);
    for (const forbidden of ["private title", "private-child", "secret-request", "runtime-private", "host-secret", '"sessionId"']) expect(serialized).not.toContain(forbidden);
    await h.publisher.close();
  });

  // The native seed and Host count the same sources, independently of the v1 wire subset.
  it("keeps iOS and Host activity sources aligned", () => {
    const source = readFileSync(new URL("../../../ios/Orbis/Orbis/LiveActivityAttributes.swift", import.meta.url), "utf8");
    const declaration = source.match(/static let agentKinds: Set<String> = (\[.+\])/u);
    expect(declaration).not.toBeNull();
    expect(JSON.parse(declaration![1]!)).toEqual([...LIVE_ACTIVITY_AGENT_KINDS]);
  });

  it.each([["openclaw", "codex"], ["hermes", "opencode"], ["hermes", "claude"], ["kimiCode", "pi"]] as const)("excludes %s rather than losing or skewing the %s activity", async (excluded, included) => {
    const h = setup();
    h.publisher.setConnected(true);
    h.write(key("excluded", excluded), execution("waiting_local_interaction"));
    await h.flush();
    expect(h.sent).toEqual([]);
    h.write(key("existing", included), execution("running"));
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.contentState).toMatchObject({ phase: "running", agentKind: included === "opencode" ? null : included, runningCount: 1, pendingCount: 0 });
    await h.publisher.close();
  });

  // LA-COMPAT-01: an OpenCode-only batch still has an identity, count, and terminal update.
  it("publishes OpenCode activity with the released v1 generic kind", async () => {
    const h = setup(); h.publisher.setConnected(true);
    const agent = key("open", "opencode");
    h.write(agent, execution("waiting_local_interaction", "turn", Date.now(), ["approval"]));
    await h.flush();
    expect(h.sent[0]?.contentState).toMatchObject({ phase: "attention", agentKind: null,
      focusKey: liveActivityFocusKey(agent), pendingCount: 1 });
    h.write(agent, execution("idle"), "ready", "completed");
    await h.flush(250);
    expect(h.sent.at(-1)).toMatchObject({ event: "end", contentState: { phase: "ended", agentKind: null } });
    const release = process.env.ORBIS_LIVE_ACTIVITY_REFERENCE_RUNTIME;
    if (release) {
      const nativeImport = createRequire(import.meta.url)("../../../scripts/test-fixtures/import-native.cjs") as
        (file: string) => Promise<{ parseLiveActivityUpdate: (value: unknown) => unknown }>;
      const released = await nativeImport(pathToFileURL(join(release, "packages/relay/dist/live-activities.js")).href);
      for (const sent of h.sent) expect(released.parseLiveActivityUpdate(sent)).toEqual(sent);
    }
    await h.publisher.close();
  });

  // Clearing the last request is immediate, and two requests on one session
  // must not look like two sessions in the compact activity.
  it("publishes the approval-clear edge without the ordinary 30-second delay", async () => {
    const h = setup(); h.publisher.setConnected(true);
    h.write(key("focus"), execution("waiting_local_interaction", "turn", Date.now(), ["a", "b"]));
    await h.flush();
    expect(h.sessions).toEqual([1]);
    expect(h.sent[0]!.contentState).toMatchObject({ phase: "attention", pendingCount: 2 });
    h.write(key("focus"), execution("running", "turn"));
    await h.flush();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.contentState).toMatchObject({ phase: "running", pendingCount: 0 });
    expect(h.sent[1]!.contentState).not.toHaveProperty("sessionCount");
    await h.publisher.close();
  });

  // LA-H03: tool/stream churn must not spend APNs budget. Ordinary count changes
  // collapse to the latest value, and elapsed minutes are rendered on-device.
  it("coalesces ordinary changes and only renews quiet activity freshness every four minutes", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    h.write(key("s1"), execution("running"));
    await h.flush();
    h.write(key("s2"), execution("running"));
    h.write(key("s3"), execution("running"));
    await h.flush(29_999);
    expect(h.sent).toHaveLength(1);
    await h.flush(1);
    expect(h.sent).toHaveLength(2);
    expect(h.sent.at(-1)?.contentState.runningCount).toBe(3);
    for (let index = 0; index < 25; index++) h.write(key("s1"), { ...execution("running"), retry: { phase: "running", attempt: index } });
    await h.flush(209_999);
    expect(h.sent).toHaveLength(2);
    await h.flush(1);
    expect(h.sent).toHaveLength(3);
    expect(h.sent.at(-1)?.revision).toBe(3);
    expect(h.sent.at(-1)!.contentState.updatedAt).toBeGreaterThan(h.sent[1]!.contentState.updatedAt);
    await h.publisher.close();
  });

  // LA-H04: reconnect/startup gaps cannot claim success. A source that becomes
  // unknown is stale, while only a matching native turn outcome proves completion.
  it("does not end an empty startup or turn an unknown source into completion", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    h.write(key("idle"), execution("idle"));
    await h.flush();
    expect(h.sent).toHaveLength(0);
    h.write(key("s1"), execution("running"));
    await h.flush();
    h.write(key("s1"), execution("running"), "unknown");
    await h.flush();
    expect(h.sent.at(-1)).toMatchObject({ event: "update", contentState: { phase: "stale", outcome: null } });
    h.write(key("s1"), execution("idle"));
    await h.flush(250);
    expect(h.sent.at(-1)).toMatchObject({ event: "end", contentState: { phase: "ended", outcome: "unknown" } });
    await h.publisher.close();
  });

  // LA-H05: failed/cancelled turns and mixed batches retain their own outcomes;
  // a later successful batch cannot inherit an earlier failure.
  it("uses explicit matching terminal evidence and resets it for the next batch", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    h.write(key("s1"), execution("running"));
    h.write(key("s2"), execution("running", "turn-2"));
    await h.flush();
    h.write(key("s1"), execution("idle"), "ready", "failed");
    h.write(key("s2"), execution("idle", "turn-2"), "ready", "completed");
    await h.flush(250);
    expect(h.sent.at(-1)?.contentState.outcome).toBe("failed");
    h.write(key("s1"), execution("running", "turn-3"));
    await h.flush(30_000);
    h.write(key("s1"), execution("idle", "turn-3"), "ready", "completed");
    await h.flush(250);
    expect(h.sent.at(-1)).toMatchObject({ event: "end", contentState: { outcome: "completed" } });
    h.write(key("s1"), execution("idle", "turn-3"), "ready", "completed");
    await h.flush(30_000);
    expect(h.sent.at(-1)?.contentState.outcome).toBe("completed");
    await h.publisher.close();
  });

  // LA-H06: source reset and service shutdown report uncertainty instead of a
  // fabricated success, and disposed subscriptions cannot resume push traffic.
  it("marks model reset and shutdown stale and stops all publication afterward", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    h.write(key("s1"), execution("running"));
    await h.flush();
    h.registry.beginModelEpoch();
    await h.flush();
    expect(h.sent.at(-1)?.contentState.phase).toBe("stale");
    await h.publisher.close();
    const count = h.sent.length;
    h.publisher.setConnected(true);
    h.write(key("s2"), execution("running"));
    await h.flush(300_000);
    expect(h.sent).toHaveLength(count);
  });

  // LA-H07: the new HTTP endpoint is optional. Missing endpoint responses are
  // terminal until the next authenticated connection, avoiding retry spam.
  it.each([404, 501, 409])("silently disables unsupported or mismatched Relay (%s) until reconnect", async status => {
    const h = setup({ send: async () => status });
    h.publisher.setConnected(true);
    h.write(key("s1"), execution("running"));
    await h.flush();
    h.write(key("s2"), execution("waiting_local_interaction", "turn-2", 1_800_000_000_000, ["r1"]));
    await h.flush(900_000);
    expect(h.sent).toHaveLength(1);
    h.publisher.setConnected(false); h.publisher.setConnected(true);
    await h.flush();
    expect(h.sent).toHaveLength(2);
    await h.publisher.close();
  });

  // LA-H08: one in-flight request owns its complete lifetime. A delayed running
  // summary cannot overtake a later approval; the newest intent drains afterward.
  it("serializes delayed HTTP and sends the newest pending state next", async () => {
    let finish: ((status: number) => void) | undefined;
    const h = setup({ send: () => new Promise(resolve => { finish = resolve; }) });
    h.publisher.setConnected(true);
    h.write(key("s1"), execution("running"));
    await h.flush();
    expect(h.sent).toHaveLength(1);
    h.write(key("s2"), execution("waiting_local_interaction", "turn-2", 1_800_000_000_000, ["r1"]));
    await h.flush();
    expect(h.sent).toHaveLength(1);
    finish!(200);
    await h.flush();
    expect(h.sent).toHaveLength(2);
    expect(h.sent.at(-1)?.contentState.phase).toBe("attention");
    finish!(200);
    await h.flush();
    h.publisher.setConnected(false);
    await h.publisher.close();
  });

  // LA-H09: an old socket's late 404 must not turn off a newly connected Relay.
  // Only the current connection generation owns support and acknowledgement state.
  it("ignores late unsupported replies from the previous connection", async () => {
    let finish: ((status: number) => void) | undefined;
    let calls = 0;
    const h = setup({ send: () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(200) });
    h.publisher.setConnected(true);
    h.write(key("s1"), execution("running"));
    await h.flush();
    h.publisher.setConnected(false); h.publisher.setConnected(true);
    await h.flush();
    finish!(404);
    await h.flush();
    expect(h.sent).toHaveLength(2);
    h.write(key("s2"), execution("waiting_local_interaction", "turn-2", 1_800_000_000_000, ["r1"]));
    await h.flush();
    expect(h.sent.at(-1)?.contentState.phase).toBe("attention");
    await h.publisher.close();
  });

  // LA-H10 / S60: idle parents with confirmed active agents count once as a
  // working session. Shell/monitor commands do not keep the activity running.
  it("counts idle parent agent work but excludes shell and monitor-only work", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    const withTasks = (items: NonNullable<AgentExecutionState["tasks"]>["items"]): AgentExecutionState => ({
      ...execution("idle"), tasks: { availability: "ready", truncated: false, items },
    });
    const agent = { id: "child", title: "Review", kind: "agent", status: "running" as const };
    const shell = { id: "shell", title: "Server", kind: "shell", status: "running" as const };
    const monitor = { id: "monitor", title: "Watch", kind: "monitor", status: "waiting" as const };
    h.write(key("s1", "claude"), withTasks([agent, shell, monitor]));
    h.write(key("s2", "claude"), withTasks([shell, monitor]));
    await h.flush();
    expect(h.sent.at(-1)?.contentState).toMatchObject({ phase: "running", runningCount: 1, pendingCount: 0 });
    h.write(key("s1", "claude"), withTasks([{ ...agent, status: "completed" }, shell, monitor]));
    await h.flush(250);
    expect(h.sent.at(-1)).toMatchObject({ event: "end", contentState: { runningCount: 0, outcome: "unknown" } });
    await h.publisher.close();
  });

  // LA-H11: losing an inventory cannot fabricate completion of previously
  // observed child agents; only a complete replacement can clear their work.
  it("marks background-agent work stale when its inventory loses confirmation", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    const child = { id: "child", title: "Review", kind: "agent", status: "running" as const };
    const parent = (availability: "ready" | "unknown", truncated = false): AgentExecutionState => ({
      ...execution("idle"), tasks: { availability, truncated, items: [child] },
    });
    h.write(key("s1", "claude"), parent("ready"));
    await h.flush();
    h.write(key("s1", "claude"), parent("unknown", true));
    await h.flush();
    expect(h.sent.at(-1)).toMatchObject({ event: "update", contentState: { phase: "stale", outcome: null } });
    h.write(key("s1", "claude"), { ...execution("idle"), tasks: { availability: "ready", truncated: false, items: [] } });
    await h.flush(250);
    expect(h.sent.at(-1)?.event).toBe("end");
    await h.publisher.close();
  });

  // LA-H12: a parent's successful terminal turn is not success evidence for
  // asynchronous agents that continued afterward and may have failed separately.
  it("does not reuse parent success for an activity prolonged by background agents", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    const child = { id: "child", title: "Review", kind: "agent", status: "running" as const };
    h.write(key("s1", "claude"), { ...execution("idle"), tasks: { availability: "ready", truncated: false, items: [child] } }, "ready", "completed");
    await h.flush();
    h.write(key("s1", "claude"), { ...execution("idle"), tasks: { availability: "ready", truncated: false, items: [{ ...child, status: "failed" }] } }, "ready", "completed");
    await h.flush(250);
    expect(h.sent.at(-1)).toMatchObject({ event: "end", contentState: { outcome: "unknown" } });
    await h.publisher.close();
  });

  // LA-H13: an adapter on another clock can give a future startedAt. The
  // summary remains valid by omitting elapsed time rather than forging an origin.
  it("omits future or malformed source start times without losing running state", async () => {
    const h = setup();
    h.publisher.setConnected(true);
    for (const startedAt of [Date.now() + 300_000, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
      h.write(key("s1"), execution("running", "turn-1", startedAt));
      await h.flush(30_000);
      expect(h.sent.at(-1)?.contentState).toMatchObject({ phase: "running", runningCount: 1, startedAt: null });
    }
    h.write(key("s1"), execution("running", "turn-1", Date.now() - 60_000));
    await h.flush(30_000);
    expect(h.sent.at(-1)?.contentState.startedAt).toBeLessThanOrEqual(h.sent.at(-1)!.contentState.updatedAt);
    expect(h.sent.at(-1)?.contentState.startedAt).not.toBeNull();
    await h.publisher.close();
  });
});
