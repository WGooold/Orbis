import type { ProviderFields } from "./provider-form.js";
import { ProviderError } from "./provider-error.js";

export function providerUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError("请填写有效的供应商 API 地址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new ProviderError("供应商地址须为 HTTP(S)，且不能包含登录信息");
  return url;
}
export async function responseJson(response: Response, limit = 2_000_000): Promise<unknown> {
  if (!response.body) throw new ProviderError("供应商没有返回响应内容");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new ProviderError("供应商响应超过大小限制");
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new ProviderError("供应商未返回有效 JSON"); }
  } finally { await reader.cancel().catch(() => {}); }
}
/** CC Switch reachability: any HTTP response is reachable; never spend tokens or send credentials. */
export async function checkProviderEndpoint(baseUrl: string): Promise<{ status: "operational" | "degraded" | "failed"; latencyMs: number; httpStatus?: number }> {
  const url = providerUrl(baseUrl); const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "manual", headers: { accept: "*/*", "accept-encoding": "identity" } });
    const latencyMs = Math.round(performance.now() - started);
    await response.body?.cancel();
    return { status: latencyMs > 1500 ? "degraded" : "operational", latencyMs, httpStatus: response.status };
  } catch { return { status: "failed", latencyMs: Math.round(performance.now() - started) }; }
}
export async function fetchProviderModels(fields: ProviderFields): Promise<{ id: string; name: string }[]> {
  const url = providerUrl(fields.baseUrl);
  if (fields.api === "bedrock-converse-stream") throw new ProviderError("Bedrock 使用 AWS 认证，请手动配置模型");
  if (fields.apiKey.startsWith("!")) throw new ProviderError("模型发现不执行 Pi 命令表达式，请手动配置模型");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path || "/v1"}/models`;
  const headers = new Headers(fields.headers);
  if (fields.api === "anthropic-messages") {
    headers.set("x-api-key", fields.apiKey); headers.set("anthropic-version", "2023-06-01");
  } else if (fields.api === "google-generative-ai") headers.set("x-goog-api-key", fields.apiKey);
  else if (fields.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${fields.apiKey}`);
  let response: Response;
  try { response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new ProviderError("获取模型失败，请检查端点、网络和认证方式"); }
  if (!response.ok) { await response.body?.cancel(); throw new ProviderError(`获取模型失败（HTTP ${response.status}）`); }
  const body = await responseJson(response) as { data?: unknown; models?: unknown };
  const values = body?.data ?? body?.models;
  if (!Array.isArray(values)) throw new ProviderError("供应商返回的模型列表格式不受支持");
  const seen = new Set<string>();
  return values.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as { id?: unknown; name?: unknown; displayName?: unknown };
    const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : "";
    if (!id || seen.has(id) || id.length > 256) return [];
    seen.add(id);
    return [{ id, name: typeof entry.displayName === "string" ? entry.displayName : id }];
  }).slice(0, 2000);
}
