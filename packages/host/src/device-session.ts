/**
 * Host 侧的一台设备会话（spec §5.3 / §5.4）。
 *
 * 一台设备可能反复上下线，每次上下线都重跑一遍握手、重新派生 `k_h2d` / `k_d2h`——
 * 这是「换网络不掉线」和「前向保密」的共同来源。业务层只看到一条能收发字节的通道。
 */
import type { EnvelopeChannel, EnvelopeV2 } from "@pi-remote/protocol";

import {
  E2eChannel,
  E2eError,
  HostHandshake,
  buildPlaintextEnvelope,
  readHandshakeEnvelope,
  type DeviceRecord,
} from "@pi-remote/e2e";

export type DeviceSessionState = "idle" | "handshaking" | "ready";

/**
 * 一条入站帧被消化之后的结果。
 *
 * 刻意返回结构而不是回调：调用方需要知道**这是哪一种帧**才能正确地转手——
 * `ping` 要就地回一个回声（它测的就是这条路自己的往返），`data` 是 JSON 业务载荷，
 * `bin` 是裸字节（artifact 分片）。回调式签名会把这个区别抹掉。
 */
export type SessionOutcome =
  | { kind: "handshake-reply"; envelope: EnvelopeV2 }
  | { kind: "confirmed" }
  | { kind: "stale"; channel: string; n: number; last: number }
  | { kind: "payload"; frame: "data" | "ping" | "bin"; payload: Buffer };

export class HostDeviceSession {
  readonly #hostId: string;
  readonly #deviceId: string;
  readonly #pskRoot: Buffer;
  #room: string | undefined;
  #handshake: HostHandshake | undefined;
  #channel: E2eChannel | undefined;
  /** 最近一次被判重放的帧信息（由通道的 onStale 回填），随 stale 结果交给调用方。 */
  #lastStale: { channel: string; n: number; last: number } | undefined;

  constructor(input: { hostId: string; device: DeviceRecord }) {
    this.#hostId = input.hostId;
    this.#deviceId = input.device.deviceId;
    this.#pskRoot = Buffer.from(input.device.pskRoot, "base64url");
    if (this.#pskRoot.length !== 32) {
      throw new E2eError("invalid_key_length", `设备 ${this.#deviceId} 的 pskRoot 不是 32 字节`);
    }
  }

  get state(): DeviceSessionState {
    if (this.#channel !== undefined) return "ready";
    if (this.#handshake !== undefined) return "handshaking";
    return "idle";
  }

  /**
   * 处理一条来自该设备的帧。
   *
   * 一条会话只服务于一条路径：换路径就是换一套临时密钥（spec §6.2「每次切换重跑一次
   * 握手，不沿用密钥」），所以这里不做任何跨路径的状态复用。
   */
  handle(envelope: EnvelopeV2): SessionOutcome {
    const { hdr } = envelope;
    this.#room = hdr.room;

    if (hdr.k === "hs") {
      const body = readHandshakeEnvelope(envelope);
      if (body.type === "hs1") {
        // 每次 HS1 都换一套临时密钥：重连不是「恢复旧会话」，而是新会话。
        this.#handshake = new HostHandshake(this.#pskRoot);
        this.#channel = undefined;
        return {
          kind: "handshake-reply",
          envelope: buildPlaintextEnvelope({
            kind: "hs",
            room: hdr.room,
            from: this.#hostId,
            to: this.#deviceId,
            body: this.#handshake.acceptHello(body),
          }),
        };
      }
      const handshake = this.#handshake;
      if (handshake === undefined) {
        throw new E2eError("not_ready", "还没收到 HS1，无法处理 HS3");
      }
      if (body.type !== "hs3") {
        throw new E2eError("malformed", `Host 不处理 ${body.type}`);
      }
      handshake.confirm(body);
      this.#channel = new E2eChannel({
        keys: handshake.keys,
        role: "host",
        onStale: (channel, n, last) => {
          this.#lastStale = { channel, n, last };
        },
      });
      return { kind: "confirmed" };
    }

    const channel = this.#channel;
    if (channel === undefined) {
      throw new E2eError("not_ready", "握手尚未完成，不能收发加密帧");
    }
    const frame = hdr.k === "ping" ? "ping" : hdr.k === "bin" ? "bin" : "data";
    const payload = channel.open(envelope);
    // 重放（n <= last）按幂等丢弃，不是故障：返回 "stale" 让调用方安静地当没看见。
    // 把它当错误上报的话，中继可以用重放把接收方刷进错误处理。
    // 但丢弃原因（n 与水位线的差距）要带给调用方留痕——完全静默会让
    // 「发送端序号回退」这类问题不可诊断。
    if (payload === undefined) {
      const stale = this.#lastStale ?? { channel: "unknown", n: -1, last: -1 };
      this.#lastStale = undefined;
      return { kind: "stale", ...stale };
    }
    return { kind: "payload", frame, payload };
  }

  /**
   * 封一条出站帧。序号由通道自己按 channel 推进，调用方不需要关心。
   *
   * [channel] **必填**（ADR-0008）：不再有"对端不支持就降回单流"的分支。
   */
  seal(kind: "data" | "ping" | "bin", payload: Uint8Array, channel: EnvelopeChannel): EnvelopeV2 {
    const e2e = this.#channel;
    const room = this.#room;
    if (e2e === undefined || room === undefined) {
      throw new E2eError("not_ready", "握手尚未完成，不能发送数据");
    }
    return e2e.seal(
      {
        k: kind,
        room,
        from: this.#hostId,
        to: this.#deviceId,
        n: e2e.nextSequence(channel),
        ch: channel,
      },
      payload,
    );
  }
}
