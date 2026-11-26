// AGY-15: verify the developer credential independently of ACP. In agy 1.5.17
// authenticate and session/list can succeed with an arbitrary nonempty key.
const modelsUrl = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
export type AgyKeyCheck = "verified" | "rejected" | "unavailable" | "invalid";

export function agyKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512 || /\p{Cc}/u.test(value)) return undefined;
  const key = value.trim();
  // Do not pin the provider's current prefix/length (standard keys and AQ. keys differ).
  return /^[A-Za-z0-9._-]{16,512}$/.test(key) ? key : undefined;
}

export function agyEnvironmentKey(env = process.env): string | undefined {
  return env.ORBIS_AGY_ENABLED === "1" ? agyKey(env.GEMINI_API_KEY) : undefined;
}

export async function verifyAgyKey(value: unknown, signal?: AbortSignal, request = fetch): Promise<AgyKeyCheck> {
  const key = agyKey(value);
  if (!key) return "invalid";
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(10_000);
  try {
    const result = await request(modelsUrl, { method: "GET", headers: { "x-goog-api-key": key }, redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    // The body is not needed. Never read or log Google error bodies (which can contain request data).
    void result.body?.cancel().catch(() => {});
    signal?.throwIfAborted();
    if (result.status === 200) return "verified";
    if ([400, 401, 403].includes(result.status)) return "rejected";
    return "unavailable";
  } catch { signal?.throwIfAborted(); return "unavailable"; }
}

export function agyKeyFailure(status: Exclude<AgyKeyCheck, "verified">): string {
  if (status === "rejected") return "Google 未接受 Gemini API Key；请在 Host 更换密钥或检查项目权限";
  if (status === "unavailable") return "暂时无法验证 Gemini API Key；请检查 Host 到 Google 的连接后重试";
  return "请先在 Host 本机配置 Gemini API Key";
}
