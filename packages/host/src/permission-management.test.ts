import { describe, expect, it } from "vitest";
import { PermissionManagementSchema } from "@orbis/protocol";
import { CODEX_PERMISSION_COMMANDS, codexPermissions } from "./codex-permissions.js";
import { dshPermissionOptions, dshPermissions } from "./dsh-permissions.js";
import { codexPermissionManagement, dshPermissionManagement } from "./permission-management.js";

const nativeOptions = dshPermissionOptions({ options: [
  { value: "workspace-write", name: "Workspace" },
  { value: "danger-full-access", name: "Full" },
  { value: "auto", name: "Auto" },
] }) ?? [];

describe("Codex permission management projection", () => {
  it("projects native facts and the existing command catalogue into opaque settings", () => {
    const raw = codexPermissions({ sandboxPolicy: { type: "workspaceWrite", networkAccess: false,
      writableRoots: ["D:/shared"], readOnlyAccess: { readableRoots: ["D:/read"] } },
    approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    const result = codexPermissionManagement(raw);
    expect(result.tone).toBe("restricted");
    expect(result.summary).toBe("工作区可写 · 按需询问");
    expect(result.settings.map(setting => [setting.id, setting.currentValue])).toEqual([
      ["sandbox", "workspaceWrite"], ["network", "restricted"], ["approvals", "on-request"], ["approval-reviewer", "auto_review"],
    ]);
    for (const command of CODEX_PERMISSION_COMMANDS) {
      expect(result.settings.find(setting => setting.id === command.name)?.options).toEqual(command.argument?.options);
    }
    expect(result.details).toContain("D:/shared");
    expect(result.details).toContain("D:/read");
    expect(result.details).toContain("自动审查");
    expect(result.details).toContain("持久权限设置");
    expect(result.details).toContain("once");
    expect(PermissionManagementSchema.parse(result)).toEqual(result);
  });

  it("keeps missing and future native values unknown without selecting a guessed option", () => {
    const missing = codexPermissionManagement(undefined);
    expect(missing.tone).toBe("unknown");
    expect(missing.settings.every(setting => setting.currentValue === undefined)).toBe(true);
    expect(missing.details).toContain("网络：未知");
    const future = codexPermissionManagement({ sandbox: "future-sandbox", approvalPolicy: "future-approval", reviewer: "future-reviewer", profile: "full" });
    expect(future.tone).toBe("unknown");
    expect(future.details).toContain("future-sandbox");
    expect(future.details).toContain("future-approval");
    expect(future.details).toContain("future-reviewer");
    expect(future.settings.every(setting => setting.currentValue === undefined)).toBe(true);
  });

  it("disables network in full access and disables every setting while busy", () => {
    const raw = codexPermissions({ sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" });
    const result = codexPermissionManagement(raw);
    expect(result.tone).toBe("full");
    expect(result.settings.find(setting => setting.id === "network")).toMatchObject({ currentValue: "enabled", disabledReason: expect.stringContaining("无法单独限制网络") });
    expect(result.settings.find(setting => setting.id === "sandbox")?.disabledReason).toBeUndefined();
    expect(result.details).toContain("这不代表自动批准所有操作");
    expect(codexPermissionManagement(raw, true).settings.every(setting => setting.disabledReason?.includes("待处理审批"))).toBe(true);
  });

  it("preserves reported problems with an actionable problem tone", () => {
    const result = codexPermissionManagement({ sandbox: "workspaceWrite", approvalPolicy: "untrusted", networkAccess: true, problem: "Windows 沙箱初始化失败" });
    expect(result.tone).toBe("problem");
    expect(result.details).toContain("Windows 沙箱初始化失败");
  });
});

describe("DSH permission management projection", () => {
  it("uses the native preset catalogue and never infers scope or network from a preset", () => {
    const result = dshPermissionManagement(dshPermissions("danger-full-access"), nativeOptions)!;
    expect(result.tone).toBe("unknown");
    expect(result.settings).toEqual([{ id: "permission-preset", label: "会话权限预设", currentValue: "danger-full-access", options: nativeOptions }]);
    expect(result.details).toContain("文件范围：未知");
    expect(result.details).toContain("网络：未知");
    expect(result.details).toContain("审批：未知");
    expect(PermissionManagementSchema.parse(result)).toEqual(result);
    expect(dshPermissionManagement(undefined, [])).toBeUndefined();
  });

  it("describes custom configuration from facts and retains an unknown profile", () => {
    const custom = dshPermissionManagement({ sandbox: "workspace-write", approvalPolicy: "ask", profile: "custom", networkAccess: false }, nativeOptions)!;
    expect(custom.summary).toBe("自定义 · 工作区可写 · 需要时询问");
    expect(custom.tone).toBe("restricted");
    expect(custom.settings[0]?.currentValue).toBe("custom");
    expect(custom.settings[0]?.options.some(option => option.value === "custom")).toBe(false);
    expect(custom.details).toContain("网络：受限");
    const future = dshPermissionManagement({ sandbox: "read-only", approvalPolicy: "ask", profile: "future-native-preset" }, nativeOptions)!;
    expect(future.tone).toBe("restricted");
    expect(future.settings[0]?.currentValue).toBe("future-native-preset");
    expect(future.details).toContain("未知（future-native-preset）");
    expect(dshPermissionManagement(undefined, nativeOptions)?.settings[0]?.currentValue).toBeUndefined();
  });

  it.each([
    ["ask", "受限操作会请求审批"],
    ["never", "受限操作会直接失败"],
    ["auto", "审查仍可能拒绝"],
  ])("explains %s approval semantics separately from once and durable session settings", (approvalPolicy, text) => {
    const result = dshPermissionManagement({ sandbox: "workspace-write", approvalPolicy, profile: "custom" }, nativeOptions)!;
    expect(result.details).toContain(text);
    expect(result.details).toContain("once");
    expect(result.details).toContain("持久权限设置");
    expect(result.details).toContain("网络：未知");
  });

  it("keeps unknown approval policies unknown and reports busy and problems", () => {
    const unknown = dshPermissionManagement({ sandbox: "danger-full-access", approvalPolicy: "future-policy" }, nativeOptions)!;
    expect(unknown.tone).toBe("unknown");
    expect(unknown.details).toContain("future-policy");
    const busy = dshPermissionManagement({ sandbox: "danger-full-access", approvalPolicy: "never", profile: "danger-full-access", problem: "原生权限配置失败" }, nativeOptions, true)!;
    expect(busy.tone).toBe("problem");
    expect(busy.details).toContain("原生权限配置失败");
    expect(busy.settings.every(setting => setting.disabledReason?.includes("待处理审批"))).toBe(true);
  });
});
