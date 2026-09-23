import type { RuntimePermissions, RuntimeSlashCommand } from "@pi-remote/protocol";
import { object } from "./codex-interactions.js";

export const CODEX_PERMISSION_COMMANDS: readonly RuntimeSlashCommand[] = [
  { name: "sandbox", description: "文件访问范围", source: "builtin", argument: { kind: "select", required: true, options: [
    { value: "readOnly", label: "只读", description: "允许读取文件；写入需要额外授权。" },
    { value: "workspaceWrite", label: "工作区可写", description: "允许修改当前工作目录及临时目录。切换范围会清除额外可写目录。" },
    { value: "dangerFullAccess", label: "完全访问", description: "可读写电脑账户能访问的文件并联网，不受 Codex 沙箱限制。" },
  ] } },
  { name: "network", description: "网络访问", source: "builtin", argument: { kind: "select", required: true, options: [
    { value: "restricted", label: "限制联网", description: "联网操作受沙箱限制，可否申请放行取决于审批策略。" },
    { value: "enabled", label: "允许联网", description: "允许会话访问网络。" },
  ] } },
  { name: "approvals", description: "何时申请审批", source: "builtin", argument: { kind: "select", required: true, options: [
    { value: "on-request", label: "按需询问", description: "由 Codex 判断何时申请额外授权。" },
    { value: "untrusted", label: "不可信操作先询问", description: "可信的读取操作直接执行，其他操作先申请审批。" },
    { value: "never", label: "不申请审批", description: "受限操作直接失败；这不代表自动批准所有操作。" },
  ] } },
  { name: "approval-reviewer", description: "谁来处理审批", source: "builtin", argument: { kind: "select", required: true, options: [
    { value: "user", label: "由我处理", description: "在手机或电脑上查看并决定。" },
    { value: "auto_review", label: "自动审查", description: "由 Codex 自动审查风险并决定是否允许。" },
  ] } },
];

/** Change one setting at a time; retain unprojected filesystem restrictions when changing network. */
export function codexPermissionUpdate(name: string, value: string, settings: unknown): Record<string, unknown> {
  const command = CODEX_PERMISSION_COMMANDS.find((candidate) => candidate.name === name);
  if (!command?.argument?.options?.some((option) => option.value === value)) throw new Error("权限选项已失效，请重新打开设置");
  if (name === "approvals") return { approvalPolicy: value };
  if (name === "approval-reviewer") return { approvalsReviewer: value };
  const current = object(settings);
  const sandbox = object(current.sandboxPolicy ?? current.sandbox);
  if (typeof sandbox.type !== "string") throw new Error("尚未收到当前沙箱设置，请刷新会话后重试");
  if (name === "network") {
    if (!["readOnly", "workspaceWrite", "externalSandbox"].includes(sandbox.type)) {
      throw new Error("完全访问模式无法单独限制联网，请先选择只读或工作区可写");
    }
    return { sandboxPolicy: { ...sandbox, networkAccess: sandbox.type === "externalSandbox" ? value : value === "enabled" } };
  }
  if (sandbox.type === value) return { sandboxPolicy: sandbox };
  return { sandboxPolicy: value === "dangerFullAccess" ? { type: value } : {
    type: value,
    networkAccess: sandbox.networkAccess === true || sandbox.networkAccess === "enabled" || sandbox.type === "dangerFullAccess",
    ...(value === "workspaceWrite" ? { writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false } : {}),
  } };
}

/** Consume effective settings returned by app-server, never infer them from global config. */
export function codexPermissions(value: unknown): RuntimePermissions | undefined {
  const settings = object(value);
  const sandbox = object(settings.sandboxPolicy ?? settings.sandbox);
  if (typeof sandbox.type !== "string" || settings.approvalPolicy === undefined) return undefined;
  const approvalPolicy = typeof settings.approvalPolicy === "string" ? settings.approvalPolicy : JSON.stringify(settings.approvalPolicy);
  const roots = (value: unknown) => Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : undefined;
  const readableRoots = roots(object(sandbox.readOnlyAccess ?? sandbox.access).readableRoots);
  const writableRoots = roots(sandbox.writableRoots);
  const profile = object(settings.activePermissionProfile).id;
  const networkAccess = sandbox.type === "dangerFullAccess" ? true
    : typeof sandbox.networkAccess === "boolean" ? sandbox.networkAccess
      : sandbox.type === "externalSandbox" ? sandbox.networkAccess === "enabled" : false;
  return { sandbox: sandbox.type, approvalPolicy, networkAccess,
    ...(typeof settings.approvalsReviewer === "string" ? { reviewer: settings.approvalsReviewer } : {}),
    ...(typeof profile === "string" ? { profile } : {}),
    ...(writableRoots === undefined ? {} : { writableRoots }),
    ...(readableRoots === undefined ? {} : { readableRoots }),
  };
}

export function codexErrorMessage(error: unknown): string {
  const record = object(error);
  const message = typeof error === "string" ? error : typeof record.message === "string" ? record.message : "Codex 执行失败";
  if (/windows sandbox|setup refresh|helper_unknown_error/i.test(message)) {
    return `Windows 沙箱初始化失败，请在电脑端修复 Codex 沙箱设置后重试。批准某次操作无法修复初始化故障。\n${message}`;
  }
  if (/sandbox/i.test(message) || record.codexErrorInfo === "sandboxError") {
    return `Codex 沙箱执行失败，请检查本会话的权限范围和电脑端沙箱设置。\n${message}`;
  }
  return message;
}
