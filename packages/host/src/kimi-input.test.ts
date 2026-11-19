import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KimiInput, KimiPromptJournal } from "./kimi-input.js";
import { KimiConversation } from "./kimi-conversation.js";
import { KimiSessions } from "./kimi-sessions.js";
import type { RuntimeEvent } from "@orbis/protocol";

let root: string;
let input: KimiInput | undefined;
const agent = { hostId: "test", agentKind: "kimiCode" as const, sessionId: "kimi-code:test:session_input" };
const time = "2026-11-19T05:00:00.000Z";
const empty = { active: null, queued: [] };
const opener = (id: string) => ({ type: "user_message", item_id: "opener", status: "ended", created_at: time, placement: "opener", text: "same", prompt_ids: [id] });
const activeTurn = (id: string, promptId: string) => ({ turn_id: id, ordinal: 1, kind: "agent", status: "running", started_at: time, items: [opener(promptId)] });
const native = (id: string, status = "running") => ({ prompt_id: id, status, content: [{ type: "text", text: "same" }] });
const send = (messageId: string, text = "same") => ({ type: "user_message" as const, messageId, text });
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "orbis-kimi-input-"))); });
afterEach(async () => { input?.close(); input = undefined; await rm(root, { recursive: true, force: true }); });
async function fixture(handler: (path: string, body: Record<string, unknown> | undefined) => unknown) {
  const journal = new KimiPromptJournal(join(root, "inputs.json")); await journal.load();
  const requests = vi.fn(async (path: string, options?: { body?: unknown }) => {
    if (path.endsWith("/environment")) return { environment_id: "local", workspace_id: "test", cwd: root };
    if (path.endsWith("/session_input")) return { id: "session_input", workspace_id: "test", metadata: { cwd: root }, archived: false,
      main_turn_active: false, busy: false, title: "test", created_at: time, updated_at: time, agent_config: { model: "test" } };
    return handler(path, options?.body as Record<string, unknown> | undefined);
  });
  const rest = { requestJson: <T>(path: string, options?: { body?: unknown }) => requests(path, options) as Promise<T> };
  const events: RuntimeEvent[] = [];
  const emit = (event: RuntimeEvent) => { events.push(event); };
  const conversation = new KimiConversation({ agent: () => agent, nativeId: "session_input", client: rest, emit,
    clientMessageIds: ids => journal.aliases(agent.sessionId, ids), onUserItem: (_turn, ids) => input?.observePromptIds(ids),
    onTurnEnded: turn => input?.observeEnd(turn) });
  const lane = input = new KimiInput({ sessionId: agent.sessionId, nativeId: "session_input", sessions: new KimiSessions(rest, "test"),
    journal, conversation, emit, idle: () => true });
  conversation.frame({ type: "turns", turns: [], has_more: false });
  return { lane, conversation, journal, events, requests };
}

it("retains lost prompt admissions durably and reconciles merged items by identity, not text", async () => {
  const posts: string[] = [];
  const f = await fixture((_, body) => {
    if (!body) return empty;
    posts.push(String(body.prompt_id));
    if (posts.length === 1) throw new Error("native receipt lost");
    return native(posts.at(-1)!);
  });
  await f.lane.send("one", send("message-1"));
  expect(f.events.at(-1)).toMatchObject({ status: "unconfirmed" });
  await f.lane.send("replay", send("message-1"));
  await f.lane.send("conflict", send("message-1", "different"));
  expect(f.events.at(-1)).toMatchObject({ status: "message_id_conflict" });
  await f.lane.send("two", send("message-2"));
  expect(posts).toHaveLength(2); expect(posts[0]).not.toBe(posts[1]);
  const reloaded = new KimiPromptJournal(f.journal.path);
  expect(await reloaded.reserve(agent.sessionId, "message-1", "same")).toMatchObject({ fresh: false, record: { prompt: posts[0] } });
  f.conversation.frame({ type: "turns", has_more: false, turns: [{ ...activeTurn("turn", "browser-id"), status: "ended", outcome: "completed",
    items: [{ ...opener("browser-id"), prompt_ids: [...posts, "browser-id"] }] }] });
  const snapshot = await f.conversation.sync({ type: "session.sync", sessionId: agent.sessionId, syncId: "sync", range: "preview" });
  expect(snapshot).toMatchObject({ display: { entries: [{ message: { clientMessageIds: ["message-1", "message-2"] } }] } });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "one", status: "success" }));
  await f.lane.send("reconciled", send("message-1"));
  expect(f.events.at(-1)).toMatchObject({ status: "success" });
  expect(posts).toHaveLength(2);
});

it("observes the browser queue and stops only a proven opener, not a naturally advanced successor", async () => {
  let active = "next";
  let aborts = 0;
  const f = await fixture((path) => {
    if (path.endsWith(":abort")) { aborts++; expect(path).toContain("/target:abort"); return { aborted: true }; }
    return { active: native(active), queued: [native("browser-queued", "queued")] };
  });
  f.conversation.frame({ type: "turns", turns: [activeTurn("target-turn", "target")], has_more: false });
  await f.lane.stop("wrong");
  expect(aborts).toBe(0); expect(f.events.at(-1)).toMatchObject({ status: "not_cancelable" });
  active = "target";
  await f.lane.stop("stop");
  expect(aborts).toBe(1);
  expect(f.events.at(-1)).toMatchObject({ status: "pending" });
  f.conversation.frame({ type: "turn.ended", turn: { ...activeTurn("target-turn", "target"), status: "ended", outcome: "interrupted", end_reason: "user_cancelled" } });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "stop", status: "success" }));
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "delivery.snapshot", items: [expect.objectContaining({ state: "accepted" })] })));
});
