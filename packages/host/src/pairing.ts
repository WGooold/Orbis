/**
 * Host 侧的配对流程（spec §4）。
 *
 * 配对窗口是**显式打开、120 秒后自动失效**的，不存在「长期监听配对」的状态。
 * 窗口里的 `psk` 一次性：`acceptPairRequest` 成功后会就地把内存里的那份清零。
 */
import type { KeyObject } from "node:crypto";

import type { EnvelopeV2 } from "@pi-remote/protocol";

import {
  E2eError,
  acceptPairRequest,
  buildPairEnvelope,
  buildPairingQrPayload,
  openPairingWindow,
  privateKeyFromRaw,
  readPairEnvelope,
  type DeviceRecord,
  type HostIdentity,
  type PairingQrLanEndpoint,
  type PairingQrPayload,
  type PairingWindow,
} from "@pi-remote/e2e";

export type OpenedPairingWindow = {
  code: string;
  payload: PairingQrPayload;
  expiresAtMs: number;
};

/**
 * 向 Relay 申请一个配对码（spec §9：v1 的码机制保留，继续签发**管道**凭据）。
 * Host 只是把 Relay 给的 code 和密码学材料拼进同一个二维码。
 */
export async function requestPairingCode(input: {
  httpBase: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ code: string; expiresInMs: number }> {
  const doFetch = input.fetchImpl ?? fetch;
  const response = await doFetch(`${input.httpBase}/v1/pairing-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.adminToken}` },
  });
  if (!response.ok) {
    throw new Error(`Relay 拒绝签发配对码（HTTP ${response.status}）`);
  }
  const body = await response.json() as { code?: unknown; expiresInMs?: unknown };
  if (typeof body.code !== "string" || body.code.length === 0) {
    throw new Error("Relay 返回的配对码格式不对");
  }
  return { code: body.code, expiresInMs: typeof body.expiresInMs === "number" ? body.expiresInMs : 0 };
}

export class HostPairingService {
  readonly #hostId: string;
  readonly #hostName: string;
  readonly #hostPrivateKey: KeyObject;
  readonly #hostPublicRaw: Buffer;
  #window: PairingWindow | undefined;

  constructor(identity: HostIdentity) {
    this.#hostId = identity.hostId;
    this.#hostName = identity.hostName;
    this.#hostPrivateKey = privateKeyFromRaw(identity.privateRaw);
    this.#hostPublicRaw = identity.publicRaw;
  }

  get active(): boolean {
    return this.#window !== undefined;
  }

  /** 打开窗口。重复调用会直接替换掉上一个窗口（旧二维码随之作废）。 */
  open(input: {
    relayUrl: string;
    code: string;
    lan?: readonly PairingQrLanEndpoint[];
    now?: number;
    ttlSeconds?: number;
  }): OpenedPairingWindow {
    const window = openPairingWindow({
      hostId: this.#hostId,
      hostPublicRaw: this.#hostPublicRaw,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    });
    this.#window = window;
    const payload = buildPairingQrPayload({
      relayUrl: input.relayUrl,
      code: input.code,
      hostId: this.#hostId,
      hostName: this.#hostName,
      hostPublicRaw: this.#hostPublicRaw,
      psk: window.psk,
      expiresAt: Math.floor(window.expiresAtMs / 1_000),
      ...(input.lan === undefined ? {} : { lan: input.lan }),
    });
    return { code: input.code, payload, expiresAtMs: window.expiresAtMs };
  }

  /**
   * 处理一条收到的 `pair` 帧。成功即关窗——`psk` 是一次性的。
   * 失败抛 `E2eError`，调用方据此决定怎么回给用户。
   */
  acceptFrame(envelope: EnvelopeV2): { accept: EnvelopeV2; device: DeviceRecord } {
    const window = this.#window;
    if (window === undefined) {
      throw new E2eError("window_closed", "配对窗口没有打开，请在电脑上重新执行配对命令");
    }
    const body = readPairEnvelope(envelope);
    if (body.type !== "pair-request") {
      throw new E2eError("malformed", "Host 只接受 pair-request");
    }

    const result = acceptPairRequest({ window, hostPrivateKey: this.#hostPrivateKey, request: body });
    if (!result.ok) {
      throw new E2eError(result.code, result.message);
    }
    this.#window = undefined;

    return {
      accept: buildPairEnvelope({
        room: envelope.hdr.room,
        from: this.#hostId,
        to: envelope.hdr.from,
        body: result.accept,
      }),
      device: {
        deviceId: result.device.deviceId,
        devicePub: result.device.devicePub,
        pskRoot: result.device.pskRoot,
        label: "",
        createdAt: Math.floor(Date.now() / 1_000),
        revoked: false,
      },
    };
  }

  close(): void {
    this.#window?.psk.fill(0);
    this.#window = undefined;
  }
}
