import type { RuntimeMetadata } from "@orbis/protocol";
import { record, type JsonObject } from "./acp-client.js";

export const AGY_APPROVAL_SETTING = "agy-tool-approval";
const modes = {
  ask: { label: "逐次确认", detail: "AGY 请求工具审批时，由你确认。" },
  "auto-edit": { label: "自动批准编辑", detail: "自动批准编辑请求；命令和其他操作仍需确认。" },
  "auto-tools": { label: "自动批准工具（含命令）", detail: "自动批准已识别的工具操作，包括运行命令。提问和不明确的请求仍需确认。" },
} as const;
export type AgyApprovalMode = keyof typeof modes;
export const isAgyApprovalMode = (value: string): value is AgyApprovalMode => Object.hasOwn(modes, value);

export function agyPermissionMetadata(mode: AgyApprovalMode): Pick<RuntimeMetadata, "permissions" | "permissionManagement"> {
  return {
    // This is a Host approval policy, not a claim about the CLI's effective sandbox.
    permissions: { sandbox: "unknown", approvalPolicy: mode },
    permissionManagement: {
      summary: modes[mode].label, tone: "restricted",
      details: `${modes[mode].detail}\n仅作用于当前打开的会话，不更改 CLI 沙盒设置。`,
      settings: [{ id: AGY_APPROVAL_SETTING, label: "工具审批", currentValue: mode,
        options: Object.entries(modes).map(([value, { label }]) => ({ value, label })) }],
    },
  };
}

const toolKinds = new Set(["read", "edit", "delete", "move", "search", "execute", "fetch"]);
const hasAgyWarning = (meta: unknown): boolean => Object.hasOwn(record(meta), "agy.security.warning");

/** ACP also carries native questions as permission requests. Never infer authorization from titles or option labels. */
export function canAutoApproveAgyTool(mode: AgyApprovalMode, params: JsonObject, optionMeta: unknown, trackedKind?: string): boolean {
  if (mode === "ask") return false;
  const tool = record(params.toolCall);
  const id = tool.toolCallId;
  if (typeof id !== "string" || !id || id.length > 512 || id !== id.trim() || id.startsWith("interaction_")) return false;
  if (hasAgyWarning(params._meta) || hasAgyWarning(tool._meta) || hasAgyWarning(optionMeta)) return false;
  if (tool.kind != null && trackedKind !== undefined && tool.kind !== trackedKind) return false;
  const kind = tool.kind ?? trackedKind;
  return mode === "auto-edit" ? kind === "edit" : typeof kind === "string" && toolKinds.has(kind);
}
