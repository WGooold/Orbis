import { Worker } from "node:worker_threads";
import { ProviderError } from "./provider-error.js";
import { providerUrl, responseJson } from "./provider-network.js";
import { usageTemplate } from "./provider-usage-templates.js";

export type UsageScript = { enabled: boolean; language: "javascript"; code: string; timeout: number; apiKey?: string; baseUrl?: string; accessToken?: string; userId?: string; templateType?: string; autoQueryInterval?: number };
export class UsageQueryError extends ProviderError {
  constructor(message: string, readonly transient: boolean) { super(message); }
}
export function validateUsageScript(value: unknown): UsageScript {
  const script = value as UsageScript | null;
  if (!script || typeof script.enabled !== "boolean" || script.language !== "javascript" || typeof script.code !== "string" || script.code.length > 32_000 || !Number.isFinite(script.timeout) || script.timeout < 2 || script.timeout > 30) throw new ProviderError("用量脚本必须使用 JavaScript，超时为 2–30 秒，代码不超过 32 KB");
  for (const key of ["apiKey", "baseUrl", "accessToken", "userId", "templateType"] as const) if (script[key] !== undefined && (typeof script[key] !== "string" || script[key].length > 4000)) throw new ProviderError("用量脚本凭据格式无效");
  if (script.autoQueryInterval !== undefined && (!Number.isInteger(script.autoQueryInterval) || script.autoQueryInterval < 0 || script.autoQueryInterval > 1440)) throw new ProviderError("自动查询间隔须为 0–1440 分钟，0 表示关闭");
  return structuredClone(script);
}
async function evaluate(code: string, response?: unknown): Promise<unknown> {
  const worker = new Worker(new URL("./provider-usage-worker.js", import.meta.url), { workerData: { code, ...(response === undefined ? {} : { response }) }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { void worker.terminate(); reject(new ProviderError("用量脚本执行超时")); }, 6_000);
    worker.once("message", (message: { error?: string; result?: unknown }) => { clearTimeout(timeout); void worker.terminate(); if (message.error) reject(new ProviderError(message.error)); else resolve(message.result); });
    worker.once("error", () => { clearTimeout(timeout); reject(new ProviderError("无法执行用量脚本")); });
    worker.once("exit", code => { clearTimeout(timeout); if (code !== 0) reject(new ProviderError("用量脚本进程已结束")); });
  });
}
export async function queryProviderUsage(script: UsageScript, credentials: { apiKey: string; baseUrl: string }): Promise<unknown[]> {
  validateUsageScript(script);
  if (!script.enabled) throw new ProviderError("用量查询未启用");
  let baseUrl = script.baseUrl?.trim() || credentials.baseUrl;
  let code = script.code;
  if (script.templateType === "balance") {
    const template = usageTemplate("balance", baseUrl);
    code = template.code; baseUrl = template.baseUrl!;
  }
  for (const [key, value] of Object.entries({ apiKey: script.apiKey?.trim() || credentials.apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), accessToken: script.accessToken ?? "", userId: script.userId ?? "" })) code = code.replaceAll(`{{${key}}}`, value);
  const request = await evaluate(code) as { url?: unknown; method?: unknown; headers?: HeadersInit; body?: unknown } | null;
  if (!request || typeof request.url !== "string") throw new ProviderError("用量脚本缺少 request.url");
  const url = providerUrl(request.url);
  if (script.templateType !== "custom") {
    const base = providerUrl(baseUrl);
    if (url.hostname !== base.hostname || (url.port || (url.protocol === "https:" ? "443" : "80")) !== (base.port || (base.protocol === "https:" ? "443" : "80"))) throw new ProviderError("用量请求的主机和端口必须与供应商一致");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new ProviderError("用量请求需要 HTTPS");
  }
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) throw new ProviderError("用量请求方法无效");
  const headers = new Headers(request.headers);
  const body = request.body === undefined ? undefined : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  let response: Response;
  try { response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: "error", signal: AbortSignal.timeout(script.timeout * 1000) }); }
  catch { throw new UsageQueryError("用量请求失败，请检查网络与脚本配置", true); }
  if (!response.ok) { await response.body?.cancel(); throw new UsageQueryError(`用量请求失败（HTTP ${response.status}）`, response.status >= 500 || response.status === 429); }
  let data: unknown;
  try { data = await responseJson(response); }
  catch (error) { throw new UsageQueryError(error instanceof ProviderError ? error.message : "读取用量响应失败", !(error instanceof ProviderError)); }
  const output = await evaluate(code, data);
  const rows = Array.isArray(output) ? output : [output];
  if (!rows.length || rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || ["remaining", "total", "used"].some(key => row[key] !== undefined && (typeof row[key] !== "number" || !Number.isFinite(row[key]))))) throw new ProviderError("用量脚本返回的额度格式无效");
  return rows;
}
