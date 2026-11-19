import { execFile } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { Readable } from "node:stream";
import * as tls from "node:tls";
import { promisify } from "node:util";
import type { ProviderFields } from "./provider-form.js";
import { ProviderError } from "./provider-error.js";

const execute = promisify(execFile);
const nativeFetch = globalThis.fetch;

const isLoopbackHost = (host: string): boolean => {
  const clean = host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (clean === "localhost" || clean.endsWith(".localhost") || clean === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (clean.startsWith("::ffff:127.")) return true;
  return false;
};

export function shouldBypassProxy(hostname: string, exceptions: string[]): boolean {
  if (isLoopbackHost(hostname)) return true;
  const host = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  for (const raw of exceptions) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    if (rule === "<local>") { if (!host.includes(".")) return true; continue; }
    const target = rule.replace(/:\d+$/, "");
    if (target.startsWith("*.")) {
      const suffix = target.slice(1);
      if (host.endsWith(suffix) || host === target.slice(2)) return true;
    } else if (target.startsWith(".")) {
      if (host.endsWith(target) || host === target.slice(1)) return true;
    } else if (host === target || host.endsWith(`.${target}`)) {
      return true;
    }
  }
  return false;
}

function normalizeProxyUrl(raw: string, defaultScheme = "http"): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${defaultScheme}://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:", "socks5:", "socks5h:", "socks:"].includes(parsed.protocol) || !parsed.hostname) return undefined;
    return parsed.toString();
  } catch { return undefined; }
}

export function parseScutilProxy(output: string, protocol: "http:" | "https:"): { url?: string; exceptions: string[] } {
  const scalar = (key: string): string | undefined => {
    const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"));
    return match?.[1]?.trim();
  };
  const exceptions: string[] = [];
  const block = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/);
  if (block?.[1]) {
    for (const line of block[1].split("\n")) {
      const entry = line.match(/^\s*\d+\s*:\s*(.+)$/);
      if (entry?.[1]) exceptions.push(entry[1].trim());
    }
  }
  const hostPort = (host: string | undefined, port: string | undefined, scheme: string): string | undefined => {
    if (!host || !port || !/^\d+$/.test(port)) return undefined;
    const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return normalizeProxyUrl(`${scheme}://${formatted}:${port}`, scheme);
  };
  if (protocol === "https:" && scalar("HTTPSEnable") === "1") {
    const url = hostPort(scalar("HTTPSProxy"), scalar("HTTPSPort"), "http");
    if (url) return { url, exceptions };
  }
  if (scalar("HTTPEnable") === "1") {
    const url = hostPort(scalar("HTTPProxy"), scalar("HTTPPort"), "http");
    if (url) return { url, exceptions };
  }
  if (scalar("SOCKSEnable") === "1") {
    const url = hostPort(scalar("SOCKSProxy"), scalar("SOCKSPort"), "socks5");
    if (url) return { url, exceptions };
  }
  return { exceptions };
}

export function parseWindowsProxy(output: string, protocol: "http:" | "https:"): { url?: string; exceptions: string[] } {
  const enabled = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  if (!enabled || Number.parseInt(enabled[1] ?? "0", 16) !== 1) return { exceptions: [] };
  const server = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  if (!server) return { exceptions: [] };
  const override = output.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() ?? "";
  const exceptions = override.split(";").map(s => s.trim()).filter(Boolean);
  if (!server.includes("=")) {
    const url = normalizeProxyUrl(server, "http");
    return url ? { url, exceptions } : { exceptions };
  }
  const map = new Map<string, string>();
  for (const part of server.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const scheme = protocol === "https:" ? ["https", "http", "socks"] : ["http", "https", "socks"];
  for (const key of scheme) {
    const value = map.get(key);
    if (!value) continue;
    const url = normalizeProxyUrl(value, key === "socks" ? "socks5" : "http");
    if (url) return { url, exceptions };
  }
  return { exceptions };
}

async function resolveProxyUrl(target: URL, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (shouldBypassProxy(target.hostname, noProxy)) return undefined;
  const keys = target.protocol === "https:"
    ? ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]
    : ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  for (const key of keys) {
    const value = env[key];
    if (value?.trim()) return normalizeProxyUrl(value);
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execute("/usr/sbin/scutil", ["--proxy"], { timeout: 2_000, maxBuffer: 64_000 });
      const parsed = parseScutilProxy(stdout, target.protocol);
      if (parsed.url && !shouldBypassProxy(target.hostname, parsed.exceptions)) return parsed.url;
    } catch { /* Fall back to direct connection when scutil is unavailable. */ }
  } else if (process.platform === "win32") {
    try {
      const { stdout } = await execute("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { timeout: 2_000, maxBuffer: 64_000 });
      const parsed = parseWindowsProxy(stdout, target.protocol);
      if (parsed.url && !shouldBypassProxy(target.hostname, parsed.exceptions)) return parsed.url;
    } catch { /* Fall back to direct connection when registry lookup fails. */ }
  }
  return undefined;
}

function readSocketUntil(socket: net.Socket, signal: AbortSignal | undefined, complete: (buf: Buffer) => number | undefined): Promise<{ head: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); socket.destroy(); reject(new Error("Proxy request aborted")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error("Proxy connection closed prematurely")); };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > 16_384) { cleanup(); socket.destroy(); reject(new Error("Proxy handshake exceeded size limit")); return; }
      const joined = Buffer.concat(chunks);
      const splitAt = complete(joined);
      if (splitAt !== undefined) {
        cleanup();
        resolve({ head: joined.subarray(0, splitAt), rest: joined.subarray(splitAt) });
      }
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  });
}

function encodeIpv6(ip: string): Buffer | undefined {
  const zone = ip.indexOf("%");
  const clean = zone >= 0 ? ip.slice(0, zone) : ip;
  const parts = clean.split("::");
  if (parts.length > 2) return undefined;
  const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if (missing < 0 || (parts.length === 1 && missing !== 0)) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return undefined;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const val = Number.parseInt(groups[i]!, 16);
    if (!Number.isFinite(val) || val < 0 || val > 0xffff) return undefined;
    buf.writeUInt16BE(val, i * 2);
  }
  return buf;
}

async function openProxySocket(proxy: URL, target: URL, signal: AbortSignal | undefined): Promise<net.Socket> {
  const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const targetHost = target.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : proxy.protocol.startsWith("socks") ? 1080 : 80);
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  const socket: net.Socket = proxy.protocol === "https:"
    ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })
    : net.connect({ host: proxyHost, port: proxyPort });
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { cleanup(); socket.destroy(); reject(new Error("Proxy request aborted")); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const onConnect = () => { cleanup(); resolve(); };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off(proxy.protocol === "https:" ? "secureConnect" : "connect", onConnect);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", onConnect);
  });
  try {
    if (proxy.protocol.startsWith("socks")) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password);
      const hasAuth = user.length > 0 || pass.length > 0;
      socket.write(Buffer.from(hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
      const greeting = await readSocketUntil(socket, signal, buf => buf.length >= 2 ? 2 : undefined);
      if (greeting.rest.length) socket.unshift(greeting.rest);
      if (greeting.head[0] !== 0x05 || greeting.head[1] === 0xff) throw new Error("SOCKS5 handshake rejected");
      if (greeting.head[1] === 0x02) {
        const u = Buffer.from(user, "utf8");
        const p = Buffer.from(pass, "utf8");
        if (u.length > 255 || p.length > 255) throw new Error("SOCKS5 credentials too long");
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        const auth = await readSocketUntil(socket, signal, buf => buf.length >= 2 ? 2 : undefined);
        if (auth.rest.length) socket.unshift(auth.rest);
        if (auth.head[1] !== 0x00) throw new Error("SOCKS5 authentication failed");
      } else if (greeting.head[1] !== 0x00) {
        throw new Error("SOCKS5 auth method unsupported");
      }
      let addrBytes: Buffer;
      let atyp: number;
      if (net.isIPv4(targetHost)) {
        atyp = 0x01;
        addrBytes = Buffer.from(targetHost.split(".").map(n => Number.parseInt(n, 10)));
      } else {
        const ipv6 = net.isIPv6(targetHost) ? encodeIpv6(targetHost) : undefined;
        if (ipv6) { atyp = 0x04; addrBytes = ipv6; }
        else {
          const domain = Buffer.from(targetHost, "utf8");
          if (domain.length > 255) throw new Error("Target host too long for SOCKS5");
          atyp = 0x03;
          addrBytes = Buffer.concat([Buffer.from([domain.length]), domain]);
        }
      }
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), addrBytes, portBuf]));
      const reply = await readSocketUntil(socket, signal, buf => {
        if (buf.length < 4) return undefined;
        const type = buf[3];
        if (type === 0x01) return buf.length >= 10 ? 10 : undefined;
        if (type === 0x04) return buf.length >= 22 ? 22 : undefined;
        if (type === 0x03) {
          if (buf.length < 5) return undefined;
          const total = 5 + buf[4]! + 2;
          return buf.length >= total ? total : undefined;
        }
        return buf.length;
      });
      if (reply.rest.length) socket.unshift(reply.rest);
      if (reply.head[0] !== 0x05 || reply.head[1] !== 0x00) throw new Error(`SOCKS5 connect failed (${reply.head[1]})`);
      return target.protocol === "https:" ? tls.connect({ socket, servername: targetHost }) : socket;
    }
    const authority = targetHost.includes(":") ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
    if (proxy.username || proxy.password) {
      const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
      lines.push(`Proxy-Authorization: Basic ${auth}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    const response = await readSocketUntil(socket, signal, buf => {
      const idx = buf.indexOf("\r\n\r\n");
      return idx >= 0 ? idx + 4 : undefined;
    });
    if (response.rest.length) socket.unshift(response.rest);
    const statusLine = response.head.toString("latin1").split("\r\n")[0] ?? "";
    const code = Number.parseInt(statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/)?.[1] ?? "0", 10);
    if (code !== 200) throw new Error(`Proxy CONNECT failed (${code})`);
    return tls.connect({ socket, servername: targetHost });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function requestViaProxy(input: string | URL, init: RequestInit, proxyUrl: string): Promise<Response> {
  const target = new URL(input.toString());
  const proxy = new URL(proxyUrl);
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw new Error("Request aborted");
  const isHttpsTarget = target.protocol === "https:";
  const useDirectHttpProxy = !isHttpsTarget && (proxy.protocol === "http:" || proxy.protocol === "https:");
  const tunnelSocket = useDirectHttpProxy ? undefined : await openProxySocket(proxy, target, signal);

  const reqHeaders = new Headers(init.headers);
  const headers: Record<string, string> = {};
  reqHeaders.forEach((value, key) => { headers[key] = value; });
  if (useDirectHttpProxy && (proxy.username || proxy.password)) {
    headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
  }
  const bodyBuffer = typeof init.body === "string" ? Buffer.from(init.body, "utf8")
    : init.body instanceof URLSearchParams ? Buffer.from(init.body.toString(), "utf8")
      : init.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
  if (bodyBuffer && !reqHeaders.has("content-length")) headers["content-length"] = String(bodyBuffer.byteLength);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      tunnelSocket?.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => { req.destroy(new Error("Request aborted")); fail(new Error("Request aborted")); };
    const tunnelAgent = useDirectHttpProxy ? undefined : (() => {
      const agent = new (isHttpsTarget ? https.Agent : http.Agent)({ keepAlive: false });
      agent.createConnection = () => tunnelSocket!;
      return agent;
    })();
    const options: https.RequestOptions = useDirectHttpProxy ? {
      protocol: proxy.protocol,
      hostname: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
      method: init.method ?? "GET",
      path: target.toString(),
      headers: { ...headers, host: target.host },
      agent: false,
    } : {
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: Number(target.port) || (isHttpsTarget ? 443 : 80),
      method: init.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      headers,
      agent: tunnelAgent!,
    };
    const requester = (useDirectHttpProxy ? proxy.protocol === "https:" : isHttpsTarget) ? https.request : http.request;
    const req = requester(options, (res) => {
      const status = res.statusCode ?? 502;
      if (init.redirect === "error" && status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        fail(new Error("Redirect disallowed"));
        return;
      }
      const responseHeaders = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const key = res.rawHeaders[i];
        const value = res.rawHeaders[i + 1];
        if (key !== undefined && value !== undefined) responseHeaders.append(key, value);
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      const nullBody = [204, 205, 304].includes(status);
      if (nullBody) res.resume();
      const webBody = nullBody ? null : Readable.toWeb(res) as unknown as BodyInit;
      resolve(new Response(webBody, { status, ...(res.statusMessage ? { statusText: res.statusMessage } : {}), headers: responseHeaders }));
    });
    req.on("error", fail);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

export async function proxyFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (globalThis.fetch !== nativeFetch) return globalThis.fetch(input, init);
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const proxyUrl = await resolveProxyUrl(url);
  if (!proxyUrl) return nativeFetch(input, init);
  return requestViaProxy(url, init, proxyUrl);
}

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
    const text = Buffer.concat(chunks).toString("utf8");
    try { return JSON.parse(text) as unknown; }
    catch {
      if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text) || response.headers.get("content-type")?.includes("text/html")) {
        throw new ProviderError("供应商返回了 HTML 网页，请检查 API 地址及版本路径（如 /v1）");
      }
      throw new ProviderError("供应商未返回有效 JSON");
    }
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
  // Only Anthropic's SDK adds /v1 to its API root. OpenAI-compatible transports
  // append to the configured base URL verbatim, including a root with no version.
  url.pathname = fields.api === "anthropic-messages" && !path.endsWith("/v1") ? `${path}/v1/models` : `${path}/models`;
  const headers = new Headers(fields.headers);
  if (fields.api === "anthropic-messages") {
    headers.set("x-api-key", fields.apiKey); headers.set("anthropic-version", "2023-06-01");
  } else if (fields.api === "google-generative-ai") headers.set("x-goog-api-key", fields.apiKey);
  else if (fields.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${fields.apiKey}`);
  let response: Response;
  try { response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new ProviderError("获取模型失败，请检查端点、网络和认证方式"); }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 405 || response.headers.get("content-type")?.includes("text/html") ? "，请检查 API 地址及版本路径（如 /v1），当前地址可能指向网页" : "";
    throw new ProviderError(`获取模型失败（HTTP ${response.status}）${hint}`);
  }
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
