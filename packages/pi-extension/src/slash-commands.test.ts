import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeCapabilitiesSchema } from "@pi-remote/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_SLASH_COMMAND, PiSlashCommandAdapter } from "./slash-commands.js";

afterEach(() => vi.restoreAllMocks());

const makePi = () => ({
  getCommands: vi.fn(() => [
    { name: "deploy", description: "Deploy app", source: "extension", sourceInfo: {} },
    { name: "review", description: "Review prompt", source: "prompt", sourceInfo: {} },
    { name: "reload", description: "Colliding prompt", source: "prompt", sourceInfo: {} },
    { name: "skill:code-review", description: "Review skill", source: "skill", sourceInfo: {} },
    { name: INTERNAL_SLASH_COMMAND, description: "internal", source: "extension", sourceInfo: {} },
  ]),
  sendUserMessage: vi.fn(),
  setSessionName: vi.fn(),
  getSessionName: vi.fn(() => "work"),
  setModel: vi.fn(async () => true),
  setThinkingLevel: vi.fn(),
  getThinkingLevel: vi.fn(() => "medium" as const),
});

describe("PiSlashCommandAdapter", () => {
  it("publishes one menu containing built-ins, extension commands, prompts and skills", async () => {
    const adapter = new PiSlashCommandAdapter(makePi() as never, () => undefined);

    const commands = await adapter.commands();

    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "reload", source: "builtin" }),
      expect.objectContaining({ name: "deploy", source: "extension" }),
      expect.objectContaining({ name: "review", source: "prompt" }),
      expect.objectContaining({ name: "skill:code-review", source: "skill" }),
    ]));
    expect(commands.some((command) => command.name === INTERNAL_SLASH_COMMAND)).toBe(false);
    expect(commands.filter((command) => command.name === "reload")).toHaveLength(1);
  });

  it("publishes capabilities for a long Session tree without overflowing the call stack", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValueOnce([]);
    const tree = [] as Array<{ entry: { id: string; type: string }; children: unknown[] }>;
    let parent: { entry: { id: string; type: string }; children: unknown[] } | undefined;
    for (let index = 19_999; index >= 0; index -= 1) {
      const node = { entry: { id: `entry-${index}`, type: "custom" }, children: parent === undefined ? [] : [parent] };
      parent = node;
    }
    if (parent) tree.push(parent);
    const context = {
      cwd: "/work",
      isIdle: () => true,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
      },
      sessionManager: {
        getTree: () => tree,
        getLeafId: () => "entry-19999",
        getSessionDir: () => "/sessions",
      },
    };
    const adapter = new PiSlashCommandAdapter(makePi() as never, () => context as never);

    const commands = await adapter.commands();
    const treeCommand = commands.find((command) => command.name === "tree");

    expect(treeCommand?.argument?.options).toHaveLength(20_000);
    expect(treeCommand?.argument?.options?.at(-1)?.tree?.isCurrent).toBe(true);
  });

  it("preserves branch ancestry and active position when hiding remote timing entries", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    const pi = makePi();
    const tree = [{
      entry: { id: "user", type: "message", message: { role: "user" } },
      children: [{
        entry: { id: "started", type: "custom", customType: "pi_remote_turn_started" },
        children: [{
          entry: { id: "assistant", type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }], stopReason: "stop" } },
          children: [{
            entry: { id: "timing", type: "custom", customType: "pi_remote_turn_timing" },
            children: [{
              entry: { id: "ordinary-custom", type: "custom", customType: "extension-state" },
              children: [],
            }],
          }],
        }, {
          entry: { id: "alternate", type: "message", message: { role: "user" } },
          children: [],
        }],
      }],
    }];
    const context = {
      cwd: "/work",
      isIdle: () => true,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
      },
      sessionManager: {
        getTree: () => tree,
        getLeafId: () => "timing",
        getSessionDir: () => "/sessions",
      },
    };
    const adapter = new PiSlashCommandAdapter(pi as never, () => context as never);
    const capabilities = RuntimeCapabilitiesSchema.parse({ commands: await adapter.commands() });
    const treeCommand = capabilities.commands.find((command) => command.name === "tree");

    expect(treeCommand?.argument).toMatchObject({
      kind: "tree",
      options: [
        { value: "user", tree: { parentId: null, isOnActivePath: true, isCurrent: false } },
        { value: "assistant", tree: { parentId: "user", isOnActivePath: true, isCurrent: true } },
        { value: "ordinary-custom", tree: { parentId: "assistant", isOnActivePath: false } },
        { value: "alternate", tree: { parentId: "user", isOnActivePath: false } },
      ],
    });
    await expect(adapter.execute("tree", "started")).rejects.toThrow("slash_command_argument_not_available");
    const pending = adapter.execute("tree", "alternate");
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledOnce());
    const token = String(pi.sendUserMessage.mock.calls[0]?.[0]).split(" ").at(-1) ?? "";
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    await adapter.handleInternalCommand(token, {
      navigateTree,
      sessionManager: { getLeafId: () => "alternate" },
    } as never);
    await expect(pending).resolves.toEqual({ leafId: "alternate" });
    expect(navigateTree).toHaveBeenCalledWith("alternate", { summarize: false });
  });

  it("hands the edited prompt back when /tree lands on a user message", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    const pi = makePi();
    const tree = [{
      entry: { id: "user", type: "message", message: { role: "user", content: [{ type: "text", text: "改写这一段" }] } },
      children: [{
        entry: {
          id: "assistant",
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
        },
        children: [],
      }],
    }];
    const context = {
      cwd: "/work",
      isIdle: () => true,
      scopedModels: [],
      modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
      sessionManager: { getTree: () => tree, getLeafId: () => "assistant", getSessionDir: () => "/sessions" },
    };
    const adapter = new PiSlashCommandAdapter(pi as never, () => context as never);

    const pending = adapter.execute("tree", "user");
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledOnce());
    const token = String(pi.sendUserMessage.mock.calls[0]?.[0]).split(" ").at(-1) ?? "";
    // 落到用户消息时 Pi 把 leaf 移到它的父节点（根 → null），并把原文交回来供手机回填输入框。
    await adapter.handleInternalCommand(token, {
      navigateTree: vi.fn(async () => ({ cancelled: false, editorText: "改写这一段" })),
      sessionManager: { getLeafId: () => null },
    } as never);

    await expect(pending).resolves.toEqual({ leafId: null, editorText: "改写这一段" });
  });

  it("labels resume options with names, first-message previews and session IDs in list order", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValueOnce([
      { id: "named-session", name: "Named session", firstMessage: "ignored", path: "/named" },
      { id: "null-name", name: null, firstMessage: "First message", path: "/null" },
      { id: "empty-name", name: "", firstMessage: "Second message", path: "/empty" },
      { id: "whitespace-name", name: "  \t", firstMessage: "Third message", path: "/whitespace" },
      { id: "no-preview", name: null, firstMessage: " \n\t", path: "/no-preview" },
    ] as never);
    const context = {
      cwd: "/work",
      isIdle: () => true,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
      },
      sessionManager: {
        getTree: () => [],
        getSessionDir: () => "/sessions",
      },
    };
    const adapter = new PiSlashCommandAdapter(makePi() as never, () => context as never);

    const resume = (await adapter.commands()).find((command) => command.name === "resume");

    expect(resume?.argument).toMatchObject({
      kind: "select",
      options: [
        { value: "named-session", label: "Named session", description: "named-session" },
        { value: "null-name", label: "First message", description: "null-name" },
        { value: "empty-name", label: "Second message", description: "empty-name" },
        { value: "whitespace-name", label: "Third message", description: "whitespace-name" },
        { value: "no-preview", label: "no-preview", description: "no-preview" },
      ],
    });
  });

  it("routes resume selection by the real session ID and preserves the selected path", async () => {
    const sessions = [{
      id: "session-id",
      name: "Session label",
      firstMessage: "ignored",
      path: "/sessions/session-id.jsonl",
    }];
    vi.spyOn(SessionManager, "list").mockResolvedValue(sessions as never);
    const pi = makePi();
    const switchSession = vi.fn(async (_path: string, options: { withSession?: (next: unknown) => Promise<void> }) => {
      await options.withSession?.({ sessionManager: { getSessionId: () => "resumed-id" } });
      return { cancelled: false };
    });
    const context = {
      cwd: "/work",
      isIdle: () => true,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
      },
      sessionManager: {
        getTree: () => [],
        getSessionDir: () => "/sessions",
      },
      switchSession,
    };
    const adapter = new PiSlashCommandAdapter(pi as never, () => context as never);

    const pending = adapter.execute("resume", "session-id");
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledOnce());
    const token = String(pi.sendUserMessage.mock.calls[0]?.[0]).split(" ").at(-1) ?? "";
    await adapter.handleInternalCommand(token, {
      sessionManager: { getSessionDir: () => "/sessions" },
      switchSession,
    } as never);

    await expect(pending).resolves.toEqual({ sessionId: "resumed-id" });
    expect(switchSession).toHaveBeenCalledWith("/sessions/session-id.jsonl", expect.any(Object));
  });

  it("delegates extension commands, prompts and skills to Pi prompt expansion", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    const pi = makePi();
    const adapter = new PiSlashCommandAdapter(pi as never, () => undefined);

    await expect(adapter.execute("deploy", "production")).resolves.toEqual({
      command: "deploy",
      accepted: true,
    });
    expect(pi.sendUserMessage).toHaveBeenCalledWith("/deploy production", {
      expandPromptTemplates: true,
    });

    // While Pi is streaming, a delegated command must steer like the TUI does.
    const streamingPi = makePi();
    const context = {
      cwd: "/work",
      isIdle: () => false,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
      },
      sessionManager: {
        getTree: () => [],
        getSessionDir: () => "/sessions",
      },
    };
    const streaming = new PiSlashCommandAdapter(streamingPi as never, () => context as never);

    await streaming.execute("deploy", "production");
    expect(streamingPi.sendUserMessage).toHaveBeenCalledWith("/deploy production", {
      deliverAs: "steer",
      expandPromptTemplates: true,
    });
  });

  it("dispatches built-ins through a real Pi command context", async () => {
    const pi = makePi();
    const adapter = new PiSlashCommandAdapter(pi as never, () => undefined);
    const reload = vi.fn(async () => undefined);

    const pending = adapter.execute("reload", "");
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledOnce());
    const [message, options] = pi.sendUserMessage.mock.calls[0] ?? [];
    expect(message).toMatch(new RegExp(`^/${INTERNAL_SLASH_COMMAND} [0-9a-f-]{36}$`));
    expect(options).toEqual({ expandPromptTemplates: true });
    const token = String(message).split(" ").at(-1) ?? "";

    await adapter.handleInternalCommand(token, {
      isIdle: () => true,
      reload,
    } as never);

    await expect(pending).resolves.toEqual({ reloaded: true });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("forks before the selected user message like the TUI fork command", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValueOnce([]);
    const pi = makePi();
    const discoveryContext = {
      cwd: "/work",
      isIdle: () => true,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
      },
      sessionManager: {
        getTree: () => [{
          entry: { id: "entry-user", type: "message", message: { role: "user", content: "request" } },
          children: [],
        }],
        getLeafId: () => "entry-user",
        getSessionDir: () => "/sessions",
      },
    };
    const adapter = new PiSlashCommandAdapter(pi as never, () => discoveryContext as never);
    const pending = adapter.execute("fork", "entry-user");
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledOnce());
    const token = String(pi.sendUserMessage.mock.calls[0]?.[0]).split(" ").at(-1) ?? "";
    const fork = vi.fn(async (_entryId: string, options: { withSession?: (next: unknown) => Promise<void> }) => {
      await options.withSession?.({ sessionManager: { getSessionId: () => "forked-session" } });
      return { cancelled: false };
    });

    await adapter.handleInternalCommand(token, { fork } as never);

    await expect(pending).resolves.toEqual({ sessionId: "forked-session" });
    expect(fork).toHaveBeenCalledWith("entry-user", expect.objectContaining({ position: "before" }));
  });

  it("rejects built-in arguments that are missing, unexpected, or unavailable", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    const pi = makePi();
    const context = {
      cwd: "/work",
      isIdle: () => true,
      scopedModels: [{ model: { provider: "openai", id: "gpt-5", name: "GPT-5" } }],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        getTree: () => [],
        getSessionDir: () => "/sessions",
      },
    };
    const adapter = new PiSlashCommandAdapter(pi as never, () => context as never);

    await expect(adapter.execute("model", "")).rejects.toThrow("slash_command_argument_required");
    await expect(adapter.execute("reload", "unexpected")).rejects.toThrow("slash_command_arguments_not_allowed");
    await expect(adapter.execute("model", "openai/missing")).rejects.toThrow("slash_command_argument_not_available");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
