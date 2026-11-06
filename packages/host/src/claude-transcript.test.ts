import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@orbis/protocol";
import { ClaudeSessionHistory } from "./claude-session-history.js";
import { ClaudeTranscriptProjection, ClaudeTranscriptReader, findClaudeTranscript } from "./claude-transcript.js";
import { AgentConversationState } from "./agent-conversation-state.js";
import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { AgentToolInventory } from "./agent-tool-inventory.js";
import { ToolInventoryIngestion } from "./tool-inventory-ingestion.js";

const at = "2026-10-28T10:00:00.000Z";
const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "user", uuid, parentUuid, timestamp: at, message: { role: "user", content }, ...extra });
const assistant = (uuid: string, parentUuid: string | null, content: unknown[]) =>
  ({ type: "assistant", uuid, parentUuid, timestamp: at, message: { role: "assistant", model: "claude-opus-5-5", content } });
const line = (row: unknown) => `${JSON.stringify(row)}\n`;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function tempConfig(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orbis-claude-"));
  roots.push(root);
  return root;
}

describe("ClaudeTranscriptProjection", () => {
  it("updates the Host preview after resuming a long transcript and persisting a new reply", async () => {
    const root = await tempConfig();
    const path = join(root, "long.jsonl");
    await writeFile(path, Array.from({ length: 1055 }, (_, i) => line(user(`u${i}`, i ? `u${i - 1}` : null, `row ${i}`))).join(""));
    const model = new AgentConversationState(new AgentStateRegistry());
    const scope: StateScope = { kind: "agent", key: { hostId: "local", agentKind: "claude", sessionId: "long" } };
    const history = new ClaudeSessionHistory("long", root, event => {
      if (event.type === "session.patch") expect(model.accept(scope, event)).toBe(true);
    }, { locate: async () => path });
    try {
      const initial = await history.sync({ type: "session.sync", sessionId: "long", syncId: "resume", range: "preview" });
      expect(model.accept(scope, initial)).toBe(true);
      await appendFile(path, line(user("sent", "u1054", "new question")) + line(assistant("reply", "sent", [{ type: "text", text: "new answer" }])));
      await history.refresh();
      const reopened = model.recover(scope, { type: "session.sync", sessionId: "long", syncId: "reopen", range: "preview" });
      expect(reopened?.cursor.leafId).toBe("reply");
      expect(reopened?.entries.slice(-2).map(item => item.entryId)).toEqual(["sent", "reply"]);
      expect(reopened!.source!.seq).toBeGreaterThan(initial.source!.seq);
      const direct = await history.sync({ type: "session.sync", sessionId: "long", syncId: "direct", range: "preview" });
      expect(model.accept(scope, direct)).toBe(true);
      expect(direct.cursor).toEqual(reopened?.cursor);
    } finally { history.close(); }
  });

  it("syncs the published inventory while a live Claude tool remains active", async () => {
    // DSH-SYNC-07：共享源的 raw live 读取改动后，Claude 同步仍须保留已发布的工具引用与版本。
    const root = await tempConfig(), path = join(root, "tools.jsonl");
    await writeFile(path, line(user("u1", null, "read file")));
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    const inventory = new AgentToolInventory(registry), ingestion = new ToolInventoryIngestion(inventory);
    const agent = { hostId: "local", agentKind: "claude" as const, sessionId: "tools" };
    const scope: StateScope = { kind: "agent", key: agent }, rejected: string[] = [];
    const accept = (event: RuntimeEvent) => {
      if (event.type === "session.tools.produced") expect(ingestion.accept("claude:tools", agent, event)).toBe(true);
      else if (event.type === "session.patch" || event.type === "session.snapshot") model.accept(scope, event,
        ready => ready && event.source && event.live?.toolInventory ? ingestion.prepare("claude:tools", agent, event.source, event.live.toolInventory) : undefined,
        reason => rejected.push(reason));
    };
    const history = new ClaudeSessionHistory("tools", root, accept, { locate: async () => path });
    try {
      accept(await history.sync({ type: "session.sync", sessionId: "tools", syncId: "initial", range: "preview" }));
      history.observe({ type: "tool.started", toolCallId: "call", toolName: "Read", arguments: {} });
      const snapshot = await history.sync({ type: "session.sync", sessionId: "tools", syncId: "with-tools", range: "preview" });
      accept(snapshot);
      expect(rejected).toEqual([]);
      expect(snapshot.live).toMatchObject({ tools: [], toolInventory: { totalCount: 1 } });
    } finally { history.close(); inventory.dispose(); }
  });

  it("shows slash commands, their output and shell runs without Claude's markup", () => {
    const projection = new ClaudeTranscriptProjection();
    projection.push(user("c1", null, "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>"));
    projection.push(user("o1", "c1", "<local-command-stdout>\u001b[1mSet model to Sonnet\u001b[22m</local-command-stdout>"));
    projection.push(user("o2", "o1", "<local-command-stdout></local-command-stdout>"));
    projection.push(user("b1", "o2", [{ type: "text", text: "<bash-input>git status</bash-input>" }]));
    projection.push(user("b2", "b1", "<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>"));
    expect(projection.entries.map(entry => entry.data.message)).toMatchObject([
      { role: "user", content: "/model sonnet" },
      { role: "bashExecution", command: "", output: "Set model to Sonnet" },
      { role: "bashExecution", command: "git status", output: "" },
      { role: "bashExecution", command: "", output: "clean" },
    ]);
    // The empty output row is skipped but still anchors its child.
    expect(projection.entries[2]?.parentId).toBe("o1");
  });

  it("keeps the Session's title, permission mode, model and directory from metadata rows", () => {
    const projection = new ClaudeTranscriptProjection();
    projection.push({ type: "permission-mode", permissionMode: "plan", sessionId: "s" });
    projection.push({ type: "ai-title", aiTitle: "Generated", sessionId: "s" });
    projection.push(user("u1", null, "hi", { cwd: "/repo" }));
    projection.push(assistant("a1", "u1", [{ type: "text", text: "hello" }]));
    projection.push({ type: "assistant", uuid: "x", parentUuid: "a1", timestamp: at, message: { role: "assistant", model: "<synthetic>", content: [] } });
    projection.push({ type: "custom-title", customTitle: "Renamed", sessionId: "s" });
    projection.push({ type: "ai-title", aiTitle: "Later generated", sessionId: "s" });
    projection.push({ type: "permission-mode", permissionMode: "acceptEdits", sessionId: "s" });
    expect(projection.facts).toEqual({ title: "Renamed", permissionMode: "acceptEdits", model: "claude-opus-5-5", cwd: "/repo" });
  });

  it("projects the main conversation and links entries through skipped native rows", () => {
    const projection = new ClaudeTranscriptProjection();
    projection.push(user("meta", null, "<local-command-caveat>", { isMeta: true }));
    projection.push(user("u1", "meta", "列出文件"));
    projection.push({ type: "attachment", uuid: "att", parentUuid: "u1", timestamp: at });
    projection.push(assistant("a1", "att", [{ type: "thinking", thinking: "", signature: "hidden" }]));
    projection.push(assistant("a2", "a1", [{ type: "thinking", thinking: "先看目录" }]));
    projection.push(assistant("a3", "a2", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]));
    projection.push(user("r1", "a3", [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt", is_error: false }]));
    projection.push(assistant("side", "r1", [{ type: "text", text: "subagent" }]));
    projection.push({ ...assistant("sub", "r1", [{ type: "text", text: "subagent" }]), isSidechain: true });
    projection.push({ type: "system", subtype: "turn_duration", uuid: "sys", parentUuid: "side", timestamp: at });
    projection.push(assistant("a4", "sys", [{ type: "text", text: "只有 a.txt" }]));

    expect(projection.entries.map(entry => [entry.entryId, entry.parentId])).toEqual([
      ["u1", null], ["a2", "u1"], ["a3", "a2"], ["r1", "a3"], ["side", "r1"], ["a4", "side"],
    ]);
    expect(projection.leafId).toBe("a4");
    expect(projection.entries[1]!.data.message).toMatchObject({ role: "assistant", content: [{ type: "thinking", thinking: "先看目录" }] });
    expect(projection.entries[2]!.data.message).toMatchObject({ content: [{ type: "toolCall", id: "toolu_1", name: "Bash", arguments: { command: "ls" } }] });
    expect(projection.entries[3]!.data.message).toMatchObject({ role: "toolResult", toolCallId: "toolu_1", toolName: "Bash",
      content: [{ type: "text", text: "a.txt" }], isError: false });
    expect(projection.has("sub")).toBe(true);
  });

  it("splits several tool results and maps compact summaries", () => {
    const projection = new ClaudeTranscriptProjection();
    projection.push(user("r", null, [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "one" }] },
      { type: "tool_result", tool_use_id: "t2", content: "two", is_error: true },
    ]));
    projection.push(user("c", "r", "This session is being continued…", { isCompactSummary: true }));
    expect(projection.entries.map(entry => [entry.entryId, entry.parentId, entry.type])).toEqual([
      ["r:result:0", null, "message"], ["r:result:1", "r:result:0", "message"], ["c", "r:result:1", "compaction"],
    ]);
    expect(projection.entries[1]!.data.message).toMatchObject({ isError: true });
    expect(projection.entries[2]!.data).toEqual({ summary: "This session is being continued…" });
  });
});

describe("ClaudeTranscriptReader", () => {
  it("reads appended rows incrementally, waits for unterminated lines and restarts on truncation", async () => {
    const root = await tempConfig();
    const path = join(root, "s.jsonl");
    await writeFile(path, line(user("u1", null, "hi")) + JSON.stringify(assistant("a1", "u1", [{ type: "text", text: "hel" }])));
    const reader = new ClaudeTranscriptReader(path);
    expect(await reader.read()).toBe(false);
    expect(reader.projection.entries.map(entry => entry.entryId)).toEqual(["u1"]);
    await appendFile(path, "\n" + line(user("u2", "a1", "again")));
    await reader.read();
    expect(reader.projection.entries.map(entry => entry.entryId)).toEqual(["u1", "a1", "u2"]);
    await writeFile(path, line(user("x", null, "fresh")));
    expect(await reader.read()).toBe(true);
    expect(reader.projection.entries.map(entry => entry.entryId)).toEqual(["x"]);
  });

  it("finds a transcript by Session id and rejects path-like ids", async () => {
    const root = await tempConfig();
    await mkdir(join(root, "projects", "-repo"), { recursive: true });
    await writeFile(join(root, "projects", "-repo", "abc-123.jsonl"), "");
    await expect(findClaudeTranscript("abc-123", root)).resolves.toBe(join(root, "projects", "-repo", "abc-123.jsonl"));
    await expect(findClaudeTranscript("../abc-123", root)).resolves.toBeUndefined();
    await expect(findClaudeTranscript("missing", root)).resolves.toBeUndefined();
  });
});

describe("ClaudeSessionHistory", () => {
  it("serves the transcript as a ready snapshot and replaces streamed output once the turn rows land", async () => {
    const root = await tempConfig();
    await mkdir(join(root, "projects", "-repo"), { recursive: true });
    const path = join(root, "projects", "-repo", "session-1.jsonl");
    await writeFile(path, line(user("u1", null, "hi")));
    const patches: Extract<RuntimeEvent, { type: "session.patch" }>[] = [];
    const history = new ClaudeSessionHistory("session-1", root, event => { if (event.type === "session.patch") patches.push(event); },
      { settleIntervalMs: 5, settleTimeoutMs: 500 });

    const snapshot = await history.sync({ type: "session.sync", sessionId: "session-1", syncId: "sync-1", range: "preview" });
    expect(snapshot).toMatchObject({ sessionId: "session-1", syncId: "sync-1", cursor: { leafId: "u1" }, source: { ready: true } });
    expect(snapshot.entries.map(entry => entry.entryId)).toEqual(["u1"]);

    history.observe({ type: "turn.started", turnId: "t", startedAt: 1 });
    history.observe({ type: "message.started", message: { messageId: "t:0", role: "assistant", content: [], timestamp: 1 } });
    history.observe({ type: "message.delta", messageId: "t:0", contentType: "text", contentIndex: 0, delta: "hello" });
    expect(history.source.snapshot().live.messages).toHaveLength(1);

    const settled = history.settleTurn(["a1"]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(history.source.snapshot().live.messages).toHaveLength(1);
    await appendFile(path, line(assistant("a1", "u1", [{ type: "text", text: "hello" }])));
    await settled;
    expect(history.source.snapshot().live.messages).toEqual([]);
    expect(history.source.snapshot().checkpoint.head.leafId).toBe("a1");
    expect(patches.at(-1)).toMatchObject({ head: { leafId: "a1" }, live: { messages: [] } });
  });

  it("hands every UUID of a native step to canonical history atomically before the turn ends", async () => {
    const root = await tempConfig();
    const path = join(root, "step.jsonl");
    await writeFile(path, line(user("u", null, "hi")));
    const patches: Extract<RuntimeEvent, { type: "session.patch" }>[] = [];
    const history = new ClaudeSessionHistory("step", root, event => { if (event.type === "session.patch") patches.push(event); },
      { locate: async () => path });
    try {
      await history.refresh();
      history.observe({ type: "turn.started", turnId: "t", startedAt: 1 });
      history.observe({ type: "message.started", message: { messageId: "t:0", role: "assistant", timestamp: 1,
        content: [{ type: "thinking", text: "plan" }, { type: "text", text: "hello" }] } });
      history.reserveStepRow("t:0", "thought");
      history.reserveStepRow("t:0", "answer");
      await appendFile(path, line(assistant("thought", "u", [{ type: "thinking", thinking: "plan" }])));
      await history.refresh();
      const gated = await history.sync({ type: "session.sync", sessionId: "step", syncId: "gated", range: "preview" });
      expect(gated.entries.map(entry => entry.entryId)).toEqual(["u"]);
      expect(gated.live?.messages).toHaveLength(1);
      // The boundary may arrive before its last disk write; retain the whole streamed response.
      await history.finishStep("t:0", ["thought", "answer"]);
      expect(history.source.snapshot().live.messages).toHaveLength(1);
      await appendFile(path, line(assistant("answer", "thought", [{ type: "text", text: "hello" }])));
      await history.refresh();
      const committed = patches.at(-1)!;
      expect(committed.entries?.map(entry => entry.entryId)).toEqual(["thought", "answer"]);
      expect(committed.live?.messages).toEqual([]);
      expect(committed.live?.turn).toEqual({ turnId: "t", startedAt: 1 });
      expect(patches.every(patch => !patch.display?.entries.some(row => row.entryId === "thought" || row.entryId === "answer") || patch.live?.messages.length === 0)).toBe(true);
      // turn.complete reconstructs a finished message from its adapter cache; it must stay retired.
      history.observe({ type: "message.finished", message: { messageId: "t:0", role: "assistant", timestamp: 1,
        content: [{ type: "text", text: "hello" }] } });
      history.observe({ type: "message.delta", messageId: "t:0", delta: "late" });
      expect(history.source.snapshot().live.messages).toEqual([]);
      const restored = await history.sync({ type: "session.sync", sessionId: "step", syncId: "restored", range: "preview" });
      expect(restored.display?.entries.filter(row => row.message?.role === "assistant")).toHaveLength(2);
      expect(restored.live?.messages).toEqual([]);
    } finally { history.close(); }
  });

  it("cleans only the ended turn when the next turn starts during transcript settling", async () => {
    const root = await tempConfig();
    const path = join(root, "race.jsonl");
    await writeFile(path, "");
    const history = new ClaudeSessionHistory("race", root, () => {}, { locate: async () => path, settleTimeoutMs: 0 });
    try {
      await history.refresh();
      const message = (messageId: string) => ({ messageId, role: "assistant" as const, timestamp: 1, content: [{ type: "text" as const, text: messageId }] });
      history.observe({ type: "message.started", message: message("old:0") });
      const settling = history.settleTurn(["not-yet-written"], ["old:0"]);
      history.observe({ type: "turn.started", turnId: "next", startedAt: 2 });
      history.observe({ type: "message.started", message: message("next:0") });
      await settling;
      expect(history.source.snapshot().live.messages.map(item => item.message.messageId)).toEqual(["next:0"]);
      expect(history.source.snapshot().live.turn?.turnId).toBe("next");
      history.observe({ type: "message.finished", message: message("old:0") });
      expect(history.source.snapshot().live.messages.map(item => item.message.messageId)).toEqual(["next:0"]);
    } finally { history.close(); }
  });

  it("retains a sealed step after the disk-settle deadline and commits it on a later refresh", async () => {
    const root = await tempConfig();
    const path = join(root, "late.jsonl");
    await writeFile(path, "");
    const history = new ClaudeSessionHistory("late", root, () => {}, { locate: async () => path, settleTimeoutMs: 0 });
    try {
      await history.refresh();
      history.observe({ type: "message.started", message: { messageId: "t:0", role: "assistant", timestamp: 1,
        content: [{ type: "text", text: "late answer" }] } });
      history.reserveStepRow("t:0", "late-native");
      await history.finishStep("t:0", ["late-native"]);
      await history.settleTurn(["late-native"], ["t:0"]);
      expect(history.source.snapshot().live.messages).toHaveLength(1);
      await appendFile(path, line(assistant("late-native", null, [{ type: "text", text: "late answer" }])));
      await history.refresh();
      expect(history.source.snapshot().live.messages).toEqual([]);
      expect(history.source.snapshot().checkpoint.head.leafId).toBe("late-native");
    } finally { history.close(); }
  });

  it("retires a signature-only or denied step without a canonical display row", async () => {
    const history = new ClaudeSessionHistory("empty", await tempConfig(), () => {}, { locate: async () => undefined });
    history.observe({ type: "message.started", message: { messageId: "t:0", role: "assistant", timestamp: 1, content: [] } });
    await history.finishStep("t:0", []);
    // A newly created session with no file must still process the explicit empty boundary.
    expect(history.source.snapshot().live.messages).toEqual([]);
    history.close();
  });

  it("treats a Session without a transcript yet as an empty ready history", async () => {
    const history = new ClaudeSessionHistory("new-session", await tempConfig(), () => undefined);
    const snapshot = await history.sync({ type: "session.sync", sessionId: "new-session", syncId: "s", range: "preview" });
    expect(snapshot).toMatchObject({ entries: [], cursor: { leafId: null }, source: { ready: true } });
  });

  it("claims only a later transcript row with the exact submitted text for a phone prompt (ADR-0049)", async () => {
    const root = await tempConfig();
    await mkdir(join(root, "projects", "-repo"), { recursive: true });
    const path = join(root, "projects", "-repo", "session-2.jsonl");
    await writeFile(path, line(user("u1", null, "继续")));
    const patches: Extract<RuntimeEvent, { type: "session.patch" }>[] = [];
    const history = new ClaudeSessionHistory("session-2", root, event => { if (event.type === "session.patch") patches.push(event); });
    await history.refresh();

    history.expectPrompt("app-1", "继续");
    history.expectPrompt("app-2", "继续");
    await appendFile(path, line(assistant("a1", "u1", [{ type: "text", text: "好" }])) +
      line(user("u2", "a1", "本地输入")) + line(user("u3", "u2", [{ type: "text", text: "继续" }])) + line(user("u4", "u3", "继续")));
    await history.refresh();

    const snapshot = await history.sync({ type: "session.sync", sessionId: "session-2", syncId: "s", range: "preview" });
    const ids = snapshot.entries.map(entry => (entry.data.message as { clientMessageId?: string }).clientMessageId);
    // The row that existed before the prompt and the local row are never claimed.
    expect(ids).toEqual([undefined, undefined, undefined, "app-1", "app-2"]);
    expect(snapshot.display?.entries.map(row => row.message?.clientMessageId)).toEqual([undefined, undefined, undefined, "app-1", "app-2"]);
    expect(patches.at(-1)?.display?.entries.find(row => row.entryId === "u3")?.message?.clientMessageId).toBe("app-1");

    const again = await history.sync({ type: "session.sync", sessionId: "session-2", syncId: "s2", range: "preview" });
    expect(again.entries.find(entry => entry.entryId === "u3")).toBe(snapshot.entries.find(entry => entry.entryId === "u3"));
  });
});
