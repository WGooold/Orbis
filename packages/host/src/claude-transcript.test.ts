import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@orbis/protocol";
import { ClaudeSessionHistory } from "./claude-session-history.js";
import { ClaudeTranscriptProjection, ClaudeTranscriptReader, findClaudeTranscript } from "./claude-transcript.js";

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

  it("treats a Session without a transcript yet as an empty ready history", async () => {
    const history = new ClaudeSessionHistory("new-session", await tempConfig(), () => undefined);
    const snapshot = await history.sync({ type: "session.sync", sessionId: "new-session", syncId: "s", range: "preview" });
    expect(snapshot).toMatchObject({ entries: [], cursor: { leafId: null }, source: { ready: true } });
  });
});
