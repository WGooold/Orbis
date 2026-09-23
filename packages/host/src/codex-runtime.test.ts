/**
 * CodexRuntime 的映射测试：不跑真 app-server，用一个可脚本的假客户端，
 * 验证 thread 列表 → 目录条目、turn/item 事件流 → runtime 事件、审批闭环。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentSessionSummary, RuntimeEvent, SessionSyncRequest } from "@pi-remote/protocol";

import { CODEX_RUNTIME_ID, type CodexAppServer, type CodexServerRequest } from "./codex-daemon.js";
import { CodexRuntime, codexHeadWindowLaunch } from "./codex-runtime.js";

function makeHarness(options?: {
  /** 覆盖 `model/list` 的回复（capabilities 的 select 选项数据源）。 */
  modelList?: unknown;
  /** 让 `model/list` 直接失败（验证降级路径）。 */
  modelListFails?: boolean;
  skillsList?: unknown;
  mcpServerStatusList?: unknown;
}): {
  runtime: CodexRuntime;
  server: CodexAppServer;
  rolloutRoot: string;
  events: RuntimeEvent[];
  requests: ReturnType<typeof vi.fn>;
  resolveNext: (result: unknown) => void;
  rejectNext: (error: unknown) => void;
  serverRequest: (frame: { id: string; method: string; params: unknown }) => { result: unknown };
  notify: (method: string, params: unknown) => void;
} {
  const events: RuntimeEvent[] = [];
  const queue: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const request = vi.fn((method: string) => {
    // markStarted 会探一次 model/list 来缓存默认模型名（用于 runtime.metadata 的 model
    // 字段）。它不属于被测的请求序列，直接就地回一个固定的模型表，不占用 queue——
    // 否则每个用例的 resolveNext 都会错位。
    if (method === "model/list") {
      if (options?.modelListFails === true) return Promise.reject(new Error("app-server 未就绪"));
      return Promise.resolve(
        options?.modelList ?? { data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] },
      );
    }
    if (method === "skills/list" || method === "mcpServerStatus/list") {
      return Promise.resolve({
        data: method === "skills/list"
          ? options?.skillsList ?? []
          : options?.mcpServerStatusList ?? [],
      });
    }
    return new Promise<unknown>((resolve, reject) => {
      queue.push({ resolve, reject });
    });
  });
  const server = {
    request,
    notify: vi.fn(),
  } as unknown as CodexAppServer;
  // 磁盘 rollout 扫描指向空临时目录：既不让测试读到本机真实的 ~/.codex/sessions，
  // 又给磁盘目录用例一个可写入的根。
  const rolloutRoot = mkdtempSync(join(tmpdir(), "pi-remote-codex-rollout-"));
  const runtime = new CodexRuntime({
    server,
    onEvent: (event) => events.push(event),
    rolloutRoot,
  });
  return {
    runtime,
    server,
    rolloutRoot,
    events,
    requests: request,
    resolveNext: (result) => {
      const next = queue.shift();
      if (next === undefined) throw new Error("没有在途请求");
      next.resolve(result);
    },
    rejectNext: (error: unknown) => {
      const next = queue.shift();
      if (next === undefined) throw new Error("没有在途请求");
      next.reject(error);
    },
    serverRequest: (frame) => {
      // 构造时 CodexRuntime 已把自己的处理器赋到 server.onServerRequest 上。
      // 用 getter 返回：respond 在 handleCommand 时才被调用，不能按值快照。
      const captured: { result?: unknown } = {};
      const handled: CodexServerRequest = {
        id: frame.id,
        method: frame.method,
        params: frame.params,
        respond: (value) => {
          captured.result = value;
        },
        fail: () => {},
      };
      (server.onServerRequest as (r: CodexServerRequest) => void)(handled);
      return {
        get result() {
          return captured.result;
        },
      };
    },
    notify: (method, params) => {
      (server.onNotification as (m: string, p: unknown) => void)(method, params);
    },
  };
}

async function activate(
  h: ReturnType<typeof makeHarness>,
  threadId = "th-1",
  threadSettings: { model?: string; modelProvider?: string } = {},
): Promise<void> {
  const activating = h.runtime.activate({ type: "resume", sessionId: threadId });
  h.resolveNext({
    model: threadSettings.model,
    modelProvider: threadSettings.modelProvider,
    thread: { id: threadId, cwd: "D:/repo", turns: [] },
  });
  await activating;
}

function syncHistory(h: ReturnType<typeof makeHarness>, options: Partial<SessionSyncRequest> = {}) {
  const start = h.events.length;
  const command: SessionSyncRequest = {
    type: "session.sync", sessionId: "th-1", syncId: "sync", range: "preview", ...options,
  };
  h.runtime.handleCommand(command, "sync-command", command.sessionId);
  return h.events.slice(start).find((event) => event.type === "session.snapshot");
}

describe("Codex bounded canonical history", () => {
  const item = (id: string, text = id) => ({ id, type: "agentMessage", text });

  it("syncs a new thread before its rollout exists and keeps syncing after the first message", async () => {
    const h = makeHarness();
    const activating = h.runtime.activate({ type: "new", cwd: "D:/repo" });
    h.resolveNext({ thread: {
      id: "th-1", cwd: "D:/repo", turns: [],
      path: join(h.rolloutRoot, "not-yet-created", "rollout-th-1.jsonl"),
    } });
    await activating;
    expect(syncHistory(h)).toMatchObject({
      sessionId: "th-1", syncId: "sync", cursor: { leafId: null },
      mode: "replace", entries: [], complete: true, hasOlder: false, rangeStatus: "complete",
    });
    expect(h.events.at(-1)).toMatchObject({ type: "command.result", commandId: "sync-command", ok: true });

    h.runtime.handleCommand({ type: "user_message", text: "Hello", messageId: "phone-1" }, "send-1", "th-1");
    expect(h.requests).toHaveBeenCalledWith("turn/start", {
      threadId: "th-1", input: [{ type: "text", text: "Hello" }], clientUserMessageId: "phone-1",
    });
    h.resolveNext({ turn: { id: "t" } });
    h.notify("turn/started", { threadId: "th-1", turn: { id: "t" } });
    h.notify("item/completed", { threadId: "th-1", turnId: "t", item: {
      id: "user-1", type: "userMessage", clientId: "phone-1", content: [{ type: "text", text: "Hello" }],
    } });
    h.notify("item/completed", { threadId: "th-1", turnId: "t", item: item("reply-1", "Hi") });
    h.notify("turn/completed", { threadId: "th-1", turn: { id: "t" } });
    expect(syncHistory(h)).toMatchObject({
      cursor: { leafId: "reply-1" }, complete: true, rangeStatus: "complete",
      entries: [{ entryId: "user-1", parentId: null }, { entryId: "reply-1", parentId: "user-1" }],
    });
    expect(h.events.at(-1)).toMatchObject({ type: "command.result", commandId: "sync-command", ok: true });
  });

  it("still reports an unreadable rollout when resuming an existing thread", async () => {
    const h = makeHarness();
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({ thread: {
      id: "th-1", cwd: "D:/repo", turns: [], path: join(h.rolloutRoot, "missing-th-1.jsonl"),
    } });
    await activating;
    expect(syncHistory(h)).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({
      type: "command.result", commandId: "sync-command", ok: false, error: "rollout_unreadable",
    });
  });

  it("does not suppress other rollout read failures for a new thread", async () => {
    const h = makeHarness();
    const activating = h.runtime.activate({ type: "new", cwd: "D:/repo" });
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", turns: [], path: h.rolloutRoot } });
    await activating;
    expect(syncHistory(h)).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({
      type: "command.result", commandId: "sync-command", ok: false, error: "rollout_unreadable",
    });
  });

  it("responds to all range parameters and never pushes an unsolicited full graph", async () => {
    const h = makeHarness();
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", turns: [{ id: "t", status: "completed", items: Array.from({ length: 10 }, (_, i) => item(String(i + 1))) }] } });
    await activating;
    expect(h.events.some((event) => event.type === "session.snapshot")).toBe(false);
    expect(syncHistory(h, { maxEntries: 3 })?.entries.map((entry) => entry.entryId)).toEqual(["8", "9", "10"]);
    expect(syncHistory(h, { range: "history", maxEntries: 3, beforeEntryId: "8" })?.entries.map((entry) => entry.entryId)).toEqual(["5", "6", "7"]);
    expect(syncHistory(h, { range: "catchup", maxEntries: 3, knownLeafId: "3", targetLeafId: "8" }))
      .toMatchObject({ mode: "append", targetLeafId: "8", complete: false, entries: [{ entryId: "4" }, { entryId: "5" }, { entryId: "6" }] });
    expect(syncHistory(h, { targetLeafId: "missing" })).toMatchObject({ entries: [], rangeStatus: "leaf_not_found" });
  });

  it("keeps the same canonical Entries across notification duplicates, all ranges and a fresh replay", async () => {
    const h = makeHarness();
    await activate(h);
    const completed = [item("a"), { id: "tool", type: "mcpToolCall", server: "s", tool: "t", arguments: { z: 1, a: 2 }, result: { z: 1, a: 2 } }, item("b")];
    for (const entry of completed) h.notify("item/completed", { threadId: "th-1", turnId: "t", item: entry });
    const first = syncHistory(h)!;
    expect(first.entries.every((entry) => entry.timestamp === "1970-01-01T00:00:00.000Z")).toBe(true);
    h.notify("item/completed", { threadId: "th-1", turnId: "t", item: completed[0] });
    h.notify("item/completed", { threadId: "th-1", turnId: "t", item: { ...completed[1], arguments: { a: 2, z: 1 }, result: { a: 2, z: 1 } } });
    for (const range of ["preview", "history", "catchup"] as const) expect(syncHistory(h, { range })?.entries).toEqual(first.entries);
    const reloaded = makeHarness();
    const activating = reloaded.runtime.activate({ type: "resume", sessionId: "th-1" });
    reloaded.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", turns: [{ id: "t", status: "completed", items: completed }] } });
    await activating;
    expect(syncHistory(reloaded)?.entries).toEqual(first.entries);
  });

  it("waits for incomplete items and preserves source order when tools complete out of order", async () => {
    const h = makeHarness();
    await activate(h);
    h.notify("item/started", { threadId: "th-1", item: item("a", "partial") });
    h.notify("item/started", { threadId: "th-1", item: item("b", "partial") });
    h.notify("item/completed", { threadId: "th-1", item: item("b", "finished b") });
    expect(syncHistory(h)?.entries).toEqual([]);
    h.notify("item/completed", { threadId: "th-1", item: item("a", "finished a") });
    expect(syncHistory(h)?.entries.map((entry) => [entry.entryId, entry.parentId])).toEqual([["a", null], ["b", "a"]]);
    const replay = makeHarness();
    const activating = replay.runtime.activate({ type: "resume", sessionId: "th-1" });
    replay.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", turns: [{ id: "t", status: "inProgress", items: [item("a", "partial")] }] } });
    await activating;
    expect(syncHistory(replay)?.entries).toEqual([]);
    replay.notify("item/completed", { threadId: "th-1", item: item("a", "finished a") });
    expect(syncHistory(replay)?.entries).toHaveLength(1);
  });

  it("fails conflicting completed Entries without publishing overwritten canonical data", async () => {
    const h = makeHarness();
    await activate(h);
    h.notify("item/completed", { threadId: "th-1", item: item("a", "original") });
    expect(syncHistory(h)?.entries).toHaveLength(1);
    h.notify("item/completed", { threadId: "th-1", item: item("a", "changed") });
    expect(syncHistory(h)).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ type: "command.result", commandId: "sync-command", ok: false, error: "canonical_entry_conflict" });
  });

  it("returns a correlated error for oversized data and invalid Session identity", async () => {
    const h = makeHarness();
    await activate(h);
    h.notify("item/completed", { threadId: "th-1", item: item("big", "中".repeat(400_000)) });
    expect(syncHistory(h)).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ type: "command.result", commandId: "sync-command", ok: false, error: "session_entry_too_large" });
    h.runtime.handleCommand({ type: "session.sync", sessionId: "other", syncId: "bad", range: "preview" }, "bad-command", "th-1");
    expect(h.events.at(-1)).toMatchObject({ ok: false, commandId: "bad-command", error: "session_mismatch" });
  });

  it("validates rollout Session identity and requires an authoritative path for ambiguous copies", async () => {
    const h = makeHarness();
    const rollout = (text: string, id = "th-1") => [
      JSON.stringify({ type: "session_meta", payload: { id, cwd: "D:/repo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "item_completed", turn_id: "t", item: { type: "AgentMessage", id: "a", content: [{ type: "Text", text }] } } }),
    ].join("\n");
    writeFileSync(join(h.rolloutRoot, "wrong-th-1.jsonl"), rollout("wrong identity", "other"));
    writeFileSync(join(h.rolloutRoot, "old-th-1.jsonl"), rollout("much longer stale history"));
    const authoritative = join(h.rolloutRoot, "current-th-1.jsonl");
    writeFileSync(authoritative, rollout("current"));
    await activate(h);
    expect(syncHistory(h)).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ ok: false, error: "rollout_ambiguous" });
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", path: authoritative, turns: [] } });
    await activating;
    expect(syncHistory(h)?.entries).toMatchObject([{ data: { message: { content: [{ type: "text", text: "current" }] } } }]);
    const wrong = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", path: join(h.rolloutRoot, "wrong-th-1.jsonl"), turns: [] } });
    await wrong;
    expect(syncHistory(h)).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ ok: false, error: "rollout_session_mismatch" });
  });

  it("does not splice across corrupt rollout records and tolerates an unfinished final append", async () => {
    const h = makeHarness();
    const file = join(h.rolloutRoot, "th-1.jsonl");
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "th-1" } });
    const completed = (id: string) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: item(id) } });
    writeFileSync(file, [meta, completed("a"), '{"type":"event_msg","payload":{"type":"item_completed"'].join("\n"));
    await activate(h);
    expect(syncHistory(h)?.entries.map((entry) => entry.entryId)).toEqual(["a"]);
    writeFileSync(file, [meta, completed("a"), '{"type":"event_msg",', completed("b")].join("\n"));
    await activate(h);
    expect(syncHistory(h)).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ ok: false, error: "rollout_invalid" });
  });
});

describe("CodexRuntime", () => {
  it("archive state follows native success; retries and external notifications preserve the same session", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h);
    const offline = vi.fn();
    const changed = vi.fn();
    h.runtime.onOffline = offline;
    h.runtime.onArchiveChange = changed;

    const failed = h.runtime.setArchived("th-1", true);
    h.resolveNext({ thread: { path: "C:\\codex\\sessions\\rollout.jsonl", status: { type: "idle" } } });
    await vi.waitFor(() => expect(h.requests).toHaveBeenLastCalledWith("thread/archive", { threadId: "th-1" }));
    const rejected = expect(failed).rejects.toThrow("disk failure");
    h.rejectNext(new Error("disk failure"));
    await rejected;
    expect(h.runtime.directoryEntries().some((entry) => entry.sessionId === "th-1")).toBe(true);
    expect(offline).not.toHaveBeenCalled();

    const archived = h.runtime.setArchived("th-1", true);
    h.resolveNext({ thread: { path: "C:\\codex\\sessions\\rollout.jsonl", status: { type: "idle" } } });
    await vi.waitFor(() => expect(h.requests).toHaveBeenLastCalledWith("thread/archive", { threadId: "th-1" }));
    h.resolveNext({});
    await archived;
    expect(h.runtime.directoryEntries()).toEqual([]);
    expect(offline).toHaveBeenCalledTimes(1);

    const count = h.requests.mock.calls.length;
    const retry = h.runtime.setArchived("th-1", true);
    h.resolveNext({ thread: { path: "C:\\codex\\archived_sessions\\rollout.jsonl", status: { type: "notLoaded" } } });
    await retry;
    expect(h.requests.mock.calls.length).toBe(count + 1);

    const restored = h.runtime.setArchived("th-1", false);
    h.resolveNext({ thread: { path: "C:\\codex\\archived_sessions\\rollout.jsonl", status: { type: "notLoaded" } } });
    await vi.waitFor(() => expect(h.requests).toHaveBeenLastCalledWith("thread/unarchive", { threadId: "th-1" }));
    h.resolveNext({ thread: { id: "th-1" } });
    await restored;
    expect(h.runtime.directoryEntries()).toEqual([]);
    h.notify("thread/archived", { threadId: "external" });
    h.notify("thread/unarchived", { threadId: "external" });
    expect(changed.mock.calls).toEqual([["external", true], ["external", false]]);

    const busy = h.runtime.setArchived("another", true);
    h.resolveNext({ thread: { path: "C:/codex/sessions/another.jsonl", status: { type: "active" } } });
    await expect(busy).rejects.toMatchObject({ code: "session_busy" });
  });

  it("catalog：归档参数透传到 thread/list，并保留 archived 标记", async () => {
    const h = makeHarness();
    const pending = h.runtime.catalog(true);
    expect(h.requests).toHaveBeenCalledWith("thread/list", { limit: 200, modelProviders: [], archived: true });
    h.resolveNext({
      data: [{ id: "archived-1", cwd: "D:/repo", createdAt: 100, updatedAt: 200, turns: [] }],
    });
    await expect(pending).resolves.toEqual([expect.objectContaining({
      sessionId: "archived-1", agentKind: "codex", archived: true,
    })]);
  });

  it("catalog：thread/list 的结果映射成 agentKind=codex 的目录条目（Unix 秒 → 毫秒）", async () => {
    const h = makeHarness();
    const pending = h.runtime.catalog();
    expect(h.requests).toHaveBeenCalledWith("thread/list", { limit: 200, modelProviders: [] });
    h.resolveNext({
      data: [
        {
          id: "019f-thread-1",
          modelProvider: "custom",
          cwd: "D:/repo",
          name: "统一会话名称",
          preview: "帮我看看这个设计",
          createdAt: 1_782_812_705,
          updatedAt: 1_782_812_800,
          turns: [{ id: "t1", items: [], status: "completed" }],
        },
      ],
    });
    const sessions: AgentSessionSummary[] = await pending;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "019f-thread-1",
      modelProvider: "custom",
      cwd: "D:/repo",
      name: "统一会话名称",
      firstMessage: "帮我看看这个设计",
      createdAt: 1_782_812_705_000,
      modifiedAt: 1_782_812_800_000,
      messageCount: 1,
      agentKind: "codex",
    });
  });

  it("Codex 的已有标题和自动改名同步到 runtime，且不同 thread 的名称不串线", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", name: "已有标题", turns: [] } });
    await activating;
    await activate(h, "th-2");
    const metadata = () => h.runtime.directoryEntries().find((entry) => entry.sessionId === "th-1");
    expect(metadata()?.sessionName).toBe("已有标题");

    h.events.length = 0;
    h.notify("thread/name/updated", { threadId: "th-1", threadName: "Codex 自动生成的标题" });
    expect(metadata()?.sessionName).toBe("Codex 自动生成的标题");
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "runtime.metadata",
      metadata: expect.objectContaining({ sessionId: "th-1", sessionName: "Codex 自动生成的标题" }),
    }));
    expect(h.runtime.directoryEntries().find((entry) => entry.sessionId === "th-2")?.sessionName).toBeUndefined();

    h.notify("thread/name/updated", { threadId: "th-1", threadName: null });
    expect(metadata()?.sessionName).toBeUndefined();
  });

  it("catalog：thread/list 没有的会话由磁盘 rollout 补齐（host 重启后历史不丢）", async () => {
    const h = makeHarness();
    mkdirSync(join(h.rolloutRoot, "2026", "09", "14"), { recursive: true });
    writeFileSync(
      join(h.rolloutRoot, "2026", "09", "14", "rollout-2026-09-14T15-37-07-019f-disk-1.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-09-14T07:37:23.454Z",
          type: "session_meta",
          payload: { id: "019f-disk-1", cwd: "D:/repo-b", timestamp: "2026-09-14T07:37:07.471Z", model_provider: "legacy" },
        }),
        JSON.stringify({
          timestamp: "2026-09-14T07:37:23.471Z",
          type: "event_msg",
          payload: { type: "user_message", message: "磁盘里的历史会话" },
        }),
      ].join("\n"),
      "utf8",
    );
    const pending = h.runtime.catalog();
    h.resolveNext({ data: [] }); // app-server 重启后内存为空
    const sessions: AgentSessionSummary[] = await pending;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "019f-disk-1",
      modelProvider: "legacy",
      cwd: "D:/repo-b",
      firstMessage: "磁盘里的历史会话",
      agentKind: "codex",
    });
    expect(sessions[0]?.createdAt).toBe(Date.parse("2026-09-14T07:37:07.471Z"));
  });

  it("catalog：thread/list 失败（app-server 未就绪）时目录只剩磁盘 rollout，且活跃 thread 优先", async () => {
    const h = makeHarness();
    writeFileSync(
      join(h.rolloutRoot, "rollout-x-019f-disk-2.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "019f-disk-2", cwd: "D:/repo-c", model_provider: "disk-provider" } })}\n`,
      "utf8",
    );
    // 活跃 thread 与磁盘条目同 id：thread/list 的（信息更全）赢。
    const pending = h.runtime.catalog();
    h.resolveNext({
      data: [{ id: "019f-disk-2", cwd: "D:/repo-c", createdAt: 100, updatedAt: 200, turns: [] }],
    });
    const sessions: AgentSessionSummary[] = await pending;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.messageCount).toBe(0); // 来自 thread/list（turns=[] → 0），不是磁盘的兜底条目
    expect(sessions[0]?.modifiedAt).toBe(200_000);
    expect(sessions[0]?.modelProvider).toBe("disk-provider");

    // thread/list 整个失败：磁盘条目顶上，不抛错。
    const pending2 = h.runtime.catalog();
    h.rejectNext(new Error("app-server 未就绪"));
    const fallback: AgentSessionSummary[] = await pending2;
    expect(fallback.map((entry) => entry.sessionId)).toEqual(["019f-disk-2"]);
    expect(fallback[0]?.modelProvider).toBe("disk-provider");
  });

  it("current provider comes from configuration without activating a thread and refreshes after changes", async () => {
    const h = makeHarness();
    for (const [config, expected] of [
      [{ model_provider: "custom" }, "custom"],
      [{ model_provider: "other" }, "other"],
      [{}, "openai"],
      [{ model_provider: "effective", profile: "work", profiles: { work: { model_provider: "overridden" } } }, "effective"],
      [{ model_provider: "" }, undefined],
    ] as const) {
      const pending = h.runtime.currentProvider();
      expect(h.requests).toHaveBeenLastCalledWith("config/read", { includeLayers: false }, 5_000);
      h.resolveNext({ config });
      expect(await pending).toBe(expected);
    }
    expect(h.runtime.directoryEntries()).toEqual([]);
    const failed = h.runtime.currentProvider();
    h.rejectNext(new Error("offline"));
    expect(await failed).toBeUndefined();
    const malformed = h.runtime.currentProvider();
    h.resolveNext({});
    expect(await malformed).toBeUndefined();
  });

  it("catalog keeps live provider ownership over disk and leaves missing ownership unknown", async () => {
    const h = makeHarness();
    writeFileSync(join(h.rolloutRoot, "rollout-ownership.jsonl"), JSON.stringify({
      type: "session_meta", payload: { id: "owned", cwd: "D:/repo", model_provider: "old" },
    }));
    const pending = h.runtime.catalog();
    h.resolveNext({ data: [
      { id: "owned", cwd: "D:/repo", createdAt: 100, updatedAt: 200, modelProvider: "actual" },
      { id: "unknown", cwd: "D:/repo", createdAt: 100, updatedAt: 200 },
    ] });
    const entries = await pending;
    expect(entries.find((entry) => entry.sessionId === "owned")?.modelProvider).toBe("actual");
    expect(entries.find((entry) => entry.sessionId === "unknown")?.modelProvider).toBeUndefined();
  });

  it("activate：thread/resume 后回放 turns 条目图并发布 replace 快照", async () => {
    const h = makeHarness();
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({
      thread: {
        id: "th-1",
        cwd: "D:/repo",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              { id: "i-user", type: "userMessage", content: [{ type: "text", text: "你好" }] },
              { id: "i-agent", type: "agentMessage", text: "你好！我能帮你做什么？" },
            ],
          },
        ],
      },
    });
    await activating;
    h.runtime.handleCommand({ type: "session.sync", sessionId: "th-1", syncId: "test-preview", range: "preview" }, "test-command", "th-1");
    const snapshot = h.events.find((event) => event.type === "session.snapshot");
    expect(snapshot).toBeDefined();
    if (snapshot?.type !== "session.snapshot") return;
    expect(snapshot.mode).toBe("replace");
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({ entryId: "i-user", parentId: null, type: "message" });
    expect(snapshot.entries[1]).toMatchObject({ entryId: "i-agent", parentId: "i-user" });
  });

  it("user_message → turn/start；agentMessage/delta → message.started + message.delta；turn/completed 收尾", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    expect(h.runtime.handleCommand({ type: "user_message", text: "列出目录" })).toBe(true);
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/start", {
        threadId: "th-1",
        input: [{ type: "text", text: "列出目录" }],
      });
    });
    // App 没带 messageId 时不钉 clientUserMessageId，item 以 entry id 正常上屏。
    h.notify("turn/started", { threadId: "th-1", turn: { id: "turn-9", startedAt: 1_800_000_000 } });
    h.notify("item/agentMessage/delta", { threadId: "th-1", itemId: "msg-1", delta: "正在" });
    h.notify("item/agentMessage/delta", { threadId: "th-1", itemId: "msg-1", delta: "列目录…" });
    h.notify("item/completed", { threadId: "th-1", item: { id: "msg-1", type: "agentMessage", text: "正在列目录…" } });
    h.notify("turn/completed", { threadId: "th-1", turn: { id: "turn-9", startedAt: 1_800_000_000, durationMs: 1_234 } });

    const started = h.events.filter((event) => event.type === "message.started");
    expect(started.length).toBeGreaterThanOrEqual(1);
    const deltas = h.events.filter((event) => event.type === "message.delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ messageId: "msg-1", contentType: "text", delta: "正在" });
    const finished = h.events.find((event) => event.type === "message.finished");
    expect(finished).toMatchObject({ message: { role: "assistant", content: [{ type: "text", text: "正在列目录…" }] } });
    expect(h.events.some((event) => event.type === "turn.started" && event.turnId === "turn-9")).toBe(true);
    expect(h.events.some((event) => event.type === "turn.finished" && event.turnId === "turn-9")).toBe(true);
    const statuses = h.events.filter((event) => event.type === "runtime.status");
    expect(statuses.at(-1)).toMatchObject({ status: "idle" });
  });

  it("clientUserMessageId：userMessage item 用 App 的 messageId 上屏，落盘后映射回 entry id", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    expect(h.runtime.handleCommand({
      type: "user_message",
      text: "同一条消息",
      messageId: "live-user",
    })).toBe(true);
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/start", expect.objectContaining({
        threadId: "th-1",
        input: [{ type: "text", text: "同一条消息" }],
        clientUserMessageId: "live-user",
      }));
    });
    h.notify("turn/started", { threadId: "th-1", turn: { id: "turn-user", startedAt: 1_800_000_000 } });
    // app-server 把 clientUserMessageId 放在 item.clientId 原样带回（started + completed）。
    h.notify("item/started", {
      threadId: "th-1",
      item: { id: "entry-user", type: "userMessage", clientId: "live-user", content: [{ type: "text", text: "同一条消息" }] },
    });
    h.notify("item/completed", {
      threadId: "th-1",
      item: { id: "entry-user", type: "userMessage", clientId: "live-user", content: [{ type: "text", text: "同一条消息" }] },
    });
    h.notify("turn/completed", {
      threadId: "th-1",
      turn: { id: "turn-user", startedAt: 1_800_000_000, durationMs: 10 },
    });

    // 唯一一条用户消息事件链：started / finished 各一次，都用 App 的 messageId。
    const started = h.events.filter((event) => event.type === "message.started" && event.message?.role === "user");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ message: { messageId: "live-user", role: "user", content: [{ text: "同一条消息" }] } });
    const finished = h.events.filter((event) => event.type === "message.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      message: { messageId: "live-user", role: "user", content: [{ text: "同一条消息" }] },
    });
    const turnFinished = h.events.find((event) => event.type === "turn.finished");
    expect(turnFinished).toMatchObject({
      persistedMessages: [{ messageId: "live-user", entryId: "entry-user" }],
    });
  });

  it("旧版 app-server 未带回 clientId 时，userMessage 仍以 entry id 单条上屏", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    expect(h.runtime.handleCommand({
      type: "user_message",
      text: "旧版回退",
      messageId: "live-user",
    })).toBe(true);
    h.notify("turn/started", { threadId: "th-1", turn: { id: "turn-old", startedAt: 1_800_000_000 } });
    h.notify("item/started", {
      threadId: "th-1",
      item: { id: "entry-old", type: "userMessage", content: [{ type: "text", text: "旧版回退" }] },
    });
    h.notify("item/completed", {
      threadId: "th-1",
      item: { id: "entry-old", type: "userMessage", content: [{ type: "text", text: "旧版回退" }] },
    });
    h.notify("turn/completed", {
      threadId: "th-1",
      turn: { id: "turn-old", startedAt: 1_800_000_000, durationMs: 10 },
    });

    const started = h.events.filter((event) => event.type === "message.started" && event.message?.role === "user");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ message: { messageId: "entry-old" } });
    const turnFinished = h.events.find((event) => event.type === "turn.finished");
    expect(turnFinished).not.toHaveProperty("persistedMessages");
  });

  it("Codex 工具 item 作为对话流中的 tool_call 渲染，而不是追加到底部", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.notify("item/started", {
      threadId: "th-1",
      item: { id: "tool-1", type: "commandExecution", command: "npm test", cwd: "D:/repo" },
    });
    h.notify("item/completed", {
      threadId: "th-1",
      item: {
        id: "tool-1",
        type: "commandExecution",
        command: "npm test",
        cwd: "D:/repo",
        status: "completed",
        exitCode: 0,
      },
    });

    const started = h.events.find((event) => event.type === "message.started");
    expect(started).toMatchObject({
      message: {
        messageId: "tool-1",
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "tool-1", toolName: "commandExecution" }],
      },
    });
    const finished = h.events.find((event) => event.type === "message.finished");
    expect(finished).toMatchObject({
      message: {
        messageId: "tool-1",
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "tool-1" }],
      },
    });
    expect(h.events).toContainEqual({
      type: "tool.started",
      toolCallId: "tool-1",
      toolName: "commandExecution",
      arguments: { command: "npm test", cwd: "D:/repo" },
    });
    expect(h.events).toContainEqual({
      type: "tool.finished",
      toolCallId: "tool-1",
      toolName: "commandExecution",
      result: { status: "completed", exitCode: 0 },
      isError: false,
    });
  });

  it("Codex 工具输出增量映射为 tool.updated，MCP progress 也使用同一 toolCallId", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.notify("item/started", {
      threadId: "th-1",
      item: { id: "cmd-1", type: "commandExecution", command: "dir" },
    });
    h.notify("item/commandExecution/outputDelta", {
      threadId: "th-1",
      itemId: "cmd-1",
      delta: "file.txt\n",
    });
    h.notify("item/started", {
      threadId: "th-1",
      item: { id: "mcp-1", type: "mcpToolCall", server: "local", tool: "search" },
    });
    h.notify("item/mcpToolCall/progress", {
      threadId: "th-1",
      itemId: "mcp-1",
      message: "still working",
    });

    expect(h.events).toContainEqual({
      type: "tool.updated",
      toolCallId: "cmd-1",
      toolName: "commandExecution",
      partialResult: "file.txt\n",
    });
    expect(h.events).toContainEqual({
      type: "tool.updated",
      toolCallId: "mcp-1",
      toolName: "search",
      partialResult: "still working",
    });
  });

  it("Codex 历史工具 item 回放为相邻的 tool_call 和 tool result 消息", async () => {
    const h = makeHarness();
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({
      thread: {
        id: "th-1",
        cwd: "D:/repo",
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [{
            id: "tool-1",
            type: "commandExecution",
            command: "npm test",
            cwd: "D:/repo",
            status: "completed",
            exitCode: 0,
          }],
        }],
      },
    });
    await activating;

    h.runtime.handleCommand({ type: "session.sync", sessionId: "th-1", syncId: "test-preview", range: "preview" }, "test-command", "th-1");
    const snapshot = h.events.find((event) => event.type === "session.snapshot");
    expect(snapshot?.type).toBe("session.snapshot");
    if (snapshot?.type !== "session.snapshot") return;
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      entryId: "tool-1",
      data: {
        message: {
          messageId: "tool-1",
          role: "assistant",
          content: [{ type: "tool_call", toolCallId: "tool-1" }],
        },
      },
    });
    expect(snapshot.entries[1]).toMatchObject({
      entryId: "tool-1:result",
      parentId: "tool-1",
      data: {
        message: {
          messageId: "tool-1:result",
          role: "tool",
          toolCallId: "tool-1",
          isError: false,
        },
      },
    });
  });

  it("turn 时长取 app-server 的 durationMs（秒级 startedAt 转毫秒），不是本端时钟", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.notify("turn/started", { threadId: "th-1", turn: { id: "t-dur", startedAt: 1_800_000_000 } });
    h.notify("turn/completed", { threadId: "th-1", turn: { id: "t-dur", startedAt: 1_800_000_000, durationMs: 4_321 } });

    const started = h.events.find((event) => event.type === "turn.started");
    expect(started).toMatchObject({ turnId: "t-dur", startedAt: 1_800_000_000_000 });
    const finished = h.events.find((event) => event.type === "turn.finished");
    expect(finished).toMatchObject({ turnId: "t-dur", startedAt: 1_800_000_000_000, durationMs: 4_321 });
  });

  it("runtime.metadata 带 model（model/list 的 displayName）与 contextUsage（tokenUsage 通知）", async () => {
    const h = makeHarness({
      modelList: {
        data: [{
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          isDefault: true,
          defaultReasoningEffort: "medium",
        }],
      },
    });
    h.runtime.markStarted();
    await activate(h);
    h.events.length = 0;

    // 上下文占用只经 thread/tokenUsage/updated 来（thread 快照/ turn 通知都没有）。
    h.notify("thread/tokenUsage/updated", {
      threadId: "th-1",
      turnId: "t1",
      tokenUsage: {
        // total 是线程累计量；last 才是当前上下文对应的本轮输入量。
        total: { totalTokens: 1_400_000, inputTokens: 1_399_900, outputTokens: 100 },
        last: { totalTokens: 36_010, inputTokens: 36_000, outputTokens: 10 },
        modelContextWindow: 258_400,
      },
    });

    await vi.waitFor(() => {
      const metadata = h.events.filter((event) => event.type === "runtime.metadata").at(-1);
      expect(metadata).toBeDefined();
      if (metadata?.type !== "runtime.metadata") return;
      expect(metadata.metadata.runtimeId).toBe(`${CODEX_RUNTIME_ID}:th-1`);
      expect(metadata.metadata.model).toMatchObject({ id: "gpt-5.5", name: "GPT-5.5" });
      expect(metadata.metadata.thinkingLevel).toBe("medium");
      expect(metadata.metadata.contextUsage).toMatchObject({
        tokens: 36_000,
        contextWindow: 258_400,
      });
      // percent 由 last.inputTokens/window 推出（36_000 / 258_400 ≈ 13.94%），
      // 不能使用线程累计的 total.inputTokens。
      expect(metadata.metadata.contextUsage?.percent).toBeCloseTo(13.931, 2);
    });
  });

  it("runtime.metadata 使用会话返回的模型，而不是 app-server 默认模型", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1", { model: "gpt-5.5-codex", modelProvider: "openai" });

    const metadata = h.events.find((event) => event.type === "runtime.metadata");
    expect(metadata).toMatchObject({
      type: "runtime.metadata",
      metadata: { model: { id: "gpt-5.5-codex" } },
    });
    if (metadata?.type === "runtime.metadata") expect(metadata.metadata.model?.name).toBeUndefined();
  });

  it("电脑端切换模型后通过 thread/settings/updated 更新 APP 元数据", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h);
    h.events.length = 0;

    h.notify("thread/settings/updated", {
      threadId: "th-1",
      model: "gpt-5.5-codex",
      modelProvider: "openai",
    });

    const metadata = h.events.find((event) => event.type === "runtime.metadata");
    expect(metadata).toMatchObject({ metadata: { model: { id: "gpt-5.5-codex" } } });
  });

  it("announce：重播 capabilities + metadata（手机重连后 slash 菜单仍在）", async () => {
    const h = makeHarness();
    await activate(h, "th-1");
    h.events.length = 0;

    h.runtime.announce("th-1");
    const capabilities = h.events.find((event) => event.type === "runtime.capabilities");
    expect(capabilities).toBeDefined();
    if (capabilities?.type !== "runtime.capabilities") return;
    expect(capabilities.capabilities.commands.map((command) => command.name)).toContain("model");
    expect(h.events.some((event) => event.type === "runtime.metadata")).toBe(true);
    expect(h.runtime.activeThreadIds()).toEqual(["th-1"]);
  });

  it("审批闭环：字符串命令 → 手机选择 → app-server 确认后关闭", async () => {
    const h = makeHarness();
    await activate(h);

    const approval = h.serverRequest({
      id: "srv-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", threadId: "th-1", turnId: "t1", command: "Get-ChildItem D:/repo", cwd: "D:/repo" },
    });

    const requested = h.events.find((event) => event.type === "interaction.requested");
    expect(requested).toBeDefined();
    if (requested?.type !== "interaction.requested") return;
    expect(requested.request).toMatchObject({
      kind: "select",
      runtimeId: `${CODEX_RUNTIME_ID}:th-1`,
      extensionId: "codex",
      toolName: "commandExecution",
    });
    expect(requested.request.argumentSummary).toBe("Get-ChildItem D:/repo");

    // 手机批准 → decision=accept（respond 的结果经由 getter 读取）。
    h.runtime.handleCommand({
      type: "interaction.respond",
      requestId: requested.request.requestId,
      extensionId: "codex",
      response: { kind: "select", value: "0" },
    });
    expect(approval.result).toEqual({ decision: "accept" });
    expect(h.events.some((event) => event.type === "interaction.resolved")).toBe(false);
    h.notify("serverRequest/resolved", { threadId: "th-1", requestId: "srv-1" });
    expect(h.events.some((event) => event.type === "interaction.resolved" && event.requestId === requested.request.requestId)).toBe(true);
  });

  it("审批超时自动 decline 并广播 interaction.cancelled（防 turn 挂死）", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      await activate(h);
      h.runtime.markStarted();
      h.serverRequest({
        id: "srv-2",
        method: "item/fileChange/requestApproval",
        params: { itemId: "f-1", threadId: "th-1", turnId: "t1" },
      });
      expect(h.runtime.directoryEntries()[0]?.status).toBe("waiting_local_interaction");
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 1);
      expect(h.events.some((event) => event.type === "interaction.cancelled")).toBe(true);
      expect(h.runtime.directoryEntries()[0]?.status).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("未支持的命令返回 false（host-service 据此回 unsupported_command）", () => {
    const h = makeHarness();
    expect(h.runtime.handleCommand({ type: "file.download", path: "C:/x", offset: 0 })).toBe(false);
  });

  it("capabilities：activate 时按 thread 粒度广播 runtime.capabilities（命令词表来自后端，APP 不认 agentKind）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    expect(h.events.filter((event) => event.type === "runtime.capabilities")).toHaveLength(0);
    await activate(h, "th-1");
    const caps = h.events.filter((event) => event.type === "runtime.capabilities");
    expect(caps.length).toBeGreaterThanOrEqual(1);
    const event = caps[0];
    if (event?.type !== "runtime.capabilities") throw new Error("unreachable");
    const names = event.capabilities.commands.map((command) => command.name);
    expect(names).toContain("model");
    expect(names).toContain("compact");
    // `/tree` 已接线：选项由当前 thread 的条目图投影，动作映射到 thread/revert。
    expect(names).toContain("tree");
    // 未接线/拿不出的命令不声明（声明即承诺）。
    expect(names).not.toContain("clone");
    // `/quit` 已接线：由 Host 结束本机 TUI 进程兑现。
    expect(names).toContain("quit");
  });

  it("capabilities：必须挂在 codex:<threadId> 上（APP 按该 runtimeId 对 runtime.online 清旧值）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    // 事件出口把 threadId 交给 host-service 拼 runtimeId；capabilities 事件必须带 threadId。
    const caps = h.events.filter((event) => event.type === "runtime.capabilities");
    expect(caps.length).toBeGreaterThanOrEqual(1);
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "model", args: "m" }, "c", "th-1")).toBe(true);
    expect(h.runtime.capabilities().commands.map((c) => c.name)).toContain("model");
  });

  it("capabilities：/model 与 /thinking 发布 select 选项（二级菜单数据源）", async () => {
    const h = makeHarness({
      modelList: {
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "Frontier model",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Deep" },
            ],
          },
          { id: "secret-model", displayName: "Secret", hidden: true },
          { id: "gpt-5.4", displayName: "gpt-5.4", supportedReasoningEfforts: [] },
        ],
      },
    });
    h.runtime.markStarted();
    await vi.waitFor(() => {
      expect(h.runtime.capabilities().commands.find((c) => c.name === "model")?.argument?.kind).toBe("select");
    });
    await activate(h, "th-1");

    const model = h.runtime.capabilities().commands.find((c) => c.name === "model");
    expect(model?.argument?.kind).toBe("select");
    const modelOptions = model?.argument?.options ?? [];
    const values = modelOptions.map((o) => o.value);
    expect(values).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(values).not.toContain("secret-model"); // hidden 不上菜单
    expect(modelOptions[0]).toMatchObject({ label: "GPT-5.5", description: "Frontier model" });

    const thinking = h.runtime.capabilities().commands.find((c) => c.name === "thinking");
    expect(thinking?.argument?.kind).toBe("select");
    const thinkingOptions = thinking?.argument?.options ?? [];
    expect(thinkingOptions.map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(thinkingOptions[1]).toMatchObject({ label: "medium", description: "Balanced" });
  });

  it("capabilities：/thinking 选项跟随会话当前模型", async () => {
    const h = makeHarness({
      modelList: {
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          },
          { id: "gpt-5.4", displayName: "gpt-5.4", supportedReasoningEfforts: [{ reasoningEffort: "minimal" }] },
        ],
      },
    });
    h.runtime.markStarted();
    await activate(h, "th-1");
    // 切到 gpt-5.4：/thinking 的选项应当换成该模型支持的 minimal。
    h.runtime.handleCommand({ type: "slash.execute", name: "model", args: "gpt-5.4" }, "c-model", "th-1");
    const caps = h.events.filter((event) => event.type === "runtime.capabilities").at(-1);
    const thinking = caps?.capabilities.commands.find((c) => c.name === "thinking");
    expect((thinking?.argument?.options ?? []).map((o) => o.value)).toEqual(["minimal"]);
  });

  it("capabilities：model/list 未就绪时 /model /thinking 退回纯文本（降级不报错）", async () => {
    const h = makeHarness({ modelListFails: true });
    h.runtime.markStarted();
    await activate(h, "th-1");
    const model = h.runtime.capabilities().commands.find((c) => c.name === "model");
    expect(model?.argument?.kind).toBe("text");
  });

  it("capabilities：动态发布 Codex skills 和 MCP tools，并在同一菜单中排除 builtin 冲突", async () => {
    const h = makeHarness({
      skillsList: [{
        cwd: "D:/repo",
        errors: [],
        skills: [
          { name: "review", path: "D:/skills/review/SKILL.md", description: "Review code", enabled: true },
          { name: "compact", path: "D:/skills/compact/SKILL.md", description: "Collision", enabled: true },
        ],
      }],
      mcpServerStatusList: [{
        name: "local",
        authStatus: "unsupported",
        resourceTemplates: [],
        resources: [],
        tools: {
          search: { name: "search", description: "Search files", inputSchema: {} },
        },
      }],
    });
    await activate(h);
    await vi.waitFor(() => {
      expect(h.runtime.capabilities().commands.some((command) => command.name === "review")).toBe(true);
    });

    const commands = h.runtime.capabilities().commands;
    expect(commands).toContainEqual(expect.objectContaining({
      name: "review",
      source: "skill",
      argument: { kind: "text", required: false, hint: "[arguments]" },
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      name: "mcp:local:search",
      source: "mcp",
      description: "Search files",
    }));
    expect(commands.filter((command) => command.name === "compact")).toHaveLength(1);
  });

  it("slash.execute 动态 skill 使用 Codex skill input，MCP command 调用 mcpServer/tool/call", async () => {
    const h = makeHarness({
      skillsList: [{
        cwd: "D:/repo",
        errors: [],
        skills: [{ name: "review", path: "D:/skills/review/SKILL.md", description: "Review", enabled: true }],
      }],
      mcpServerStatusList: [{
        name: "local",
        authStatus: "unsupported",
        resourceTemplates: [],
        resources: [],
        tools: { search: { name: "search", inputSchema: {} } },
      }],
    });
    await activate(h);
    await vi.waitFor(() => {
      expect(h.runtime.capabilities().commands.some((command) => command.name === "review")).toBe(true);
    });

    expect(h.runtime.handleCommand({
      type: "slash.execute",
      name: "mcp:local:search",
      args: '{"query":"TODO"}',
    }, "c-mcp", "th-1")).toBe(true);
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("mcpServer/tool/call", {
        threadId: "th-1",
        server: "local",
        tool: "search",
        arguments: { query: "TODO" },
      });
    });

    expect(h.runtime.handleCommand({ type: "slash.execute", name: "review", args: "changed files" }, "c-skill", "th-1")).toBe(true);
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/start", expect.objectContaining({
        threadId: "th-1",
        input: [
          { type: "skill", name: "review", path: "D:/skills/review/SKILL.md" },
          { type: "text", text: "changed files" },
        ],
      }));
    });
  });

  it("slash.execute /model：写会话级覆盖，随后 turn/start 带 model", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "model", args: "gpt-5.5" }, "c-model", "th-1")).toBe(true);
    // /model 立刻回成功回执。
    expect(h.events).toContainEqual({ type: "command.result", commandId: "c-model", ok: true });
    h.runtime.dispatchCommand(`${CODEX_RUNTIME_ID}:th-1`, "c-msg", { type: "user_message", text: "hi" });
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/start", {
        threadId: "th-1",
        input: [{ type: "text", text: "hi" }],
        model: "gpt-5.5",
      });
    });
  });

  it("slash.execute /model：模型表已缓存时拒绝未知 id（手输路径的早报错）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "model", args: "no-such-model" }, "c-bad", "th-1")).toBe(true);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "command.result", commandId: "c-bad", ok: false, status: "failure" }),
    );
  });

  it("slash.execute /thinking：会话级 effort 随 turn/start 带上", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    h.runtime.handleCommand({ type: "slash.execute", name: "thinking", args: "high" }, "c-th", "th-1");
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "runtime.metadata",
      metadata: expect.objectContaining({ thinkingLevel: "high" }),
    }));
    h.runtime.dispatchCommand(`${CODEX_RUNTIME_ID}:th-1`, "c-msg", { type: "user_message", text: "hi" });
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/start", {
        threadId: "th-1",
        input: [{ type: "text", text: "hi" }],
        effort: "high",
      });
    });
  });

  it("slash.execute /name：走 thread/name/set；无参时不写库、直接回成功", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    // 无参查询：不产生 RPC，直接成功回执。
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "name", args: "" }, "c-name0", "th-1")).toBe(true);
    expect(h.requests).not.toHaveBeenCalledWith("thread/name/set", expect.anything() as unknown);
    // 有参：发 thread/name/set。
    h.runtime.handleCommand({ type: "slash.execute", name: "name", args: "改名" }, "c-name1", "th-1");
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("thread/name/set", { threadId: "th-1", name: "改名" });
    });
  });

  it("slash.execute /compact：走 thread/compact/start", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "compact", args: "" }, "c-cmp", "th-1")).toBe(true);
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("thread/compact/start", { threadId: "th-1" });
    });
  });

  it("slash.execute /new：新起一条 thread 并进目录", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "new", args: "" }, "c-new", "th-1")).toBe(true);
    h.resolveNext({ thread: { id: "th-2", cwd: "D:/repo", turns: [] } });
    await vi.waitFor(() => {
      expect(h.runtime.directoryEntries().map((entry) => entry.sessionId)).toContain("th-2");
    });
  });

  it("slash.execute /fork：走 thread/fork 得到新 thread", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "fork", args: "" }, "c-fork", "th-1")).toBe(true);
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("thread/fork", { threadId: "th-1" });
    });
    h.resolveNext({ thread: { id: "th-fork", cwd: "D:/repo", turns: [] } });
    await vi.waitFor(() => {
      expect(h.runtime.directoryEntries().map((entry) => entry.sessionId)).toContain("th-fork");
    });
  });

  /** 带真实 turns 的激活：/tree 的数据源是条目图，空 turns 测不出东西。 */
  async function activateWithTurns(
    h: ReturnType<typeof makeHarness>,
    turns: unknown[],
  ): Promise<void> {
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-1" });
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo", turns } });
    await activating;
  }

  const TREE_TURNS = [
    {
      id: "turn-1",
      items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "第一条问题" }] },
        { type: "commandExecution", id: "c1", command: "ls", status: "completed" },
        { type: "agentMessage", id: "a1", text: "第一条回答" },
      ],
    },
    {
      id: "turn-2",
      items: [
        { type: "userMessage", id: "u2", content: [{ type: "text", text: "第二条问题" }] },
        { type: "agentMessage", id: "a2", text: "第二条回答" },
      ],
    },
  ];

  it("capabilities：/tree 的选项来自当前 thread 的条目图（轮次链 + 当前位置 + 工具默认折叠）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activateWithTurns(h, TREE_TURNS);

    const tree = h.runtime.capabilities().commands.find((command) => command.name === "tree");
    expect(tree?.argument?.kind).toBe("tree");
    const options = tree?.argument?.options ?? [];
    // 预序的线性链：工具调用及其结果都各自成条目。
    expect(options.map((option) => option.value)).toEqual(["u1", "c1", "c1:result", "a1", "u2", "a2"]);
    expect(options[0]).toMatchObject({
      value: "u1",
      tree: { parentId: null, role: "user", defaultHidden: false, isCurrent: false, isOnActivePath: true },
    });
    // 工具条目用 Pi 的词表 role=toolResult，APP 才会归到「工具」并收进细节。
    expect(options.find((option) => option.value === "c1")).toMatchObject({
      tree: { parentId: "u1", role: "toolResult", defaultHidden: true },
    });
    // 线性链上每个节点的父节点就是前一条；当前位置只落在最后一条。
    expect(options.at(-1)).toMatchObject({
      value: "a2",
      tree: { parentId: "u2", role: "assistant", defaultHidden: false, isCurrent: true },
    });
  });

  it("slash.execute /tree <用户消息>：原地 revert 到该轮之前，并回传原文（编辑这条消息并重新开始）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activateWithTurns(h, TREE_TURNS);

    expect(h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "u2" }, "c-tree", "th-1")).toBe(true);
    await vi.waitFor(() => {
      // 用户消息：丢掉这一轮及其之后；原地截断，不派生新会话。
      expect(h.requests).toHaveBeenCalledWith("thread/revert", { threadId: "th-1", beforeTurnId: "turn-2" });
    });
    // revert 的响应不带 turns，历史得自己重新拉一遍。
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo" } });
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("thread/turns/list", {
        threadId: "th-1",
        itemsView: "full",
        sortDirection: "asc",
        limit: 200,
      });
    });
    h.resolveNext({ data: [TREE_TURNS[0]] });
    await vi.waitFor(() => {
      expect(h.events).toContainEqual({
        type: "command.result",
        commandId: "c-tree",
        ok: true,
        status: "success",
        result: { editorText: "第二条问题" },
      });
    });
  });

  it("slash.execute /tree <助手回复>：原地 revert 到它的下一轮，不带原文（从这条回复后继续）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activateWithTurns(h, TREE_TURNS);

    expect(h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "a1" }, "c-tree", "th-1")).toBe(true);
    await vi.waitFor(() => {
      // a1 属于 turn-1：保留到这一轮，就是从 turn-2 起丢掉。
      expect(h.requests).toHaveBeenCalledWith("thread/revert", { threadId: "th-1", beforeTurnId: "turn-2" });
    });
    h.resolveNext({ thread: { id: "th-1", cwd: "D:/repo" } });
    await vi.waitFor(() => expect(h.requests).toHaveBeenCalledWith("thread/turns/list", expect.anything()));
    h.resolveNext({ data: [TREE_TURNS[0]] });
    await vi.waitFor(() => {
      expect(h.events).toContainEqual({
        type: "command.result",
        commandId: "c-tree",
        ok: true,
        status: "success",
      });
    });
  });

  it("slash.execute /tree <最后一条回复>：历史已经停在这一点，不发任何 RPC", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activateWithTurns(h, TREE_TURNS);

    // a2 属于最后一轮 turn-2：没有"下一轮"可丢，回执成功即可。
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "a2" }, "c-tree", "th-1")).toBe(true);
    expect(h.events).toContainEqual({ type: "command.result", commandId: "c-tree", ok: true, status: "success" });
    expect(h.requests.mock.calls.some(([method]) => method === "thread/revert")).toBe(false);
  });

  it("slash.execute /tree 未知节点：回失败且不发 revert（不猜轮次边界）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activateWithTurns(h, TREE_TURNS);

    expect(h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "nope" }, "c-tree", "th-1")).toBe(true);
    expect(h.events).toContainEqual({
      type: "command.result",
      commandId: "c-tree",
      ok: false,
      status: "failure",
      error: "未知的历史节点 nope",
    });
    expect(h.requests.mock.calls.some(([method]) => method === "thread/revert")).toBe(false);
  });

  it("slash.execute /tree 无参：只回成功（选项已经随 capabilities 发下去了）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activateWithTurns(h, TREE_TURNS);

    expect(h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "" }, "c-tree", "th-1")).toBe(true);
    expect(h.events).toContainEqual({ type: "command.result", commandId: "c-tree", ok: true, status: "success" });
    expect(h.requests.mock.calls.some(([method]) => method === "thread/revert")).toBe(false);
  });

  it("slash.execute /quit：结束本机 TUI 进程并让该 thread 下线", async () => {
    const endpoint = "ws://127.0.0.1:9996";
    const queue: Array<{ resolve: (v: unknown) => void }> = [];
    const server = {
      request: (method: string) => method === "model/list"
        ? Promise.resolve({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] })
        : new Promise((res) => queue.push({ resolve: res })),
      notify: vi.fn(),
      endpoint,
    } as unknown as CodexAppServer;
    const events: RuntimeEvent[] = [];
    const kills: Array<{ sessionId: string; endpoint: string }> = [];
    const removed: { reason: string; runtimes: unknown[] }[] = [];
    const runtime = new CodexRuntime({
      server,
      onEvent: (event) => events.push(event),
      rolloutRoot: mkdtempSync(join(tmpdir(), "pi-remote-codex-quit-")),
      openHeadWindow: () => {},
      killTuiProcesses: ({ sessionId, endpoint: target }) => {
        kills.push({ sessionId, endpoint: target });
        return Promise.resolve(true);
      },
    });
    runtime.markStarted();
    runtime.onOffline = (reason, runtimes) => { removed.push({ reason, runtimes }); };
    const activating = runtime.activate({ type: "resume", sessionId: "th-quit" });
    queue.shift()!.resolve({ thread: { id: "th-quit", cwd: "D:/repo", turns: [{ id: "t1", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] }] }] } });
    await activating;

    expect(runtime.handleCommand({ type: "slash.execute", name: "quit", args: "" }, "c-quit", "th-quit")).toBe(true);
    // 结束的是这个 thread 的 TUI（sessionId + 本 app-server 端点），不是别的会话。
    await vi.waitFor(() => expect(kills).toEqual([{ sessionId: "th-quit", endpoint }]));
    await vi.waitFor(() => expect(removed).toHaveLength(1));
    expect(events).toContainEqual({ type: "command.result", commandId: "c-quit", ok: true, status: "success" });
    expect(removed[0]!.reason).toContain("/quit");
    expect(removed[0]!.runtimes[0]).toMatchObject({ runtimeId: "codex:th-quit" });
    expect(runtime.directoryEntries()).toEqual([]);
  });

  it("slash.execute 未声明的命令（如 clone）：返回 false → unsupported_command", () => {
    const h = makeHarness();
    h.runtime.markStarted();
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "clone", args: "" })).toBe(false);
  });

  it("slash.execute 缺会话（/model 无活跃 thread）：回 command.result 失败", () => {
    const h = makeHarness();
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "model", args: "x" }, "c1")).toBe(true);
    expect(h.events).toContainEqual({ type: "command.result", commandId: "c1", ok: false, status: "failure", error: "没有活跃的 Codex 会话，请重新激活" });
  });

  it("实现 AgentBackend 端口：kind/isReady/ownsRuntime/directoryEntries 的空壳语义", () => {
    const h = makeHarness();
    expect(h.runtime.kind).toBe("codex");
    expect(h.runtime.isReady()).toBe(false);
    expect(h.runtime.ownsRuntime("codex")).toBe(true);
    expect(h.runtime.ownsRuntime("codex:th-1")).toBe(true);
    expect(h.runtime.ownsRuntime("pi-something")).toBe(false);
    // 没启动/没活跃 thread：空壳不进进程目录（§8.1）。
    expect(h.runtime.directoryEntries()).toEqual([]);
    h.runtime.markStarted();
    expect(h.runtime.isReady()).toBe(true);
    expect(h.runtime.directoryEntries()).toEqual([]);
  });

  it("多 thread 并发：每个活跃 thread 一条进程目录条目，runtimeId 为 codex:<threadId>", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    await activate(h, "th-2");
    const entries = h.runtime.directoryEntries();
    expect(entries.map((entry) => entry.runtimeId)).toEqual([
      `${CODEX_RUNTIME_ID}:th-1`,
      `${CODEX_RUNTIME_ID}:th-2`,
    ]);
    expect(entries.map((entry) => entry.sessionId)).toEqual(["th-1", "th-2"]);
    expect(entries.every((entry) => entry.cwd === "D:/repo")).toBe(true);
    // 命令按 per-thread runtimeId 路由到对应 thread。
    expect(h.runtime.dispatchCommand(`${CODEX_RUNTIME_ID}:th-2`, "c1", { type: "user_message", text: "给二号" })).toBe("handled");
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/start", {
        threadId: "th-2",
        input: [{ type: "text", text: "给二号" }],
      });
    });
  });

  it("session.sync 回显请求的 syncId（快照按 syncId 关联，自造 id 会被手机丢弃）", async () => {
    const h = makeHarness();
    h.runtime.markStarted();
    await activate(h, "th-1");
    h.events.length = 0;
    expect(h.runtime.handleCommand(
      { type: "session.sync", sessionId: "th-1", syncId: "phone-sync-42", range: "preview" },
      "cmd-1",
      "th-1",
    )).toBe(true);
    const snapshot = h.events.find((event) => event.type === "session.snapshot");
    expect(snapshot).toMatchObject({ sessionId: "th-1", syncId: "phone-sync-42", mode: "replace" });
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "command.result",
      commandId: "cmd-1",
      ok: true,
    }));
  });

  it("旧格式 thread：resume 只给空 turns 时读磁盘 rollout 重建条目图（PascalCase 归一化）", async () => {
    const h = makeHarness();
    mkdirSync(join(h.rolloutRoot, "2026", "07", "17"), { recursive: true });
    writeFileSync(
      join(h.rolloutRoot, "2026", "07", "17", "rollout-2026-07-17T21-58-40-th-old.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "th-old", cwd: "D:/repo" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "item_completed", thread_id: "th-old", turn_id: "t1", item: { type: "UserMessage", id: "item-1", content: [{ type: "text", text: "旧会话的提问" }] } },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "item_completed", thread_id: "th-old", turn_id: "t1", item: { type: "AgentMessage", id: "item-2", content: [{ type: "Text", text: "旧会话的回答" }] } },
        }),
      ].join("\n"),
      "utf8",
    );
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-old" });
    // 旧格式：turns 存在但 items 全空（app-server 不为旧 rollout 注水）。
    h.resolveNext({ thread: { id: "th-old", cwd: "D:/repo", turns: [{ id: "t1", status: "completed", items: [] }] } });
    await activating;
    h.runtime.handleCommand({ type: "session.sync", sessionId: "th-old", syncId: "test-preview", range: "preview" }, "test-command", "th-old");
    const snapshot = h.events.find((event) => event.type === "session.snapshot");
    expect(snapshot?.type === "session.snapshot" ? snapshot.entries.map((entry) => entry.entryId) : []).toEqual(["item-1", "item-2"]);
    // 归一化后正常映射成消息；助手消息的文本从 content[].type="Text"（大写 T）里取回——
    // 旧实现只读 item.text，会得到空串（历史里只剩用户、没有助手）。
    const graph = h.events.find((event) => event.type === "session.snapshot");
    if (graph?.type !== "session.snapshot") return;
    expect(graph.entries[0]).toMatchObject({ data: { message: { role: "user", content: [{ type: "text", text: "旧会话的提问" }] } } });
    expect(graph.entries[1]).toMatchObject({ data: { message: { role: "assistant", content: [{ type: "text", text: "旧会话的回答" }] } } });
  });

  it("旧格式 thread 也开有头窗口（在线必须绑定 TUI 窗口在，否则「没 TUI 却在线」）", async () => {
    const rolloutRoot = mkdtempSync(join(tmpdir(), "pi-remote-codex-oldwin-"));
    mkdirSync(join(rolloutRoot, "2026", "07", "17"), { recursive: true });
    writeFileSync(
      join(rolloutRoot, "2026", "07", "17", "rollout-2026-07-17T21-58-40-th-old.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "th-old", cwd: "D:/repo" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "item_completed", thread_id: "th-old", turn_id: "t1", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "q" }] } } }),
      ].join("\n"),
      "utf8",
    );
    const queue: Array<{ resolve: (v: unknown) => void }> = [];
    const server = { request: (method: string) => method === "model/list" ? Promise.resolve({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] }) : new Promise((res) => queue.push({ resolve: res })), notify: vi.fn(), endpoint: "ws://127.0.0.1:9999" } as unknown as CodexAppServer;
    const opened: string[] = [];
    const runtime = new CodexRuntime({
      server,
      onEvent: () => {},
      rolloutRoot,
      openHeadWindow: ({ sessionId }) => { opened.push(sessionId); },
    });
    runtime.markStarted();
    const activating = runtime.activate({ type: "resume", sessionId: "th-old" });
    // 旧格式：turns 存在但 items 全空。
    queue.shift()!.resolve({ thread: { id: "th-old", cwd: "D:/repo", turns: [{ id: "t1", items: [] }] } });
    await activating;
    expect(opened).toEqual(["th-old"]); // 旧格式也开窗：在线⇔有 TUI
  });

  it("新格式 thread（turns 带 items）正常开有头窗口", async () => {
    const rolloutRoot = mkdtempSync(join(tmpdir(), "pi-remote-codex-openwin-"));
    const queue: Array<{ resolve: (v: unknown) => void }> = [];
    const server = { request: (method: string) => method === "model/list" ? Promise.resolve({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] }) : new Promise((res) => queue.push({ resolve: res })), notify: vi.fn(), endpoint: "ws://127.0.0.1:9998" } as unknown as CodexAppServer;
    const opened: string[] = [];
    const runtime = new CodexRuntime({
      server,
      onEvent: () => {},
      rolloutRoot,
      openHeadWindow: ({ sessionId }) => { opened.push(sessionId); },
    });
    runtime.markStarted();
    const activating = runtime.activate({ type: "resume", sessionId: "th-new" });
    // 新格式：turn 带 item，#replayTurns 能填出条目 → 不是旧格式 → 开窗。
    queue.shift()!.resolve({ thread: { id: "th-new", cwd: "D:/repo", turns: [{ id: "t1", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] }] }] } });
    await activating;
    expect(opened).toEqual(["th-new"]);
  });

  it("TUI 窗口关闭 → 该 thread 下线（onOffline 广播 + 目录移除）", async () => {
    const rolloutRoot = mkdtempSync(join(tmpdir(), "pi-remote-codex-closewin-"));
    const queue: Array<{ resolve: (v: unknown) => void }> = [];
    const server = { request: (method: string) => method === "model/list" ? Promise.resolve({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] }) : new Promise((res) => queue.push({ resolve: res })), notify: vi.fn(), endpoint: "ws://127.0.0.1:9997" } as unknown as CodexAppServer;
    // 看门狗：先回报「TUI 在线」（标 seen），再回报「空」（触发下线）。
    const pollResults: Set<string>[] = [new Set(["th-close"]), new Set()];
    let watcherTick: () => void = () => {};
    const origSetInterval = globalThis.setInterval;
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((fn: () => void) => { watcherTick = fn; return 0 as unknown as NodeJS.Timeout; }) as typeof setInterval;
    const removed: { reason: string; runtimes: unknown[] }[] = [];
    let afterRemoveDirectory: unknown[] = [];
    const runtime = new CodexRuntime({
      server,
      onEvent: () => {},
      rolloutRoot,
      openHeadWindow: () => {},
      pollTuiProcesses: () => Promise.resolve(pollResults.shift() ?? new Set<string>()),
    });
    runtime.markStarted();
    runtime.onOffline = (reason, runtimes) => { removed.push({ reason, runtimes }); };
    runtime.onMetadataChange = () => { afterRemoveDirectory = runtime.directoryEntries(); };
    const activating = runtime.activate({ type: "resume", sessionId: "th-close" });
    queue.shift()!.resolve({ thread: { id: "th-close", cwd: "D:/repo", turns: [{ id: "t1", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] }] }] } });
    await activating;
    (globalThis as { setInterval: typeof setInterval }).setInterval = origSetInterval;
    const flush = () => new Promise((r) => setTimeout(r, 20));
    // 第一次 tick：TUI 在线 → 标 seen，不应下线。
    watcherTick();
    await flush();
    expect(removed).toEqual([]);
    // 第二次 tick：TUI 没了 → 下线广播 + 目录清空。
    watcherTick();
    await flush();
    expect(removed).toHaveLength(1);
    expect(removed[0]!.reason).toContain("已关闭");
    expect(removed[0]!.runtimes[0]).toMatchObject({ runtimeId: "codex:th-close" });
    expect(afterRemoveDirectory).toEqual([]);
  });

  it("turn 进行中收到 followUp：入队（message.queued accepted），turn/completed 后补跑", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.runtime.handleCommand({ type: "user_message", text: "第一条" }, "c1");
    h.notify("turn/started", { threadId: "th-1", turn: { id: "turn-1", startedAt: 1_800_000_000 } });

    h.runtime.handleCommand(
      { type: "user_message", text: "第二条", messageId: "q1", delivery: "followUp" },
      "c2",
    );
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "message.queued",
      queueId: "q1",
      delivery: "followUp",
      state: "accepted",
    }));

    h.notify("turn/completed", { threadId: "th-1", turn: { id: "turn-1", startedAt: 1_800_000_000, durationMs: 1_234 } });
    await vi.waitFor(() => {
      // 排队消息补跑时同样钉 clientUserMessageId，气泡仍以 App 的 messageId 上屏。
      expect(h.requests).toHaveBeenCalledWith("turn/start", expect.objectContaining({
        threadId: "th-1",
        input: [{ type: "text", text: "第二条" }],
        clientUserMessageId: "q1",
      }));
    });
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "message.queued",
      queueId: "q1",
      state: "delivered",
    }));
  });

  it("turn 进行中收到无 delivery 的消息：拒绝并回 command.result（runtime_busy）", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.runtime.handleCommand({ type: "user_message", text: "占用中" }, "c1");
    h.notify("turn/started", { threadId: "th-1", turn: { id: "turn-1", startedAt: 1_800_000_000 } });
    h.runtime.handleCommand({ type: "user_message", text: "插不进来" }, "c2");

    expect(h.events).toContainEqual(expect.objectContaining({
      type: "command.result",
      commandId: "c2",
      ok: false,
      error: "runtime_busy",
    }));
  });

  it("steer：打断当前 turn 并插队，turn/completed 后立即开跑插队的消息", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.runtime.handleCommand({ type: "user_message", text: "跑偏了" }, "c1");
    h.notify("turn/started", { threadId: "th-1", turn: { id: "turn-1", startedAt: 1_800_000_000 } });

    h.runtime.handleCommand(
      { type: "user_message", text: "纠正方向", messageId: "s1", delivery: "steer" },
      "c2",
    );
    // steer 立即打断当前 turn。
    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/interrupt", { threadId: "th-1", turnId: "turn-1" });
    });
    h.notify("turn/completed", { threadId: "th-1", turn: { id: "turn-1", startedAt: 1_800_000_000, durationMs: 1_234 } });

    await vi.waitFor(() => {
      expect(h.requests).toHaveBeenCalledWith("turn/start", {
        threadId: "th-1",
        input: [{ type: "text", text: "纠正方向" }],
        clientUserMessageId: "s1",
      });
    });
  });

  it("user_message.cancel 撤回排队消息：message.queued cancelled + command.result", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.runtime.handleCommand({ type: "user_message", text: "占用中" }, "c1");
    h.notify("turn/started", { threadId: "th-1", turn: { id: "turn-1", startedAt: 1_800_000_000 } });
    h.runtime.handleCommand(
      { type: "user_message", text: "反悔了", messageId: "q9", delivery: "followUp" },
      "c2",
    );
    h.runtime.handleCommand({ type: "user_message.cancel", messageId: "q9" }, "c3");

    expect(h.events).toContainEqual(expect.objectContaining({
      type: "message.queued",
      queueId: "q9",
      state: "cancelled",
    }));
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "command.result",
      commandId: "c3",
      ok: true,
      status: "cancelled",
    }));

    // turn 结束后不再补跑被撤回的消息。
    h.notify("turn/completed", { threadId: "th-1", turn: { id: "turn-1", startedAt: 1_800_000_000, durationMs: 1_234 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.requests).not.toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [{ type: "text", text: "反悔了" }],
    }));
  });

  it("turn/start 失败：回 command.result 失败 + isError 的 message.finished", async () => {
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;

    h.runtime.handleCommand({ type: "user_message", text: "会失败的" }, "c-err");
    // 在途请求就是刚才的 turn/start：让它失败。
    h.rejectNext(new Error("boom"));
    await vi.waitFor(() => {
      expect(h.events).toContainEqual(expect.objectContaining({
        type: "command.result",
        commandId: "c-err",
        ok: false,
      }));
    });
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "message.finished",
      message: expect.objectContaining({ role: "user", isError: true }),
    }));
  });

  it("app-server 退出：thread 清空、isReady 落回 false、onOffline 收到原因与退出前目录", async () => {
    const h = makeHarness();
    const offline: Array<{ reason: string; runtimes: string[] }> = [];
    h.runtime.onOffline = (reason, runtimes) => offline.push({ reason, runtimes: runtimes.map((r) => r.runtimeId) });
    await activate(h);
    h.runtime.markStarted();
    expect(h.runtime.hasActiveThread).toBe(true);

    (h.server.onExit as (code: number | null) => void)(1);
    expect(h.runtime.hasActiveThread).toBe(false);
    expect(h.runtime.isReady()).toBe(false);
    expect(offline).toHaveLength(1);
    expect(offline[0]?.reason).toContain("已退出");
    expect(offline[0]?.runtimes).toEqual([`${CODEX_RUNTIME_ID}:th-1`]);
  });
});

/**
 * 有头窗口的启动命令是纯拼接，不必真开窗：把 `-EncodedCommand` 解回来断言，
 * 这也正是 wt 实际收到的内容。
 */
describe("codexHeadWindowLaunch", () => {
  const sessionId = "01a0a5f7-632e-7182-9269-42cf23932203";
  const launch = codexHeadWindowLaunch({ cwd: "D:/repo", sessionId, endpoint: "ws://127.0.0.1:58322" });
  const script = Buffer.from(launch.args[launch.args.length - 1] ?? "", "base64").toString("utf16le");

  it("走 wt + -EncodedCommand（带空格的 -Command 会被 wt 重拼引号）", () => {
    expect(launch.command).toBe("wt.exe");
    expect(launch.args.slice(0, 3)).toEqual(["-d", "D:/repo", "powershell"]);
    expect(launch.args).toContain("-EncodedCommand");
  });

  it("窗口壳不带 -NoExit：codex 退出后窗口必须跟着走，不留残壳窗", () => {
    expect(launch.args).not.toContain("-NoExit");
    // 必须 `exit 0`：WT 的 closeOnExit 缺省只对退出码 0 关窗格。
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("先等 rollout 落盘再 attach 到本 app-server 的 thread", () => {
    expect(script).toContain("Get-ChildItem");
    expect(script).toContain(`'*${sessionId}*'`);
    expect(script).toContain(`codex resume '${sessionId}' --remote 'ws://127.0.0.1:58322'`);
  });

  it("使用 app-server 的精确 CLI 入口，避免 PATH 上的旧 Codex 被 TUI 选中", () => {
    const exact = codexHeadWindowLaunch({
      cwd: "D:/repo",
      sessionId,
      endpoint: "ws://127.0.0.1:58322",
      codexCommand: {
        command: "C:/nvm4w/nodejs/node.exe",
        prefixArgs: ["C:/nvm4w/nodejs/node_modules/@openai/codex/bin/codex.js"],
      },
    });
    const exactScript = Buffer.from(exact.args.at(-1) ?? "", "base64").toString("utf16le");
    expect(exactScript).toContain(
      `& 'C:/nvm4w/nodejs/node.exe' 'C:/nvm4w/nodejs/node_modules/@openai/codex/bin/codex.js' resume '${sessionId}'`,
    );
    expect(exactScript).not.toContain("Get-Command codex");
  });

  it("只有「找不到 codex」才留在原地报错（不闪退）", () => {
    expect(script).toContain("Get-Command codex");
    expect(script).toContain("Read-Host");
  });
});

/**
 * TUI 切换会话检测（/new → thread/started、/resume → thread/status/changed 广播）：
 * 假 app-server 广播通知，Host 应把旧会话下线、新会话收编，并把窗口 key 过户给新
 * thread（看门狗 / /quit 继续按 argv 里的原始 sessionId 找进程）。
 */
describe("CodexRuntime TUI 切换会话", () => {
  const GRACE_MS = 5;
  const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  /** 与 makeHarness 同思路，但带 endpoint + openHeadWindow 注入（切换检测的前提是有窗口）。 */
  function makeSwitchHarness() {
    const events: RuntimeEvent[] = [];
    const queue: Array<{ resolve: (v: unknown) => void }> = [];
    const opened: string[] = [];
    const offline: { reason: string; runtimeIds: string[] }[] = [];
    const pollResults: Set<string>[] = [];
    const server = {
      request: (method: string): Promise<unknown> => {
        if (method === "model/list") {
          return Promise.resolve({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] });
        }
        if (method === "skills/list" || method === "mcpServerStatus/list") return Promise.resolve({ data: [] });
        return new Promise((resolve) => queue.push({ resolve }));
      },
      notify: vi.fn(),
      endpoint: "ws://127.0.0.1:9931",
    } as unknown as CodexAppServer;
    const rolloutRoot = mkdtempSync(join(tmpdir(), "pi-remote-codex-switch-"));
    // 捕获看门狗 tick：#startHeadWatcher 在 activate 内部调用，覆盖窗必须盖到那之后。
    let watcherTick: () => void = () => {};
    const origSetInterval = globalThis.setInterval;
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((fn: () => void) => {
      watcherTick = fn;
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setInterval;
    const runtime = new CodexRuntime({
      server,
      onEvent: (event) => events.push(event),
      rolloutRoot,
      openHeadWindow: ({ sessionId }) => { opened.push(sessionId); },
      pollTuiProcesses: () => Promise.resolve(pollResults.shift() ?? new Set(["th-1"])),
      tuiSwitchGraceMs: GRACE_MS,
    });
    runtime.markStarted();
    runtime.onOffline = (reason, runtimes) => {
      offline.push({ reason, runtimeIds: runtimes.map((r) => r.runtimeId) });
    };
    const notify = (method: string, params: unknown) => {
      (server.onNotification as unknown as (m: string, p: unknown) => void)(method, params);
    };
    const activateDefault = async () => {
      const activating = runtime.activate({ type: "resume", sessionId: "th-1" });
      queue.shift()!.resolve({
        thread: {
          id: "th-1",
          cwd: "D:/repo",
          turns: [{ id: "t1", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] }] }],
        },
      });
      await activating;
      (globalThis as { setInterval: typeof setInterval }).setInterval = origSetInterval;
    };
    return { runtime, events, queue, offline, opened, pollResults, notify, activateDefault, watcher: () => watcherTick() };
  }

  it("TUI /new（thread/started 广播）→ 旧会话下线、新会话收编且不重开窗口", async () => {
    const h = makeSwitchHarness();
    await h.activateDefault();
    expect(h.opened).toEqual(["th-1"]);
    h.events.length = 0;

    // ephemeral 线程（标题生成、/side、review fork、临时子代理）不算切换：它 path=null、
    // 不收 thread/turns/list，收编过去会让手机连到一个拉不出历史的空会话、真会话被下线。
    h.notify("thread/started", { thread: { id: "th-title", cwd: "D:/repo", ephemeral: true, path: null } });
    await flush();
    expect(h.offline).toEqual([]);
    expect(h.queue).toEqual([]); // 连探询都不用发
    expect(h.events).toEqual([]);

    // TUI 在窗口里 /new：广播 thread/started（带完整 thread 对象，含 cwd）。
    h.notify("thread/started", { thread: { id: "th-tui-new", cwd: "D:/repo2" } });
    // 宽限窗口后：cwd 来自广播，无需 thread/list；第一笔在途请求是 thread/turns/list。
    await vi.waitFor(() => {
      expect(h.queue.length).toBeGreaterThan(0);
    });
    h.queue.shift()!.resolve({
      data: [{ id: "t9", items: [{ type: "userMessage", id: "u9", content: [{ type: "text", text: "TUI 里说的" }] }] }],
    });
    await flush();

    expect(h.offline).toHaveLength(1);
    expect(h.offline[0]!.reason).toContain("已切换");
    expect(h.offline[0]!.runtimeIds).toEqual(["codex:th-1"]);
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "runtime.metadata",
      metadata: expect.objectContaining({ runtimeId: "codex:th-tui-new", cwd: "D:/repo2" }),
    }));
    expect(h.events.some((event) => event.type === "session.snapshot")).toBe(false);
    // 不重开窗口：窗口就是原来那个。
    expect(h.opened).toEqual(["th-1"]);

    // 窗口 key 过户：看门狗按 argv 里的原始 id（th-1）判存活。先在（不下线）后无（下线）。
    h.watcher();
    await flush();
    expect(h.offline).toHaveLength(1);
    h.pollResults.push(new Set());
    h.watcher();
    await flush();
    expect(h.offline).toHaveLength(2);
    expect(h.offline[1]!.runtimeIds).toEqual(["codex:th-tui-new"]);
  });

  it("TUI /resume（thread/status/changed 广播）→ cwd 问 thread/list，收编同上", async () => {
    const h = makeSwitchHarness();
    await h.activateDefault();
    h.events.length = 0;

    h.notify("thread/status/changed", { threadId: "th-other", status: { kind: "idle" } });
    await vi.waitFor(() => {
      expect(h.queue.length).toBeGreaterThan(0);
    });
    // 第一笔在途请求是 thread/list（cwd 探询；广播里只有 threadId）。
    h.queue.shift()!.resolve({
      data: [{ id: "th-other", cwd: "D:/repo3", createdAt: 1, updatedAt: 2, turns: [] }],
    });
    await vi.waitFor(() => {
      expect(h.queue.length).toBeGreaterThan(0);
    });
    h.queue.shift()!.resolve({ data: [] }); // thread/turns/list：空历史
    await flush();

    expect(h.offline).toHaveLength(1);
    expect(h.offline[0]!.runtimeIds).toEqual(["codex:th-1"]);
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "runtime.metadata",
      metadata: expect.objectContaining({ runtimeId: "codex:th-other", cwd: "D:/repo3" }),
    }));
  });

  it("Host 自己 activate 的广播不误判：宽限窗口内被收编的 thread 忽略", async () => {
    const h = makeSwitchHarness();
    const activating = h.runtime.activate({ type: "resume", sessionId: "th-2" });
    // 广播先于 RPC 响应到达（此刻 th-2 还没进 #threads）。
    h.notify("thread/started", { thread: { id: "th-2", cwd: "D:/repo" } });
    h.queue.shift()!.resolve({ thread: { id: "th-2", cwd: "D:/repo", turns: [] } });
    await activating;
    await flush();
    expect(h.offline).toEqual([]);
    // 收编路径没有发起任何请求（queue 只被 activate 的 thread/resume 用过一次）。
    expect(h.queue).toHaveLength(0);
  });

  it("没有 TUI 窗口时未托管 thread 的通知直接忽略", async () => {
    // makeHarness 的假 server 没有 endpoint → #openHeadWindow 早退 → #headWindows 为空。
    const h = makeHarness();
    await activate(h);
    h.events.length = 0;
    h.notify("thread/started", { thread: { id: "th-stray", cwd: "D:/x" } });
    await flush();
    expect(h.events.some((event) =>
      event.type === "runtime.metadata"
      && (event as { metadata?: { runtimeId?: string } }).metadata?.runtimeId === "codex:th-stray",
    )).toBe(false);
    expect(h.requests).not.toHaveBeenCalledWith("thread/turns/list", expect.anything());
  });
});
