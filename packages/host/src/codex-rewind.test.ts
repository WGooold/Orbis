import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, SessionSyncRequest } from "@pi-remote/protocol";

import type { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Item = Record<string, unknown> & { id: string };

const user = (id: string): Item => ({
  id,
  type: "userMessage",
  content: [{ type: "text", text: id }],
});

const reply = (id: string, text = id): Item => ({ id, type: "agentMessage", text });

function harness() {
  const root = mkdtempSync(join(tmpdir(), "orbis-codex-rewind-"));
  roots.push(root);
  const events: RuntimeEvent[] = [];
  let retainedTurns: unknown[] = [];
  const request = vi.fn(async (method: string) => {
    if (method === "thread/resume") return { thread: { id: "session", cwd: "D:/repo", turns: [] } };
    if (method === "thread/revert") return { thread: { id: "session", cwd: "D:/repo", turns: [] } };
    if (method === "thread/turns/list") return { data: retainedTurns };
    return { data: [] };
  });
  const server = { request, notify: vi.fn() } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, rolloutRoot: root, onEvent: event => events.push(event) });
  const notify = (method: string, params: unknown) => {
    (server.onNotification as (name: string, value: unknown) => void)(method, params);
  };
  const activate = () => runtime.activate({ type: "resume", sessionId: "session" });
  const sync = (options: Partial<SessionSyncRequest> = {}) => {
    const start = events.length;
    runtime.handleCommand({ type: "session.sync", sessionId: "session", syncId: "sync", range: "preview", ...options }, "sync", "session");
    return events.slice(start).find(event => event.type === "session.snapshot");
  };
  const tree = async (entryId: string) => {
    runtime.handleCommand({ type: "slash.execute", name: "tree", args: entryId }, "tree", "session");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "command.result", commandId: "tree", ok: true, status: "success",
    })));
  };
  return {
    runtime, request, events, notify, activate, sync, tree,
    setTurns: (turns: unknown[]) => { retainedTurns = turns; },
  };
}

function complete(h: ReturnType<typeof harness>, turnId: string, ...items: Item[]) {
  for (const item of items) h.notify("item/started", { threadId: "session", turnId, item });
  for (const item of items) h.notify("item/completed", { threadId: "session", turnId, item });
}

describe("Codex tree replay", () => {
  it("keeps retained parents when turns/list returns a different completion order", async () => {
    const h = harness();
    await h.activate();
    const a = reply("a");
    const b = reply("b");
    const c = reply("c");
    const nextTurn = reply("next");
    complete(h, "turn-1", a, b, c);
    complete(h, "turn-2", nextTurn);
    const before = h.sync();
    expect(before?.entries.map(entry => [entry.entryId, entry.parentId])).toEqual([
      ["a", null], ["b", "a"], ["c", "b"], ["next", "c"],
    ]);

    h.setTurns([{ id: "turn-1", status: "completed", items: [a, c, b] }]);
    await h.tree("c");
    const after = h.sync({ range: "catchup", targetLeafId: "c" });
    expect(after?.entries).toEqual(before?.entries.slice(0, 3));
    expect(h.events.at(-1)).toMatchObject({ type: "command.result", commandId: "sync", ok: true });
  });

  it("reports a canonical conflict when a retained item changes data", async () => {
    const h = harness();
    await h.activate();
    const a = reply("a");
    const b = reply("b", "before");
    const nextTurn = reply("next");
    complete(h, "turn-1", a, b);
    complete(h, "turn-2", nextTurn);
    expect(h.sync()).toBeDefined();

    h.setTurns([{ id: "turn-1", status: "completed", items: [a, { ...b, text: "after" }] }]);
    await h.tree("b");
    expect(h.sync()).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({
      type: "command.result", commandId: "sync", ok: false, error: "canonical_entry_conflict",
    });
  });

  it("publishes the retained prefix immediately after tree truncates later turns", async () => {
    const h = harness();
    await h.activate();
    const u1 = user("u1");
    const a1 = reply("a1");
    const u2 = user("u2");
    const a2 = reply("a2");
    complete(h, "turn-1", u1, a1);
    complete(h, "turn-2", u2, a2);
    const before = h.sync();
    expect(before?.entries).toHaveLength(4);

    h.setTurns([{ id: "turn-1", status: "completed", items: [u1, a1] }]);
    await h.tree("u2");
    const after = h.sync();
    expect(after?.entries).toEqual(before?.entries.slice(0, 2));
    expect(h.events.at(-1)).toMatchObject({ type: "command.result", commandId: "sync", ok: true });
  });
});
