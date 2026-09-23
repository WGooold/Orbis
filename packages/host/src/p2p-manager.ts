/**
 * P2P 传输（spec §6.1 的第二级 Path，M5）。
 *
 * 选型：**WebRTC DataChannel**（libdatachannel / node-datachannel）。三条理由：
 *
 * 1. NAT 穿透是现成的：ICE + STUN 内置，打洞成功率是这套技术栈的主业，不是我们的副业。
 * 2. DataChannel 一条消息天然有边界——一条消息装一个 `v2.frame` JSON，与 LAN/Relay 的外壳
 *    完全同构，device-link 那边一行不用改。
 * 3. 两端都有成熟实现：Node 用 node-datachannel（预编译二进制），Android 用 Google 官方
 *    org.webrtc。不用自己维护任何密码学/可靠传输代码——加密由我们的 Envelope E2E 负责
 *    （每条路径独立握手，spec §6.2），DTLS 只是传输层顺带。
 *
 * 信令走 Relay 的 E2E data 帧（`p2p.request`/`p2p.offer`/`p2p.answer`，spec 在 protocol 包里
 * 定义）：Relay 依旧零知识，不需要任何新角色。SDP 里烧好全部 ICE 候选（gather 完再发，
 * 非 trickle）——信令只在建连时发生一次，不值得为省一两个包引入增量消息。
 */
import type { DataChannel } from "node-datachannel";
import { PeerConnection } from "node-datachannel";

import type { EnvelopeV2 } from "@pi-remote/protocol";

import { describeError } from "./describe-error.js";
import { PROTOCOL_VERSION, V2FrameSchema } from "@pi-remote/protocol";

import type { PathSink } from "./device-link.js";

/**
 * 「P2P 优先、失败降级中继」的节拍常量。
 *
 * 借鉴 RustDesk 的两条做法，两条都只影响本地决策，不碰 Relay：
 *
 * 1. **单次尝试有上限。** RustDesk 给直连算一个按 NAT 类型决定的窗口（最短 1 秒、最长打洞耗时×6），
 *    到点没连上就落中继；这里同样给一个墙上时钟上限（gather + 信令 + ICE + DTLS 全算在内），
 *    而不是无限期等 ICE 自己报 failed。
 * 2. **失败要记着。** RustDesk 把 `direct_failures` 存进 PeerConfig，下次连接据此缩短直连窗口
 *    （乘数从 6 降到 3），即「上次打不通，这次别耗那么久」；这里用连续失败计数 + 冷却，
 *    避免每次重连都白跑一遍完整超时。
 *
 * 与 RustDesk 的差异：它的窗口是按 NAT 类型算的（需要 hbbs 做映射一致性探测），
 * 我们的 P2P 是 WebRTC/UDP，拿不到那种 TCP 映射证据，所以用「实测失败」替代「预判 NAT 类型」。
 */
export const P2P_ATTEMPT_TIMEOUT_MS = 15_000;
export const P2P_MAX_CONSECUTIVE_FAILURES = 3;
export const P2P_COOLDOWN_MS = 300_000;

/** libdatachannel 的 ICE 服务器格式：stun://host:port */
export type HostP2pManagerOptions = {
  stunServers: readonly string[];
  /** 信令与业务共用一条通道：SDP 用它发给设备（一般走 Relay 兜底路径）。 */
  sendToDevice: (deviceId: string, message: Record<string, unknown>) => void;
  /** DC 开通后收到的每一帧（含握手）。与 LAN 端点的 onEnvelope 同构。 */
  onEnvelope: (deviceId: string, envelope: EnvelopeV2, sink: PathSink) => void;
  /** P2P 路径断了。HostService 据此 detach 并回落。 */
  onPathDown: (deviceId: string) => void;
  /** 单次打洞尝试的上限（缺省 `P2P_ATTEMPT_TIMEOUT_MS`）。 */
  attemptTimeoutMs?: number;
  /** 连续失败多少次后进入冷却（缺省 `P2P_MAX_CONSECUTIVE_FAILURES`）。 */
  maxConsecutiveFailures?: number;
  /** 冷却时长（缺省 `P2P_COOLDOWN_MS`）。 */
  cooldownMs?: number;
  log?: (line: string) => void;
};

/**
 * 拒绝一次打洞请求的理由。
 *
 * 带 `retryInMs` 而不是只回一个 false，是因为设备需要知道「还要等多久」：只说「不行」
 * 会让手机立刻重试，把冷却变成一串无谓的往返。
 */
export type P2pAttemptRefusal = { reason: "cooldown"; retryInMs: number };

type PendingPeer = {
  peer: PeerConnection;
  channel: DataChannel | undefined;
  downTimer: ReturnType<typeof setTimeout> | undefined;
  /** 单次尝试的墙上时钟上限。到达时还没 connected 就判失败并回落。 */
  attemptTimer: ReturnType<typeof setTimeout> | undefined;
  /** 这条连接是否真正到达过 connected。区分「没连上」与「连上后又掉」——只有前者算失败。 */
  connected: boolean;
  /** 失败只记一次：`failed` 状态和 channel 关闭常常先后各来一遍。 */
  failureRecorded: boolean;
};

export class HostP2pManager {
  readonly #options: HostP2pManagerOptions;
  readonly #peers = new Map<string, PendingPeer>();
  /** 连续失败次数（成功即清零）。等价于 RustDesk 的 `direct_failures`，但不落盘。 */
  readonly #failures = new Map<string, number>();
  /** 冷却截止时间戳。冷却期内拒绝新的打洞请求，直接走中继。 */
  readonly #cooldownUntil = new Map<string, number>();

  constructor(options: HostP2pManagerOptions) {
    this.#options = options;
  }

  has(deviceId: string): boolean {
    return this.#peers.has(deviceId);
  }

  /**
   * 手机请求建立 P2P。Host 是 offerer——它是「服务侧」，与 LAN 的方向一致。
   * candidates 全部 gather 完才把 offer 发出去（device 收到即可直接 answer）。
   *
   * 返回 `undefined` 表示这次受理了（或已在试）；返回 `P2pAttemptRefusal` 表示**拒绝了**，
   * 调用方必须把它回报设备——否则设备只会看到「没反应」。
   */
  startOffer(deviceId: string): P2pAttemptRefusal | undefined {
    const cooldown = this.cooldownRemainingMs(deviceId);
    if (cooldown > 0) {
      this.#options.log?.(
        `P2P：${deviceId} 处于冷却中（已连续失败 ${this.#failures.get(deviceId) ?? 0} 次），` +
          `${Math.ceil(cooldown / 1_000)} 秒内不再尝试，继续走中继`,
      );
      return { reason: "cooldown", retryInMs: cooldown };
    }
    if (this.#peers.has(deviceId)) {
      // 旧的没退干净就再来一次：只可能发生在旧连接半死不活时。让位，重开。
      this.#options.log?.(`P2P：${deviceId} 已有进行中的连接，先关闭再重建`);
      this.stop(deviceId);
      // **必须立刻把 p2p 从可用集里摘掉**（onPathDown → link.detach → 选路回落中继）。
      // 否则选路器仍认为 p2p 可用，下面重建出来的新 offer 会按「当前生效路径」发进这条
      // 刚被关掉的死通道：设备永远收不到（也就没有 answer），状态页却还挂着「P2P 直连」，
      // 业务帧全部进黑洞，直到 15s 尝试超时才回落——用户看到的就是「P2P 根本不能用」。
      this.#options.onPathDown(deviceId);
    }
    let pending: PendingPeer;
    try {
      pending = this.#createPeer(deviceId);
    } catch (error) {
      this.#options.log?.(`P2P：为 ${deviceId} 创建 PeerConnection 失败：${describeError(error)}`);
      this.#recordFailure(deviceId, "创建 PeerConnection 失败");
      return undefined;
    }
    const { peer } = pending;
    const channel = peer.createDataChannel("pi-remote");
    pending.channel = channel;
    this.#wireChannel(deviceId, channel);
    return undefined;
  }

  /** 还要等多久（毫秒）才允许下一次尝试；0 表示现在就可以试。 */
  cooldownRemainingMs(deviceId: string): number {
    const until = this.#cooldownUntil.get(deviceId);
    if (until === undefined) return 0;
    const remaining = until - Date.now();
    if (remaining <= 0) {
      // 冷却自然过期：顺手清掉，失败计数也归零——冷却的意义就是「给它一次干净的重试」。
      this.#cooldownUntil.delete(deviceId);
      this.#failures.delete(deviceId);
      return 0;
    }
    return remaining;
  }

  /** 忘掉一台设备的失败历史（解除配对、设备被撤销时用）。 */
  forget(deviceId: string): void {
    this.#failures.delete(deviceId);
    this.#cooldownUntil.delete(deviceId);
  }

  /** 这台设备当前的连续打洞失败次数（成功即清零）。给状态展示与诊断用。 */
  consecutiveFailures(deviceId: string): number {
    return this.#failures.get(deviceId) ?? 0;
  }

  /** 手机answer回来了。 */
  acceptAnswer(deviceId: string, sdp: string): void {
    const pending = this.#peers.get(deviceId);
    if (pending === undefined) {
      this.#options.log?.(`P2P：${deviceId} 的 answer 没有对应的 offer，丢弃`);
      return;
    }
    try {
      pending.peer.setRemoteDescription(sdp, "answer");
      this.#options.log?.(`P2P：${deviceId} 的 answer 已受理`);
    } catch (error) {
      this.#options.log?.(`P2P：受理 ${deviceId} 的 answer 失败：${describeError(error)}`);
      this.#recordFailure(deviceId, "受理 answer 失败");
      this.stop(deviceId);
    }
  }

  /** 关闭某台设备的 P2P 连接（设备撤销、路径切换后的清理、重建前让位）。 */
  stop(deviceId: string): void {
    const pending = this.#peers.get(deviceId);
    if (pending === undefined) return;
    this.#peers.delete(deviceId);
    if (pending.downTimer !== undefined) {
      clearTimeout(pending.downTimer);
      pending.downTimer = undefined;
    }
    if (pending.attemptTimer !== undefined) {
      clearTimeout(pending.attemptTimer);
      pending.attemptTimer = undefined;
    }
    try {
      pending.channel?.close();
    } catch {
      // 连接本来就坏了，关不掉就算了。
    }
    try {
      pending.peer.close();
    } catch {
      // 同上。
    }
  }

  stopAll(): void {
    for (const deviceId of [...this.#peers.keys()]) this.stop(deviceId);
  }

  #createPeer(deviceId: string): PendingPeer {
    // node-datachannel 是 C++ 绑定：构造函数不进 Promise，回调里出错只会走 onError。
    const peer = new PeerConnection(`pi-remote-${deviceId}`, {
      iceServers: this.#options.stunServers.length > 0 ? [...this.#options.stunServers] : [],
    }) as PeerConnection;
    const pending: PendingPeer = {
      peer,
      channel: undefined,
      downTimer: undefined,
      attemptTimer: undefined,
      connected: false,
      failureRecorded: false,
    };
    this.#peers.set(deviceId, pending);

    // 尝试上限：从这一刻起算，覆盖 gather → 信令 → ICE → DTLS 整条链路。
    // 到点还没 connected 就判失败并回落——而不是无限期等 ICE 自己报 failed（网络受限时
    // 它可能一直停在 checking，手机状态页于是永远显示中继，用户也永远等不到解释）。
    pending.attemptTimer = setTimeout(() => {
      if (this.#peers.get(deviceId) !== pending) return;
      this.#options.log?.(
        `P2P：${deviceId} 打洞超过 ${this.#attemptTimeoutMs}ms 仍未连接，判失败，回落中继`,
      );
      this.#recordFailure(deviceId, "打洞超时");
      this.stop(deviceId);
      this.#options.onPathDown(deviceId);
    }, this.#attemptTimeoutMs);

    // 回调必须全部在 createDataChannel 之前注册：进程内 host candidate 的 gather 快到
    // 同步完成，「complete」先于注册触发就把 offer 永远吞掉了。
    // gather 完成后本地描述才是最终形态（非 trickle），此时才把 offer 发给设备。
    peer.onGatheringStateChange((state) => {
      if (state !== "complete") return;
      const local = peer.localDescription();
      if (local === undefined || local === null) return;
      this.#options.sendToDevice(deviceId, { type: "p2p.offer", protocolVersion: PROTOCOL_VERSION, sdp: local.sdp });
      this.#options.log?.(`P2P：offer 已发给 ${deviceId}（${local.sdp.length}B）`);
    });
    peer.onStateChange((state) => {
      // 守卫：回调可能晚于「重建」到达——旧 peer 的 closed 不能误杀新连接。
      if (this.#peers.get(deviceId) !== pending) return;
      if (state === "connected" || state === "completed") {
        pending.connected = true;
        if (pending.downTimer !== undefined) {
          clearTimeout(pending.downTimer);
          pending.downTimer = undefined;
        }
        if (pending.attemptTimer !== undefined) {
          clearTimeout(pending.attemptTimer);
          pending.attemptTimer = undefined;
        }
        // 成功即清零：连续失败计数描述的是「最近连续几次没打通」，打通了就不再成立。
        this.#failures.delete(deviceId);
        this.#cooldownUntil.delete(deviceId);
        return;
      }
      if (state === "disconnected") {
        if (pending.downTimer === undefined) {
          this.#options.log?.(`P2P：${deviceId} 短暂断开，等待恢复`);
          pending.downTimer = setTimeout(() => {
            if (this.#peers.get(deviceId) !== pending) return;
            this.#options.log?.(`P2P：${deviceId} 断开超过 5 秒，路径下线`);
            this.stop(deviceId);
            this.#options.onPathDown(deviceId);
          }, P2P_DISCONNECT_GRACE_MS);
        }
        return;
      }
      if (state === "failed" || state === "closed") {
        this.#options.log?.(`P2P：${deviceId} 连接状态 ${state}，路径下线`);
        // 只在「从没连上过」时算失败：连上之后再掉属于链路质量问题，计进冷却会让
        // 一次成功连接换来几分钟的 P2P 禁用，那是反的。
        if (!pending.connected) this.#recordFailure(deviceId, `ICE ${state}`);
        this.stop(deviceId);
        this.#options.onPathDown(deviceId);
      }
    });
    peer.onDataChannel((channel) => {
      // answerer 侧（不会发生——我们永远是 offerer），防御性接住。
      pending.channel = channel;
      this.#wireChannel(deviceId, channel);
    });
    return pending;
  }

  #wireChannel(deviceId: string, channel: DataChannel): void {
    channel.onOpen(() => {
      this.#options.log?.(`P2P：${deviceId} 的数据通道已开通`);
    });
    channel.onMessage((raw) => {
      const pending = this.#peers.get(deviceId);
      if (pending === undefined) return;
      if (typeof raw !== "string") return; // 这一级只跑 v2.frame 文本，与 LAN 一致
      let envelope: EnvelopeV2;
      try {
        const parsed = V2FrameSchema.safeParse(JSON.parse(raw) as unknown);
        if (!parsed.success) return;
        envelope = parsed.data.envelope;
      } catch {
        return;
      }
      const sink: PathSink = (outbound: EnvelopeV2): void => {
        const current = this.#peers.get(deviceId);
        const active = current?.channel;
        // 通道不在 / 发送被拒（SCTP 缓冲区满）都**抛出去**，而不是自己判这条路径死：
        // 写入层切片（issue 03）之后一条消息是若干小片，交给多路复用器留在队首重试才是对的
        // ——当场丢掉就是一条永远凑不齐的消息（见 piece.ts）。真的发不出去时，多路复用器
        // 重试耗尽后会通过 `onPathWriteAbandoned` 让上层 `detach` 这条路径。
        // 根因与修法见 docs/adr/0010-write-layer-slicing.md。
        if (active === undefined) throw new Error(`P2P 到 ${deviceId} 的数据通道不可用`);
        if (active.sendMessage(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: outbound })) === false) {
          throw new Error(`P2P 到 ${deviceId} 的发送被拒绝`);
        }
      };
      // DataChannel 的待发字节数——多路复用器的水位判据（node-datachannel 上是方法，不是属性）。
      sink.backlog = () => {
        const channel = this.#peers.get(deviceId)?.channel;
        if (channel === undefined) return 0;
        try {
          return channel.bufferedAmount();
        } catch {
          // 通道刚关：没有待发字节，让多路复用器照常放行，别把队列卡在这里。
          return 0;
        }
      };
      try {
        this.#options.onEnvelope(deviceId, envelope, sink);
      } catch (error) {
        this.#options.log?.(`P2P：处理 ${deviceId} 的帧失败：${describeError(error)}`);
      }
    });
    channel.onClosed(() => {
      if (this.#peers.get(deviceId)?.channel !== channel) return;
      this.#options.log?.(`P2P：${deviceId} 的数据通道已关闭`);
      // 通道从没开通过就关掉，说明这次打洞没成（ICE 失败/对端放弃）——同样是失败证据。
      // 已经 connected 过再关则不计，理由同 onStateChange 里的注释。
      if (this.#peers.get(deviceId)?.connected !== true) {
        this.#recordFailure(deviceId, "数据通道未开通即关闭");
      }
      this.stop(deviceId);
      this.#options.onPathDown(deviceId);
    });
  }

  get #attemptTimeoutMs(): number {
    return this.#options.attemptTimeoutMs ?? P2P_ATTEMPT_TIMEOUT_MS;
  }

  /**
   * 记一次失败。达到阈值就进入冷却，冷却期内 [startOffer] 直接拒绝。
   *
   * 只记一次：`failed` 状态、channel 关闭、超时定时器常常在同一个失败上先后各来一遍。
   */
  #recordFailure(deviceId: string, reason: string): void {
    const pending = this.#peers.get(deviceId);
    if (pending !== undefined) {
      if (pending.failureRecorded) return;
      pending.failureRecorded = true;
    }
    const failures = (this.#failures.get(deviceId) ?? 0) + 1;
    this.#failures.set(deviceId, failures);
    const limit = this.#options.maxConsecutiveFailures ?? P2P_MAX_CONSECUTIVE_FAILURES;
    if (failures < limit) {
      this.#options.log?.(`P2P：${deviceId} 第 ${failures} 次打洞失败（${reason}），继续走中继`);
      return;
    }
    const cooldown = this.#options.cooldownMs ?? P2P_COOLDOWN_MS;
    this.#cooldownUntil.set(deviceId, Date.now() + cooldown);
    this.#options.log?.(
      `P2P：${deviceId} 连续 ${failures} 次打洞失败（最后一次：${reason}），` +
        `冷却 ${Math.round(cooldown / 1_000)} 秒后才会再试；这期间一律走中继`,
    );
  }
}

const P2P_DISCONNECT_GRACE_MS = 5_000;
