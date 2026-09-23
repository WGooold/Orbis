/**
 * Host 主服务：身份 + 配对 + 每台设备的多条 Path + 本机 runtime 路由（spec §7.1 的「桌面侧聚合者」最小形态）。
 *
 * 三个方向各一句话：
 * - 设备 → 本机：`data` 载荷里是 `runtime.command`，按 `runtimeId` 投给 loopback 上注册的进程。
 * - 本机 → 设备：runtime 的 `runtime.event` / 二进制帧包成 `data` 载荷广播给所有就绪设备。
 * - 设备的多条 Path：Relay 常驻做控制面，LAN 与 Relay 并存时由 `DeviceLink` 选，换路后
 *   主动把结果告诉手机（§6.2 / §14 B4）。
 *
 * 会话目录聚合、进程激活能力（`browse` / L1 / L2）见 `sessions.ts` / `spawner.ts`（spec §8）。
 */
import { homedir, hostname } from "node:os";

import {
  E2eError,
  findActiveDeviceRecord,
  isE2eError,
  loadDeviceStore,
  loadOrCreateHostIdentity,
  resolveStateDir,
  revokeDeviceRecord,
  saveDeviceStore,
  upsertDeviceRecord,
  type DeviceRecord,
  type DeviceStore,
  type HostIdentity,
  type PairingQrLanEndpoint,
} from "@pi-remote/e2e";
import {
  DeviceE2ePayloadSchema,
  PROTOCOL_VERSION,
  type AgentKind,
  type AgentSessionSummary,
  type DeviceE2ePayload,
  type EnvelopeChannel,
  type EnvelopeV2,
  type PathKind,
  type RelayToDeviceMessage,
  type RuntimeMetadata,
  type RuntimeEvent,
} from "@pi-remote/protocol";

import { HostDownloadService, hostArtifactIndexPath } from "./artifact-download.js";
import { HostUploadService, hostUploadIndexPath } from "./artifact-upload.js";
import type { AgentBackend, BackendActivation } from "./agent-backend.js";
import { PiBackend } from "./agent-backend.js";
import { relayHttpBase } from "./config.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { DshRuntime } from "./dsh-runtime.js";
import { describeError } from "./describe-error.js";
import { parseGitBranchRequest, readGitBranch, type GitBranchRequest } from "./git-branch.js";
import { DeviceLink, type ActivePathChange, type PathSink } from "./device-link.js";
import { DEFAULT_LAN_PORT, HostLanServer, localLanEndpoints, parseLanDiscoveryRequest, type LanDiscoveryRequest } from "./lan-server.js";
import { HostLoopbackServer } from "./loopback-server.js";
import { HostP2pManager } from "./p2p-manager.js";
import { HostPairingService, requestPairingCode, type OpenedPairingWindow } from "./pairing.js";
import { describePath, normalizePreference, type PathChange } from "./path.js";
import { parsePathPreferenceMessage, type PathPreferenceMessage } from "./path-preference.js";
import { SessionSyncTasks } from "./session-sync-tasks.js";
import { HostRelayClient, type HostRelayState } from "./relay-client.js";
import { browseDirectory, listPiSessions } from "./sessions.js";
import { ActivationError, SessionSpawner } from "./spawner.js";
import { SessionArchiveError } from "./session-archive.js";

/**
 * 会话目录（`session.list`）的缓存时长。
 *
 * 目录是只读且变化很慢的数据，而拉一次不便宜（Codex `thread/list` 2.5–6s）。
 * 手机在激活/重连/回前台时都会请求，短 TTL 足以把那些重复请求收敛成一次扫描，
 * 又不至于让用户察觉「刚建的会话不在列表里」——激活路径另走 `#invalidateCatalog`。
 */
const CATALOG_TTL_MS = 5_000;
/**
 * 一条 Host→设备的消息该走哪个 channel（票 07）。
 *
 * 分类影响**两件事**，所以分错不再是「少一层隔离」那么轻：
 *
 * - **序号流**：`bulk` 丢帧不连累控制面（票 07）。
 * - **投递顺序**：出站多路复用器（`OutboundChannelMux`）让 `ctl` 插队，`msg` / `bulk` 按水位
 *   让路。把交互帧错分成 `bulk`，它就要排在分片后面——正是「下载一开，什么都点不动」。
 *
 * 判据因此取得很宽：
 *
 * - 会带 graph / 消息 / 会话目录体量的 → `msg`（它们可能是几百 KB 到几 MB）
 * - 其余（状态、命令结果、交互、握手补发）→ `ctl`
 *
 * 分片不走这里：它们是 `bin` 帧，由 `DeviceLink.sendBinary` 直接打上 `bulk`。
 */
export function channelForDeviceMessage(message: { type: string; event?: { type?: string } }): EnvelopeChannel {
  if (message.type !== "runtime.event") return "ctl";
  const eventType = message.event?.type ?? "";
  if (
    eventType.startsWith("session.") ||
    eventType.startsWith("message.") ||
    eventType.startsWith("turn.") ||
    eventType.startsWith("tool.")
  ) {
    return "msg";
  }
  return "ctl";
}

/** 同一台设备的离线回绝在这个窗口内只报一次（见 `#shouldReportOfflineDevice`）。 */
const OFFLINE_DEVICE_REPORT_INTERVAL_MS = 10_000;
/** 水位告警的节流窗口，与 relay 的 `MUX_WARN_INTERVAL_MS` 同一判据。 */
const BULK_WARN_INTERVAL_MS = 10_000;

export type HostServiceOptions = {
  relayUrl: string;
  credential: string;
  /** 只在 `pair` 时用得到：签发设备管道凭据。 */
  adminToken?: string;
  stateDir?: string;
  reconnect?: boolean;
  /** 关掉本机 loopback 端点（只有测试会这么做：它要的是纯 Relay 路径）。 */
  loopback?: boolean;
  /** 关掉 LAN 端点。关掉后只剩 Relay 一条路径，不影响其他功能。 */
  lan?: boolean;
  /**
   * 是否真的监听 LAN 端口。`pi-remote pair` 传 `false`：它是个短命进程，去 bind 常驻 Host
   * 已经在用的端口只会失败（或者更糟：被它抢走，然后随进程退出而消失）。
   * 注意它不影响二维码里的 LAN 地址——那部分是枚举出来的，不需要监听。
   */
  lanListen?: boolean;
  /** LAN 监听端口。默认 42130——二维码要能在一个短命进程里写死它（见 `lan-server.ts`）。 */
  lanPort?: number;
  /** P2P 打洞用的 STUN 服务器（M5）。空表 = 不启用 P2P（本机/内网 relay 没有公网地址，打洞无意义）。 */
  stunServers?: readonly string[];
  /** 两条路径的 RTT 探测间隔（毫秒）。0 表示不探。测试会调小它。 */
  probeIntervalMs?: number;
  /**
   * `bulk`（artifact 分片）的速率上限，字节/秒。`0`/缺省 = 不限速。
   *
   * 它管的是**平均**带宽（桶空就丢这一片，靠 pull 重传自愈）；「分片不许堵住控制帧」是
   * 出站多路复用器的职责，与这个上限无关——即使限速全开，控制帧也照样插队。
   */
  bulkBytesPerSecond?: number;
  /** Pi 会话根目录。测试注入临时目录；缺省 `~/.pi/agent/sessions`。 */
  sessionsRoot?: string;
  /** 进程激活器。测试注入 mock；缺省真 spawner（spec §8）。 */
  spawner?: SessionSpawner;
  /**
   * Codex 后端（spec §7.4，M4）。由调用方负责 app-server 子进程的生命周期
   * （CLI 在 `--codex` 时创建并 stop）；缺省/未传 = 不启用 Codex。
   */
  codexRuntime?: CodexRuntime;
  dshRuntime?: DshRuntime;
  log?: (line: string) => void;
  /** 配对成功。调用方负责对外报告；落盘已经由 HostService 完成。 */
  onPaired?: (device: DeviceRecord) => void;
  /** 收到某台设备发来的、已解密的业务载荷，且**没有**被本机业务消化掉。 */
  onData?: (deviceId: string, payload: Buffer) => void;
  /** 单台设备的帧处理失败。坏帧不该放倒整条 Host 连接。 */
  onDeviceError?: (deviceId: string, error: unknown) => void;
  /** 某台设备的生效路径变了（§6.2）。 */
  onPathChange?: (deviceId: string, change: ActivePathChange) => void;
  onStateChange?: (state: HostRelayState) => void;
};

export class HostService {
  readonly #options: HostServiceOptions;
  readonly #stateDir: string;
  readonly #identity: HostIdentity;
  readonly #store: DeviceStore;
  readonly #pairing: HostPairingService;
  readonly #links = new Map<string, DeviceLink>();
  readonly #sessionSync: SessionSyncTasks;
  /**
   * 每台设备手工排过的连接优先级（§6.2）。手机每次 E2E 就绪后重发，所以只在内存里留一份；
   * Host 重启后用默认顺序，等手机下一次上报再覆盖。
   */
  readonly #pathPreferences = new Map<string, PathKind[]>();
  #relay: HostRelayClient | undefined;
  #loopback: HostLoopbackServer | undefined;
  #lan: HostLanServer | undefined;
  #p2p: HostP2pManager | undefined;
  readonly #spawner: SessionSpawner;
  /**
   * 本机的全部 agent 后端（spec §7.4 的适配器收口）。顺序即 resume 的尝试顺序：
   * Pi 在前（磁盘会话），Codex 在后（thread 空间）。分派只面向 `AgentBackend`
   * 接口，不为单个后端写特判。
   */
  readonly #backends: readonly AgentBackend[];
  readonly #downloads: HostDownloadService;
  readonly #uploads: HostUploadService;
  /**
   * 每个 (runtimeId, channel) 已知的最大事件序号。
   *
   * Host 自己也会产生事件（下载的 `artifact.started` 等），而手机按序号去重
   * （`sequence <= lastSequence` 一律丢弃），所以从 Host 出去的事件序号必须是
   * 严格递增的——不管它来自 Pi 还是来自 Host 自己。
   *
   * 键是 **(runtimeId, channel) 复合**（issue 02）：事件按 `ctl`/`msg` 分道投递，
   * `ctl` 插队是常态，跨道的到达顺序不再代表发送顺序。全局一条流水的话，
   * 后到的 `ctl` 会把先发出的 `msg` 事件的水位线永久抬高——手机从此丢掉所有
   * 更小的 `msg` 序号。按道各记一份之后，插队变得无害。
   */
  readonly #eventSequences = new Map<string, number>();
  /** 同一台设备的离线回绝只报一次的时间戳（详见 `#shouldReportOfflineDevice`）。 */
  readonly #offlineDeviceReportedAt = new Map<string, number>();
  #persistChain: Promise<void> = Promise.resolve();
  /**
   * 会话目录的短 TTL 缓存与「正在扫」占位（见 `#catalogWithCache`）。
   * 目录变化很慢、拉取很贵，而手机端会反复请求——不收敛就会互相堆叠。
   */
  #catalogCache: { at: number; sessions: AgentSessionSummary[] } | undefined;
  #catalogInFlight: Promise<AgentSessionSummary[]> | undefined;
  #catalogEpoch = 0;
  #sessionMutation: Promise<void> = Promise.resolve();
  readonly #gitReads = new Map<string, ReturnType<typeof readGitBranch>>();

  private constructor(
    options: HostServiceOptions,
    stateDir: string,
    identity: HostIdentity,
    store: DeviceStore,
  ) {
    this.#options = options;
    this.#stateDir = stateDir;
    this.#identity = identity;
    this.#store = store;
    this.#pairing = new HostPairingService(identity);
    this.#spawner = options.spawner ?? new SessionSpawner({ ...(options.log === undefined ? {} : { log: options.log }) });
    this.#downloads = new HostDownloadService({
      indexPath: hostArtifactIndexPath(stateDir),
      publishEvent: (deviceId, runtimeId, event) => {
        this.#sendToDevice(deviceId, {
          type: "runtime.event",
          protocolVersion: PROTOCOL_VERSION,
          runtimeId,
          sequence: this.#nextEventSequence(runtimeId, channelForDeviceMessage({ type: "runtime.event", event })),
          event,
        });
      },
      publishBinary: (deviceId, frame) => {
        this.#links.get(deviceId)?.sendBinary(frame);
      },
      publishMessage: (deviceId, message) => {
        this.#sendToDevice(deviceId, message);
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    void this.#downloads.load();
    this.#uploads = new HostUploadService({
      indexPath: hostUploadIndexPath(stateDir),
      publishMessage: (deviceId, message) => {
        this.#sendToDevice(deviceId, message);
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    void this.#uploads.load();
    this.#sessionSync = new SessionSyncTasks({
      link: (deviceId) => this.#links.get(deviceId),
      dispatch: (runtimeId, commandId, command) => {
        for (const backend of this.#backends) {
          if (backend.isReady() && backend.ownsRuntime(runtimeId)) return backend.dispatchCommand(runtimeId, commandId, command);
        }
        return "offline";
      },
      encodeEvent: (runtimeId, event) => Buffer.from(JSON.stringify(this.#runtimeEventMessage(runtimeId, event)), "utf8"),
      sendEvent: (deviceId, runtimeId, event) => this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId, event)),
      error: (deviceId, commandId, code, message) => this.#sendToDevice(deviceId, { type: "protocol.error", code, message: message ?? code, commandId }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    // 后端装配：Pi 恒有；Codex 由调用方注入（CLI 在 --codex 时创建 app-server）。
    // Codex 的事件出口 / 元数据重播 / 离线广播都在这里挂上——对 Host 其余部分而言
    // 它只是 #backends 里多了一个 AgentBackend。
    const backends: AgentBackend[] = [
      new PiBackend({
        spawner: this.#spawner,
        sendCommand: (runtimeId, commandId, command) =>
          this.#loopback?.sendCommand(runtimeId, commandId, command) ?? false,
        runtimeIds: () => this.localRuntimes.map((runtime) => runtime.runtimeId),
        sessionIsOnline: (sessionId) => this.localRuntimes.some((runtime) => runtime.sessionId === sessionId),
        ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
        ...(options.log === undefined ? {} : { log: options.log }),
      }),
    ];
    if (options.codexRuntime !== undefined) {
      const codex = options.codexRuntime;
      codex.setEventSink((event, threadId) => {
        // 每个活跃 thread 一条独立进程：对外 runtimeId 是 `codex:<threadId>`，
        // 序号也按这个粒度记（APP 按 runtimeId+channel+sequence 去重防丢）。
        const runtimeId = threadId === undefined ? codex.runtimeId : codex.runtimeIdFor(threadId);
        this.#publishRuntimeEvent(runtimeId, event);
      });
      // Codex 的 cwd/状态会随会话激活与 turn 起止变化；目录里那份快照不会自己更新，
      // 这里跟着重播 runtime.online（APP 按 runtimeId upsert）让主页面卡片保持如实。
      // 多 thread 并发时每次把整组条目重播一遍：upsert 幂等，多播不重复建卡。
      codex.onMetadataChange = () => {
        for (const runtime of codex.directoryEntries()) {
          this.#broadcastDeviceMessage({ type: "runtime.online", runtime });
        }
      };
      // app-server 进程退出 = Codex 全部会话掉线：用退出前的目录快照逐个广播，
      // 别让手机端永远「在线」。
      codex.onOffline = (reason, runtimes) => {
        for (const runtime of runtimes) {
          this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId: runtime.runtimeId, reason });
        }
      };
      codex.onArchiveChange = (sessionId, archived) => {
        this.#invalidateCatalog();
        this.#broadcastDeviceMessage({ type: "session.archive.changed", agentKind: "codex", sessionId, archived });
      };
      backends.push(codex);
    }
    if (options.dshRuntime !== undefined) {
      const dsh = options.dshRuntime;
      dsh.setEventSink((event, runtimeId) => this.#publishRuntimeEvent(runtimeId, event));
      dsh.onMetadataChange = () => {
        for (const runtime of dsh.directoryEntries()) this.#broadcastDeviceMessage({ type: "runtime.online", runtime });
      };
      dsh.onOffline = (reason, runtimes) => {
        this.#invalidateCatalog();
        for (const runtime of runtimes) this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId: runtime.runtimeId, reason });
      };
      backends.push(dsh);
    }
    this.#backends = backends;
  }

  static async create(options: HostServiceOptions): Promise<HostService> {
    const stateDir = resolveStateDir(options.stateDir);
    // 身份文件读不出来时 loadOrCreate 会直接抛错：换了身份等于所有设备失效，
    // 那必须让用户看到，而不是悄悄重建。
    const identity = await loadOrCreateHostIdentity({ dir: stateDir });
    const store = await loadDeviceStore(stateDir);
    return new HostService(options, stateDir, identity, store);
  }

  get hostId(): string {
    return this.#identity.hostId;
  }

  get devices(): readonly DeviceRecord[] {
    return this.#store.devices;
  }

  get pairing(): HostPairingService {
    return this.#pairing;
  }

  get relayState(): HostRelayState {
    return this.#relay?.state ?? "closed";
  }

  /** 本机 loopback 端点。未启用或未启动时为 `undefined`。 */
  get loopback(): HostLoopbackServer | undefined {
    return this.#loopback;
  }

  /** LAN 端点。未启用或未起来时为 `undefined`（此时只剩 Relay 一条路径）。 */
  get lan(): HostLanServer | undefined {
    return this.#lan;
  }

  /** 写进二维码的 LAN 地址表。地址在配对时枚举，端口走配置——见 `lan-server.ts`。 */
  get lanEndpoints(): readonly PairingQrLanEndpoint[] {
    if (this.#options.lan === false) return [];
    // 监听已经起来时用**实际**端口：配了 0（让系统分配）的话，配置里的那个 0 写进二维码毫无意义。
    return localLanEndpoints(this.#lan?.port ?? this.#lanPort);
  }

  /** 当前已接入 Host 的本机 runtime（Pi 进程）。 */
  get localRuntimes(): readonly RuntimeMetadata[] {
    return this.#loopback?.runtimes ?? [];
  }

  /**
   * 设备重连后补发的 runtime 目录：loopback 上的 Pi 进程 + 各后端的目录条目。
   *
   * Codex 只有**挂着活跃 thread** 才算一条进程（`directoryEntry` 自己把关）：
   * app-server 是常驻的，但没跑会话时它没有 cwd 可言（拿 homedir 占位就是
   * 「主页面多出一条用户目录」的假进程）。会话激活时 onMetadataChange 会重播
   * runtime.online 把它补进目录。
   */
  #runtimesSnapshot(): RuntimeMetadata[] {
    const runtimes = [...this.localRuntimes];
    for (const backend of this.#backends) {
      runtimes.push(...(backend.directoryEntries?.() ?? []));
    }
    return runtimes;
  }

  /**
   * 这台电脑支持的 agent 种类，随 `device.ready` 下发给手机（§8.4）。
   *
   * Pi 恒有（spawner 起的就是它）；其它后端只在**真的就绪**时才算数——手机据此把
   * 做不到的选项置灰，免得让人点了再吃一个 `agent_unsupported`。
   */
  #agentsSnapshot(): AgentKind[] {
    return this.#backends.filter((backend) => backend.isReady()).map((backend) => backend.kind);
  }

  /** 某台设备此刻生效的路径（§14 B4 要显示的那个事实）。 */
  activePathOf(deviceId: string): PathKind | undefined {
    return this.#links.get(deviceId)?.active;
  }

  async start(): Promise<void> {
    // Host 在 Relay 眼里就是一个普通 runtime，直接复用 v1 的身份空间。
    const runtime: RuntimeMetadata = {
      runtimeId: this.#identity.hostId,
      name: this.#identity.hostName,
      cwd: homedir(),
      status: "idle",
    };
    const relay = new HostRelayClient({
      relayUrl: this.#options.relayUrl,
      credential: this.#options.credential,
      runtime,
      onFrame: (envelope) => {
        this.#handleFrame(envelope, "relay");
      },
      ...(this.#options.reconnect === undefined ? {} : { reconnect: this.#options.reconnect }),
      onStateChange: (state) => {
        if (state === "connected") {
          // 重连后必须把出口重新挂回去：`detach` 连出口一起摘掉，而出口只在链路**第一次**
          // 建立时挂上（见 #requireLink）。少了这一步，凡是断线前见过面的设备都会永久失去
          // 中继出口——手机发来的 HS1 会因为「这条路没有出口」被静默丢掉，用户看到的是
          // 「已连上中继，但电脑没有回应端到端加密握手」。挂出口 ≠ 这条路可用：
          // 可用与否仍由设备重新握手成功（MarkAvailable）决定。
          for (const link of this.#links.values()) this.#attachRelaySink(link);
        } else {
          // Relay 断了：把它从每台设备的候选路径里摘掉，让还在的 LAN 立刻接手。
          // 不摘的话生效路径会停在一个死掉的 socket 上，出站推送全部静默失败。
          for (const link of this.#links.values()) link.detach("relay");
        }
        this.#options.onStateChange?.(state);
      },
      onProtocolError: (code, message, transferId, targetDeviceId) => {
        // 目标设备不在中继上：把它名下的下载以确定原因收场。这条回绝不带 transferId
        // （v2 分片是端到端加密的，中继取不到），只能靠中继交回的 `hdr.to` 定位。
        if (code === "device_offline" && targetDeviceId !== undefined) {
          const failed = this.#downloads.failDeviceTransfers(targetDeviceId, code);
          // 分片泵在收到第一条回绝前已经排了一窗，后续只是余波：只报一次。
          //
          // 这里**不能**动这条路本身（detach/摘可用性）：detach 会连同该路径的 E2E 会话
          // 一起清掉，而 APP 侧只会在 socket 重开或收到 host.online 时重新握手——它以为
          // 自己连着，于是 Host 后续广播全部静默丢掉，手机就冻在「运行中」。
          if (failed > 0 || this.#shouldReportOfflineDevice(targetDeviceId)) {
            this.#options.log?.(`设备 ${targetDeviceId} 不在中继上：终止 ${failed} 条下载`);
          }
          return;
        }
        // 中继明确回绝了一次转发（例如它不认识某种帧、或目标设备不在线）。
        // 这类回绝只到得了这里，不落日志就等于消失——协议对不齐时最难查的就是它。
        this.#options.log?.(`中继回绝了转发：${code} ${message}`);
        // 带 transferId 的回绝是下载流的：中继已经丢了这条路，Host 直接收场即可。
        if (transferId !== undefined) this.#downloads.failTransferFromRelay(transferId, code);
      },
    });
    this.#relay = relay;

    // LAN 端点先起：端口被占基本只有一个原因——这台机器上已经有一个 Host 在跑。
    // 这种情况必须在做任何副作用之前就失败（写 loopback 发现文件、连中继、抢 runtime 身份），
    // 否则两个 Host 会用同一个中继身份互相踢，手机端表现为状态卡住、聊天不更新。
    if (this.#options.lan !== false && this.#options.lanListen !== false) {
      await this.#startLan();
    }

    if (this.#options.loopback !== false) {
      const loopback = new HostLoopbackServer({
        stateDir: this.#stateDir,
        hostId: this.#identity.hostId,
        ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
        onRuntimeOnline: (metadata) => {
          this.#broadcastDeviceMessage({
            type: "runtime.online",
            runtime: metadata,
          });
        },
        onRuntimeOffline: (runtimeId, reason) => {
          this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId, reason });
        },
        onRuntimeEvent: (runtimeId, _piSequence, event) => {
          // 顺手记下 artifact 的元数据（含 path）：这是 Host 之后能替 runtime 服务下载的依据。
          if (event.type === "artifact.started") this.#downloads.noteArtifact(runtimeId, event.artifact);
          this.#publishRuntimeEvent(runtimeId, event);
        },
        onRuntimeFrame: (_runtimeId, frame) => {
          // artifact 分片是裸字节。以前它被当成 `data` 载荷发出去，手机按 UTF-8 解读再拿去
          // 解析 JSON，于是「下载」等于「界面报一句收到无效的中继服务器消息」。
          this.#broadcastBinary(frame);
        },
      });
      this.#loopback = loopback;
      await loopback.start();
    }

    if (this.#options.stunServers !== undefined && this.#options.stunServers.length > 0) {
      this.#p2p = new HostP2pManager({
        stunServers: this.#options.stunServers,
        sendToDevice: (deviceId, message) => {
          this.#sendToDevice(deviceId, message as RelayToDeviceMessage);
        },
        onEnvelope: (deviceId, envelope, sink) => {
          try {
            const link = this.#requireLink(deviceId);
            link.attach("p2p", sink);
            link.handle("p2p", envelope);
          } catch (error) {
            this.#options.onDeviceError?.(deviceId, error);
            this.#options.log?.(`P2P 上处理 ${deviceId} 的帧失败：${describeError(error)}`);
          }
        },
        onPathDown: (deviceId) => {
          this.#links.get(deviceId)?.detach("p2p");
        },
        ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
      });
      this.#options.log?.(`P2P 已启用（STUN：${this.#options.stunServers.join(", ")}）`);
    } else {
      // 刻意不静默。之前漏传 stunServers 时这里什么都不说，于是「手机永远显示中继」在日志里
      // 完全无迹可寻——排查只能靠读代码。P2P 被关掉必须留下一行理由。
      // 措辞保持中性：短命进程（`pi-remote pair`、本地 smoke 脚本）不传 STUN 是有意为之。
      this.#options.log?.(
        "P2P 未启用：本进程没有可用的 STUN 服务器 → 一律走中继。" +
          "要开启需配置 stunServers 或设置 PI_REMOTE_STUN_SERVERS（relayUrl 非 wss:// 时不会自动推导）",
      );
    }

    if (this.#options.codexRuntime !== undefined) {
      // Codex 后端就绪（app-server 子进程由调用方管理生命周期）。启动时还没有活跃
      // thread，不广播 runtime.online——目录里不该有一条 cwd=homedir 的「空壳 Codex」；
      // 会话激活后 onMetadataChange 会补上。
      this.#options.codexRuntime.markStarted();
      this.#options.log?.(`Codex 后端已就绪（runtimeId=${this.#options.codexRuntime.runtimeId}）`);
    }

    await relay.start();
  }

  async stop(): Promise<void> {
    this.#sessionSync.close();
    this.#pairing.close();
    await this.#lan?.stop();
    this.#lan = undefined;
    this.#p2p?.stopAll();
    this.#p2p = undefined;
    for (const link of this.#links.values()) link.close();
    this.#links.clear();
    await this.#loopback?.stop();
    this.#loopback = undefined;
    await this.#relay?.stop();
    this.#relay = undefined;
    await this.#persistChain;
    // 上传索引与 `.part` 句柄同样是脱离调用栈的写。进程退出前不等它们，下次启动就少一截
    // 可续传的状态——用户要重传的不是几个分片，是整个文件。
    await this.#uploads.flush();
  }

  /**
   * LAN 起不来（端口被占、没有可用网卡）不是致命错误：Relay 一条路也能跑完整套功能，
   * 只是慢。所以这里降级并说清楚原因，而不是让整个 Host 启动失败。
   */
  async #startLan(): Promise<void> {
    const lan = new HostLanServer({
      port: this.#lanPort,
      resolveDevice: (deviceId) => findActiveDeviceRecord(this.#store, deviceId),
      onEnvelope: (deviceId, envelope, sink) => {
        try {
          const link = this.#requireLink(deviceId);
          link.attach("lan", sink);
          link.handle("lan", envelope);
        } catch (error) {
          this.#options.onDeviceError?.(deviceId, error);
          this.#options.log?.(`LAN 上处理 ${deviceId} 的帧失败：${describeError(error)}`);
        }
      },
      onDeviceOffline: (deviceId) => {
        this.#links.get(deviceId)?.detach("lan");
      },
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
    });
    try {
      await lan.start();
    } catch (error) {
      // 端口被占：这台机器上几乎可以肯定已经有一个 Host 在跑。此时静默降级去连中继
      // 是最坏的选择——两个 Host 抢同一个 runtime 身份，中继会把对方踢掉，手机那边
      // 看到的是状态时断时续、聊天不更新，而日志里只剩一串 relay reconnecting。
      if (isAddressInUse(error)) {
        throw new Error(
          `LAN 端口 ${this.#lanPort} 已被占用（通常表示已经有一个 Host 在运行）：` +
          "先停掉那个进程再启动本进程，否则两个 Host 会抢同一个中继身份。",
        );
      }
      this.#options.log?.(`LAN 端点未启动（${describeError(error)}），本次只走中继`);
      return;
    }
    this.#lan = lan;
    const endpoints = lan.endpoints.map((entry) => `${entry.host}:${entry.port}`).join(", ");
    this.#options.log?.(endpoints.length > 0 ? `LAN 端点已监听：${endpoints}` : "LAN 端点已监听（未找到非回环网卡）");
  }

  /**
   * 打开配对窗口：先向 Relay 换一个配对码，再和密码学材料拼成同一个二维码。
   *
   * LAN 地址一并写进二维码——那是**唯一**能把「电脑在局域网里的地址」带到手机上的通道。
   */
  async openPairingWindow(input?: {
    lan?: readonly PairingQrLanEndpoint[];
    /** 本地窗口时长（秒）。Relay 配对码自身 300s 过期，默认应不超过它。 */
    ttlSeconds?: number;
  }): Promise<OpenedPairingWindow> {
    const adminToken = this.#options.adminToken ?? this.#options.credential;
    const { code } = await requestPairingCode({ httpBase: relayHttpBase(this.#options.relayUrl), adminToken });
    const lan = input?.lan ?? this.lanEndpoints;
    return this.#pairing.open({
      relayUrl: this.#options.relayUrl,
      code,
      ...(input?.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      ...(lan.length === 0 ? {} : { lan }),
    });
  }

  /** 把一条业务载荷加密后发给某台设备（走它当前生效的路径）。 */
  sendData(deviceId: string, payload: Uint8Array, channel: EnvelopeChannel): void {
    this.#requireLink(deviceId).send(payload, channel);
  }

  revokeDevice(deviceId: string): boolean {
    const changed = revokeDeviceRecord(this.#store, deviceId);
    if (!changed) return false;
    this.#downloads.releaseDevice(deviceId);
    this.#uploads.releaseDevice(deviceId, "artifact_transport_disconnected");
    // P2P 的失败计数是「按设备」记的：设备都撤销了就别让它的历史留在内存里，
    // 否则同一槽位换一台新手机配对后会莫名继承冷却。
    this.#p2p?.stop(deviceId);
    this.#p2p?.forget(deviceId);
    this.#sessionSync.clearDevice(deviceId);
    this.#links.get(deviceId)?.close();
    this.#links.delete(deviceId);
    this.#persist();
    return true;
  }

  renameDevice(deviceId: string, label: string): boolean {
    const device = this.#store.devices.find(entry => entry.deviceId === deviceId && !entry.revoked);
    if (!device) return false;
    device.label = label;
    this.#persist();
    return true;
  }

  get #lanPort(): number {
    return this.#options.lanPort ?? DEFAULT_LAN_PORT;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * 一条入站帧。`path` 是它**从哪条路来**的：握手应答必须原路返回，
   * 而对端的 `hdr.from` 只是索引，不是身份（身份由 §5.3 的 MAC 证明）。
   */
  #handleFrame(envelope: EnvelopeV2, path: PathKind): void {
    const deviceId = envelope.hdr.from;
    try {
      if (envelope.hdr.k === "pair") {
        // 配对只能走中继：LAN 端点只接受**已配对**设备，扫码时它还不是。
        const { accept, device } = this.#pairing.acceptFrame(envelope);
        upsertDeviceRecord(this.#store, device);
        this.#persist();
        this.#relay?.send(accept);
        this.#options.log?.(`已配对设备 ${device.deviceId}`);
        this.#options.onPaired?.(device);
        return;
      }
      // `handle` 只在这条路径**没有出口**时返回 false（出口在 relay 重连后必须重挂，
      // 见 #attachRelaySink）。这种事默认是无声的，而它恰好是「手机在等 HS2、Host 这边
      // 一点痕迹都没有」的成因，所以必须留一行日志。
      const link = this.#requireLink(deviceId);
      if (!link.handle(path, envelope)) {
        this.#options.log?.(`${path} 路径没有出口，丢弃来自 ${deviceId} 的 ${envelope.hdr.k} 帧`);
      }
    } catch (error) {
      // 一条坏帧只影响它自己那台设备：其他设备的通道必须继续可用。
      this.#options.onDeviceError?.(deviceId, error);
      this.#options.log?.(
        `处理来自 ${deviceId} 的帧失败：${isE2eError(error) ? `${error.code} ` : ""}${describeError(error)}`,
      );
      if (envelope.hdr.k === "hs") this.#links.get(deviceId)?.detach(path);
    }
  }

  /**
   * 设备发来的明文载荷。
   *
   * 它装的是两样东西：v1 里设备本来发给 Relay 的那套消息（`runtime.command`），和
   * M3 的进程激活请求（`session.list` / `session.browse` / `session.activate`，spec §8）。
   * 认不出来的载荷交给上层（`onData`），不静默吞掉，方便接后端功能时排查。
   */
  #handleDevicePayload(deviceId: string, payload: Buffer, frame: "data" | "bin" = "data"): void {
    if (frame === "bin") {
      this.#uploads.handleData(deviceId, payload);
      return;
    }
    const message = parseDevicePayload(payload);
    if (message === undefined) {
      this.#options.onData?.(deviceId, payload);
      return;
    }
    if (message.type === "runtime.git.request") {
      void this.#handleGitBranchRequest(deviceId, message).catch((error: unknown) => {
        this.#options.onDeviceError?.(deviceId, error);
      });
      return;
    }
    if (message.type === "host.lan.request") {
      // Refresh addresses for already-paired phones and DHCP changes, only after E2E authentication.
      // Pairing-only processes do not advertise a listener they haven't started.
      const response = { type: "host.lan", protocolVersion: PROTOCOL_VERSION, endpoints: this.#lan?.endpoints ?? [] };
      this.#links.get(deviceId)?.send(Buffer.from(JSON.stringify(response), "utf8"), "ctl");
      return;
    }
    if (message.type === "device.pathPreference") {
      this.#applyPathPreference(deviceId, message.preference);
      return;
    }
    // ── 接收方驱动的范围下载（ADR-0005）：设备发 read 索取一段，Host 按范围应答。
    if (message.type === "artifact.read") {
      void this.#downloads.handleRead(deviceId, message);
      return;
    }
    if (message.type === "artifact.done") {
      this.#downloads.handleDone(deviceId, message.transferId);
      return;
    }
    // ── 上传（spec: 手机上传文件到电脑）：接收方驱动（ADR-0012），落地、校验、拉取都在这里。
    if (message.type === "file.upload.init") {
      void this.#uploads.handleInit(deviceId, message);
      return;
    }
    if (message.type === "file.upload.cancel") {
      void this.#uploads.handleCancel(deviceId, message.uploadId);
      return;
    }
    if (message.type === "session.activate" || message.type === "session.archive") {
      // Serialize activation with file moves, including the gap before a spawned Pi registers.
      this.#sessionMutation = this.#sessionMutation.then(() => this.#handleSessionRequest(deviceId, message));
      return;
    }
    if (message.type === "session.list" || message.type === "session.browse") {
      // 会话目录在磁盘上，天然是异步的；不阻塞帧处理循环，失败自己回报设备。
      void this.#handleSessionRequest(deviceId, message);
      return;
    }
    if (message.type === "p2p.request" || message.type === "p2p.answer") {
      if (this.#p2p === undefined) {
        this.#options.log?.(`P2P 未启用，忽略 ${deviceId} 的 ${message.type}`);
        this.#sendToDevice(deviceId, {
          type: "protocol.error",
          code: "p2p_unavailable",
          message: "Host 未启用 P2P（缺少 STUN 配置），继续走中继",
        });
        return;
      }
      if (message.type === "p2p.request") {
        // 冷却期内 Host 会拒绝。必须明确回报：只让请求「石沉大海」的话，手机既不知道
        // 该不该重试、也不知道自己还在走中继，状态页就永远停在「中继」而没人知道原因。
        const refusal = this.#p2p.startOffer(deviceId);
        if (refusal !== undefined) {
          this.#sendToDevice(deviceId, {
            type: "protocol.error",
            code: "p2p_cooling_down",
            message: `P2P 连续打洞失败，${Math.ceil(refusal.retryInMs / 1_000)} 秒内不再尝试，继续走中继`,
          });
        }
      } else this.#p2p.acceptAnswer(deviceId, message.sdp);
      return;
    }
    if (message.type !== "runtime.command") {
      this.#options.onData?.(deviceId, payload);
      return;
    }
    const command = message.command;
    // 下载的取消先给 Host 的下载服务认领：它服务的那条传输只有它认识。
    if (command.type === "artifact.cancel") {
      if (this.#downloads.handleTransferControl(deviceId, message.runtimeId, command)) return;
    }
    if (command.type === "file.download" || command.type === "artifact.download") {
      // 下载完全由 Host 服务（spec §9.4 的 Host→APP 模型）：文件就在这台机器的磁盘上，
      // Host 常驻，读盘发分片不需要任何 Pi 进程参与。**不再回落到 runtime**——手机发的
      // 就是对 Host 的请求，Host 服务不了就如实回报失败，而不是把它转给某个进程再报
      // runtime_offline（那会把「Host 读不到这个文件」误说成「进程不在线」）。
      void this.#downloads.offerDownload(deviceId, message.runtimeId, message.commandId, command);
      return;
    }
    this.#routeRuntimeCommand(deviceId, message);
  }

  /** Read only the directory registered by the target runtime; the phone cannot supply a path. */
  async #handleGitBranchRequest(deviceId: string, request: GitBranchRequest): Promise<void> {
    const runtime = this.#runtimesSnapshot().find((entry) => entry.runtimeId === request.runtimeId);
    if (runtime === undefined) return;
    let pending = this.#gitReads.get(runtime.cwd);
    if (pending === undefined) {
      pending = readGitBranch(runtime.cwd);
      this.#gitReads.set(runtime.cwd, pending);
    }
    let identity: Awaited<ReturnType<typeof readGitBranch>>;
    try {
      identity = await pending;
    } finally {
      if (this.#gitReads.get(runtime.cwd) === pending) this.#gitReads.delete(runtime.cwd);
    }
    const current = this.#runtimesSnapshot().find((entry) => entry.runtimeId === request.runtimeId);
    if (current?.cwd !== runtime.cwd || current.sessionId !== runtime.sessionId) return;
    this.#links.get(deviceId)?.send(Buffer.from(JSON.stringify({
      type: "runtime.git",
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      runtimeId: runtime.runtimeId,
      sessionId: runtime.sessionId ?? null,
      cwd: runtime.cwd,
      ...identity,
    }), "utf8"), "ctl");
  }

  /**
   * 把一条 `runtime.command` 投给它指名道姓的后端（spec §7.4 的统一分派）。
   *
   * 归属一次命中：`ownsRuntime` 认领了但命令不认识 → `unsupported_command`；
   * 没有任何后端认领（或认领后进程已掉线）→ `runtime_offline`——手机据此区分
   * 「该重拉进程」和「这个后端做不到」（§8）。
   */
  #routeRuntimeCommand(
    deviceId: string,
    message: Extract<DeviceE2ePayload, { type: "runtime.command" }>,
  ): void {
    const { runtimeId, commandId, command } = message;
    if (command.type === "session.sync") {
      this.#sessionSync.request(deviceId, runtimeId, commandId, command);
      return;
    }
    for (const backend of this.#backends) {
      if (!backend.isReady() || !backend.ownsRuntime(runtimeId)) continue;
      const result = backend.dispatchCommand(runtimeId, commandId, command);
      if (result === "handled") return;
      this.#sendToDevice(deviceId, {
        type: "protocol.error",
        code: result === "offline" ? "runtime_offline" : "unsupported_command",
        message: result === "offline"
          ? `runtime ${runtimeId} 当前没有在本机运行`
          : `${backend.kind} 后端不支持命令 ${command.type}`,
        commandId,
      });
      return;
    }
    this.#sendToDevice(deviceId, {
      type: "protocol.error",
      code: "runtime_offline",
      message: `runtime ${runtimeId} 当前没有在本机运行`,
      commandId,
    });
  }

  /** `session.activated` 回执：激活结果统一从 `BackendActivation` 摊平成协议字段。 */
  #sendActivated(deviceId: string, requestId: string, agentKind: AgentKind, activated: BackendActivation): void {
    this.#sendToDevice(deviceId, {
      type: "session.activated",
      requestId,
      agentKind,
      ...(activated.sessionId === undefined ? {} : { sessionId: activated.sessionId }),
      spawnMode: activated.spawnMode,
      ...(activated.pid === undefined ? {} : { pid: activated.pid }),
    });
  }

  /**
   * 拉全部后端的会话目录，带**短 TTL 缓存**和**并发合并**。
   *
   * 目录是只读且变化很慢的数据，但拉一次并不便宜：Codex 侧 `thread/list` 实测
   * 2.5–6s（codex CLI 内部要扫全部 rollout），Pi 侧要扫盘。手机在激活会话、
   * 重连、回前台时都会请求；不收敛的话这些请求会互相叠加，把每一台设备都拖进
   * 几十秒的等待——用户看到的就是「新建的会话几十秒后才出现在手机上」。
   *
   * 两条收敛路径：
   * - **并发合并**：`#catalogInFlight` 存在时直接复用同一个 Promise，同一瞬间的
   *   多个请求只扫一次盘。
   * - **TTL 缓存**：`CATALOG_TTL_MS` 内的请求直接回上次结果。
   *
   * 激活会话（`session.activate`）会显式 `#invalidateCatalog()`——新建/恢复会话
   * 后必须让手机立刻看到新条目，缓存不能挡住这条路径。
   */
  async #catalogWithCache(): Promise<{ sessions: AgentSessionSummary[]; cached: boolean }> {
    const now = Date.now();
    if (this.#catalogCache !== undefined && now - this.#catalogCache.at < CATALOG_TTL_MS) {
      return { sessions: this.#catalogCache.sessions, cached: true };
    }
    const epoch = this.#catalogEpoch;
    if (this.#catalogInFlight !== undefined) {
      const sessions = await this.#catalogInFlight;
      if (epoch !== this.#catalogEpoch) return this.#catalogWithCache();
      return { sessions, cached: true };
    }
    const task = this.#collectCatalogs();
    this.#catalogInFlight = task;
    try {
      const sessions = await task;
      if (epoch !== this.#catalogEpoch) return this.#catalogWithCache();
      this.#catalogCache = { at: Date.now(), sessions };
      return { sessions, cached: false };
    } finally {
      if (this.#catalogInFlight === task) this.#catalogInFlight = undefined;
    }
  }

  /** 实际扫一遍所有后端（`#catalogWithCache` 的唯一慢路径）。 */
  async #collectCatalogs(): Promise<AgentSessionSummary[]> {
    const sessions: AgentSessionSummary[] = [];
    for (const backend of this.#backends) {
      if (!backend.isReady()) continue;
      try {
        const started = Date.now();
        const [active, archived] = await Promise.all([backend.catalog(), backend.catalog(true)]);
        const catalog = [...new Map([...active, ...archived].map((entry) => [entry.sessionId, entry])).values()];
        this.#options.log?.(`[debug] session.list：${backend.kind} 返回 ${catalog.length} 条（${Date.now() - started}ms）`);
        sessions.push(...catalog);
      } catch (error) {
        this.#options.log?.(`拉取 ${backend.kind} 会话目录失败，本次跳过该后端：${describeError(error)}`);
      }
    }
    // 目录是发给手机的单条 E2E 消息，历史太久会撑成大帧（中继可能拒收）。
    return sessions.slice(0, 2_000);
  }

  /** 激活或归档操作后失效目录缓存：状态变化必须马上出现在手机侧栏。 */
  #invalidateCatalog(): void {
    this.#catalogEpoch += 1;
    this.#catalogCache = undefined;
    this.#catalogInFlight = undefined;
  }

  /** §8 的四个请求。所有失败都走 `protocol.error` 并带回 `requestId`，不静默吞。 */
  async #handleSessionRequest(
    deviceId: string,
    message: Extract<DeviceE2ePayload, { type: "session.list" | "session.browse" | "session.activate" | "session.archive" }>,
  ): Promise<void> {
    const requestId = message.requestId;
    this.#options.log?.(`[debug] 收到 ${message.type}（requestId=${requestId}）`);
    try {
      if (message.type === "session.archive") {
        const backend = this.#backends.find((candidate) => candidate.kind === message.agentKind && candidate.isReady());
        if (backend === undefined) throw new ActivationError("agent_unsupported", "对应的 agent 后端未就绪");
        try {
          await backend.setArchived(message.sessionId, message.archived);
        } finally {
          // Even a failed native call can unload a thread or leave a completed file move.
          this.#invalidateCatalog();
        }
        this.#broadcastDeviceMessage({
          type: "session.archive.changed", requestId,
          agentKind: message.agentKind, sessionId: message.sessionId, archived: message.archived,
        });
        return;
      }
      if (message.type === "session.list") {
        // 各后端各拉各的目录（Pi 扫盘、Codex 问 app-server），单后端失败不拖垮列表。
        // 扫盘条目只知道「来自本机」：补上主机名，手机侧栏才能把「电脑上有、手机还没
        // 缓存过」的会话归到这台主机下，而不是落进未知主机分组（§8.1）。
        //
        // 目录是**只读且变化很慢**的东西，而单次拉取并不便宜（Codex 侧 `thread/list`
        // 实测 2.5–6s，Pi 侧全盘扫）。手机在每次激活/重连/回前台都会请求一遍，
        // 不收敛的话这些请求会互相堆叠、把每一台设备都拖进几十秒的等待。
        // 这里按 TTL 缓存 + 合并并发请求：同一时刻的多个 `session.list` 共享同一次扫描。
        const { sessions, cached } = await this.#catalogWithCache();
        const localHostname = hostname();
        const payload = {
          type: "session.list.result" as const,
          requestId,
          sessions: sessions.map((entry) => ({ ...entry, hostname: localHostname })),
        };
        this.#options.log?.(
          `[debug] 回 session.list.result：${payload.sessions.length} 条，${JSON.stringify(payload).length} 字节${cached ? "（命中缓存）" : ""}`,
        );
        this.#sendToDevice(deviceId, payload);
        return;
      }
      if (message.type === "session.browse") {
        // hasSessions 需要 cwd 集合：跳过逐文件读取，只扫每目录最新一个。
        const { cwds } = await listPiSessions({ summaries: false, ...(this.#options.sessionsRoot === undefined ? {} : { root: this.#options.sessionsRoot }) });
        const result = await browseDirectory(message.path, cwds);
        this.#sendToDevice(deviceId, {
          type: "session.browse.result",
          requestId,
          path: result.path,
          ...(result.parent === undefined ? {} : { parent: result.parent }),
          entries: result.entries,
        });
        return;
      }
      // session.activate。会话 id 空间互不相交（§7.5）：
      // - new 按 agentKind 点名后端，没这个后端就是 agent_unsupported；
      // - resume 按装配顺序（Pi → Codex）逐个问，session_not_found = 不归它管。
      const target = message.target;
      const context = {
        deviceId,
        ...(message.spawnMode === undefined ? {} : { spawnMode: message.spawnMode }),
      };
      if (target.type === "new") {
        const backend = this.#backends.find((candidate) => candidate.kind === target.agentKind);
        if (backend === undefined) {
          throw new ActivationError(
            "agent_unsupported",
            target.agentKind === "codex"
              ? "Codex 后端未启用：请用 `pi-remote host --codex` 启动"
              : target.agentKind === "dsh" ? "DeepSeek Harness 后端未启用：请用 `pi-remote host --dsh` 启动" : "未知的 agent 类型",
          );
        }
        if (!backend.isReady()) {
          throw new ActivationError("agent_unsupported", `${backend.kind} 后端未就绪`);
        }
        const activated = await backend.activate({ type: "new", cwd: target.cwd }, context);
        // 新建会话会改变目录（Codex 多一条活跃 thread、Pi 多一个会话文件）：
        // 让缓存立刻失效，否则手机在这 5s 内重新拉目录还是旧列表。
        this.#invalidateCatalog();
        this.#sendActivated(deviceId, requestId, backend.kind, activated);
        return;
      }
      for (const backend of this.#backends) {
        if (!backend.isReady()) continue;
        try {
          const activated = await backend.activate({ type: "resume", sessionId: target.sessionId }, context);
          // 恢复会话会把它带进活跃 thread 目录（Codex），同样要失效缓存。
          this.#invalidateCatalog();
          this.#sendActivated(deviceId, requestId, backend.kind, activated);
          return;
        } catch (error) {
          if (error instanceof ActivationError && error.code === "session_not_found") continue;
          throw error;
        }
      }
      throw new ActivationError("session_not_found", `找不到会话 ${target.sessionId}（可能已被删除）`);
    } catch (error) {
      const code = error instanceof ActivationError || error instanceof SessionArchiveError ? error.code : "session_request_failed";
      this.#sendToDevice(deviceId, {
        type: "protocol.error",
        code,
        message: describeError(error),
        requestId,
      });
      this.#options.log?.(`设备 ${deviceId} 的会话请求失败（${message.type}）：${describeError(error)}`);
    }
  }

  /**
   * 一条通道刚刚握手完成。**每一次**握手完成都要补一份 runtime 目录，两次动作顺序重要：
   *
   * 1. 先补目录。手机重开时它只是重新握了一次手，断开期间错过的 `runtime.online` /
   *    `offline` 一个都没收到，手里没有任何进程；不补的话它会一直停在旧状态上。
   * 2. 然后才宣布生效路径，让手机把输入切到这条路上（§14 B4）。
   *
   * 注意这不属于「路径变了」（见 `#handlePathChange`）：同一条路上的重新握手不会改变生效
   * 路径，而对端恰恰是那时候最需要目录——把它挂在路径变更上，手机重开就永远补不到。
   */
  #handleSessionReady(deviceId: string, kind: PathKind, active: PathKind, change: PathChange): void {
    this.#sessionSync.clearDevice(deviceId);
    if (change.changed) {
      this.#options.log?.(`设备 ${deviceId} 的路径 ${describePath(change.from)} → ${describePath(change.to)}`);
      this.#options.onPathChange?.(deviceId, {
        from: change.from,
        to: change.to,
        rttMs: undefined,
      });
    }
    // 两条都走**刚握手完成的这条路**，不走选路：Host 手里那条「生效路径」可能早就死了
    // （手机换了网、或干脆被杀掉，中继不会替它转告），而这条路刚刚证明过自己能通。
    this.#sendToDeviceOn(deviceId, kind, {
      type: "device.ready",
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      runtimes: this.#runtimesSnapshot(),
      agents: this.#agentsSnapshot(),
    });
    const rttMs = this.#links.get(deviceId)?.activeRttMs;
    this.#sendToDeviceOn(deviceId, kind, {
      type: "device.path",
      protocolVersion: PROTOCOL_VERSION,
      path: active,
      ...(rttMs === undefined ? {} : { rttMs: Math.round(rttMs) }),
    });
    // Codex 是 Host 内部后端，没有 Pi RuntimeBridge 那样的 transport connected/resync
    // 钩子来重播 capabilities——重连后 `runtime.online` 会把 capabilities 清掉，slash 菜单
    // 就再也不出来。这里趁刚握手完成、这条路确定能通，把每个活跃 codex thread 的
    // capabilities + metadata 补发给这台设备（走运行中事件通道，序号照常递增防丢）。
    const codex = this.#options.codexRuntime;
    if (codex !== undefined && codex.isReady()) {
      for (const threadId of codex.activeThreadIds()) {
        codex.announce(threadId);
      }
    }
    this.#options.dshRuntime?.announce();
    // Pi 侧同理：扩展只在自己的 transport 重连时才重播 capabilities，而那和“手机刚重连”
    // 是两件事——手机侧被 `device.ready` / `runtime.online` 清掉词表后，只要扩展的 transport
    // 没断过，`/` 菜单就一直空着（一直要到下一轮 turn 结束刷新 capabilities）。
    for (const { runtimeId, event } of this.#loopback?.runtimeCapabilities() ?? []) {
      this.#sendToDeviceOn(deviceId, kind, {
        type: "runtime.event",
        protocolVersion: PROTOCOL_VERSION,
        runtimeId,
        sequence: this.#nextEventSequence(runtimeId, channelForDeviceMessage({ type: "runtime.event", event })),
        event,
      });
      // 手机重开时，Pi 的 loopback transport 通常没有断过，因此 Pi 不会自动收到
      // `RuntimeBridge` 的 transport.connected/resync 回调。主动请求一次权威交互快照，
      // 否则手机只能恢复目录和状态角标，却永远拿不到已经在电脑端 Pending 的问题详情。
      this.#loopback?.sendResync(runtimeId, "device_reconnected");
    }
    // 没上报过 capabilities 的 runtime 也可能持有交互；resync 不应依赖命令词表。
    for (const runtime of this.#loopback?.runtimes ?? []) {
      if (this.#loopback?.runtimeCapabilities().some((entry) => entry.runtimeId === runtime.runtimeId)) continue;
      this.#loopback?.sendResync(runtime.runtimeId, "device_reconnected");
    }
  }

  /**
   * 生效路径变了（换路，或某条路没了）。
   *
   * 这里**不补** runtime 目录——那件事属于「握手完成」（见 `#handleSessionReady`）。
   */
  #handlePathChange(deviceId: string, change: ActivePathChange): void {
    this.#options.log?.(
      `设备 ${deviceId} 的路径 ${describePath(change.from)} → ${describePath(change.to)}`
        + (change.rttMs === undefined ? "" : `（${Math.round(change.rttMs)} ms）`),
    );
    if (change.to === undefined) {
      this.#sessionSync.clearDevice(deviceId);
      return;
    }
    this.#sendToDevice(deviceId, {
      type: "device.path",
      protocolVersion: PROTOCOL_VERSION,
      path: change.to,
      ...(change.rttMs === undefined ? {} : { rttMs: Math.round(change.rttMs) }),
    });
    this.#options.onPathChange?.(deviceId, change);
  }

  #sendToDevice(deviceId: string, message: RelayToDeviceMessage): void {
    const link = this.#links.get(deviceId);
    if (link === undefined) return;
    try {
      // `send` 走当前生效路径；没有可用路径时返回 false，此时消息就是发不出去，
      // 也不该假装发出去了——上层会靠重连后的 `device.ready` 重新对齐。
      link.send(Buffer.from(JSON.stringify(message), "utf8"), channelForDeviceMessage(message));
    } catch (error) {
      this.#options.onDeviceError?.(deviceId, error);
    }
  }

  /** 指定路径上的发送（握手刚完成时用，理由见 `DeviceLink.sendOn`）。 */
  #sendToDeviceOn(deviceId: string, kind: PathKind, message: RelayToDeviceMessage): void {
    const link = this.#links.get(deviceId);
    if (link === undefined) return;
    try {
      link.sendOn(kind, Buffer.from(JSON.stringify(message), "utf8"), channelForDeviceMessage(message));
    } catch (error) {
      this.#options.onDeviceError?.(deviceId, error);
    }
  }

  #runtimeEventMessage(runtimeId: string, event: RuntimeEvent): Extract<RelayToDeviceMessage, { type: "runtime.event" }> {
    return { type: "runtime.event", protocolVersion: PROTOCOL_VERSION, runtimeId,
      sequence: this.#nextEventSequence(runtimeId, channelForDeviceMessage({ type: "runtime.event", event })), event };
  }

  #publishRuntimeEvent(runtimeId: string, event: RuntimeEvent): void {
    if (this.#sessionSync.handleEvent(runtimeId, event)) return;
    this.#broadcastDeviceMessage(this.#runtimeEventMessage(runtimeId, event));
  }

  #broadcastDeviceMessage(message: RelayToDeviceMessage): void {
    this.#broadcastPayload(Buffer.from(JSON.stringify(message), "utf8"), channelForDeviceMessage(message));
  }

  /** 广播给所有握好手的设备。单台设备封帧失败不影响其他设备。 */
  #broadcastPayload(payload: Uint8Array, channel: EnvelopeChannel): void {
    for (const [deviceId, link] of this.#links) {
      try {
        if (!link.send(payload, channel)) continue;
      } catch (error) {
        this.#options.onDeviceError?.(deviceId, error);
      }
    }
  }

  /** 同上，但封成 `bin` 帧（裸字节载荷，例如 artifact 分片）。 */
  #broadcastBinary(payload: Uint8Array): void {
    for (const [deviceId, link] of this.#links) {
      try {
        if (!link.sendBinary(payload)) continue;
      } catch (error) {
        this.#options.onDeviceError?.(deviceId, error);
      }
    }
  }

  /**
   * Host 是发给手机的**事件序号的唯一权威**：按 (runtimeId, channel) 取号。
   *
   * Pi 自己在 loopback 上带的 `sequence` 只服务本机链路，这里**不采用**——
   * 它是全局一条流水（见 pi-extension 的 `nextRuntimeSequence`），与分道投递
   * 的现实不匹配，采纳它就是把 issue 02 的跨道倒挂原样搬给手机。
   *
   * 首次见到某个 (runtimeId, channel) 时用当前时间起步——它必然高于上一次
   * 会话里的任何序号：手机的 `lastSequence` 活在 APP 进程内存里，Host 重启
   * 不能指望手机那边清零。
   */
  #nextEventSequence(runtimeId: string, channel: EnvelopeChannel): number {
    const key = `${runtimeId}\u0000${channel}`;
    const known = this.#eventSequences.get(key);
    const next = known === undefined ? Date.now() : known + 1;
    this.#eventSequences.set(key, next);
    return next;
  }

  /**
   * 同一台设备的离线回绝在短窗口内只报一次。
   *
   * 分片泵在收到第一条回绝之前已经排了一整窗，收场动作只能在第一条回绝时生效；
   * 剩下的是余波，如果逐条落日志，一次断线的 88MB 下载就能把 Host 日志刷成十几 MB。
   */
  #shouldReportOfflineDevice(deviceId: string): boolean {
    const now = Date.now();
    const last = this.#offlineDeviceReportedAt.get(deviceId);
    if (last !== undefined && now - last < OFFLINE_DEVICE_REPORT_INTERVAL_MS) return false;
    this.#offlineDeviceReportedAt.set(deviceId, now);
    return true;
  }

  #requireLink(deviceId: string): DeviceLink {
    const existing = this.#links.get(deviceId);
    if (existing !== undefined) return existing;
    const record = findActiveDeviceRecord(this.#store, deviceId);
    if (record === undefined) {
      throw new E2eError("mac_mismatch", `设备 ${deviceId} 未配对或已被撤销`);
    }
    const pathPreference = this.#pathPreferences.get(deviceId);
    // 每台设备一条链路，节流状态跟着闭包走：慢链路的大下载里水位告警会持续触发，
    // 不节流就是每个 pump tick 一行日志（真机实测一次 84MB 下载刷出 1.89 GB）。
    let lastBulkWarnAt = 0;
    const link = new DeviceLink({
      hostId: this.#identity.hostId,
      device: record,
      ...(this.#options.probeIntervalMs === undefined ? {} : { probeIntervalMs: this.#options.probeIntervalMs }),
      ...(pathPreference === undefined ? {} : { pathPreference }),
      ...(this.#options.bulkBytesPerSecond === undefined
        ? {}
        : { bulkBytesPerSecond: this.#options.bulkBytesPerSecond }),
      ...(this.#options.log === undefined
        ? {}
        : { onBulkQueuedTooLong: (kind: PathKind, queuedMs: number, queuedBytes: number) => {
          const now = Date.now();
          if (now - lastBulkWarnAt < BULK_WARN_INTERVAL_MS) return;
          lastBulkWarnAt = now;
          this.#options.log?.(
            `[bulk] ${kind} 路径上分片排队 ${Math.round(queuedMs / 1000)}s（队列 ${queuedBytes} 字节）：链路积压，分片被水位压住；控制帧不受影响（插队走 ctl）`,
          );
        } }),
      ...(this.#options.log === undefined
        ? {}
        : { onStaleFrame: (kind: PathKind, info: { channel: string; n: number; last: number }) => {
          this.#options.log?.(
            `[e2e] ${kind} 路径丢弃过期帧：ch=${info.channel} n=${info.n}（本端水位线 ${info.last}）。` +
              `多为发送端在该 channel 上的序号回退——若成批出现，检查两端会话状态是否错位`,
          );
        } }),
      onPayload: (payload, frame) => {
        this.#handleDevicePayload(deviceId, payload, frame);
      },
      onActivePathChange: (change) => {
        this.#handlePathChange(deviceId, change);
      },
      onSessionReady: (kind, active, change) => {
        this.#handleSessionReady(deviceId, kind, active, change);
      },
      // 底层写入重试耗尽：那几帧真的没出去，而它们的序号已经消耗。重发只会换一个新序号、
      // 接收侧的洞永远补不上，所以把这条路径摘掉、让选路回落（与 P2P 通道关闭时同一条出口）。
      onPathWriteAbandoned: (kind, error) => {
        this.#options.log?.(
          `${kind} 路径上的写入重试耗尽（${describeError(error)}）：摘掉这条路径，让选路回落`,
        );
        this.#links.get(deviceId)?.detach(kind);
      },
      onError: (error) => {
        this.#options.onDeviceError?.(deviceId, error);
      },
    });
    this.#links.set(deviceId, link);
    this.#attachRelaySink(link);
    return link;
  }

  /**
   * 给一条链路挂上中继出口。
   *
   * Relay 是常驻的控制面：任何设备随时都有一条 Relay 出口可用（前提是那条连接还在）。
   * 注意「挂上出口」不等于「这条路可用」——可用与否由该路径自己握手成功来决定。
   *
   * 出口必须在**每次** relay 连上之后重挂，不能只在链路创建时挂一次：relay 掉线时
   * `detach("relay")` 会把出口连同该路径的会话一起摘掉（这是对的，旧 socket 的会话
   * 不能复用），而链路本身留在地图里不会重建。只挂一次的表现是——relay 抖动一次之后，
   * 那台设备的中继入站帧全部石沉大海。
   */
  #attachRelaySink(link: DeviceLink): void {
    const sink: PathSink = (envelope) => {
      this.#relay?.send(envelope);
    };
    // 中继 socket 的待发字节数：出站多路复用器靠它决定分片什么时候才能写进去。
    sink.backlog = () => this.#relay?.bufferedAmount ?? 0;
    link.attach("relay", sink);
  }

  /**
   * 设备改了连接优先级。记下来，并立刻作用到它当前的链路上（生效路径可能当场换掉，
   * 换掉时 `DeviceLink` 会照常通过 `onActivePathChange` 宣布给手机）。
   */
  #applyPathPreference(deviceId: string, preference: readonly PathKind[]): void {
    const order = normalizePreference(preference);
    this.#pathPreferences.set(deviceId, order);
    this.#links.get(deviceId)?.setPathPreference(order);
    this.#options.log?.(`设备 ${deviceId} 的连接优先级：${order.map(describePath).join(" > ")}`);
  }

  #persist(): void {
    const snapshot: DeviceStore = { version: 1, devices: [...this.#store.devices] };
    this.#persistChain = this.#persistChain.then(() => saveDeviceStore(this.#stateDir, snapshot));
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "EADDRINUSE";
}

function parseDevicePayload(payload: Buffer): DeviceE2ePayload | PathPreferenceMessage | LanDiscoveryRequest | GitBranchRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  const result = DeviceE2ePayloadSchema.safeParse(parsed);
  if (result.success) return result.data;
  // 连接优先级不在协议 schema 里（见 path-preference.ts）：Relay 看不见的纯本机偏好。
  return parsePathPreferenceMessage(parsed) ?? parseLanDiscoveryRequest(parsed) ?? parseGitBranchRequest(parsed);
}
