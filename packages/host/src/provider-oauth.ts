// Codex OAuth contract from CC Switch f8788719 (MIT): device login, stable
// local account IDs, refresh preflight and adoption of CLI token rotations.
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProviderError } from "./provider-error.js";
import { responseJson } from "./provider-network.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const issuer = "https://auth.openai.com";
type Tokens = { id_token: string; access_token: string; refresh_token: string; account_id: string };
type Account = { id: string; subject: string; workspace: string; email: string; refreshToken: string; idToken: string; updatedAt: number; authenticatedAt: number };
type Store = { version: 1; accounts: Account[]; defaultId?: string };
export type OAuthAccount = { id: string; email: string; workspace: string; authenticatedAt: number; isDefault: boolean };
export type ManagedAuthMarker = { accountId: string; identity: string; fingerprint: string };
type Pending = { userCode: string; expiresAt: number; interval: number; nextPoll: number; targetId?: string };
export function tokenClaims(jwt: string): Obj {
  try { return object(JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"))); } catch { return {}; }
}
function identity(idToken: string, fallbackWorkspace = ""): { subject: string; workspace: string; email: string } {
  const claims = tokenClaims(idToken);
  const workspace = text(object(claims["https://api.openai.com/auth"]).chatgpt_account_id) || text(claims.chatgpt_account_id) || fallbackWorkspace;
  const subject = text(claims.sub);
  if (!subject || !workspace) throw new ProviderError("账号缺少用户或工作区身份，请重新登录");
  if (fallbackWorkspace && workspace !== fallbackWorkspace) throw new ProviderError("登录凭据中的工作区身份不一致");
  return { subject, workspace, email: text(claims.email) };
}
function nativeTokens(auth: unknown): Tokens {
  const value = object(object(auth).tokens);
  if (["id_token", "access_token", "refresh_token", "account_id"].some(key => !text(value[key]).trim())) throw new ProviderError("未找到完整的 Codex 官方登录，请先登录或添加账号");
  identity(text(value.id_token), text(value.account_id));
  return value as Tokens;
}
export function managedAuthMarker(accountId: string, auth: unknown): ManagedAuthMarker {
  const tokens = nativeTokens(auth); const owner = identity(tokens.id_token, tokens.account_id);
  return { accountId, identity: `${owner.workspace}:${owner.subject}`, fingerprint: createHash("sha256").update(JSON.stringify(tokens)).digest("hex") };
}

/** All methods run under ProviderManager's cross-process lock. Rotated refresh
 * tokens are saved before native writes and never rolled back to spent tokens. */
export class CodexOAuthAccounts {
  #pending = new Map<string, Pending>();
  #access = new Map<string, { value: string; expiresAt: number }>();
  constructor(readonly path: string, readonly request: typeof fetch = fetch, readonly now = Date.now) {}
  async #load(): Promise<Store> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) { if (object(error).code === "ENOENT") return { version: 1, accounts: [] }; throw error; }
    const data = object(JSON.parse(raw));
    if (data.version !== 1 || !Array.isArray(data.accounts)) throw new ProviderError("OAuth 账号目录格式无效，未覆盖现有文件");
    return data as Store;
  }
  async #save(store: Store): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, this.path); }
    finally { await rm(temp, { force: true }); }
  }
  async list(): Promise<OAuthAccount[]> {
    const store = await this.#load();
    return store.accounts.map(a => ({ id: a.id, email: a.email, workspace: a.workspace, authenticatedAt: a.authenticatedAt, isDefault: a.id === store.defaultId }));
  }
  async defaultId(): Promise<string | undefined> { return (await this.#load()).defaultId; }
  async setDefault(id: string): Promise<void> {
    const store = await this.#load(); if (!store.accounts.some(a => a.id === id)) throw new ProviderError("OAuth 账号不存在");
    store.defaultId = id; await this.#save(store);
  }
  async remove(id: string): Promise<void> {
    const store = await this.#load(); store.accounts = store.accounts.filter(a => a.id !== id);
    if (store.defaultId === id) { delete store.defaultId; if (store.accounts[0]) store.defaultId = store.accounts[0].id; }
    await this.#save(store); this.#access.delete(id);
    for (const [code, pending] of this.#pending) if (pending.targetId === id) this.#pending.delete(code);
  }
  async importNative(auth: unknown): Promise<string> {
    const tokens = nativeTokens(auth);
    const updatedAt = Date.parse(text(object(auth).last_refresh));
    return this.#register(tokens, Number.isFinite(updatedAt) ? updatedAt : this.now());
  }
  async #register(tokens: Tokens, updatedAt: number, targetId?: string): Promise<string> {
    const owner = identity(tokens.id_token, tokens.account_id); const store = await this.#load();
    const same = store.accounts.find(a => a.subject === owner.subject && a.workspace === owner.workspace);
    if (targetId) {
      const target = store.accounts.find(a => a.id === targetId);
      if (!target) throw new ProviderError("待重新登录的账号已删除");
      if (target.subject !== owner.subject || target.workspace !== owner.workspace) throw new ProviderError("登录身份与所选账号不同，请使用添加账号");
    }
    const id = targetId || same?.id || randomUUID();
    const account: Account = { id, ...owner, refreshToken: tokens.refresh_token, idToken: tokens.id_token, updatedAt, authenticatedAt: this.now() };
    if (same) Object.assign(same, account); else store.accounts.push(account);
    store.defaultId ??= id;
    await this.#save(store);
    this.#access.set(id, { value: tokens.access_token, expiresAt: this.#expires(tokens.access_token) });
    return id;
  }
  #expires(token: string): number {
    const exp = tokenClaims(token).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  }
  async #post(path: string, body: Obj | URLSearchParams): Promise<Response> {
    try { return await this.request(`${issuer}${path}`, { method: "POST", body: body instanceof URLSearchParams ? body : JSON.stringify(body), headers: { "content-type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json", "user-agent": "orbis-codex-oauth" }, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
    catch { throw new ProviderError("OAuth 服务暂时无法连接，请稍后重试"); }
  }
  async start(targetId?: string): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresAt: number; interval: number }> {
    if (targetId && !(await this.list()).some(a => a.id === targetId)) throw new ProviderError("OAuth 账号不存在");
    for (const [id, value] of this.#pending) if (value.expiresAt <= this.now() || (targetId && value.targetId === targetId)) this.#pending.delete(id);
    if (this.#pending.size >= 5) throw new ProviderError("请先完成或取消已有登录");
    const response = await this.#post("/api/accounts/deviceauth/usercode", { client_id: clientId });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderError(`无法开始登录（HTTP ${response.status}）`); }
    const data = object(await responseJson(response, 64_000));
    if (!text(data.device_auth_id) || !text(data.user_code)) throw new ProviderError("OAuth 登录响应格式无效");
    const interval = Math.min(60, Math.max(5, Number(data.interval) || 5)) + 3;
    const expiresAt = this.now() + Math.min(900, Math.max(1, Number(data.expires_in) || 900)) * 1000;
    this.#pending.set(text(data.device_auth_id), { userCode: text(data.user_code), expiresAt, interval, nextPoll: this.now() + interval * 1000, ...(targetId ? { targetId } : {}) });
    return { deviceCode: text(data.device_auth_id), userCode: text(data.user_code), verificationUrl: `${issuer}/codex/device`, expiresAt, interval };
  }
  cancel(code: string): void { this.#pending.delete(code); }
  async poll(code: string): Promise<{ pending: boolean; accountId?: string }> {
    const pending = this.#pending.get(code);
    if (!pending || pending.expiresAt <= this.now()) { this.#pending.delete(code); throw new ProviderError("登录已取消或过期，请重新开始"); }
    if (pending.nextPoll > this.now()) return { pending: true };
    pending.nextPoll = this.now() + pending.interval * 1000;
    const response = await this.#post("/api/accounts/deviceauth/token", { device_auth_id: code, user_code: pending.userCode });
    if (response.status === 403 || response.status === 404) { await response.body?.cancel(); return { pending: true }; }
    if (!response.ok) { await response.body?.cancel(); this.#pending.delete(code); throw new ProviderError(`登录授权失败（HTTP ${response.status}）`); }
    const grant = object(await responseJson(response, 64_000));
    if (!text(grant.authorization_code) || !text(grant.code_verifier)) throw new ProviderError("OAuth 授权响应格式无效");
    const exchange = await this.#post("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code: text(grant.authorization_code), redirect_uri: `${issuer}/deviceauth/callback`, client_id: clientId, code_verifier: text(grant.code_verifier) }));
    if (!exchange.ok) { await exchange.body?.cancel(); throw new ProviderError(`登录凭据交换失败（HTTP ${exchange.status}）`); }
    const data = object(await responseJson(exchange, 128_000));
    const owner = identity(text(data.id_token));
    const tokens = nativeTokens({ tokens: { ...data, account_id: owner.workspace } });
    const id = await this.#register(tokens, this.now(), pending.targetId);
    this.#pending.delete(code); return { pending: false, accountId: id };
  }
  /** Only a marked, same-user CLI login may update a managed refresh token. */
  async adopt(marker: ManagedAuthMarker | undefined, auth: unknown): Promise<void> {
    if (!marker || !auth) return;
    let tokens: Tokens;
    try { tokens = nativeTokens(auth); } catch { return; }
    let owner: { subject: string; workspace: string; email: string };
    try { owner = identity(tokens.id_token, tokens.account_id); } catch { return; }
    if (marker.identity !== `${owner.workspace}:${owner.subject}`) return; // Independent CLI login.
    const store = await this.#load(); const account = store.accounts.find(a => a.id === marker.accountId);
    if (!account || account.subject !== owner.subject || account.workspace !== owner.workspace) return;
    const sameTokens = account.refreshToken === tokens.refresh_token && account.idToken === tokens.id_token;
    const updatedAt = Date.parse(text(object(auth).last_refresh));
    if (!sameTokens && (!Number.isFinite(updatedAt) || updatedAt === account.updatedAt)) throw new ProviderError("检测到无法确定先后顺序的 Codex 登录凭据；请重新导入本机登录");
    if (!sameTokens && updatedAt < account.updatedAt) return;
    if (!sameTokens) {
      account.refreshToken = tokens.refresh_token; account.idToken = tokens.id_token; account.updatedAt = updatedAt;
      await this.#save(store);
    }
    this.#access.set(account.id, { value: tokens.access_token, expiresAt: this.#expires(tokens.access_token) });
  }
  async auth(id?: string): Promise<{ accountId: string; auth: Obj }> {
    const store = await this.#load(); const account = store.accounts.find(a => a.id === (id || store.defaultId));
    if (!account) throw new ProviderError("绑定的 OAuth 账号不可用，请添加账号并重新选择");
    let cached = this.#access.get(account.id);
    if (!cached || cached.expiresAt - this.now() < 60_000) {
      const response = await this.#post("/oauth/token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: clientId, scope: "openid profile email" }));
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError(response.status === 400 || response.status === 401 ? "OAuth 登录已失效，请重新登录该账号" : `刷新 OAuth 登录失败（HTTP ${response.status}）`); }
      const data = object(await responseJson(response, 128_000));
      if (!text(data.access_token)) throw new ProviderError("刷新响应缺少访问令牌");
      const owner = identity(text(data.id_token) || account.idToken, account.workspace);
      if (owner.subject !== account.subject) throw new ProviderError("刷新响应的用户身份不一致，未切换账号");
      account.refreshToken = text(data.refresh_token) || account.refreshToken;
      account.idToken = text(data.id_token) || account.idToken; account.updatedAt = this.now();
      await this.#save(store); // Do not restore a consumed refresh token if the native write fails.
      cached = { value: text(data.access_token), expiresAt: this.#expires(text(data.access_token)) || this.now() + Math.max(1, Number(data.expires_in) || 3600) * 1000 };
      this.#access.set(account.id, cached);
    }
    return { accountId: account.id, auth: { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: account.idToken, access_token: cached.value, refresh_token: account.refreshToken, account_id: account.workspace }, last_refresh: new Date(account.updatedAt).toISOString() } };
  }
}
