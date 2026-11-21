// ADR-0095: native storage, not the Codex UI/runtime label, defines catalog identity.
import { describe, expect, it } from "vitest";
import type { AgentSessionSummary } from "@orbis/protocol";
import { CodexHistoryCatalog, type CodexHistoryRead } from "./codex-history-catalog.js";

const row = (sessionId: string, kind: "codex" | "codexDesktop" = "codex"): AgentSessionSummary => ({
  sessionId, cwd: "/fixture", createdAt: 1, modifiedAt: 2, messageCount: 3, agentKind: kind, hostname: "host",
});
const read = (kind: "codex" | "codexDesktop", store: string, sessions: AgentSessionSummary[], complete = true): CodexHistoryRead => ({
  kind, store,
  active: { sessions, complete },
  archived: { sessions: [], complete },
});

describe("CodexHistoryCatalog", () => {
  it("merges equal thread IDs only inside the same confirmed native store", () => {
    const catalog = new CodexHistoryCatalog("host-a");
    const merged = catalog.update([
      read("codex", "/home/a/.codex", [row("thread-1")]),
      read("codexDesktop", "/home/a/.codex", [row("thread-1", "codexDesktop")]),
      read("codex", "/home/b/.codex", [row("thread-1")]),
    ], new Set(["codex", "codexDesktop"]));

    expect(merged.sessions).toHaveLength(2);
    expect(new Set(merged.sessions.map(session => session.sessionId)).size).toBe(2);
    expect(merged.sessions.every(session => session.agentKind === "codex")).toBe(true);
    const firstStore = catalog.id("/home/a/.codex", "thread-1");
    const secondStore = catalog.id("/home/b/.codex", "thread-1");
    expect(firstStore).not.toBe(secondStore);
    expect(catalog.route(firstStore)).toMatchObject({ store: "/home/a/.codex", threadId: "thread-1", archived: false });
    expect(catalog.route(secondStore)).toMatchObject({ store: "/home/b/.codex", threadId: "thread-1", archived: false });
    expect(merged.sessions.find(session => session.sessionId === firstStore)?.codexLaunchModes).toEqual(["desktop", "terminal"]);
  });

  it("retains previously verified launch routes across a partial source failure but honors disablement", () => {
    const catalog = new CodexHistoryCatalog("host-a");
    const initial = catalog.update([
      read("codex", "/home/a/.codex", [row("thread-1")]),
      read("codexDesktop", "/home/a/.codex", [row("thread-1", "codexDesktop")]),
    ], new Set(["codex", "codexDesktop"]));
    const id = catalog.id("/home/a/.codex", "thread-1");
    expect(initial.sessions[0]?.codexLaunchModes).toEqual(["desktop", "terminal"]);

    const partial = catalog.update([
      read("codex", "/home/a/.codex", [], false),
      read("codexDesktop", "/home/a/.codex", [], false),
    ], new Set(["codex", "codexDesktop"]));
    expect(partial.complete).toBe(false);
    expect(partial.sessions.find(session => session.sessionId === id)?.codexLaunchModes).toEqual(["desktop", "terminal"]);

    const disabled = catalog.update([read("codex", "/home/a/.codex", [row("thread-1")])], new Set(["codex"]));
    expect(disabled.sessions.find(session => session.sessionId === id)?.codexLaunchModes).toEqual(["terminal"]);
  });

  it("retains last verified rows when a later store read is incomplete", () => {
    const catalog = new CodexHistoryCatalog("host-a");
    const initial = catalog.update([read("codex", "/home/a/.codex", [row("thread-1")])], new Set(["codex"]));
    expect(initial.complete).toBe(true);
    const stale = catalog.update([read("codex", "/home/a/.codex", [], false)], new Set(["codex"]));
    expect(stale.complete).toBe(false);
    expect(stale.sessions.map(session => session.sessionId)).toEqual([catalog.id("/home/a/.codex", "thread-1")]);
  });
});
