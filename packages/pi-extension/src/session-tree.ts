import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { RuntimeSlashCommandOption } from "@pi-remote/protocol";
import { REMOTE_TURN_STARTED_CUSTOM_TYPE, REMOTE_TURN_TIMING_CUSTOM_TYPE } from "./pi-adapter.js";

const settingsTypes = new Set(["label", "custom", "model_change", "thinking_level_change", "session_info"]);

const textContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: { type?: string; text?: string }) =>
    part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join(" ");
};

const entryPreview = (entry: SessionEntry): string => {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (message.role === "bashExecution") return message.command;
      const text = textContent("content" in message ? message.content : undefined);
      if (text) return text;
      if (message.role === "toolResult") return message.toolName;
      if (message.role === "assistant") {
        return message.errorMessage || message.content.flatMap((part) =>
          part.type === "toolCall" ? [part.name] : part.type === "thinking" ? ["[thinking]"] : []).join(", ");
      }
      return "[image]";
    }
    case "compaction":
    case "branch_summary": return entry.summary;
    case "custom_message": return textContent(entry.content) || entry.customType;
    case "custom": return entry.customType;
    case "model_change": return `${entry.provider}/${entry.modelId}`;
    case "thinking_level_change": return entry.thinkingLevel;
    case "session_info": return entry.name ?? "session_info";
    case "label": return entry.label ?? "label";
  }
};

/** A preorder projection with explicit parents; internal timing entries are transparent.
 * Iterative throughout: real sessions can contain tens of thousands of entries in one chain.
 */
export function sessionTreeOptions(roots: readonly SessionTreeNode[], leafId: string | null): RuntimeSlashCommandOption[] {
  const options: RuntimeSlashCommandOption[] = [];
  const pending = [...roots].reverse().map((node) => ({ node, parentId: null as string | null }));
  let currentId: string | null = null;
  while (pending.length > 0) {
    const { node, parentId } = pending.pop()!;
    const entry = node.entry;
    const internal = entry.type === "custom" &&
      (entry.customType === REMOTE_TURN_STARTED_CUSTOM_TYPE || entry.customType === REMOTE_TURN_TIMING_CUSTOM_TYPE);
    const visibleId = internal ? parentId : entry.id;
    if (entry.id === leafId) currentId = visibleId;
    if (!internal) {
      const role = entry.type === "message" ? entry.message.role : undefined;
      const toolOnlyAssistant = entry.type === "message" && entry.message.role === "assistant" &&
        !textContent(entry.message.content).trim() &&
        (entry.message.stopReason === "stop" || entry.message.stopReason === "toolUse");
      options.push({
        value: entry.id,
        label: ((entryPreview(entry) || entry.type).replace(/\s+/g, " ").trim() || entry.type).slice(0, 160),
        description: role ?? entry.type,
        tree: {
          parentId,
          entryType: entry.type,
          ...(role === undefined ? {} : { role }),
          ...(node.label === undefined ? {} : { label: node.label.slice(0, 512) }),
          defaultHidden: settingsTypes.has(entry.type) || toolOnlyAssistant,
          isCurrent: false,
          isOnActivePath: false,
        },
      });
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: node.children[index]!, parentId: visibleId });
    }
  }
  const byId = new Map(options.map((option) => [option.value, option]));
  let activeId = currentId;
  while (activeId !== null) {
    const option = byId.get(activeId);
    if (!option?.tree) break;
    option.tree.isCurrent = activeId === currentId;
    option.tree.isOnActivePath = true;
    activeId = option.tree.parentId;
  }
  return options;
}
