import type { RuntimeMetadata, RuntimeSlashCommand } from "@orbis/protocol";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
export function dshPermissionOptions(value: unknown): NonNullable<RuntimeSlashCommand["argument"]>["options"] {
  const options = object(value).options;
  return Array.isArray(options) ? options.flatMap(raw => {
    const item = object(raw);
    if (typeof item.value !== "string" || !/^[\w-]+$/.test(item.value) || item.value === "custom") return [];
    const labels: Record<string, string> = { "workspace-write": "工作区可写", "danger-full-access": "完全访问", "read-only": "只读", auto: "自动审查" };
    const descriptions: Record<string, string> = {
      "workspace-write": "工作区内可修改；越界操作仍需单次批准。",
      "danger-full-access": "允许访问工作区外文件，仍受电脑账户权限限制。",
      auto: "由 DSH 自动审查操作，审查仍可能拒绝。",
    };
    return [{ value: item.value, label: labels[item.value] ?? String(item.name ?? item.value),
      ...(descriptions[item.value] || typeof item.description === "string" ? { description: descriptions[item.value] ?? String(item.description) } : {}) }];
  }) : [];
}
export function dshPermissions(profile: string | undefined, sandbox?: string, approvalPolicy?: string): RuntimeMetadata["permissions"] {
  if (!profile && !sandbox && !approvalPolicy) return undefined;
  return { sandbox: sandbox ?? "unknown", approvalPolicy: approvalPolicy ?? "unknown", ...(profile ? { profile } : {}), reviewer: profile === "auto" ? "auto_review" : "user" };
}
