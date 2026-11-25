import { randomUUID } from "node:crypto";
import { GatewayClientRequestError } from "@openclaw/gateway-client";
import { validateConfigPatchParams } from "@openclaw/gateway-protocol";
import { validMessageFilePathText } from "./message-file-references.js";
import { openClawRecord, type OpenClawSettingsConnection } from "./openclaw-gateway.js";

type SettingValue = string | number | boolean | string[] | null;
type Field = Readonly<{ key: string; label: string; group: string; path: string; placeholder?: string } & (
  { kind: "model" | "workspace" | "models" | "tools" | "flag" } |
  { kind: "number"; min: number; max: number } |
  { kind: "choice"; options: Readonly<Record<string, string>> }
)>;

// OPENCLAW-HOST-SETTINGS-01: write only named, supported leaves of the pinned Gateway's
// config. The raw/redacted snapshot and all other fields stay out of the desktop bridge.
const agent = "模型与工作区", security = "权限与隔离", session = "会话";
const fields: readonly Field[] = [
  { key: "model", label: "默认模型", group: agent, path: "agents.defaults.model.primary", kind: "model", placeholder: "供应商/模型 ID" },
  { key: "fallbacks", label: "备用模型", group: agent, path: "agents.defaults.model.fallbacks", kind: "models", placeholder: "按优先顺序，用英文逗号分隔" },
  { key: "workspace", label: "默认工作区", group: agent, path: "agents.defaults.workspace", kind: "workspace", placeholder: "Gateway 所在电脑的目录" },
  { key: "thinking", label: "思考强度", group: agent, path: "agents.defaults.thinkingDefault", kind: "choice", options: { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极高", adaptive: "自适应" } },
  { key: "reasoning", label: "思考内容显示", group: agent, path: "agents.defaults.reasoningDefault", kind: "choice", options: { off: "关闭", on: "显示", stream: "流式显示" } },
  { key: "timeout", label: "运行超时（秒）", group: agent, path: "agents.defaults.timeoutSeconds", kind: "number", min: 0, max: 86400 },
  { key: "concurrency", label: "最大并发", group: agent, path: "agents.defaults.maxConcurrent", kind: "number", min: 1, max: 1024 },
  { key: "profile", label: "工具配置", group: security, path: "tools.profile", kind: "choice", options: { minimal: "最少工具", coding: "编程", messaging: "消息", full: "全部工具" } },
  { key: "allow", label: "允许的工具", group: security, path: "tools.allow", kind: "tools", placeholder: "以英文逗号分隔" },
  { key: "alsoAllow", label: "在工具配置上追加", group: security, path: "tools.alsoAllow", kind: "tools", placeholder: "不能与允许列表同时设置" },
  { key: "deny", label: "禁止的工具", group: security, path: "tools.deny", kind: "tools", placeholder: "以英文逗号分隔" },
  { key: "filesInWorkspace", label: "文件工具限于工作区", group: security, path: "tools.fs.workspaceOnly", kind: "flag" },
  { key: "sandbox", label: "沙盒模式", group: security, path: "agents.defaults.sandbox.mode", kind: "choice", options: { off: "关闭", "non-main": "仅非主会话", all: "所有会话" } },
  { key: "workspaceAccess", label: "沙盒工作区权限", group: security, path: "agents.defaults.sandbox.workspaceAccess", kind: "choice", options: { none: "不挂载", ro: "只读", rw: "读写" } },
  { key: "sandboxScope", label: "沙盒隔离单位", group: security, path: "agents.defaults.sandbox.scope", kind: "choice", options: { session: "每个会话", agent: "每个 Agent", shared: "共享" } },
  { key: "execHost", label: "命令执行位置", group: security, path: "tools.exec.host", kind: "choice", options: { auto: "自动", sandbox: "沙盒", gateway: "Gateway 所在电脑", node: "已配对节点" } },
  { key: "execMode", label: "命令审批", group: security, path: "tools.exec.mode", kind: "choice", options: { deny: "拒绝执行", allowlist: "允许列表", ask: "询问", auto: "自动审核", full: "不经审批" } },
  { key: "execTimeout", label: "命令超时（秒）", group: security, path: "tools.exec.timeoutSeconds", kind: "number", min: 1, max: 86400 },
  { key: "elevated", label: "允许提权执行", group: security, path: "tools.elevated.enabled", kind: "flag" },
  { key: "resetMode", label: "会话重置策略", group: session, path: "session.reset.mode", kind: "choice", options: { none: "不重置", daily: "每天", idle: "空闲时" } },
  { key: "resetHour", label: "重置时刻（0–23 点）", group: session, path: "session.reset.atHour", kind: "number", min: 0, max: 23 },
  { key: "idleMinutes", label: "空闲时长（分钟）", group: session, path: "session.reset.idleMinutes", kind: "number", min: 1, max: 525600 },
];

const modelId = /^[a-z\d][a-z\d._:/+@-]{0,255}$/iu;
const toolId = /^[a-z\d_*][a-z\d_.:*?-]{0,127}$/iu;
const localWorkspace = /^(?:\/(?!\/)|[a-z]:[\\/]|~[\\/])/iu;

function valueFor(field: Field, value: unknown): SettingValue | undefined {
  if (value === null) return null;
  switch (field.kind) {
    case "model": return typeof value === "string" && modelId.test(value) ? value : undefined;
    case "workspace": return typeof value === "string" && value.length <= 2048 && localWorkspace.test(value) && validMessageFilePathText(value) ? value : undefined;
    case "choice": return typeof value === "string" && Object.hasOwn(field.options, value) ? value : undefined;
    case "number": return typeof value === "number" && Number.isSafeInteger(value) && value >= field.min && value <= field.max ? value : undefined;
    case "flag": return typeof value === "boolean" ? value : undefined;
    case "models": case "tools": {
      const pattern = field.kind === "models" ? modelId : toolId;
      return Array.isArray(value) && value.length <= 32 && value.every((entry): entry is string => typeof entry === "string" && pattern.test(entry))
        && new Set(value).size === value.length ? [...value] : undefined;
    }
  }
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let result: unknown = obj;
  for (const piece of path.split(".")) {
    const row = openClawRecord(result);
    if (!row || !Object.hasOwn(row, piece)) return undefined;
    result = row[piece];
  }
  return result;
}

function setPatch(root: Record<string, unknown>, path: string, value: SettingValue | Record<string, unknown>): void {
  const parts = path.split(".");
  const key = parts.pop()!;
  let row = root;
  for (const part of parts) {
    const next = openClawRecord(row[part]) ?? {};
    row[part] = next;
    row = next;
  }
  row[key] = value;
}

type FormField = Omit<Field, "path"> & { value: SettingValue; editable: boolean; options?: Readonly<Record<string, string>>; min?: number; max?: number };
type Snapshot = { hash: string; shorthand: string | undefined; fields: FormField[]; explicitAllow: boolean; explicitAlsoAllow: boolean };
function snapshotOf(response: unknown): Snapshot {
  const result = openClawRecord(response);
  // Prefer authored/resolved values. Runtime-added defaults are not explicit user configuration.
  const config = openClawRecord(result?.sourceConfig ?? result?.resolved ?? result?.config);
  const hash = result?.hash;
  if (result?.valid !== true || result.writeError !== undefined || !config || typeof hash !== "string" || !hash || hash.length > 160 || !validMessageFilePathText(hash)) {
    throw new Error("Gateway 未返回可编辑的配置。请在 OpenClaw 控制台检查配置后重新读取。");
  }
  const model = getPath(config, "agents.defaults.model");
  const shorthand = typeof model === "string" ? model : undefined;
  const legacyExecPolicy = getPath(config, "tools.exec.security") !== undefined || getPath(config, "tools.exec.ask") !== undefined;
  const projected = fields.map(field => {
    const { path, ...display } = field;
    const observed = field.key === "model" && shorthand !== undefined ? shorthand : getPath(config, path);
    const value = valueFor(field, observed ?? null);
    const editable = value !== undefined && !(field.key === "fallbacks" && shorthand !== undefined && !modelId.test(shorthand))
      && !(field.key === "execMode" && legacyExecPolicy);
    return { ...display, value: value ?? null, editable };
  });
  return { hash, shorthand, fields: projected, explicitAllow: Array.isArray(getPath(config, "tools.allow")),
    explicitAlsoAllow: Array.isArray(getPath(config, "tools.alsoAllow")) };
}

function patchFor(snapshot: Snapshot, changes: unknown) {
  const entries = openClawRecord(changes);
  if (!entries || Object.keys(entries).length > fields.length) throw new Error("OpenClaw 设置格式无效");
  const normalized = new Map<Field, SettingValue>();
  for (const [key, raw] of Object.entries(entries)) {
    const field = fields.find(item => item.key === key);
    const previous = snapshot.fields.find(item => item.key === key);
    if (!field || !previous?.editable) throw new Error("OpenClaw 设置包含不能在 Host 编辑的项目");
    const value = valueFor(field, raw);
    if (value === undefined) throw new Error(`请检查「${field.label}」的值`);
    if (JSON.stringify(value) !== JSON.stringify(previous.value)) normalized.set(field, value);
  }
  if ((Object.hasOwn(entries, "allow") ? Array.isArray(entries.allow) : snapshot.explicitAllow) &&
      (Object.hasOwn(entries, "alsoAllow") ? Array.isArray(entries.alsoAllow) : snapshot.explicitAlsoAllow)) {
    throw new Error("允许列表和追加列表不能同时设置。请清空其中一项。");
  }

  const patch: Record<string, unknown> = {};
  const replacePaths: string[] = [];
  const modelChanges = [...normalized].filter(([field]) => field.key === "model" || field.key === "fallbacks");
  for (const [field, value] of normalized) {
    // The model config can be a string shorthand. Preserve it when only fallbacks change.
    if (snapshot.shorthand !== undefined && modelChanges.some(([item]) => field === item)) continue;
    setPatch(patch, field.path, value);
    if (field.kind === "models" || field.kind === "tools") replacePaths.push(field.path);
  }
  if (snapshot.shorthand !== undefined && modelChanges.length) {
    const changed = new Map(modelChanges.map(([field, value]) => [field.key, value]));
    const primary = changed.has("model") ? changed.get("model") : snapshot.shorthand;
    const fallbacks = changed.get("fallbacks");
    const defaults = { ...(typeof primary === "string" ? { primary } : {}), ...(Array.isArray(fallbacks) ? { fallbacks } : {}) };
    setPatch(patch, "agents.defaults.model", Object.keys(defaults).length ? defaults : null);
  }
  const params = { raw: JSON.stringify(patch), baseHash: snapshot.hash, response: "summary" as const, ...(replacePaths.length ? { replacePaths } : {}) };
  if (!validateConfigPatchParams(params)) throw new Error("OpenClaw 设置格式无效");
  return normalized.size ? params : undefined;
}

/** A local, single-use form bound to the same authenticated connection and Gateway revision. */
export class OpenClawNativeSettings {
  #form: { ticket: string; connection: OpenClawSettingsConnection; snapshot: Snapshot } | undefined;
  constructor(readonly current: () => OpenClawSettingsConnection | undefined) {}

  async read(): Promise<{ ticket: string; fields: FormField[] }> {
    this.#form = undefined;
    const connection = this.current();
    if (!connection) throw new Error("请先连接 Gateway，并确认 Host 已获得管理员权限。");
    let result: unknown;
    try { result = await connection.request("config.get", {}); }
    catch { throw new Error("无法读取 Gateway 配置。请核对 Gateway 授权和连接状态。"); }
    if (connection !== this.current()) throw new Error("Gateway 已重新连接，请重新读取配置。");
    const snapshot = snapshotOf(result);
    const ticket = randomUUID();
    this.#form = { ticket, connection, snapshot };
    return { ticket, fields: snapshot.fields };
  }

  async apply(ticket: unknown, changes: unknown) {
    const form = this.#form;
    if (!form || ticket !== form.ticket || form.connection !== this.current()) throw new Error("此配置已过期，请重新读取后再应用。");
    const params = patchFor(form.snapshot, changes);
    if (!params) return { state: "unchanged" as const };
    this.#form = undefined;
    let result: unknown;
    try { result = await form.connection.request("config.patch", params); }
    catch (error) {
      if (error instanceof GatewayClientRequestError) {
        if (error.gatewayCode === "INVALID_REQUEST" && error.message === "config changed since last load; re-run config.get and retry")
          throw new Error("Gateway 配置已被修改。请重新读取并核对，再应用你的改动。");
        if (error.gatewayCode === "INVALID_REQUEST") throw new Error("Gateway 拒绝了这些配置值。请核对 OpenClaw 控制台中的配置和版本。");
        if (error.gatewayCode === "FORBIDDEN") throw new Error("Gateway 未允许保存配置。请在 Gateway 核对 Orbis Host 的管理员权限。");
      }
      throw new Error("未确认配置是否保存。请重新读取 Gateway 配置，不要直接重复提交。");
    }
    const receipt = openClawRecord(result);
    if (receipt?.ok !== true) throw new Error("未确认配置是否保存。请重新读取 Gateway 配置，不要直接重复提交。");
    return { state: receipt.noop === true ? "unchanged" as const : "saved" as const, restarting: !!openClawRecord(receipt.restart) };
  }
}
