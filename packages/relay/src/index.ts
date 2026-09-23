import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import {
  decodeJson,
  DeviceClientMessageSchema,
  PROTOCOL_VERSION,
  OutboundChannelMux,
  type MuxChannel,
  type RelayToDeviceMessage,
  type RelayToRuntimeMessage,
  RuntimeClientMessageSchema,
} from "@pi-remote/protocol";
import { WebSocketServer, WebSocket } from "ws";
import { RegistrationError, type RegistrationAuthority } from "./registration.js";
import { RelayAdmin } from "./admin.js";
import { HttpError, jsonResponse, readJson, requestSource } from "./http-utils.js";
import { createWebHandler } from "./web.js";

export interface RelayDeviceCredential {
  deviceId: string;
  credential: string;
  name: string;
  hostId?: string;
}

export interface RelayServerOptions {
  port?: number;
  host?: string;
  runtimeCredentials?: string[];
  deviceCredentials?: RelayDeviceCredential[];
  adminToken?: string;
  pairingTtlMs?: number;
  heartbeatIntervalMs?: number;
  stateFile?: string;
  registration?: RegistrationAuthority;
  adminStateFile?: string;
  downloadsDir?: string;
  /** Enable only when a trusted reverse proxy overwrites X-Real-IP. */
  trustProxy?: boolean;
  buildCommit?: string;
}

export interface RelayServer {
  readonly url: string;
  close(): Promise<void>;
}

type RuntimeConnection = {
  socket: WebSocket;
  name: string;
  connectedAt: number;
};

type DeviceConnection = {
  socket: WebSocket;
  deviceId: string;
  hostId?: string;
};

const hashCredential = (credential: string): Buffer => createHash("sha256").update(credential).digest();

const hasCredential = (hashes: Buffer[], candidate: string): boolean => {
  const candidateHash = hashCredential(candidate);
  return hashes.some((hash) => hash.length === candidateHash.length && timingSafeEqual(hash, candidateHash));
};

/**
 * 每台设备的出站多路复用器（见 `OutboundChannelMux`）。按 socket 存，连接换了自然换新的。
 *
 * 中继转发 v2 帧时**不做任何背压判断**（只有二进制推送路由有，阈值还是 64 MiB），于是下载
 * 一起来，分片就一路堆进设备 socket，控制帧按字节流顺序排在那几十兆后面——这正是「下载一开，
 * 所有控制都不响应」。`hdr.ch` 是**明文**（不在 `ct` 里、也不进 AAD），所以中继不必解密就能
 * 按 channel 调度，零知识一点没少。
 */
const deviceMuxes = new WeakMap<WebSocket, OutboundChannelMux<string>>();
const MUX_WARN_INTERVAL_MS = 10_000;
let lastMuxWarnAt = 0;

/**
 * 一帧该按哪个 channel 调度。
 *
 * `v2.frame` 直接读明文的 `hdr.ch`（**加密帧必填**，ADR-0008）；握手/配对帧（`hs`/`pair`）
 * 不参与加密流、本来就没有 `ch`，按 `ctl` 走（它们必须立即有序地送出去）；其余（状态、目录、
 * 交互、推送通知）都是小帧，一律当 `ctl`。
 */
const muxChannelOfMessage = (message: RelayToDeviceMessage | RelayToRuntimeMessage): MuxChannel => {
  if (message.type !== "v2.frame") return "ctl";
  const { k, ch } = message.envelope.hdr;
  if (k === "hs" || k === "pair") return "ctl";
  if (ch === undefined) throw new Error(`加密帧 ${k} 缺少 hdr.ch`);
  return ch;
};

const muxFor = (socket: WebSocket): OutboundChannelMux<string> => {
  const existing = deviceMuxes.get(socket);
  if (existing !== undefined) return existing;
  // 中继现在只搬 JSON 帧（推送删除后连原始二进制帧都没有了，见 ADR-0009）——所有帧共用
  // 同一个 socket 字节流，分成多条队列的话优先级就形同虚设：先入队的那条一样能把控制帧堵住。
  const created = new OutboundChannelMux<string>({
    write: (frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    },
    backlog: () => socket.bufferedAmount,
    // 这个类**绝不**丢弃已封好的帧：中继看不到 `transferId`，丢了没法让任何一方自愈，而丢一个
    // v2 帧在接收侧是**永久**空洞（发送序号推进了、对端永远收不到，整条会话报废）。队列超上限
    // 时只报警，照发——等于没有这条上限；内存由设备侧的 pull 窗口兜住。
    onBulkQueuedTooLong: (queuedMs, queuedBytes) => {
      const now = Date.now();
      if (now - lastMuxWarnAt < MUX_WARN_INTERVAL_MS) return;
      lastMuxWarnAt = now;
      console.warn(JSON.stringify({
        event: "relay.bulk.queued",
        queuedMs: Math.round(queuedMs),
        queuedBytes,
        bufferedAmount: socket.bufferedAmount,
      }));
    },
    // 队列撞上护栏（每个连接只报一次）：说明有一方在无限地从上往下灌分片。照发不丢，
    // 但这条日志是唯一能看见「内存正在被链路当缓冲」的地方。
    onBulkOverflow: (queuedBytes) => {
      console.warn(JSON.stringify({
        event: "relay.bulk.overflow",
        queuedBytes,
        bufferedAmount: socket.bufferedAmount,
      }));
    },
  });
  deviceMuxes.set(socket, created);
  return created;
};

const send = (socket: WebSocket, message: RelayToDeviceMessage | RelayToRuntimeMessage): void => {
  if (socket.readyState !== WebSocket.OPEN) return;
  // 先序列化再入队：多路复用器要拿字节数记账。`ctl` 在同一个 tick 内就写出去，
  // 所以相对顺序与直接 `socket.send` 完全一致；只有 `bulk` 会在链路积压时留在队列里等。
  const text = JSON.stringify(message);
  muxFor(socket).enqueue(muxChannelOfMessage(message), text, text.length);
};

const reject = (socket: WebSocket, code: string, message: string): void => {
  send(socket, { type: "protocol.error", code, message });
  setTimeout(() => socket.close(1008, code), 0);
};

const protocolValidationMessage = (value: unknown, issues: readonly { path: PropertyKey[] }[]): string => {
  const message = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const type = typeof message?.type === "string" ? message.type : "<missing>";
  const event = message?.event && typeof message.event === "object" ? message.event as Record<string, unknown> : undefined;
  const eventType = typeof event?.type === "string" ? event.type : undefined;
  const fieldNames = message === undefined ? "<non-object>" : Object.keys(message).sort().join(",").slice(0, 256);
  const paths = issues.map((issue) => issue.path.map(String).join(".") || "<root>").join(",").slice(0, 256);
  return `Message does not match the runtime protocol (type=${type}${eventType === undefined ? "" : `, eventType=${eventType}`}, fields=${fieldNames}, issuePaths=${paths || "<root>"})`;
};

const logProtocolValidationFailure = (value: unknown, issues: readonly { path: PropertyKey[] }[]): void => {
  const message = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const event = message?.event && typeof message.event === "object" ? message.event as Record<string, unknown> : undefined;
  console.warn(JSON.stringify({
    event: "runtime.protocol.invalid_message",
    type: typeof message?.type === "string" ? message.type : "<missing>",
    eventType: typeof event?.type === "string" ? event.type : undefined,
    fields: message === undefined ? "<non-object>" : Object.keys(message).sort().join(",").slice(0, 256),
    issuePaths: issues.map((issue) => issue.path.map(String).join(".") || "<root>").join(",").slice(0, 256),
  }));
};

export async function createRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const serveWeb = await createWebHandler(options.downloadsDir);
  const runtimeWss = new WebSocketServer({ noServer: true });
  const deviceWss = new WebSocketServer({ noServer: true });
  const responsiveSockets = new WeakSet<WebSocket>();
  const authenticatedSockets = new WeakSet<WebSocket>();
  const monitorSocket = (socket: WebSocket): void => {
    responsiveSockets.add(socket);
    socket.on("pong", () => responsiveSockets.add(socket));
  };
  const markAuthenticated = (socket: WebSocket): void => {
    authenticatedSockets.add(socket);
    responsiveSockets.add(socket);
  };
  const runtimeCredentialHashes = (options.runtimeCredentials ?? []).map(hashCredential);
  const devicesByCredential = new Map(
    (options.deviceCredentials ?? []).map((device) => [
      hashCredential(device.credential).toString("hex"),
      { deviceId: device.deviceId, name: device.name, ...(device.hostId === undefined ? {} : { hostId: device.hostId }) },
    ]),
  );
  if (options.stateFile) {
    try {
      const persisted = JSON.parse(await readFile(options.stateFile, "utf8")) as {
        version?: unknown;
        devices?: Array<{ credentialHash?: unknown; deviceId?: unknown; name?: unknown; hostId?: unknown }>;
      };
      if (persisted.version !== 1 || !Array.isArray(persisted.devices)) throw new Error("Invalid Relay state file");
      for (const device of persisted.devices) {
        if (
          typeof device.credentialHash === "string" && /^[a-f0-9]{64}$/.test(device.credentialHash) &&
          typeof device.deviceId === "string" && typeof device.name === "string"
        ) {
          devicesByCredential.set(device.credentialHash, { deviceId: device.deviceId, name: device.name, ...(typeof device.hostId === "string" ? { hostId: device.hostId } : {}) });
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  let persistence = Promise.resolve();
  const persistDevices = (): Promise<void> => {
    if (!options.stateFile) return Promise.resolve();
    const devices = [...devicesByCredential].map(([credentialHash, device]) => ({ credentialHash, ...device }));
    const pending = persistence.then(async () => {
      const temporary = `${options.stateFile}.${process.pid}.tmp`;
      await mkdir(dirname(options.stateFile!), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
      await rename(temporary, options.stateFile!);
    });
    persistence = pending.catch(() => {});
    return pending;
  };
  const pairingCodes = new Map<string, { expiresAt: number; hostId?: string }>();
  const runtimes = new Map<string, RuntimeConnection>();
  const devices = new Set<DeviceConnection>();
  const findDevice = (deviceId: string): DeviceConnection | undefined => {
    let latest: DeviceConnection | undefined;
    for (const device of devices) {
      if (device.deviceId === deviceId) latest = device;
    }
    return latest;
  };
  const adminTokenHash = options.adminToken ? hashCredential(options.adminToken) : undefined;
  const admin = await RelayAdmin.create({
    ...(options.adminToken === undefined ? {} : { token: options.adminToken }),
    ...(options.adminStateFile || options.stateFile ? { stateFile: options.adminStateFile ?? `${options.stateFile}.admin.json` } : {}),
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
  });
  const startedAt = Date.now();
  const registrationStatus = () => ({
    enabled: options.registration !== undefined && (!admin.qqEmailVerificationRequired || options.registration.enabled),
    emailDomain: "qq.com",
    qqEmailVerificationRequired: admin.qqEmailVerificationRequired,
    mailConfigured: options.registration?.enabled ?? false,
  });
  const isAdmin = (request: IncomingMessage): boolean => {
    if (!adminTokenHash) return false;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return false;
    const candidate = hashCredential(authorization.slice("Bearer ".length));
    return timingSafeEqual(adminTokenHash, candidate);
  };
  const revokeDevice = async (deviceId: string): Promise<void> => {
    const removed = [...devicesByCredential].filter(([, device]) => device.deviceId === deviceId);
    for (const [hash, device] of devicesByCredential) {
      if (device.deviceId === deviceId) devicesByCredential.delete(hash);
    }
    try { await persistDevices(); }
    catch (error) { for (const [hash, device] of removed) devicesByCredential.set(hash, device); throw error; }
    for (const device of devices) {
      if (device.deviceId === deviceId) device.socket.close(4003, "device revoked");
    }
  };

  const server: HttpServer = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
      if (await serveWeb(request, response, path)) return;
      if (request.method === "POST" && path === "/v1/admin/login") {
        const body = await readJson(request) as { token?: unknown };
        const session = admin.login(request, response, body && typeof body === "object" ? body.token : undefined);
        jsonResponse(response, 200, { csrf: session.csrf, expiresInSeconds: Math.floor((session.expiresAt - Date.now()) / 1000) });
        return;
      }
      if (request.method === "POST" && path === "/v1/admin/logout") {
        admin.logout(request, response);
        jsonResponse(response, 204);
        return;
      }
      if (request.method === "GET" && path === "/v1/admin/session") {
        const session = admin.authenticate(request);
        jsonResponse(response, 200, { csrf: session.csrf, expiresAt: session.expiresAt });
        return;
      }
      if (request.method === "POST" && path === "/v1/admin/registration") {
        admin.authenticate(request, true);
        if (!options.registration) throw new HttpError(503, "registration_unavailable");
        const body = await readJson(request) as { qqEmailVerificationRequired?: unknown };
        if (!body || typeof body.qqEmailVerificationRequired !== "boolean") throw new HttpError(400, "invalid_request");
        await admin.record("registration.email_verification", body.qqEmailVerificationRequired ? "required" : "optional", { qqEmailVerificationRequired: body.qqEmailVerificationRequired });
        jsonResponse(response, 200, registrationStatus());
        return;
      }
      if (request.method === "GET" && path === "/v1/admin/overview") {
        admin.authenticate(request);
        const deviceMap = new Map([...devicesByCredential.values()].map(device => [device.deviceId, device]));
        const deviceList = [...deviceMap.values()].map(device => ({ ...device, online: [...devices].some(connection => connection.deviceId === device.deviceId && connection.socket.readyState === WebSocket.OPEN) }));
        const registered = options.registration?.listHosts() ?? [];
        const hostIds = new Set([...registered.map(host => host.hostId), ...runtimes.keys(), ...deviceList.flatMap(device => device.hostId ? [device.hostId] : []), ...admin.disabledHosts()]);
        const hosts = [...hostIds].map(hostId => ({
          hostId, ...registered.find(host => host.hostId === hostId),
          name: runtimes.get(hostId)?.name ?? hostId,
          connectedAt: runtimes.get(hostId)?.connectedAt ?? null,
          online: runtimes.get(hostId)?.socket.readyState === WebSocket.OPEN,
          disabled: admin.isDisabled(hostId),
          registered: options.registration?.hasHost(hostId) ?? false,
          deviceCount: deviceList.filter(device => device.hostId === hostId).length,
        }));
        jsonResponse(response, 200, {
          buildCommit: options.buildCommit,
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
          registration: { ...registrationStatus(), hosts: registered.length, verifiedHosts: registered.filter(host => host.verifiedAt !== null).length },
          hosts: { online: hosts.filter(host => host.online).length, list: hosts },
          devices: deviceList,
          sockets: { hosts: runtimes.size, devices: devices.size, total: runtimes.size + devices.size },
          audit: admin.events(),
        });
        return;
      }
      const disableHostMatch = /^\/v1\/admin\/hosts\/([^/]+)$/.exec(path);
      if (request.method === "POST" && disableHostMatch) {
        admin.authenticate(request, true);
        const hostId = decodeURIComponent(disableHostMatch[1] ?? "");
        if (!options.registration?.hasHost(hostId) && !runtimes.has(hostId) && !admin.isDisabled(hostId) && ![...devicesByCredential.values()].some(device => device.hostId === hostId)) throw new HttpError(404, "host_not_found");
        const body = await readJson(request) as { disabled?: unknown };
        if (!body || typeof body.disabled !== "boolean") throw new HttpError(400, "invalid_request");
        await admin.record(body.disabled ? "host.disable" : "host.enable", hostId, { disabled: body.disabled });
        if (body.disabled) {
          runtimes.get(hostId)?.socket.close(4003, "host disabled");
          for (const device of devices) if (device.hostId === hostId) device.socket.close(4003, "host disabled");
          for (const [key, pairing] of pairingCodes) if (pairing.hostId === hostId) pairingCodes.delete(key);
        }
        jsonResponse(response, 204);
        return;
      }
      const adminDeviceMatch = /^\/v1\/admin\/devices\/([^/]+)$/.exec(path);
      if (request.method === "DELETE" && adminDeviceMatch) {
        admin.authenticate(request, true);
        const deviceId = decodeURIComponent(adminDeviceMatch[1] ?? "");
        if (![...devicesByCredential.values()].some(device => device.deviceId === deviceId)) throw new HttpError(404, "device_not_found");
        await revokeDevice(deviceId);
        await admin.record("device.revoke", deviceId);
        jsonResponse(response, 204);
        return;
      }
      if (request.method === "GET" && path === "/healthz") {
        jsonResponse(response, 200, { status: "ok", ...(options.buildCommit ? { commit: options.buildCommit } : {}) });
        return;
      }
      if (path.startsWith("/v1/registration/")) {
        response.setHeader("cache-control", "no-store");
        if (request.method === "GET" && path === "/v1/registration/status") {
          jsonResponse(response, 200, registrationStatus());
          return;
        }
        if (!options.registration) throw new RegistrationError(503, "registration_unavailable");
        if (request.method === "POST" && path === "/v1/registration/code") {
          const body = await readJson(request) as { email?: unknown; hostId?: unknown };
          if (!body || typeof body !== "object") throw new RegistrationError(400, "invalid_request");
          const forwarded = request.headers["x-real-ip"];
          const source = options.trustProxy && typeof forwarded === "string" ? forwarded : request.socket.remoteAddress ?? "unknown";
          jsonResponse(response, 202, await options.registration.requestCode(body, source));
          return;
        }
        if (request.method === "POST" && path === "/v1/registration/activate") {
          const body = await readJson(request) as { email?: unknown; hostId?: unknown; challengeId?: unknown; code?: unknown };
          if (!body || typeof body !== "object") throw new RegistrationError(400, "invalid_request");
          const activated = await options.registration.activate(body, requestSource(request, options.trustProxy), () => admin.qqEmailVerificationRequired);
          runtimes.get(activated.hostId)?.socket.close(4003, "credential rotated");
          jsonResponse(response, 201, activated);
          return;
        }
      }
      if (request.method === "GET" && path === "/v1/devices") {
        if (!isAdmin(request)) {
          jsonResponse(response, 401, { error: "unauthorized" });
          return;
        }
        jsonResponse(response, 200, {
          devices: [...new Map(
            [...devicesByCredential.values()].map((device) => [device.deviceId, device]),
          ).values()],
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/pairing-codes") {
        const authorization = request.headers.authorization;
        const hostId = authorization?.startsWith("Bearer ") ? options.registration?.hostForCredential(authorization.slice(7)) : undefined;
        if (hostId !== undefined && admin.isDisabled(hostId)) {
          jsonResponse(response, 403, { error: "host_disabled" });
          return;
        }
        if (hostId === undefined && !isAdmin(request)) {
          jsonResponse(response, 401, { error: "unauthorized" });
          return;
        }
        for (const [key, entry] of pairingCodes) if (entry.expiresAt <= Date.now()) pairingCodes.delete(key);
        if (hostId !== undefined) for (const [key, entry] of pairingCodes) if (entry.hostId === hostId) pairingCodes.delete(key);
        if (pairingCodes.size >= 10_000) { jsonResponse(response, 429, { error: "too_many_requests" }); return; }
        const code = randomBytes(6).toString("base64url").toUpperCase();
        pairingCodes.set(hashCredential(code).toString("hex"), { expiresAt: Date.now() + (options.pairingTtlMs ?? 300_000), ...(hostId === undefined ? {} : { hostId }) });
        jsonResponse(response, 201, { code, expiresInMs: options.pairingTtlMs ?? 300_000 });
        return;
      }

      if (request.method === "POST" && path === "/v1/pairings") {
        const body = await readJson(request) as { code?: unknown; deviceName?: unknown };
        if (typeof body.code !== "string" || typeof body.deviceName !== "string" || !body.deviceName.trim()) {
          jsonResponse(response, 400, { error: "invalid_request" });
          return;
        }
        const codeHash = hashCredential(body.code).toString("hex");
        const pairing = pairingCodes.get(codeHash);
        pairingCodes.delete(codeHash);
        if (!pairing || pairing.expiresAt < Date.now() || (pairing.hostId !== undefined && admin.isDisabled(pairing.hostId))) {
          jsonResponse(response, 401, { error: "invalid_pairing_code" });
          return;
        }
        const deviceId = randomBytes(16).toString("hex");
        const credential = randomBytes(32).toString("base64url");
        devicesByCredential.set(hashCredential(credential).toString("hex"), {
          deviceId,
          name: body.deviceName.trim().slice(0, 128),
          ...(pairing.hostId === undefined ? {} : { hostId: pairing.hostId }),
        });
        await persistDevices();
        jsonResponse(response, 201, { deviceId, credential });
        return;
      }

      if (request.method === "DELETE" && path === "/v1/device") {
        const authorization = request.headers.authorization;
        const credential = authorization?.startsWith("Bearer ")
          ? devicesByCredential.get(hashCredential(authorization.slice("Bearer ".length)).toString("hex"))
          : undefined;
        if (!credential) {
          jsonResponse(response, 401, { error: "unauthorized" });
          return;
        }
        await revokeDevice(credential.deviceId);
        jsonResponse(response, 204);
        return;
      }

      const revokeMatch = /^\/v1\/devices\/([^/]+)$/.exec(path);
      if (request.method === "DELETE" && revokeMatch) {
        if (!isAdmin(request)) {
          jsonResponse(response, 401, { error: "unauthorized" });
          return;
        }
        const deviceId = decodeURIComponent(revokeMatch[1] ?? "");
        await revokeDevice(deviceId);
        jsonResponse(response, 204);
        return;
      }

      jsonResponse(response, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      if (error instanceof RegistrationError || error instanceof HttpError) {
        if (error.status === 429) response.setHeader("retry-after", "60");
        if (!response.headersSent) jsonResponse(response, error.status, { error: error.code });
        else response.destroy();
        return;
      }
      if (!response.headersSent) jsonResponse(response, error instanceof URIError ? 400 : 500, { error: error instanceof URIError ? "invalid_request" : "internal_error" });
      else response.destroy();
    });
  });

  const broadcastToDevices = (message: RelayToDeviceMessage): void => {
    for (const device of devices) {
      if ((message.type === "host.online" || message.type === "host.offline") && device.hostId !== undefined && device.hostId !== message.hostId) continue;
      if ((message.type === "host.online" || message.type === "host.offline") && device.hostId === undefined && options.registration?.hasHost(message.hostId)) continue;
      send(device.socket, message);
    }
  };

  /**
   * 手机的**进程目录**只包含 agent。网关（Host 自己）也挂在 `runtimes` 里，但那是因为
   * `hdr.to = hostId` 的路由要查这张表；把它当进程播出去的话，手机上会多出一条 cwd 是
   * 用户目录的假进程，而真正的 Pi 进程看起来全都不在线。
   */

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    const wss = path === "/v1/runtime" ? runtimeWss : path === "/v1/device" ? deviceWss : undefined;
    if (!wss) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit("connection", webSocket, request));
  });

  runtimeWss.on("connection", (socket) => {
    monitorSocket(socket);
    let runtimeId: string | undefined;

    socket.on("message", (raw) => {
      let decoded: unknown;
      try {
        decoded = decodeJson(raw);
      } catch {
        reject(socket, "invalid_message", "Message must be valid JSON");
        return;
      }
      const parsed = RuntimeClientMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        logProtocolValidationFailure(decoded, parsed.error.issues);
        reject(socket, "invalid_message", protocolValidationMessage(decoded, parsed.error.issues));
        return;
      }
      const message = parsed.data;

      if (!runtimeId) {
        if (message.type !== "runtime.authenticate") {
          reject(socket, "unauthorized", "Authenticate before sending runtime events");
          return;
        }
        const registeredHost = options.registration?.hostForCredential(message.credential);
        if (admin.isDisabled(message.runtime.runtimeId)) {
          reject(socket, "host_disabled", "This Host has been disabled by an administrator");
          return;
        }
        if (registeredHost !== message.runtime.runtimeId && (registeredHost !== undefined || options.registration?.hasHost(message.runtime.runtimeId) || !hasCredential(runtimeCredentialHashes, message.credential))) {
          reject(socket, "unauthorized", "Invalid runtime credential");
          return;
        }
        if (message.role !== "host") {
          // **只有网关（Host）能挂到中继上。** 中继上的"运行时"入口会把该连接的事件
          // 以**明文**广播给设备（中继解不开 E2E，而它是运行时的直连入口），
          // 那等于让中继看见会话内容——"中继零知识"是这个产品的设计前提。
          // 扩展在找不到本机 Host 时也不再连中继（见 pi-extension 的 resolveRuntimeTransport）。
          reject(socket, "runtime_role_not_allowed", "Only the host gateway may connect to the relay");
          return;
        }
        runtimeId = message.runtime.runtimeId;
        const previous = runtimes.get(runtimeId);
        if (previous) {
          previous.socket.close(4001, "replaced");
        }
        runtimes.set(runtimeId, { socket, name: message.runtime.name.slice(0, 128), connectedAt: Date.now() });
        markAuthenticated(socket);
        send(socket, {
          type: "runtime.ready",
          protocolVersion: PROTOCOL_VERSION,
          runtimeId,
        });
        // 网关不上线/下线：它只是路由端点，不是手机要看见的进程。但它换进程这件事
        // 手机必须知道——手机只在自家 socket.open 时发 HS1，Host 重启后手机的 WS 还开着、
        // 不重握手的话，Host 侧握手永远 not_ready（UI「已连接」，请求全部石沉大海）。
        broadcastToDevices({ type: "host.online", hostId: runtimeId });
        return;
      }

      if (message.type === "v2.frame") {
        // 端到端加密帧：Relay 只看 `hdr.to` 决定送给哪台设备，不解析也不改写 `ct`。
        // 这条分支必须排在身份检查之前：v2 帧没有 `runtimeId` 字段，它完全靠 `hdr` 路由。
        if (runtimes.get(runtimeId)?.socket !== socket || admin.isDisabled(runtimeId)) return;
        if (message.envelope.hdr.from !== runtimeId) {
          reject(socket, "runtime_mismatch", "Frame sender must match the authenticated Host");
          return;
        }
        const target = findDevice(message.envelope.hdr.to);
        if (target && (target.hostId !== undefined ? target.hostId !== runtimeId : options.registration?.hasHost(runtimeId))) {
          reject(socket, "device_mismatch", "Device belongs to a different Host");
          return;
        }
        if (!target) {
          // 载荷是端到端加密的，中继只看得到收件人。回绝时必须把 `hdr.to` 一并交回：
          // Host 靠它知道是哪台设备不在了，从而把该设备名下的下载以确定原因收场，
          // 而不是对着黑洞一窗一窗重传（分片走的也是 v2 帧，中继取不到 transferId）。
          send(socket, {
            type: "protocol.error",
            code: "device_offline",
            message: "The destination device is offline",
            targetDeviceId: message.envelope.hdr.to,
          });
          return;
        }
        send(target.socket, message);
        return;
      }
      if (message.type === "runtime.authenticate" || message.runtimeId !== runtimeId) {
        reject(socket, "runtime_mismatch", "Runtime identity is bound to the authenticated connection");
        return;
      }
      if (runtimes.get(runtimeId)?.socket !== socket) return;
      if (message.type !== "runtime.event") return;
      // 中继不再转发运行时的明文事件：会话内容只能经 Host 的**端到端**通道到达设备。
      // 正常情况下这条分支到不了（只有 host 能认证），保留明确回绝是为了让"误接"立刻可见，
      // 而不是静默地把明文播出去。
      reject(socket, "runtime_event_not_allowed", "Runtime events must go through the host gateway");
    });

    socket.on("close", (_code, reason) => {
      if (!runtimeId) return;
      const active = runtimes.get(runtimeId);
      if (active?.socket !== socket) return;
      runtimes.delete(runtimeId);
      broadcastToDevices({ type: "host.offline", hostId: runtimeId, reason: reason.toString() || "disconnected" });
    });
  });

  deviceWss.on("connection", (socket) => {
    monitorSocket(socket);
    let connection: DeviceConnection | undefined;

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        reject(socket, "invalid_message", "Device messages must be JSON");
        return;
      }
      let parsed: ReturnType<typeof DeviceClientMessageSchema.safeParse>;
      try {
        parsed = DeviceClientMessageSchema.safeParse(decodeJson(raw));
      } catch {
        reject(socket, "invalid_message", "Message must be valid JSON");
        return;
      }
      if (!parsed.success) {
        reject(socket, "invalid_message", "Message does not match the device protocol");
        return;
      }
      const message = parsed.data;

      if (!connection) {
        if (message.type !== "device.authenticate") {
          reject(socket, "unauthorized", "Authenticate before sending commands");
          return;
        }
        const credentialHash = hashCredential(message.credential).toString("hex");
        const credential = devicesByCredential.get(credentialHash);
        if (!credential) {
          reject(socket, "unauthorized", "Invalid device credential");
          return;
        }
        if (credential.hostId !== undefined && admin.isDisabled(credential.hostId)) {
          reject(socket, "host_disabled", "This Host has been disabled by an administrator");
          return;
        }
        connection = { socket, deviceId: credential.deviceId, ...(credential.hostId === undefined ? {} : { hostId: credential.hostId }) };
        devices.add(connection);
        markAuthenticated(socket);
        send(socket, {
          type: "device.ready",
          protocolVersion: PROTOCOL_VERSION,
          deviceId: credential.deviceId,
          // 中继只认网关，它手里没有手机该看见的进程目录——那由 Host 自己给。
          runtimes: [],
          // 中继不知道电脑装没装 codex：`null` = 不知道，Host 自己的 device.ready 会给权威数组。
          agents: null,
        });
        return;
      }

      if (message.type === "device.authenticate") {
        reject(socket, "invalid_message", "Device is already authenticated");
        return;
      }
      if (message.type === "v2.frame") {
        // `hdr.from` 必须就是本连接已认证的身份，否则设备 A 可以往设备 B 的会话里塞帧。
        if (socket.readyState !== WebSocket.OPEN || (connection.hostId !== undefined && admin.isDisabled(connection.hostId)) || admin.isDisabled(message.envelope.hdr.to)) return;
        // 这一条是路由正确性所需，不是安全加固——真正的内容认证由 `ct` 的 AEAD 标签保证。
        if (message.envelope.hdr.from !== connection.deviceId) {
          reject(socket, "device_mismatch", "v2 frame hdr.from does not match the authenticated device");
          return;
        }
        const v2Runtime = runtimes.get(message.envelope.hdr.to);
        if (connection.hostId !== undefined ? connection.hostId !== message.envelope.hdr.to : options.registration?.hasHost(message.envelope.hdr.to)) {
          reject(socket, "runtime_mismatch", "Device belongs to a different Host");
          return;
        }
        if (!v2Runtime) {
          send(socket, {
            type: "protocol.error",
            code: "runtime_offline",
            message: "The selected runtime is offline",
          });
          return;
        }
        send(v2Runtime.socket, message);
        return;
      }
    });

    socket.on("close", () => {
      if (!connection) return;
      devices.delete(connection);
    });
  });

  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolve();
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const socket of [...runtimeWss.clients, ...deviceWss.clients]) {
      if (!authenticatedSockets.has(socket)) continue;
      if (!responsiveSockets.has(socket)) {
        socket.terminate();
        continue;
      }
      responsiveSockets.delete(socket);
      socket.ping();
    }
  }, options.heartbeatIntervalMs ?? 30_000);
  heartbeatTimer.unref?.();

  const address = server.address() as AddressInfo;
  const host = address.address === "::" ? "127.0.0.1" : address.address;
  return {
    url: `ws://${host}:${address.port}`,
    async close(): Promise<void> {
      clearInterval(heartbeatTimer);
      for (const runtime of runtimes.values()) runtime.socket.close(1001, "relay shutdown");
      for (const device of devices) device.socket.close(1001, "relay shutdown");
      await Promise.all([
        persistence,
        admin.close(),
        options.registration?.close() ?? Promise.resolve(),
        new Promise<void>((resolve) => runtimeWss.close(() => resolve())),
        new Promise<void>((resolve) => deviceWss.close(() => resolve())),
        new Promise<void>((resolve, rejectClose) => server.close((error) => error ? rejectClose(error) : resolve())),
      ]);
    },
  };
}
