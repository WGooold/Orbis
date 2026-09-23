import { describe, expect, it } from "vitest";
import { RuntimeEventSchema } from "@pi-remote/protocol";
import { codexDecline, prepareCodexInteraction } from "./codex-interactions.js";
import { codexPermissions } from "./codex-permissions.js";

const base = { runtimeId: "codex:thread-1", requestId: "mobile-request", extensionId: "codex", expiresAt: Date.now() + 300_000 };
const commandMethod = "item/commandExecution/requestApproval";

describe("Codex interaction wire contracts", () => {
  it("shows complete string commands, reasons and permission scope and only offers advertised decisions", () => {
    const interaction = prepareCodexInteraction(commandMethod, { command: "Get-Content D:/private/file",
      reason: "Read requested report", cwd: "D:/repo", additionalPermissions: { fileSystem: { read: ["D:/private"] } },
      availableDecisions: ["decline", "acceptForSession"],
    }, base);
    expect(interaction.request.argumentSummary).toBe("Get-Content D:/private/file");
    expect(interaction.request.description).toContain("D:/private");
    expect(interaction.request.description).toContain("Read requested report");
    expect(interaction.decode({ kind: "select", value: "1" })).toEqual({ decision: "acceptForSession" });
    expect(() => interaction.decode({ kind: "confirm", value: true })).toThrow();
    expect(() => interaction.decode({ kind: "select", value: "2" })).toThrow();
    expect(RuntimeEventSchema.safeParse({ type: "interaction.requested", request: interaction.request }).success).toBe(true);
  });

  it("preserves full long commands and includes the pending file diff", () => {
    const command = "Write-Output " + "a".repeat(5000);
    const long = prepareCodexInteraction(commandMethod, { command }, base);
    expect(long.request.description).toContain(command);
    const file = prepareCodexInteraction("item/fileChange/requestApproval", { grantRoot: "D:/shared" }, base,
      { changes: [{ path: "D:/shared/file", diff: "-old\n+new" }] });
    expect(file.request.argumentSummary).toContain("D:/shared/file");
    expect(file.request.description).toContain("D:/shared");
  });

  it("round-trips command and network rules without trusting phone-supplied rule content", () => {
    const decision = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } };
    const interaction = prepareCodexInteraction(commandMethod, {
      networkApprovalContext: { host: "example.com", protocol: "https", port: 443 }, availableDecisions: [decision, "decline"],
    }, base);
    expect(interaction.request.title).toBe("批准网络访问");
    expect(interaction.request.description).toContain("https://example.com:443");
    expect(interaction.decode({ kind: "select", value: "0" })).toEqual({ decision });
  });

  it("grants exactly requested permissions for the chosen scope, and refuses with an empty grant", () => {
    const permissions = { network: { enabled: true }, fileSystem: { write: ["D:/output"] } };
    const interaction = prepareCodexInteraction("item/permissions/requestApproval", { permissions }, base);
    expect(interaction.decode({ kind: "select", value: "0" })).toEqual({ permissions, scope: "turn" });
    expect(interaction.decode({ kind: "select", value: "1" })).toEqual({ permissions, scope: "session" });
    expect(interaction.decode({ kind: "select", value: "2" })).toEqual({ permissions: {}, scope: "turn" });
    expect(interaction.decode({ kind: "cancel" })).toEqual(interaction.decline);
  });

  it("maps a mixed questionnaire to Codex answers, including free text and secret fields", () => {
    const interaction = prepareCodexInteraction("item/tool/requestUserInput", { questions: [
      { id: "scope", header: "Scope", question: "Where?", isOther: true, options: [{ label: "Local", description: "Here" }] },
      { id: "token", header: "Token", question: "Token?", isSecret: true, options: null },
    ] }, base);
    expect(RuntimeEventSchema.safeParse({ type: "interaction.requested", request: interaction.request }).success).toBe(true);
    expect(interaction.request).toMatchObject({ kind: "questionnaire", questions: [{ id: "scope" }, { id: "token", secret: true, options: [], allowOther: true }] });
    expect(interaction.decode({ kind: "questionnaire", answers: [
      { id: "token", values: [], other: "secret-example" }, { id: "scope", values: ["0"] },
    ] })).toEqual({ answers: { scope: { answers: ["Local"] }, token: { answers: ["secret-example"] } } });
    expect(() => interaction.decode({ kind: "questionnaire", answers: [{ id: "scope", values: ["unknown"] }] })).toThrow();
    expect(interaction.decode({ kind: "cancel" })).toEqual({ answers: {} });
  });

  it("elicitation forms validate typed values before returning MCP content", () => {
    const interaction = prepareCodexInteraction("mcpServer/elicitation/request", {
      mode: "form", serverName: "demo", message: "Set up the task", requestedSchema: {
        type: "object", required: ["enabled", "count"], properties: {
          enabled: { type: "boolean" }, count: { type: "integer", minimum: 1, maximum: 5 },
          color: { type: "string", enum: ["red", "blue"] },
        },
      },
    }, base);
    const answer = { kind: "questionnaire" as const, answers: [
      { id: "enabled", values: ["0"] }, { id: "count", values: [], other: "3" }, { id: "color", values: ["omit"] },
    ] };
    expect(interaction.decode(answer)).toEqual({ action: "accept", content: { enabled: true, count: 3 } });
    expect(() => interaction.decode({ ...answer, answers: answer.answers.map((a) => a.id === "count" ? { ...a, other: "99" } : a) })).toThrow("数值范围");
    expect(interaction.decode({ kind: "cancel" })).toEqual({ action: "cancel", content: null });
  });

  it("supports empty enum arrays while rejecting contradictory and undersized selections", () => {
    const form = (minItems?: number) => prepareCodexInteraction("mcpServer/elicitation/request", {
      mode: "form", requestedSchema: { type: "object", required: ["tags"], properties: {
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems },
      } },
    }, base);
    const answer = (values: string[]) => ({ kind: "questionnaire" as const, answers: [{ id: "tags", values }] });
    expect(form().decode(answer(["empty"]))).toEqual({ action: "accept", content: { tags: [] } });
    expect(() => form().decode(answer(["empty", "0"]))).toThrow("不能");
    expect(() => form(2).decode(answer(["empty"]))).toThrow("无效选项");
    expect(() => form(2).decode(answer(["0"]))).toThrow("选择数量");
    expect(form(2).decode(answer(["0", "1"]))).toEqual({ action: "accept", content: { tags: ["a", "b"] } });
  });

  it("rejects ambiguous duplicate question IDs and preserves special object field names", () => {
    const q = { id: "q", question: "Explain", options: null };
    expect(() => prepareCodexInteraction("item/tool/requestUserInput", { questions: [q, q] }, base)).toThrow("重复");
    const interaction = prepareCodexInteraction("mcpServer/elicitation/request", {
      mode: "form", requestedSchema: { type: "object", required: ["__proto__"],
        properties: { ["__proto__"]: { type: "string" } } },
    }, base);
    const result = interaction.decode({ kind: "questionnaire", answers: [{ id: "__proto__", values: [], other: "text" }] });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ action: "accept", content: { ["__proto__"]: "text" } });
  });

  it("URL approval requires explicit completion and excludes non-web schemes", () => {
    const params = { mode: "url", serverName: "demo", message: "Connect", url: "https://example.com/connect" };
    const interaction = prepareCodexInteraction("mcpServer/elicitation/request", params, base);
    expect(interaction.request).toMatchObject({ externalUrl: params.url, confirmLabel: "我已完成网页操作" });
    expect(interaction.decode({ kind: "confirm", value: true })).toEqual({ action: "accept", content: null });
    expect(() => prepareCodexInteraction("mcpServer/elicitation/request", { ...params, url: "file:///C:/private" }, base)).toThrow();
    expect(codexDecline("mcpServer/elicitation/request")).toEqual({ action: "decline", content: null });
    expect(codexDecline("unknown")).toBeUndefined();
  });

  it("reports effective session permissions without guessing missing state", () => {
    expect(codexPermissions({})).toBeUndefined();
    expect(codexPermissions({ approvalPolicy: "never", sandbox: { type: "readOnly" }, approvalsReviewer: "user" }))
      .toMatchObject({ sandbox: "readOnly", approvalPolicy: "never", networkAccess: false, reviewer: "user" });
    expect(codexPermissions({ approvalPolicy: "on-request", sandboxPolicy: {
      type: "workspaceWrite", networkAccess: true, writableRoots: ["D:/repo"],
    }, activePermissionProfile: { id: ":workspace" } })).toMatchObject({ networkAccess: true, writableRoots: ["D:/repo"], profile: ":workspace" });
  });
});
