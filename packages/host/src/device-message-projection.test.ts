// FT-G01: prevent menu prose amplification without changing exact execution targets,
// old formats, decision content, native facts, or the streaming fast path.
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION, RelayToDeviceMessageSchema, RuntimeSlashCommandSchema,
  AgentCapabilityItemSchema, PermissionManagementSchema,
} from "@orbis/protocol";
import { encodeDeviceResponse } from "./device-protocol.js";
import { encodeDeviceMessage, projectDeviceMessage } from "./device-message-projection.js";

const commands = ["builtin", "extension", "prompt", "skill", "mcp"].map(source => ({
  name: source === "mcp" ? "mcp:server-a:search" : `${source}:exact-target`, source,
  description: "菜单说明",
  argument: { kind: "tree", required: true, hint: "输入提示", options: [{ value: "native:entry-1", label: "分支一",
    description: "选项说明", tree: { parentId: "native:parent", entryType: "message", role: "assistant",
      label: "原生标签", defaultHidden: true, isCurrent: false, isOnActivePath: true } }] },
}));
const minimalCommands = commands.map(command => ({
  name: command.name, source: command.source, argument: { kind: command.argument.kind, required: command.argument.required,
    options: command.argument.options.map(option => ({ value: option.value, label: option.label, tree: option.tree })) },
}));
const management = { summary: "Restricted", details: "必须保留的权限风险", tone: "restricted", settings: [
  { id: "sandbox", label: "Sandbox", currentValue: "read-only", disabledReason: "当前后端不允许修改", options: [
    { value: "read-only", label: "Read only", description: "选项说明" },
  ] },
] };
const minimalManagement = { ...management, settings: management.settings.map(setting => ({
  ...setting, options: setting.options.map(option => ({ value: option.value, label: option.label })),
})) };
const metadata = { runtimeId: "runtime", name: "Agent", cwd: "/repo", status: "idle", permissionManagement: management };
const minimalMetadata = { ...metadata, permissionManagement: minimalManagement };
const eventMessage = (event: object) => ({ type: "runtime.event", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime", sequence: 7, event });

describe("FT-G01 menu-only device projection", () => {
  it.each([18, 19] as const)("keeps all exact targets, options and strict format %s", version => {
    const input = eventMessage({ type: "runtime.capabilities", capabilities: { commands } });
    const before = structuredClone(input);
    const payload = encodeDeviceResponse(encodeDeviceMessage(input), version)!;
    const output = JSON.parse(Buffer.from(payload).toString());
    expect(output).toEqual({ ...input, protocolVersion: version, event: { type: "runtime.capabilities", capabilities: { commands: minimalCommands } } });
    expect(RelayToDeviceMessageSchema.parse({ ...output, protocolVersion: PROTOCOL_VERSION })).toEqual({ ...output, protocolVersion: PROTOCOL_VERSION });
    for (const command of output.event.capabilities.commands) expect(RuntimeSlashCommandSchema.safeParse(command).success).toBe(true);
    expect(input).toEqual(before);
  });

  it("projects every registered agent-domain menu path while preserving envelopes and input facts", () => {
    const capabilities = Object.fromEntries(commands.map(command => [command.name, { ...command, argumentKind: "tree", argumentRequired: true, optionCount: 1, hint: "重复提示" }]));
    const resources = Object.fromEntries(commands.map(command => [command.name, command]));
    const input = { type: "agent.state.snapshot", scope: "agent", requestId: "read", modelEpoch: "epoch", missing: [], truncated: false, domains: [
      { domain: "capabilities", revision: 3, value: capabilities },
      { domain: "resources", revision: 4, value: resources },
      { domain: "identity", revision: 5, value: metadata },
      { domain: "permissions", revision: 6, value: { management, problem: "风险必须保留" } },
      { domain: "interactions", revision: 7, value: { q: { description: "审批描述", options: [{ value: "yes", label: "Yes", description: "决策依据" }] } } },
      { domain: "capabilities", revision: 8, value: null },
    ] };
    const before = structuredClone(input);
    const output = projectDeviceMessage(input) as typeof input;
    expect(output).toEqual({ ...input, domains: [
      { ...input.domains[0], value: Object.fromEntries(minimalCommands.map(command => [command.name, { ...command, argumentKind: "tree", argumentRequired: true, optionCount: 1 }])) },
      { ...input.domains[1], value: Object.fromEntries(minimalCommands.map(command => [command.name, command])) },
      { ...input.domains[2], value: minimalMetadata },
      { ...input.domains[3], value: { management: minimalManagement, problem: "风险必须保留" } },
      input.domains[4], input.domains[5],
    ] });
    const projected = output.domains[0]!.value as Record<string, unknown>;
    for (const item of Object.values(projected)) expect(AgentCapabilityItemSchema.safeParse(item).success).toBe(true);
    expect(input).toEqual(before);
  });

  it.each([
    { type: "runtime.online", runtime: metadata },
    { type: "device.ready", protocolVersion: PROTOCOL_VERSION, deviceId: "phone", notificationEpoch: null, runtimes: [metadata], agents: ["pi"] },
    eventMessage({ type: "runtime.metadata", metadata }),
  ])("keeps permission risks and required labels on $type", input => {
    const output = JSON.parse(encodeDeviceMessage(input).toString());
    const projected = output.runtime ?? output.runtimes?.[0] ?? output.event.metadata;
    expect(projected).toEqual(minimalMetadata);
    expect(PermissionManagementSchema.parse(projected.permissionManagement)).toEqual(minimalManagement);
    expect(metadata.permissionManagement.settings[0]!.options[0]).toHaveProperty("description");
    expect(RelayToDeviceMessageSchema.safeParse(output).success).toBe(true);
  });

  it("retains arbitrary description keys, decision content, user JSON, and unchanged object identity", () => {
    for (const event of [
      { type: "interaction.requested", request: { description: "批准前必须看", options: [{ description: "有风险" }] } },
      { type: "message.delta", text: '{"description":"用户原文","hint":"原文"}' },
      { type: "command.result", result: { description: "执行结果", editorText: "完整编辑原文", sessionId: "session" } },
      { type: "runtime.error", message: "错误原因" },
      { type: "tool.finished", result: { description: "原始工具输出" } },
    ]) {
      const input = eventMessage(event);
      expect(projectDeviceMessage(input)).toBe(input);
    }
    const hostDomain = { type: "agent.state.snapshot", scope: "host", domains: [{ domain: "resources", value: { name: { description: "管理内容" } } }] };
    expect(projectDeviceMessage(hostDomain)).toBe(hostDomain);
    const alreadyMinimal = eventMessage({ type: "runtime.capabilities", capabilities: { commands: minimalCommands } });
    expect(projectDeviceMessage(alreadyMinimal)).toBe(alreadyMinimal);
  });

  it("preserves all 2,009 tree options and counts the removed UTF-8 bytes", () => {
    const options = Array.from({ length: 2_009 }, (_, i) => ({
      ...commands[0]!.argument.options[0]!, value: `native:${i}`, label: `节点 ${i}`,
      description: "菜单节点说明".repeat(8), tree: { ...commands[0]!.argument.options[0]!.tree, parentId: i ? `native:${i - 1}` : null },
    }));
    const input = eventMessage({ type: "runtime.capabilities", capabilities: { commands: [{ ...commands[0], argument: { ...commands[0]!.argument, options } }] } });
    const before = Buffer.byteLength(JSON.stringify(input));
    const encoded = encodeDeviceMessage(input);
    const output = JSON.parse(encoded.toString());
    expect(output.event.capabilities.commands[0].argument.options).toEqual(options.map(option => ({ value: option.value, label: option.label, tree: option.tree })));
    expect(encoded.byteLength).toBeLessThan(before);
    expect(encodeDeviceMessage(output)).toEqual(encoded);
    console.info("FT-G01 synthetic 2,009-node menu", JSON.stringify({ beforeBytes: before, afterBytes: encoded.byteLength, removedBytes: before - encoded.byteLength }));
  });
});
