import { randomUUID } from "node:crypto";
import {
  SessionManager,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeSlashCommand, RuntimeSlashCommandOption } from "@pi-remote/protocol";
import { sessionTreeOptions } from "./session-tree.js";
import type { RuntimeSlashCommandCompletion } from "@pi-remote/runtime-bridge";

export const INTERNAL_SLASH_COMMAND = "__pi_remote_slash";

const BUILTIN_COMMANDS = [
  { name: "model", description: "Select model", argument: { kind: "select", required: true, hint: "<provider/model>" } },
  { name: "tree", description: "Navigate session tree", argument: { kind: "tree", required: true, hint: "<entry>" } },
  { name: "thinking", description: "Set thinking level", argument: { kind: "select", required: true, hint: "<level>" } },
  { name: "name", description: "Show or set the session display name", argument: { kind: "text", required: false, hint: "[name]" } },
  { name: "session", description: "Show session info" },
  { name: "copy", description: "Copy the last agent message on the Pi computer" },
  { name: "fork", description: "Create a new fork", argument: { kind: "select", required: true, hint: "<entry>" } },
  { name: "clone", description: "Duplicate the current session" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the session context", argument: { kind: "text", required: false, hint: "[instructions]" } },
  { name: "resume", description: "Resume a different session", argument: { kind: "select", required: true, hint: "<session>" } },
  { name: "reload", description: "Reload extensions and resources" },
  { name: "quit", description: "Quit Pi" },
] as const;

const builtinNames = new Set<string>(BUILTIN_COMMANDS.map((command) => command.name));

type SlashCommandAPI = Pick<
  ExtensionAPI,
  "getCommands" | "sendUserMessage" | "setSessionName" | "getSessionName" | "setModel" | "setThinkingLevel" | "getThinkingLevel"
>;

type PendingCommand = {
  name: string;
  args: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SlashCommandDiagnosticFields = Record<string, string | number | boolean | undefined>;
type SlashCommandDiagnostic = (event: string, fields?: SlashCommandDiagnosticFields) => void;

type CompletionScope = { [key: symbol]: unknown };
type CompletionState = {
  completions: Map<string, RuntimeSlashCommandCompletion[]>;
  listeners: Map<string, Set<() => void>>;
};
const COMPLETION_STATE = Symbol.for("@pi-remote/slash-command-completions");

const completionState = (): CompletionState => {
  const scope = globalThis as CompletionScope;
  const existing = scope[COMPLETION_STATE] as CompletionState | undefined;
  if (existing?.completions instanceof Map && existing.listeners instanceof Map) return existing;
  const created: CompletionState = { completions: new Map(), listeners: new Map() };
  scope[COMPLETION_STATE] = created;
  return created;
};

const invocation = (name: string, args: string): string => {
  const trimmed = args.trim();
  return trimmed ? `/${name} ${trimmed}` : `/${name}`;
};

const singleArgument = (args: string, command: string): string => {
  const value = args.trim();
  if (!value || value.includes("\n")) throw new Error(`/${command} requires an argument`);
  return value;
};

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
  return content.map((part) => {
    if (part && typeof part === "object" && "type" in part && part.type === "text" &&
      "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).filter(Boolean).join("");
};

const singleLinePreview = (value: unknown): string => {
  const oneLine = contentText(value).replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
};

const preview = (entry: unknown): string => {
  if (!entry || typeof entry !== "object") return "";
  const value = entry as { id?: unknown; type?: unknown; message?: { content?: unknown }; content?: unknown };
  const raw = value.message?.content ?? value.content ?? value.type ?? value.id ?? "";
  return singleLinePreview(raw);
};

const sessionLabel = (session: { id: string; name?: unknown; firstMessage?: unknown }): string => {
  const name = typeof session.name === "string" ? session.name.trim() : "";
  const firstMessage = typeof session.firstMessage === "string" ? singleLinePreview(session.firstMessage) : "";
  return name || firstMessage || session.id;
};

type TreeNode = {
  entry: { id: string; type: string; customType?: string; message?: { role?: string } };
  children: readonly TreeNode[];
  label?: string;
};

const flattenTree = (nodes: readonly TreeNode[]): TreeNode[] => {
  const flattened: TreeNode[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    flattened.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]!);
    }
  }
  return flattened;
};

/**
 * Presents Pi's slash vocabulary as one remote interface. Built-ins are executed
 * through an opaque extension command so Pi supplies a real ExtensionCommandContext;
 * extension commands, prompts and skills are delegated to AgentSession.prompt().
 */
export class PiSlashCommandAdapter {
  readonly #pi: SlashCommandAPI;
  readonly #getContext: () => ExtensionContext | undefined;
  readonly #completionScopeId: string;
  readonly #diagnostic: SlashCommandDiagnostic | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, PendingCommand>();
  #closed = false;

  constructor(
    pi: SlashCommandAPI,
    getContext: () => ExtensionContext | undefined,
    options: { completionScopeId?: string; diagnostic?: SlashCommandDiagnostic } = {},
  ) {
    this.#pi = pi;
    this.#getContext = getContext;
    this.#completionScopeId = options.completionScopeId ?? randomUUID();
    this.#diagnostic = options.diagnostic;
  }

  async commands(): Promise<RuntimeSlashCommand[]> {
    const context = this.#getContext();
    const models = (context
      ? (context.scopedModels.length > 0
        ? context.scopedModels.map((scoped) => scoped.model)
        : context.modelRegistry.getAvailable())
      : [])
      .filter((model) => context?.modelRegistry.hasConfiguredAuth(model) === true);
    const roots = context?.sessionManager.getTree() ?? [];
    const tree = flattenTree(roots);
    const treeOptions = sessionTreeOptions(roots, roots.length > 0 ? context!.sessionManager.getLeafId() : null);
    const forkOptions = tree
      .filter((node) => node.entry.type === "message" && node.entry.message?.role === "user")
      .map((node) => ({
        value: node.entry.id,
        label: (node.label ?? preview(node.entry)) || node.entry.id,
        description: "user message",
      }));
    const sessions = context
      ? await SessionManager.list(context.cwd, context.sessionManager.getSessionDir()).catch(() => [])
      : [];

    const builtins: RuntimeSlashCommand[] = BUILTIN_COMMANDS.map((command) => {
      let options: RuntimeSlashCommandOption[] | undefined;
      if (command.name === "model") {
        options = models.map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: model.name,
          description: `${model.provider}/${model.id}`,
        }));
      } else if (command.name === "thinking") {
        const currentModel = context?.model;
        const levels = currentModel
          ? currentModel.reasoning
            ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) =>
              currentModel.thinkingLevelMap?.[level as keyof typeof currentModel.thinkingLevelMap] !== null &&
              (level !== "xhigh" && level !== "max" ||
                currentModel.thinkingLevelMap?.[level as keyof typeof currentModel.thinkingLevelMap] !== undefined))
            : ["off"]
          : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        options = levels.map((level) => ({ value: level, label: level }));
      } else if (command.name === "tree") {
        options = treeOptions;
      } else if (command.name === "fork") {
        options = forkOptions;
      } else if (command.name === "resume") {
        options = sessions.map((session) => ({
          value: session.id,
          label: sessionLabel(session),
          description: session.id,
        }));
      }
      return {
        name: command.name,
        description: command.description,
        source: "builtin",
        ...("argument" in command
          ? { argument: { ...command.argument, ...(options === undefined ? {} : { options }) } }
          : {}),
      };
    });

    const seen = new Set(builtinNames);
    const delegated: RuntimeSlashCommand[] = [];
    for (const command of this.#pi.getCommands()) {
      if (command.name.startsWith("__") || seen.has(command.name)) continue;
      seen.add(command.name);
      delegated.push({
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
        source: command.source,
        argument: { kind: "text", required: false, hint: "[arguments]" },
      });
    }
    return [...builtins, ...delegated];
  }

  async execute(name: string, args: string): Promise<unknown> {
    this.#diagnostic?.("slash.adapter.requested", { name, argsLength: args.length });
    if (this.#closed) {
      this.#diagnostic?.("slash.adapter.rejected", { name, reason: "adapter_closed" });
      throw new Error("slash command adapter is closed");
    }
    const command = (await this.commands()).find((candidate) => candidate.name === name);
    if (!command) {
      this.#diagnostic?.("slash.adapter.rejected", { name, reason: "slash_command_not_available" });
      throw new Error("slash_command_not_available");
    }
    const normalizedArgs = args.trim();
    if (command.argument === undefined && normalizedArgs) {
      this.#diagnostic?.("slash.adapter.rejected", { name, reason: "slash_command_arguments_not_allowed" });
      throw new Error("slash_command_arguments_not_allowed");
    }
    if (command.argument?.required === true && !normalizedArgs) {
      this.#diagnostic?.("slash.adapter.rejected", { name, reason: "slash_command_argument_required" });
      throw new Error("slash_command_argument_required");
    }
    if ((command.argument?.kind === "select" || command.argument?.kind === "tree") &&
      !command.argument.options?.some((option) => option.value === normalizedArgs)) {
      this.#diagnostic?.("slash.adapter.rejected", { name, reason: "slash_command_argument_not_available" });
      throw new Error("slash_command_argument_not_available");
    }
    this.#diagnostic?.("slash.adapter.validated", { name, source: command.source, argsLength: normalizedArgs.length });

    if (command.source !== "builtin") {
      const context = this.#getContext();
      this.#diagnostic?.("slash.adapter.user_message.dispatching", { name });
      this.#pi.sendUserMessage(invocation(name, args), {
        ...(context?.isIdle() === false ? { deliverAs: "steer" as const } : {}),
        expandPromptTemplates: true,
      });
      this.#diagnostic?.("slash.adapter.user_message.dispatched", { name });
      return { command: name, accepted: true };
    }

    const token = randomUUID();
    this.#diagnostic?.("slash.adapter.internal_command.dispatching", { name, token });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(token);
        this.#diagnostic?.("slash.adapter.internal_command.timed_out", { name, token });
        reject(new Error("slash command timed out"));
      }, 120_000);
      timer.unref?.();
      this.#pending.set(token, { name, args, resolve, reject, timer });
      try {
        this.#pi.sendUserMessage(`/${INTERNAL_SLASH_COMMAND} ${token}`, { expandPromptTemplates: true });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(token);
        const message = error instanceof Error ? error.message : "unable to dispatch slash command";
        this.#diagnostic?.("slash.adapter.internal_command.dispatch_failed", { name, token, error: message });
        reject(error instanceof Error ? error : new Error(message));
      }
    });
  }

  async handleInternalCommand(token: string, context: ExtensionCommandContext): Promise<void> {
    const normalizedToken = token.trim();
    const pending = this.#pending.get(normalizedToken);
    if (!pending) {
      this.#diagnostic?.("slash.adapter.internal_command.unknown", { token: normalizedToken });
      return;
    }
    this.#diagnostic?.("slash.adapter.internal_command.received", {
      name: pending.name,
      token: normalizedToken,
      argsLength: pending.args.length,
    });
    this.#pending.delete(normalizedToken);
    clearTimeout(pending.timer);
    try {
      this.#diagnostic?.("slash.adapter.builtin.started", { name: pending.name });
      const result = await this.#executeBuiltin(pending.name, pending.args, context);
      this.#diagnostic?.("slash.adapter.builtin.completed", { name: pending.name });
      pending.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "slash command failed";
      this.#diagnostic?.("slash.adapter.builtin.failed", { name: pending.name, error: message });
      pending.reject(error instanceof Error ? error : new Error(message));
    }
  }

  recordCompletion(completion: RuntimeSlashCommandCompletion): void {
    const state = completionState();
    state.completions.set(this.#completionScopeId, [
      ...(state.completions.get(this.#completionScopeId) ?? []),
      completion,
    ]);
    for (const listener of [...(state.listeners.get(this.#completionScopeId) ?? [])]) listener();
  }

  takeCompletions(): RuntimeSlashCommandCompletion[] {
    const state = completionState();
    const completions = state.completions.get(this.#completionScopeId) ?? [];
    state.completions.delete(this.#completionScopeId);
    return completions;
  }

  onCompletionAvailable(listener: () => void): () => void {
    const state = completionState();
    const listeners = state.listeners.get(this.#completionScopeId) ?? new Set<() => void>();
    listeners.add(listener);
    state.listeners.set(this.#completionScopeId, listeners);
    this.#listeners.add(listener);
    return () => {
      listeners.delete(listener);
      this.#listeners.delete(listener);
      if (listeners.size === 0) state.listeners.delete(this.#completionScopeId);
    };
  }

  close(options: { cancelPending?: boolean } = {}): void {
    this.#closed = true;
    const state = completionState();
    const listeners = state.listeners.get(this.#completionScopeId);
    for (const listener of this.#listeners) listeners?.delete(listener);
    this.#listeners.clear();
    if (listeners?.size === 0) state.listeners.delete(this.#completionScopeId);
    if (options.cancelPending === true) {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("slash command cancelled"));
      }
      this.#pending.clear();
    }
  }

  async #executeBuiltin(name: string, args: string, context: ExtensionCommandContext): Promise<unknown> {
    switch (name) {
      case "model": {
        const reference = singleArgument(args, name);
        const slash = reference.indexOf("/");
        const provider = slash < 0 ? undefined : reference.slice(0, slash);
        const modelId = slash < 0 ? reference : reference.slice(slash + 1);
        const models = context.scopedModels.length > 0
          ? context.scopedModels.map((scoped) => scoped.model)
          : context.modelRegistry.getAvailable();
        const matches = models.filter((model) =>
          provider === undefined ? model.id === reference : model.provider === provider && model.id === modelId);
        const model = matches.length === 1 ? matches[0] : undefined;
        if (!model || !context.modelRegistry.hasConfiguredAuth(model) || !await this.#pi.setModel(model)) {
          throw new Error("model_not_available");
        }
        return { provider: model.provider, modelId: model.id };
      }
      case "thinking": {
        const level = singleArgument(args, name).toLowerCase();
        const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        if (!allowed.includes(level)) throw new Error("thinking_level_not_available");
        this.#pi.setThinkingLevel(level as Parameters<SlashCommandAPI["setThinkingLevel"]>[0]);
        return { level: this.#pi.getThinkingLevel() };
      }
      case "name": {
        const value = args.trim();
        if (value) this.#pi.setSessionName(value);
        return { sessionName: this.#pi.getSessionName() };
      }
      case "session":
        return {
          sessionId: context.sessionManager.getSessionId(),
          sessionName: context.sessionManager.getSessionName(),
          cwd: context.cwd,
          leafId: context.sessionManager.getLeafId(),
          isIdle: context.isIdle(),
        };
      case "copy": {
        const entry = [...context.sessionManager.getBranch()].reverse().find((candidate) =>
          candidate.type === "message" && candidate.message.role === "assistant"
        );
        if (!entry || entry.type !== "message") throw new Error("assistant_message_not_available");
        const text = contentText((entry.message as { content?: unknown }).content).trim();
        if (!text) throw new Error("assistant_message_not_available");
        await copyToClipboard(text);
        return { copied: true };
      }
      case "new": {
        let sessionId: string | undefined;
        const result = await context.newSession({
          withSession: async (next) => { sessionId = next.sessionManager.getSessionId(); },
        });
        if (result.cancelled) throw new Error("slash_command_cancelled");
        return { sessionId };
      }
      case "resume": {
        const sessionId = singleArgument(args, name);
        const sessions = await SessionManager.list(context.cwd, context.sessionManager.getSessionDir());
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) throw new Error("session_not_available");
        let resumedId: string | undefined;
        const result = await context.switchSession(session.path, {
          withSession: async (next) => { resumedId = next.sessionManager.getSessionId(); },
        });
        if (result.cancelled) throw new Error("slash_command_cancelled");
        return { sessionId: resumedId ?? session.id };
      }
      case "tree": {
        const result = await context.navigateTree(singleArgument(args, name), { summarize: false });
        if (result.cancelled) throw new Error("slash_command_cancelled");
        // Pi 落到用户消息时把 leaf 移到它的父节点，并把那条消息的正文交回来（`editorText`），
        // 手机端据此回填输入框实现「编辑这条消息并重新开始」；落到其他节点时 leaf 就是该节点。
        // SDK 0.84.4 的 navigateTree 类型声明只写了 `cancelled`，但 agent-session 的实现确实
        // 返回 editorText，所以这里按实际返回值收窄一次（字段缺失时就不带给客户端）。
        const { editorText } = result as { cancelled: boolean; editorText?: string };
        return {
          leafId: context.sessionManager.getLeafId(),
          ...(editorText === undefined ? {} : { editorText }),
        };
      }
      case "fork": {
        let sessionId: string | undefined;
        const result = await context.fork(singleArgument(args, name), {
          position: "before",
          withSession: async (next) => { sessionId = next.sessionManager.getSessionId(); },
        });
        if (result.cancelled) throw new Error("slash_command_cancelled");
        return { sessionId };
      }
      case "clone": {
        const leafId = context.sessionManager.getLeafId();
        if (!leafId) throw new Error("session_not_available");
        let sessionId: string | undefined;
        const result = await context.fork(leafId, {
          position: "at",
          withSession: async (next) => { sessionId = next.sessionManager.getSessionId(); },
        });
        if (result.cancelled) throw new Error("slash_command_cancelled");
        return { sessionId };
      }
      case "compact":
        return await new Promise((resolve, reject) => {
          const instructions = args.trim();
          context.compact({
            ...(instructions ? { customInstructions: instructions } : {}),
            onComplete: () => resolve({ compacted: true }),
            onError: reject,
          });
        });
      case "reload":
        if (!context.isIdle()) {
          this.#diagnostic?.("pi.reload.rejected", { reason: "runtime_busy" });
          throw new Error("runtime_busy");
        }
        this.#diagnostic?.("pi.reload.requested");
        try {
          await context.reload();
          this.#diagnostic?.("pi.reload.resolved");
        } catch (error) {
          this.#diagnostic?.("pi.reload.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        return { reloaded: true };
      case "quit":
        setTimeout(() => context.shutdown(), 0);
        return { shutdown: true };
      default:
        throw new Error("slash_command_not_supported_remotely");
    }
  }
}
