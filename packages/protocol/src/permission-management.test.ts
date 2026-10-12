import { describe, expect, it } from "vitest";
import { PermissionManagementSchema, RuntimeCommandSchema, RuntimeEventSchema } from "./index.js";

describe("Host permission management contract", () => {
  it("carries opaque settings without agent-specific fields", () => {
    const management = { summary: "当前权限", details: "由后端解释", tone: "unknown", settings: [{ id: "vendor-setting", label: "配置", currentValue: "opaque-value", options: [{ value: "opaque-value", label: "配置一" }] }] };
    expect(PermissionManagementSchema.parse(management)).toEqual(management);
    expect(RuntimeEventSchema.safeParse({ type: "runtime.metadata", metadata: { runtimeId: "runtime", name: "Agent", cwd: "D:/work", status: "idle", permissionManagement: management } }).success).toBe(true);
    expect(RuntimeCommandSchema.parse({ type: "permissions.update", settingId: "vendor-setting", value: "opaque-value" })).toEqual({ type: "permissions.update", settingId: "vendor-setting", value: "opaque-value" });
    expect(RuntimeCommandSchema.safeParse({ type: "permissions.update", settingId: "", value: "value" }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ type: "permissions.update", settingId: "setting", value: "value", agentKind: "dsh" }).success).toBe(false);
  });
});
