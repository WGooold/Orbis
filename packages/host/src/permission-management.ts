import type { PermissionManagement, RuntimePermissions } from "@orbis/protocol";
import { CODEX_PERMISSION_COMMANDS } from "./codex-permissions.js";

type PermissionOption = { value: string; label: string; description?: string | undefined };
const busyReason = "会话正在执行任务或有待处理审批，请完成后再修改权限。";
const sessionDetails = "这里修改的是当前会话的持久权限设置，不会改变其他会话或新会话默认值。允许一次（once）只批准当前操作，不会修改会话权限。";
const unknown = (value: string | undefined) => value && value !== "unknown" ? `未知（${value}）` : "未知";

function scope(permissions: RuntimePermissions | undefined, dsh: boolean): { label: string; detail: string; tone: PermissionManagement["tone"] } {
  const sandbox = permissions?.sandbox;
  if (sandbox === (dsh ? "read-only" : "readOnly")) return {
    label: "只读", detail: "文件范围：只读；写入需要额外授权，是否能申请授权取决于审批策略。", tone: "restricted",
  };
  if (sandbox === (dsh ? "workspace-write" : "workspaceWrite")) return {
    label: "工作区可写", detail: "文件范围：当前工作区及原生沙箱允许的临时目录可写；工作区外操作仍受权限限制。", tone: "restricted",
  };
  if (sandbox === (dsh ? "danger-full-access" : "dangerFullAccess")) return {
    label: "完全访问", detail: "文件范围：不受原生文件沙箱限制，仍受电脑账户权限限制。", tone: "full",
  };
  if (!dsh && sandbox === "externalSandbox") return {
    label: "外部沙箱", detail: "文件范围：由外部沙箱管理；当前信息不能确定具体可读写范围。", tone: "unknown",
  };
  return { label: "文件范围未知", detail: `文件范围：${unknown(sandbox)}；不能据此判断可读写范围。`, tone: "unknown" };
}

function networkDetail(permissions: RuntimePermissions | undefined): string {
  return permissions?.networkAccess === true ? "网络：允许联网。"
    : permissions?.networkAccess === false ? "网络：受限；是否能申请放行取决于审批策略。"
      : "网络：未知；原生后端尚未报告网络权限，不能从预设名称推断。";
}

function rootsDetails(permissions: RuntimePermissions | undefined): string[] {
  return [
    ...(permissions?.readableRoots ? [`原生报告的可读目录：${permissions.readableRoots.length ? permissions.readableRoots.join("、") : "没有额外目录"}。`] : []),
    ...(permissions?.writableRoots ? [`原生报告的额外可写目录：${permissions.writableRoots.length ? permissions.writableRoots.join("、") : "没有额外目录"}。`] : []),
  ];
}

export function codexPermissionManagement(permissions: RuntimePermissions | undefined, busy = false): PermissionManagement {
  const fileScope = scope(permissions, false);
  const approval = CODEX_PERMISSION_COMMANDS.find(command => command.name === "approvals")?.argument?.options
    ?.find(option => option.value === permissions?.approvalPolicy);
  const reviewer = CODEX_PERMISSION_COMMANDS.find(command => command.name === "approval-reviewer")?.argument?.options
    ?.find(option => option.value === permissions?.reviewer);
  const facts: Record<string, string | undefined> = {
    sandbox: permissions?.sandbox,
    network: permissions?.networkAccess === undefined ? undefined : permissions.networkAccess ? "enabled" : "restricted",
    approvals: permissions?.approvalPolicy,
    "approval-reviewer": permissions?.reviewer,
  };
  const details = [fileScope.detail, networkDetail(permissions),
    `审批：${approval ? `${approval.label}。${approval.description ?? ""}` : `${unknown(permissions?.approvalPolicy)}；当前审批行为尚未确认。`}`,
    `审批处理者：${reviewer ? `${reviewer.label}。${reviewer.description ?? ""}` : `${unknown(permissions?.reviewer)}。`}`,
    ...rootsDetails(permissions), sessionDetails,
    ...(permissions?.problem ? [`权限问题：${permissions.problem}`] : []),
  ];
  return {
    summary: permissions?.problem ? "权限配置存在问题" : `${fileScope.label} · ${approval?.label ?? "审批策略未知"}`,
    details: details.join("\n"),
    tone: permissions?.problem ? "problem" : !approval ? "unknown" : fileScope.tone,
    settings: CODEX_PERMISSION_COMMANDS.map(command => {
      const options = command.argument?.options?.map(option => ({ value: option.value, label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })) ?? [];
      const currentValue = facts[command.name];
      const disabledReason = busy ? busyReason : command.name === "network" && permissions?.sandbox === "dangerFullAccess"
        ? "完全访问模式允许联网，无法单独限制网络；请先选择只读或工作区可写。" : undefined;
      return { id: command.name, label: command.description ?? command.name, options,
        ...(currentValue !== undefined && options.some(option => option.value === currentValue) ? { currentValue } : {}),
        ...(disabledReason ? { disabledReason } : {}),
      };
    }),
  };
}

export function dshPermissionManagement(permissions: RuntimePermissions | undefined, options: PermissionOption[], busy = false): PermissionManagement | undefined {
  // A native catalogue is the evidence that this backend supports permission management.
  if (options.length === 0) return undefined;
  const fileScope = scope(permissions, true);
  const approvals: Record<string, { label: string; detail: string }> = {
    ask: { label: "需要时询问", detail: "ask：受限操作会请求审批，单次批准仅适用于当前操作。" },
    never: { label: "不申请审批", detail: "never：不会请求额外审批，受限操作会直接失败；这不代表自动批准所有操作。" },
    auto: { label: "自动审查", detail: "auto：由 DSH 自动审查操作并决定是否放行，审查仍可能拒绝。" },
  };
  const approval = permissions?.profile === "auto" ? approvals.auto : permissions ? approvals[permissions.approvalPolicy] : undefined;
  const profile = permissions?.profile;
  const profileLabel = profile === "custom" ? "自定义" : options.find(option => option.value === profile)?.label;
  const details = [
    `原生权限预设：${profileLabel ?? unknown(profile)}。预设名称只标识配置，实际范围以原生报告的权限事实为准。`,
    fileScope.detail, networkDetail(permissions),
    `审批：${approval?.detail ?? `${unknown(permissions?.approvalPolicy)}；当前审批行为尚未确认。`}`,
    ...rootsDetails(permissions), sessionDetails,
    ...(permissions?.problem ? [`权限问题：${permissions.problem}`] : []),
  ];
  return {
    summary: permissions?.problem ? "权限配置存在问题" : `${profileLabel ? `${profileLabel} · ` : ""}${fileScope.label} · ${approval?.label ?? "审批策略未知"}`,
    details: details.join("\n"),
    tone: permissions?.problem ? "problem" : !approval ? "unknown" : fileScope.tone,
    settings: [{ id: "permission-preset", label: "会话权限预设", options: options.map(option => ({ ...option })),
      ...(profile && profile !== "unknown" ? { currentValue: profile } : {}),
      ...(busy ? { disabledReason: busyReason } : {}),
    }],
  };
}
