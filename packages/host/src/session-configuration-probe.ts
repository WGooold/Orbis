import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { SessionConfigurationCatalog, SessionConfigurationValues } from "@orbis/protocol";
import type { PiCommand } from "./spawner.js";
import { PI_WORKSPACE_APPROVAL_ARGS } from "./agent-startup.js";
import { agentInvocation, stopAgentProcess } from "./agent-command.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const objects = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];

/** A short native read, without a prompt or persistent session. No credential values leave this process. */
async function probe(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  requests: Obj[], response: (value: Obj) => boolean): Promise<Obj[]> {
  const invocation = agentInvocation({ command, prefixArgs: [] }, args, env);
  const child = spawn(invocation.command, invocation.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    detached: process.platform !== "win32",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
  const results: Obj[] = [];
  try {
    return await new Promise<Obj[]>((resolve, reject) => {
      let input = ""; let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(results);
      };
      const timer = setTimeout(() => finish(new Error("原生配置读取超时，请重试")), 15_000);
      child.on("error", () => finish(new Error("无法读取原生配置，请检查 Agent 安装")));
      child.on("exit", () => { if (results.length < requests.length) finish(new Error("原生配置读取未完成")); });
      child.stdin.on("error", () => finish(new Error("原生配置读取连接已关闭")));
      child.stdout.on("data", (bytes: Buffer) => {
        input += bytes.toString("utf8");
        if (input.length > 4 * 1024 * 1024) { finish(new Error("原生配置清单过大")); return; }
        let index: number;
        while ((index = input.indexOf("\n")) >= 0) {
          const line = input.slice(0, index); input = input.slice(index + 1);
          try {
            const item = object(JSON.parse(line));
            if (response(item)) results.push(item);
            if (results.length === requests.length) finish();
          } catch { /* The CLI can print informational lines before JSON. */ }
        }
      });
      // Drain diagnostics but never return raw credential-bearing native output.
      child.stderr.resume();
      for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  } finally {
    child.stdin.destroy();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      void stopAgentProcess(child, env, process.platform !== "win32" || /\.(?:cmd|bat|ps1)$/iu.test(command));
    });
  }
}

export async function piSessionConfiguration(pi: PiCommand, cwd: string, env: NodeJS.ProcessEnv): Promise<SessionConfigurationCatalog> {
  const results = await probe(pi.command, [...pi.prefixArgs, "--offline", "--mode", "rpc", "--no-session", ...PI_WORKSPACE_APPROVAL_ARGS,
    "--no-mcp", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates"], cwd, { ...env, ORBIS_CONFIGURATION_PROBE: "1" },
    [{ id: "configuration-state", type: "get_state" }, { id: "configuration-models", type: "get_available_models" }], value => value.type === "response");
  if (results.some(result => result.success !== true)) throw new Error("Pi 未能读取模型配置");
  const state = object(results.find(item => item.command === "get_state")?.data);
  const models = objects(object(results.find(item => item.command === "get_available_models")?.data).models);
  const selected = object(state.model);
  const available = models.flatMap(model => {
    if (typeof model.provider !== "string" || typeof model.id !== "string") return [];
    const map = object(model.thinkingLevelMap);
    const levels = model.reasoning === true ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter(level =>
      map[level] !== null && (!["xhigh", "max"].includes(level) || map[level] !== undefined)) : ["off"];
    return [{ value: `${model.provider}/${model.id}`, label: `${String(model.name ?? model.id)} (${model.provider})`,
      thinking: levels.map(value => ({ value, label: value })) }];
  });
  return { binding: createHash("sha256").update(JSON.stringify(models.map(model => [model.provider, model.id, model.baseUrl]))).digest("hex"),
    defaults: { ...(typeof selected.provider === "string" && typeof selected.id === "string" ? { model: `${selected.provider}/${selected.id}` } : {}),
      ...(typeof state.thinkingLevel === "string" && state.model ? { thinking: state.thinkingLevel } : {}) },
    models: available, permissions: [], notice: "Pi 的权限由电脑端与扩展管理。" };
}

export async function claudeSessionConfiguration(command: string, cwd: string, env: NodeJS.ProcessEnv, selected?: SessionConfigurationValues): Promise<SessionConfigurationCatalog> {
  const results = await probe(command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    ...(selected?.model === undefined ? [] : ["--model", selected.model]),
    ...(selected?.thinking === undefined ? [] : ["--effort", selected.thinking]),
    ...(selected?.permissions?.mode === undefined ? [] : ["--permission-mode", selected.permissions.mode === "default" ? "manual" : selected.permissions.mode])], cwd,
    { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    [{ type: "control_request", request_id: "configuration", request: { subtype: "initialize" } }], value => value.type === "control_response");
  const response = object(results[0]?.response);
  if (response.subtype !== "success") throw new Error("Claude 未能读取原生配置");
  const data = object(response.response);
  const models = objects(data.models).flatMap(model => typeof model.value !== "string" ? [] : [{ value: model.value,
    label: typeof model.resolvedModel === "string" ? `${String(model.displayName ?? model.value)} (${model.resolvedModel})` : String(model.displayName ?? model.value),
    thinking: (Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter((value): value is string => typeof value === "string").map(value => ({ value, label: value })) : []) }]);
  // The alias list does not report the selected model. Sending `default` would
  // override a configured model, so both unknown defaults stay inherited.
  const mode = typeof data.current_permission_mode === "string" ? data.current_permission_mode : undefined;
  const permissionValues = mode === undefined ? {} : { mode };
  // CLI calls the interactive default `manual`; transcript/classic hooks call it `default`.
  const modes = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
  return { binding: createHash("sha256").update(JSON.stringify([env.CLAUDE_CONFIG_DIR, env.ANTHROPIC_BASE_URL, models])).digest("hex"),
    defaults: { permissions: mode === "manual" ? { mode: "default" } : permissionValues }, models,
    permissions: [{ id: "mode", label: "权限模式", ...(mode === undefined ? {} : { currentValue: mode }),
      options: modes.map(value => ({ value, label: ({ default: "手动审批", acceptEdits: "允许编辑", plan: "计划模式", auto: "自动审查", dontAsk: "不询问", bypassPermissions: "跳过权限检查" })[value] ?? value })) }] };
}
