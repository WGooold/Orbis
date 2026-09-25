// CC Switch f8788719 UsageScriptModal and services/balance.rs (MIT).
import { ProviderError } from "./provider-error.js";
import { providerUrl } from "./provider-network.js";

export const usageTemplates = [
  { id: "custom", name: "自定义脚本" }, { id: "general", name: "通用余额" },
  { id: "newapi", name: "New API" }, { id: "balance", name: "官方余额（DeepSeek 等）" },
];
export function usageTemplate(id: string, baseUrl: string): { code: string; baseUrl?: string } {
  if (id === "custom") return { code: '({\n  request: { url: "", method: "GET", headers: {} },\n  extractor: response => ({ remaining: 0, unit: "USD" })\n})' };
  if (id === "general") return { code: '({\n  request: { url: "{{baseUrl}}/user/balance", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } },\n  extractor: response => ({ isValid: response.is_active ?? true, remaining: response.balance, unit: "USD" })\n})' };
  if (id === "newapi") return { code: '({\n  request: { url: "{{baseUrl}}/api/user/self", method: "GET", headers: { Authorization: "Bearer {{accessToken}}", "New-Api-User": "{{userId}}", "Content-Type": "application/json" } },\n  extractor: response => response.success && response.data ? { planName: response.data.group || "默认套餐", remaining: response.data.quota / 500000, used: response.data.used_quota / 500000, total: (response.data.quota + response.data.used_quota) / 500000, unit: "USD" } : { isValid: false, invalidMessage: response.message || "查询失败" }\n})' };
  if (id !== "balance") throw new ProviderError("未知用量模板");
  const host = providerUrl(baseUrl).hostname.toLowerCase();
  let origin = `https://${host}`; let path: string; let extractor: string;
  if (host === "api.deepseek.com") {
    path = "/user/balance";
    extractor = 'r => (r.balance_infos || []).map(b => ({ planName: b.currency || "CNY", remaining: Number(b.total_balance), unit: b.currency || "CNY", isValid: r.is_available ?? true }))';
  } else if (["api.stepfun.ai", "api.stepfun.com"].includes(host)) {
    origin = "https://api.stepfun.com"; path = "/v1/accounts";
    extractor = 'r => ({ planName: "StepFun", remaining: Number(r.balance), unit: "CNY", isValid: true })';
  } else if (["api.siliconflow.cn", "api.siliconflow.com"].includes(host)) {
    path = "/v1/user/info";
    extractor = `r => ({ planName: "SiliconFlow", remaining: Number(r.data.totalBalance), unit: "${host.endsWith(".cn") ? "CNY" : "USD"}", isValid: true })`;
  } else if (host === "openrouter.ai") {
    path = "/api/v1/credits";
    extractor = 'r => { const d = r.data || r; const total = Number(d.total_credits), used = Number(d.total_usage); return { planName: "OpenRouter", total, used, remaining: total - used, unit: "USD", isValid: total > used }; }';
  } else if (host === "api.novita.ai") {
    path = "/v3/user/balance";
    extractor = 'r => ({ planName: "Novita AI", remaining: Number(r.availableBalance) / 10000, unit: "USD", isValid: Number(r.availableBalance) > 0 })';
  } else throw new ProviderError("此端点暂无官方余额模板，请选择通用、New API 或自定义脚本");
  return { baseUrl: origin, code: `({\n  request: { url: "{{baseUrl}}${path}", method: "GET", headers: { Authorization: "Bearer {{apiKey}}", Accept: "application/json" } },\n  extractor: ${extractor}\n})` };
}
