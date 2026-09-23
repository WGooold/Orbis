import { z } from "zod";

export const PROTOCOL_VERSION = 7 as const;
export const ARTIFACT_CHUNK_BYTES = 1024 * 1024;

/**
 * 手机上传到电脑的单文件上限。
 *
 * 100 MiB 是产品选择（覆盖截图、日志、PDF、小视频），不是传输能力上限：分片仍是 1 MiB，
 * 这个值只在 schema 与手机 UI 两侧做拦截。
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** 一条消息最多携带几个附件。 */
export const MAX_MESSAGE_ATTACHMENTS = 10;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const ARTIFACT_FRAME_HEADER_BYTES = 24;
const ARTIFACT_FRAME_KIND_CHUNK = 1;
const ARTIFACT_FRAME_MAGIC = Uint8Array.from([0x50, 0x49, 0x52, 0x33]);
const MAX_RUNTIME_ID_BYTES = 256;
const MAX_TRANSFER_ID_BYTES = 256;
const boundedFrameId = (maximumBytes: number) => z.string().min(1).max(maximumBytes)
  .refine((value) => value.trim().length > 0, "identifier must not be blank")
  .refine((value) => new TextEncoder().encode(value).byteLength <= maximumBytes, "identifier is too large");
const TransferIdSchema = boundedFrameId(MAX_TRANSFER_ID_BYTES);

export type ArtifactChunkFrame = {
  runtimeId: string;
  transferId: string;
  offset: number;
  data: Uint8Array;
};

const artifactFrameError = (): Error => new Error("invalid_artifact_chunk_frame");

export function encodeArtifactChunkFrame(frame: ArtifactChunkFrame): Uint8Array {
  const runtimeId = new TextEncoder().encode(frame.runtimeId);
  const transferId = new TextEncoder().encode(frame.transferId);
  if (!frame.runtimeId.trim() || runtimeId.byteLength > MAX_RUNTIME_ID_BYTES ||
    !frame.transferId.trim() || transferId.byteLength > MAX_TRANSFER_ID_BYTES ||
    !Number.isSafeInteger(frame.offset) || frame.offset < 0 ||
    frame.data.byteLength < 1 || frame.data.byteLength > ARTIFACT_CHUNK_BYTES) {
    throw artifactFrameError();
  }
  const output = new Uint8Array(ARTIFACT_FRAME_HEADER_BYTES + runtimeId.byteLength + transferId.byteLength + frame.data.byteLength);
  output.set(ARTIFACT_FRAME_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, ARTIFACT_FRAME_KIND_CHUNK);
  view.setUint16(6, runtimeId.byteLength);
  view.setUint16(8, transferId.byteLength);
  view.setUint16(10, 0);
  view.setBigUint64(12, BigInt(frame.offset));
  view.setUint32(20, frame.data.byteLength);
  output.set(runtimeId, ARTIFACT_FRAME_HEADER_BYTES);
  output.set(transferId, ARTIFACT_FRAME_HEADER_BYTES + runtimeId.byteLength);
  output.set(frame.data, ARTIFACT_FRAME_HEADER_BYTES + runtimeId.byteLength + transferId.byteLength);
  return output;
}

export function decodeArtifactChunkFrame(input: Uint8Array): ArtifactChunkFrame {
  if (input.byteLength < ARTIFACT_FRAME_HEADER_BYTES) throw artifactFrameError();
  if (!ARTIFACT_FRAME_MAGIC.every((byte, index) => input[index] === byte)) throw artifactFrameError();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint8(4) !== PROTOCOL_VERSION || view.getUint8(5) !== ARTIFACT_FRAME_KIND_CHUNK) {
    throw artifactFrameError();
  }
  const runtimeIdBytes = view.getUint16(6);
  const transferIdBytes = view.getUint16(8);
  if (view.getUint16(10) !== 0) throw artifactFrameError();
  const offset = view.getBigUint64(12);
  const payloadLength = view.getUint32(20);
  const transferIdStart = ARTIFACT_FRAME_HEADER_BYTES + runtimeIdBytes;
  const payloadStart = transferIdStart + transferIdBytes;
  if (runtimeIdBytes < 1 || runtimeIdBytes > MAX_RUNTIME_ID_BYTES ||
    transferIdBytes < 1 || transferIdBytes > MAX_TRANSFER_ID_BYTES ||
    offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    payloadLength < 1 || payloadLength > ARTIFACT_CHUNK_BYTES ||
    payloadStart + payloadLength !== input.byteLength) {
    throw artifactFrameError();
  }
  let runtimeId: string;
  let transferId: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    runtimeId = decoder.decode(input.subarray(ARTIFACT_FRAME_HEADER_BYTES, transferIdStart));
    transferId = decoder.decode(input.subarray(transferIdStart, payloadStart));
  } catch {
    throw artifactFrameError();
  }
  if (!runtimeId.trim() || !transferId.trim()) throw artifactFrameError();
  return {
    runtimeId,
    transferId,
    offset: Number(offset),
    data: input.slice(payloadStart),
  };
}

export const RuntimeStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_local_interaction",
]);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

/**
 * 一条 runtime 连接在 Relay 身份空间里的角色。
 *
 * `host` 是**网关**（Gateway）：它以 runtime 的身份挂在 Relay 上，唯一目的是让手机能把帧
 * 路由到它（`hdr.to = hostId`），它自己不是一个 agent 进程。
 *
 * 这件事必须由客户端说出来，因为 Relay 无法从凭据上区分 Host 与 Pi（两者用同一份 runtime
 * credential），而两者的差别对手机是可见的：Relay 若把网关当成一条进程播出去，手机上就会
 * 凭空多出一个 cwd 是用户目录的「进程」，与它并列的真正的 Pi 进程反而看起来不在线。
 *
 * **必填**（ADR-0008）：不再有"缺省 `agent`"的旧客户端。
 */
export const RuntimeRoleSchema = z.enum(["agent", "host"]);
export type RuntimeRole = z.infer<typeof RuntimeRoleSchema>;

export const RuntimeModelInfoSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
  /** Human-readable model name when the provider catalogue has one. */
  name: z.string().min(1).max(256).optional(),
});
export type RuntimeModelInfo = z.infer<typeof RuntimeModelInfoSchema>;

export const RuntimeContextUsageSchema = z.strictObject({
  /** Estimated tokens in the active context; null while Pi cannot estimate them yet. */
  tokens: z.number().int().nonnegative().nullable(),
  contextWindow: z.number().int().positive(),
  /** Context utilization against `contextWindow`, or null when `tokens` is unknown. */
  percent: z.number().min(0).max(100).nullable(),
});
export type RuntimeContextUsage = z.infer<typeof RuntimeContextUsageSchema>;

/** Effective session permissions reported by the backend; absence never implies full access. */
export const RuntimePermissionsSchema = z.strictObject({
  sandbox: z.string(),
  approvalPolicy: z.string(),
  reviewer: z.string().optional(),
  networkAccess: z.boolean().optional(),
  writableRoots: z.array(z.string()).optional(),
  readableRoots: z.array(z.string()).optional(),
  profile: z.string().optional(),
  problem: z.string().optional(),
});
export type RuntimePermissions = z.infer<typeof RuntimePermissionsSchema>;

export const RuntimeMetadataSchema = z.strictObject({
  runtimeId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096),
  status: RuntimeStatusSchema,
  sessionId: z.string().min(1).max(256).optional(),
  sessionGraphSync: z.boolean().optional(),
  sessionLeafId: z.string().max(256).nullable().optional(),
  // Machine identity of the Pi host. Needs no user setup, so the APP can tell Pi processes
  // apart across devices. 可选的原因是 `os.hostname()` 可能抛——不是兼容旧中继。
  hostname: z.string().min(1).max(256).optional(),
  sessionName: z.string().min(1).max(256).optional(),
  // Active model, thinking level, and context utilization are reported so the APP can show them
  // in the chat status line. All are optional because a runtime may not know them yet.
  model: RuntimeModelInfoSchema.optional(),
  thinkingLevel: z.string().min(1).max(64).optional(),
  contextUsage: RuntimeContextUsageSchema.optional(),
  permissions: RuntimePermissionsSchema.optional(),
});
export type RuntimeMetadata = z.infer<typeof RuntimeMetadataSchema>;

export const SessionCatalogEntrySchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  cwd: z.string().max(4096),
  firstMessage: z.string().max(4_000).optional(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  messageCount: z.number().int().nonnegative().max(100_000),
});
export type SessionCatalogEntry = z.infer<typeof SessionCatalogEntrySchema>;

/**
 * 会话条目来源（spec §7.2 的 AgentBackend）。
 *
 * `pi` 的历史会话由 Host 直接扫磁盘（§8.1）；`codex` 走 M4 的 daemon。手机侧只按
 * agentKind 画角标，分组逻辑（以 cwd 分组）不因它分叉（§7.5）。
 */
export const AgentKindSchema = z.enum(["pi", "codex", "dsh"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * 拉起形态（spec §8.3）。结果一律随响应回执，手机不推断。
 *
 * - `tui`：明确要求在电脑上开一个可见窗口。手机要「有头」时用这一档——它不依赖
 *   Host 猜得准不准，也不需要手机去了解 Host 跑在什么会话里。
 * - `headless`：明确要求无窗口。
 * - `auto`：交给 Host 判定（历史行为）。Windows 上只能看 `SESSIONNAME` 这类启发式
 *   信号，从服务、计划任务、SSH 或 IDE 内部启动的 Host 都拿不到它，会一律降级成
 *   无头——所以「要开窗」不该走这一档。
 */
export const SpawnModeSchema = z.enum(["auto", "tui", "headless"]);
export type SpawnMode = z.infer<typeof SpawnModeSchema>;

/** 磁盘扫描出的会话 = v1 的目录条目 + agentKind。`messageCount` 磁盘扫描拿不到，恒为 0。 */
export const AgentSessionSummarySchema = SessionCatalogEntrySchema.extend({
  agentKind: AgentKindSchema,
  /**
   * 产生这条会话的 Pi 主机名（`os.hostname()`）。
   *
   * 扫盘本身拿不到主机身份：手机侧栏按主机分组，而「电脑上有、手机还没缓存过」的会话
   * 没有历史缓存里的 hostname 可继承，只能由 Host 在这里补。**必填**（ADR-0008）。
   */
  hostname: z.string().min(1).max(256),
  /** Archive state is owned by the backend, not by runtime history snapshots. */
  archived: z.boolean().optional(),
  /** Provider that owns this session; independent of the currently selected model. */
  modelProvider: z.string().min(1).max(128).optional(),
});
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;

export const BrowseEntrySchema = z.strictObject({
  name: z.string().min(1).max(255),
  isDir: z.boolean(),
  /** 这个目录下有过会话（§8.1）：手机据此把「有历史」的目录排前面。 */
  hasSessions: z.boolean(),
});
export type BrowseEntry = z.infer<typeof BrowseEntrySchema>;

const safeFileName = z.string().min(1).max(255).refine(
  (value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") &&
    [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
  "invalid file name",
);

export const RemoteArtifactSchema = z.strictObject({
  artifactId: z.string().uuid(),
  fileName: safeFileName,
  mimeType: z.string().min(1).max(128),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1).optional(),
});
export type RemoteArtifact = z.infer<typeof RemoteArtifactSchema>;

// ───────────────────────────────────────────────────────────────────────────────
// v2 Envelope —— 端到端加密报文的线格式
//
// Relay 只被允许看见这个结构里的 `hdr`。`ct` 是不透明字符串，Relay 不解析、
// 也不能改（它含 AEAD 认证标签，且 `hdr` 进了 AAD）。
//
// 本节是两端必须逐字节一致的互操作契约，改动即为协议破坏性变更。
// ───────────────────────────────────────────────────────────────────────────────

export const ENVELOPE_VERSION_V2 = 2 as const;

/**
 * `hdr.k` —— 帧种类标签。
 * `hs` 是连接握手帧：`ct` 里装的是 base64url 的**明文** JSON（只含临时公钥与
 * MAC，无秘密），因为它必须在会话密钥建立之前就能被读懂。
 * 其余三种的 `ct` 都是 AEAD 密文。
 *
 * `data` 与 `bin` 的区别只有一件事：**载荷是不是 JSON 文本**。
 * 业务消息全是 JSON，收端可以直接 UTF-8 解码；而 artifact 分片是裸字节，
 * 把它塞进 `data` 会让收端把分片当文本读，解出乱码再拿去解析 JSON——那就是
 * 「收到无效的中继服务器消息」的来源。字节流一律走 `bin`。
 *
 * `piece` 是**传输层碎片**（见 `piece.ts`）：它装的不是自己的密文，而是把某条已封好的
 * 信封的 `ct` 切开后的一截。它仍然包在 `v2.frame` 里，所以中继只按 `hdr.to` / `hdr.ch`
 * 路由与排队，既不需要重组也不需要理解它。
 */
export const EnvelopeKindSchema = z.enum(["pair", "hs", "data", "ping", "bin", "piece"]);
export type EnvelopeKind = z.infer<typeof EnvelopeKindSchema>;

/**
 * E2E 信封的逻辑 channel（spec: docs/adr/0012-receiver-driven-upload.md）。
 *
 * 存在的理由：`E2eChannel` 原本只有一个发送/接收序号，于是 1 MiB 的分片和一条 `session.sync`
 * 在协议层是**同一个序列**。分片不仅排在控制帧前面（队头阻塞），而且丢一帧会让后面所有帧
 * （含控制帧）全部卡在 `sequence_gap` 上——用户看到的就是「下载一开，聊天记录不刷新 / 消息
 * 发不出去 / 连接反复断」。
 *
 * - `ctl`：状态、命令结果、交互请求、探针。延迟敏感。
 * - `msg`：会话同步、消息增量、会话目录。体量大但仍然是交互流量。
 * - `bulk`：artifact 分片（上传与下载）。可限速，丢一帧由上层重传自愈。
 *
 * **`ch` 必填**（ADR-0008 取消了向后兼容）：不再有"不携带 `ch` = 单流"的旧对端，
 * 也不再需要握手里的 `channels` 协商。
 */
export const EnvelopeChannelSchema = z.enum(["ctl", "msg", "bulk"]);
export type EnvelopeChannel = z.infer<typeof EnvelopeChannelSchema>;

/** 握手帧不参与加密流，序号固定为 0；加密流的序号从 1 开始（§5.3）。 */
export const ENVELOPE_HANDSHAKE_SEQUENCE = 0 as const;

/**
 * 不透明标识：可打印 ASCII、不含空格与换行。
 * `canonEnvelopeAad` 用换行分隔字段，所以这个约束是 AAD 无歧义的前提。
 */
const OpaqueIdSchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/u, "must be printable ASCII without spaces");

export const RoutingHeaderV2Schema = z.strictObject({
  k: EnvelopeKindSchema,
  room: OpaqueIdSchema,
  from: OpaqueIdSchema,
  to: OpaqueIdSchema,
  n: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * 见 `EnvelopeChannelSchema`。
   *
   * **加密帧（`data`/`ping`/`bin`）必填**；握手帧（`hs`/`pair`）不带——它们不参与加密流。
   * 不存在"缺省 = 单流"的旧对端（ADR-0008），因此接收侧拿到没有 `ch` 的加密帧即协议错误。
   */
  ch: EnvelopeChannelSchema.optional(),
  /**
   * 仅片帧（`k: "piece"`）携带。见 `piece.ts`。
   *
   * - `ik`：**原信封**的 `k`（这一片属于一条 `data` 还是 `bin`）；
   * - `mid`：同一条消息的所有片共用的 id（发送方生成）；
   * - `idx`：片序号，0 起连续；
   * - `last`：末片标记（接收侧据此判断整条已收齐）。
   *
   * 它们**不参与 AAD**（`canonEnvelopeAad` 只用 k/room/from/to/ch/n）：片不被单独加密，
   * 重组出来的信封才走 AEAD，完整性只有在那一层才有意义。
   */
  ik: EnvelopeKindSchema.optional(),
  mid: OpaqueIdSchema.optional(),
  idx: z.number().int().nonnegative().max(1_000_000).optional(),
  last: z.boolean().optional(),
});
export type RoutingHeaderV2 = z.infer<typeof RoutingHeaderV2Schema>;

export const EnvelopeV2Schema = z.strictObject({
  v: z.literal(ENVELOPE_VERSION_V2),
  hdr: RoutingHeaderV2Schema,
  ct: z.string().min(1),
});
export type EnvelopeV2 = z.infer<typeof EnvelopeV2Schema>;

/**
 * AAD = canon(hdr)：UTF-8 的六行，LF 分隔，无尾随换行，每行 `字段名=值`：
 *
 *     k=data
 *     room=r1
 *     from=d1
 *     to=h1
 *     ch=ctl
 *     n=417
 *
 * 刻意**不做 JSON 序列化**：JSON 的转义规则与数字格式化在不同实现之间会漂移
 * （尤其 JVM 侧），而 AAD 只要差一个字节就解密失败。把字段名写进 AAD 还顺带
 * 保证了字段顺序或名字被改也会被发现。
 *
 * `ch` 必须进 AAD：它参与 nonce 派生（见 `envelopeNonce`），不认证它等于给
 * 「两端对 ch 的理解不一致」留一条静默通道——解密能成功、nonce 却是按另一个
 * channel 算的。
 */
export function canonEnvelopeAad(hdr: RoutingHeaderV2): Uint8Array {
  return Buffer.from(`k=${hdr.k}\nroom=${hdr.room}\nfrom=${hdr.from}\nto=${hdr.to}\nch=${hdr.ch}\nn=${hdr.n}`, "utf8");
}

/**
 * `channel` 在 nonce 前四字节里的槽位。
 *
 * nonce = uint32BE(槽位) ‖ uint64BE(n)（12 字节）。序号 `n` 按 channel 各自从 1 开始，
 * 只用 `n` 派生 nonce 会让两条 channel 的第 1 帧拿到同一个 (key, nonce) 加密不同明文
 * ——AES-GCM 在 nonce 重用下机密性与认证同时失效。槽位把不同 channel 的 nonce 空间
 * **彻底分开**：同一个 `n` 在三条道上得到三个不同的 nonce，`n` 撞车也不再撞 nonce。
 *
 * `0` 保留不用：ADR-0008 之后不存在"缺省 = 单流"的帧，见到 0 只能是实现 bug。
 */
const CHANNEL_SLOT: Record<EnvelopeChannel, number> = { ctl: 1, msg: 2, bulk: 3 };

/**
 * `nonce = 0x00000000 || uint64BE(n)` 是 v4 及以前的布局，它依赖"n 全局唯一"这个
 * 多路复用并不提供的性质（见 `CHANNEL_SLOT`）。v5 起前四字节是 channel 槽位。
 *
 * 因为 `n` 已经是 AAD 的一部分且发送侧严格递增，nonce 无需随报文传输。
 */
export function envelopeNonce(channel: EnvelopeChannel, n: number): Uint8Array {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(CHANNEL_SLOT[channel], 0);
  nonce.writeBigUInt64BE(BigInt(n), 4);
  return nonce;
}

/**
 * v2 帧的传输外层：Relay 与 Path 只搬运 `envelope`，不看里面的 `ct`。
 *
 * 路由靠 `hdr.to`：Host 发的帧 `hdr.to` 是 deviceId，手机发的帧 `hdr.to` 是
 * Host 的 runtimeId。Relay 因此不需要房间状态，也不需要理解业务。
 */
export const V2FrameSchema = z.strictObject({
  type: z.literal("v2.frame"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  envelope: EnvelopeV2Schema,
});
export type V2Frame = z.infer<typeof V2FrameSchema>;

/**
 * 承载 Envelope 的一条传输路径（spec §6.1）。
 *
 * 这个枚举同时是**用户的可见事实**：手机聊天页顶部显示的就是它（§6.2「APP 侧显示当前走的是哪条路径」）。
 * 所以取值是稳定的对外契约，不是内部实现细节。
 */
export const PathKindSchema = z.enum(["lan", "p2p", "relay"]);
export type PathKind = z.infer<typeof PathKindSchema>;

// ─── 本机发现文件（Host ↔ Pi 扩展） ────────────────────────────────────────────
//
// 它不是线协议，但它必须被 Host 与扩展**逐字段一致地**解释，所以和 v2 线契约住在一起。
// Host 启动时把这个文件写到 `~/.pi-remote/`，Pi 扩展读它来决定「走本机还是走 Relay」。
//
// `token` 的性质是**防手滑，不是安全边界**：本机任何进程本来就读得到这个文件。
// 它解决的问题是「残留的旧文件指向一个已经退出的 Host」和「一台机器上跑着两个 Host 时
// 接到了错误的那一个」——两者都会表现为「连接成功但没有会话」，比连不上更难查。

export const LOOPBACK_DESCRIPTOR_FILE = "loopback.json";
export const LOOPBACK_DESCRIPTOR_VERSION = 1;
/** loopback 端点复用 runtime 侧的路径，因为它说的就是 runtime 侧的那套消息。 */
export const LOOPBACK_PATH = "/v1/runtime";

export const LoopbackDescriptorSchema = z.strictObject({
  version: z.literal(LOOPBACK_DESCRIPTOR_VERSION),
  /** `ws://127.0.0.1:<port>`；不含路径，路径由 `LOOPBACK_PATH` 决定。 */
  url: z.string().min(1),
  token: z.string().min(1),
  hostId: z.string().min(1),
  /** 用来识别「这个文件属于哪个还在跑的进程」。 */
  pid: z.number().int().positive(),
});
export type LoopbackDescriptor = z.infer<typeof LoopbackDescriptorSchema>;

export const RemoteContentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("thinking"), text: z.string() }),
  z.strictObject({ type: z.literal("artifact"), artifact: RemoteArtifactSchema }),
  z.strictObject({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.unknown(),
  }),
]);
export type RemoteContent = z.infer<typeof RemoteContentSchema>;

export const ChatMessageSchema = z.strictObject({
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "custom", "system"]),
  content: z.array(RemoteContentSchema),
  timestamp: z.number().int().nonnegative(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const RemoteSessionEntrySchema = z.strictObject({
  entryId: z.string().min(1).max(256),
  parentId: z.string().max(256).nullable(),
  type: z.string().min(1).max(128),
  timestamp: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()),
});
export type RemoteSessionEntry = z.infer<typeof RemoteSessionEntrySchema>;

export const SessionBranchCursorSchema = z.strictObject({
  leafId: z.string().max(256).nullable(),
});
export type SessionBranchCursor = z.infer<typeof SessionBranchCursorSchema>;

export const SessionSyncRangeSchema = z.enum(["preview", "history", "catchup"]);
export type SessionSyncRange = z.infer<typeof SessionSyncRangeSchema>;
export const SessionSyncRangeStatusSchema = z.enum([
  "complete",
  "older_available",
  "leaf_not_found",
  "range_start_not_found",
  "missing_parent",
  "cycle_detected",
  "limit_reached",
]);
export type SessionSyncRangeStatus = z.infer<typeof SessionSyncRangeStatusSchema>;

export const RuntimeTurnTimingSchema = z.strictObject({
  turnId: z.string().min(1).max(256),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  turnIndex: z.number().int().nonnegative().optional(),
  messageId: z.string().min(1).max(256).optional(),
});
export type RuntimeTurnTiming = z.infer<typeof RuntimeTurnTimingSchema>;

const InteractionBaseSchema = z.strictObject({
  runtimeId: z.string().min(1),
  requestId: z.string().min(1),
  extensionId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  toolName: z.string().min(1).max(256).optional(),
  argumentSummary: z.string().max(4_000).optional(),
  externalUrl: z.url().refine((url) => /^https?:\/\//i.test(url)).optional(),
  submitted: z.boolean().optional(),
  expiresAt: z.number().int().positive(),
});

export const QuestionnaireQuestionSchema = z.strictObject({
  id: z.string().min(1).max(256),
  header: z.string().max(100).optional(),
  question: z.string().min(1).max(4_000),
  options: z.array(z.strictObject({
    value: z.string().min(1).max(256),
    label: z.string().min(1).max(512),
    description: z.string().max(4_000).optional(),
  })).max(32),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  allowNotes: z.boolean().optional(),
  secret: z.boolean().optional(),
}).refine((question) => question.options.length > 0 || question.allowOther === true, "A question needs options or free text");
export type QuestionnaireQuestion = z.infer<typeof QuestionnaireQuestionSchema>;

export const QuestionnaireAnswerSchema = z.strictObject({
  id: z.string().min(1).max(256),
  values: z.array(z.string().min(1).max(256)).max(32),
  other: z.string().max(4_000).optional(),
  notes: z.string().max(4_000).optional(),
});
export type QuestionnaireAnswer = z.infer<typeof QuestionnaireAnswerSchema>;

export const InteractionRequestSchema = z.discriminatedUnion("kind", [
  InteractionBaseSchema.extend({
    kind: z.literal("confirm"),
    confirmLabel: z.string().optional(),
    cancelLabel: z.string().optional(),
  }),
  InteractionBaseSchema.extend({
    kind: z.literal("select"),
    options: z.array(z.strictObject({ value: z.string(), label: z.string(), description: z.string().optional() })).min(1),
  }),
  InteractionBaseSchema.extend({
    kind: z.literal("multi-select"),
    options: z.array(z.strictObject({ value: z.string(), label: z.string(), description: z.string().optional() })).min(1),
    minSelections: z.number().int().nonnegative().optional(),
    maxSelections: z.number().int().positive().optional(),
  }),
  InteractionBaseSchema.extend({
    kind: z.literal("input"),
    placeholder: z.string().optional(),
    initialValue: z.string().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    secret: z.boolean().optional(),
  }),
  InteractionBaseSchema.extend({
    kind: z.literal("questionnaire"),
    questions: z.array(QuestionnaireQuestionSchema).min(1).max(16),
  }),
]);
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;

export const InteractionResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("confirm"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("select"), value: z.string() }),
  z.strictObject({ kind: z.literal("multi-select"), values: z.array(z.string()) }),
  z.strictObject({ kind: z.literal("input"), value: z.string() }),
  z.strictObject({ kind: z.literal("questionnaire"), answers: z.array(QuestionnaireAnswerSchema).min(1).max(16) }),
  z.strictObject({ kind: z.literal("cancel") }),
]);
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

export const RuntimeSlashCommandOptionSchema = z.strictObject({
  value: z.string().min(1).max(4_096),
  label: z.string().min(1).max(512),
  description: z.string().max(4_000).optional(),
  tree: z.strictObject({
    parentId: z.string().min(1).max(4_096).nullable(),
    entryType: z.string().min(1),
    role: z.string().optional(),
    label: z.string().max(512).optional(),
    defaultHidden: z.boolean(),
    isCurrent: z.boolean(),
    isOnActivePath: z.boolean(),
  }).optional(),
});
export type RuntimeSlashCommandOption = z.infer<typeof RuntimeSlashCommandOptionSchema>;

export const RuntimeSlashCommandArgumentSchema = z.strictObject({
  kind: z.enum(["text", "select", "tree"]),
  required: z.boolean(),
  hint: z.string().max(256).optional(),
  options: z.array(RuntimeSlashCommandOptionSchema).optional(),
});
export type RuntimeSlashCommandArgument = z.infer<typeof RuntimeSlashCommandArgumentSchema>;

export const RuntimeSlashCommandNameSchema = z.string().min(1).max(256).regex(/^[^\s/]+$/u);

export const RuntimeSlashCommandSchema = z.strictObject({
  name: RuntimeSlashCommandNameSchema,
  description: z.string().max(4_000).optional(),
  source: z.enum(["builtin", "extension", "prompt", "skill", "mcp"]),
  argument: RuntimeSlashCommandArgumentSchema.optional(),
});
export type RuntimeSlashCommand = z.infer<typeof RuntimeSlashCommandSchema>;

// `messageAttachments` 能力位已删（ADR-0008）：附件现在是无条件支持的，不再需要声明。
export const RuntimeCapabilitiesSchema = z.strictObject({
  commands: z.array(RuntimeSlashCommandSchema),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export const RuntimeCommandStatusSchema = z.enum(["pending", "success", "failure", "cancelled", "not_cancelable", "already_delivered", "message_id_conflict"]);
export type RuntimeCommandStatus = z.infer<typeof RuntimeCommandStatusSchema>;

/**
 * 手机请求型下载的传输模式。
 *
 * 下载只有一个模式：**接收方驱动的范围下载**（ADR-0005）：发起方的 `offset` 就是进度，
 * 所以没有、也不需要 ACK。`stream` + `artifact.ack` 那条旧路径已删除（ADR-0008）。
 */

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("runtime.status"), status: RuntimeStatusSchema }),
  z.strictObject({ type: z.literal("runtime.metadata"), metadata: RuntimeMetadataSchema }),
  z.strictObject({ type: z.literal("runtime.capabilities"), capabilities: RuntimeCapabilitiesSchema }),
  z.strictObject({
    type: z.literal("session.catalog"),
    sessions: z.array(SessionCatalogEntrySchema).max(100_000),
  }),
  z.strictObject({
    type: z.literal("message.queued"),
    queueId: z.string().min(1),
    text: z.string().min(1),
    delivery: z.enum(["steer", "followUp"]),
    state: z.enum(["accepted", "delivered", "cancelled", "rejected", "not_cancelable"]),
    error: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("session.snapshot"),
    sessionId: z.string().min(1).max(256),
    syncId: z.string().min(1).max(256),
    cursor: SessionBranchCursorSchema,
    mode: z.enum(["replace", "append", "prepend"]),
    entries: z.array(RemoteSessionEntrySchema),
    turnTimings: z.array(RuntimeTurnTimingSchema).optional(),
    range: SessionSyncRangeSchema.optional(),
    targetLeafId: z.string().max(256).nullable().optional(),
    beforeEntryId: z.string().max(256).nullable().optional(),
    hasOlder: z.boolean().optional(),
    complete: z.boolean().optional(),
    rangeStatus: SessionSyncRangeStatusSchema.optional(),
  }),
  z.strictObject({ type: z.literal("message.started"), message: ChatMessageSchema, queueId: z.string().min(1).optional() }),
  z.strictObject({
    type: z.literal("message.delta"),
    messageId: z.string(),
    contentType: z.enum(["text", "thinking", "tool_call"]).optional(),
    contentIndex: z.number().int().nonnegative().optional(),
    delta: z.string(),
  }),
  z.strictObject({ type: z.literal("message.finished"), message: ChatMessageSchema, queueId: z.string().min(1).optional() }),
  z.strictObject({
    type: z.literal("turn.started"),
    turnId: z.string().min(1).max(256),
    startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    turnIndex: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("turn.finished"),
    turnId: z.string().min(1).max(256),
    startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    turnIndex: z.number().int().nonnegative().optional(),
    messageId: z.string().min(1).max(256).optional(),
    persistedMessageId: z.string().min(1).max(256).optional(),
    /**
     * Authoritative mapping from the temporary id the Runtime streamed to the Pi session entry id
     * assigned when the message was persisted. Only the Runtime can resolve this: Pi allocates the
     * entry id after `message_end`, so a device would have to guess by matching message content.
     * Covers every message persisted by this turn (user, assistant and tool results).
     */
    persistedMessages: z.array(z.strictObject({
      messageId: z.string().min(1).max(256),
      entryId: z.string().min(1).max(256),
    })).optional(),
  }),
  z.strictObject({ type: z.literal("tool.started"), toolCallId: z.string(), toolName: z.string(), arguments: z.unknown() }),
  z.strictObject({ type: z.literal("tool.updated"), toolCallId: z.string(), toolName: z.string(), partialResult: z.unknown() }),
  z.strictObject({ type: z.literal("tool.finished"), toolCallId: z.string(), toolName: z.string(), result: z.unknown(), isError: z.boolean() }),
  z.strictObject({ type: z.literal("interaction.requested"), request: InteractionRequestSchema }),
  z.strictObject({ type: z.literal("interaction.snapshot"), requests: z.array(InteractionRequestSchema).max(64) }),
  z.strictObject({ type: z.literal("interaction.resolved"), requestId: z.string(), source: z.enum(["local", "remote"]) }),
  z.strictObject({ type: z.literal("interaction.cancelled"), requestId: z.string(), reason: z.enum(["cancelled", "timeout", "disconnected", "owner_closed"]) }),
  z.strictObject({ type: z.literal("local_interaction.required"), kind: z.string(), title: z.string().optional() }),
  z.strictObject({
    type: z.literal("command.result"),
    commandId: z.string(),
    ok: z.boolean(),
    status: RuntimeCommandStatusSchema.optional(),
    error: z.string().optional(),
    result: z.unknown().optional(),
  }),
  z.strictObject({
    type: z.literal("artifact.started"),
    commandId: z.string().min(1),
    transferId: TransferIdSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    artifact: RemoteArtifactSchema,
  }),
  z.strictObject({
    type: z.literal("artifact.failed"),
    artifactId: z.string().uuid(),
    transferId: TransferIdSchema,
    error: z.string().min(1),
  }),
  z.strictObject({ type: z.literal("runtime.error"), message: z.string(), recoverable: z.boolean(), commandId: z.string().min(1).max(256).optional() }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

const downloadOffset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();

export const RuntimeCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file.download"), path: z.string().min(1), offset: downloadOffset }),
  z.strictObject({ type: z.literal("artifact.download"), artifactId: z.string().uuid(), offset: downloadOffset }),
  z.strictObject({
    type: z.literal("artifact.cancel"),
    transferId: TransferIdSchema,
    reason: z.string().max(256).optional(),
  }),
  z.strictObject({
    type: z.literal("session.sync"),
    sessionId: z.string().min(1).max(256),
    syncId: z.string().min(1).max(256),
    /** Omitted when the device has no graph; otherwise this is its current leaf. */
    knownLeafId: z.string().max(256).nullable().optional(),
    targetLeafId: z.string().max(256).nullable().optional(),
    beforeEntryId: z.string().max(256).nullable().optional(),
    maxEntries: z.number().int().positive().max(2_000).optional(),
    range: SessionSyncRangeSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("user_message"),
    text: z.string().min(1).max(100_000)
      .refine((text) => !text.trimStart().startsWith("/"), "slash commands require slash.execute"),
    messageId: z.string().min(1).max(256).optional(),
    delivery: z.enum(["steer", "followUp"]).optional(),
    /**
     * 已落地的附件：**只是电脑上的绝对路径**，没有别的。
     *
     * 不做描述符（fileName/size/sha256）、不做图片嗅探、不做 content parts：附件唯一的
     * 用途就是让 agent 知道「这个文件在这里」，它自己的工具能读。手机把路径拼进消息正文
     * 也能达到同样效果，保留独立字段是为了手机端 UI 与以后的可能扩展——不需要时它就是空的。
     */
    attachments: z.array(z.string().min(1).max(4096)).max(MAX_MESSAGE_ATTACHMENTS).optional(),
  }),
  z.strictObject({
    type: z.literal("user_message.cancel"),
    messageId: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal("slash.execute"),
    name: RuntimeSlashCommandNameSchema,
    args: z.string().max(100_000),
  }),
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({
    type: z.literal("interaction.respond"),
    requestId: z.string().min(1),
    extensionId: z.string().min(1),
    response: InteractionResponseSchema,
  }),
]);
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;

export const RuntimeClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("runtime.authenticate"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    credential: z.string().min(1),
    /** 见 `RuntimeRoleSchema`：必填（ADR-0008）。 */
    role: RuntimeRoleSchema,
    runtime: RuntimeMetadataSchema,
  }),
  z.strictObject({
    type: z.literal("runtime.event"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runtimeId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    event: RuntimeEventSchema,
  }),
  V2FrameSchema,
]);
export type RuntimeClientMessage = z.infer<typeof RuntimeClientMessageSchema>;

/**
 * loopback 端点收到的消息。
 *
 * 以前还有一个不注册的 `loopback.ping` 探测（用于"走 loopback 还是回落到中继"的选择）；
 * 回退路径删掉后探测也失去了存在理由（没有可回退的目标，“等 Host” 就是正确行为）。
 *
 * 注意：这里的 `runtime.event` 是**扩展 → Host** 的本机明文事件，与中继无关。
 */
export const LoopbackInboundSchema = RuntimeClientMessageSchema;
export type LoopbackInbound = z.infer<typeof LoopbackInboundSchema>;
export const DeviceClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("device.authenticate"), protocolVersion: z.literal(PROTOCOL_VERSION), credential: z.string().min(1) }),
  V2FrameSchema,
]);
export type DeviceClientMessage = z.infer<typeof DeviceClientMessageSchema>;

/**
 * E2E `data` 载荷里允许出现的消息（spec §5.2 / §8）。
 *
 * 与 `DeviceClientMessage` 分开：后者是 Relay 看得见的**明文**设备消息，而现在那里
 * 只剩 `device.authenticate` 与 v2 帧——命令只存在于 E2E 密文里（ADR-0008）。
 */
export const DeviceE2ePayloadSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("runtime.command"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runtimeId: z.string().min(1),
    commandId: z.string().min(1),
    command: RuntimeCommandSchema,
  }),
  // ── 进程激活（spec §8）。请求/响应都用 requestId 关联；失败走 protocol.error 并带回 requestId。
  z.strictObject({ type: z.literal("session.list"), protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string().min(1).max(128) }),
  z.strictObject({
    type: z.literal("session.archive"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(128),
    agentKind: AgentKindSchema,
    sessionId: z.string().min(1).max(256),
    archived: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("session.browse"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(128),
    /** 为空返回盘符 / 根；否则返回该目录的子目录与父目录。手机逐层下钻（§8.1）。 */
    path: z.string().max(4096).optional(),
  }),
  z.strictObject({
    type: z.literal("session.activate"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(128),
    /** L1 = 继续已有会话（cwd 来自会话记录）；L2 = 在指定目录新建（cwd 由手机选，§8.1）。 */
    target: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("resume"), sessionId: z.string().min(1).max(256) }),
      z.strictObject({ type: z.literal("new"), agentKind: AgentKindSchema, cwd: z.string().min(1).max(4096) }),
    ]),
    spawnMode: SpawnModeSchema.optional(),
  }),
  // ── P2P 信令（spec §6.1 / M5）。SDP 里已经烧好 ICE 候选（gather 完再发，非 trickle）：
  // 信令只发生在建立连接时，不值得为省一两个包引入 candidate 增量消息。
  // 手机请求 → Host 出 offer → 手机回 answer。全部走 E2E data 帧，Relay 零改动。
  z.strictObject({ type: z.literal("p2p.request"), protocolVersion: z.literal(PROTOCOL_VERSION) }),
  z.strictObject({
    type: z.literal("p2p.offer"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    /** WebRTC session description（offer），ICE 候选已 gather 完毕。 */
    sdp: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    type: z.literal("p2p.answer"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    /** WebRTC session description（answer），ICE 候选已 gather 完毕。 */
    sdp: z.string().min(1).max(16_384),
  }),
  // ── 接收方驱动的范围下载（ADR-0005）。设备发 read 索取一段，Host 只按范围应答：
  // 请求与响应都是 E2E 载荷（Relay 只按 hdr.to 路由，看不到 offset/长度），
  // 分片沿用既有 `bin` 帧。发送方不维护窗口/重传/进度，全部状态在设备侧。
  z.strictObject({
    type: z.literal("artifact.read"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    transferId: TransferIdSchema,
    requestId: z.string().min(1).max(128),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** 一个请求对应恰好一个 chunk；长度由设备决定，Host 不做窗口判断。 */
    length: z.number().int().positive().max(ARTIFACT_CHUNK_BYTES),
  }),
  /** 设备已完成并校验通过：Host 据此释放 transfer 上下文（完成判定在接收方，见 ADR-0005）。 */
  z.strictObject({
    type: z.literal("artifact.done"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    transferId: TransferIdSchema,
  }),
  // ── 手机上传文件到电脑（spec: docs/adr/0012-receiver-driven-upload.md）。与下载同构：**接收方驱动**
  // （ADR-0012）。Host 是接收方，持有 .part 与持久前缀，由它按 durableBytes 主动拉取；
  // 手机只是「文件在哪」的 advertise 方 + 读请求的服务方。批量字节走既有的 `bin` 分片帧
  // （`transferId` = `uploadId`），不新增帧格式。
  z.strictObject({
    type: z.literal("file.upload.init"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(128),
    /** 只是「这条上传属于哪个会话」的标注，不参与落地路径。 */
    runtimeId: z.string().min(1).max(256),
    /** 手机算好的**绝对**目录（`<cwd>/.pi-remote-uploads/<sha256>`）；不存在则创建。 */
    directory: z.string().min(1).max(4096),
    fileName: safeFileName,
    size: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
    sha256: z.string().regex(HASH_PATTERN),
    mimeType: z.string().max(255).optional(),
  }),
  z.strictObject({
    type: z.literal("file.upload.cancel"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    uploadId: TransferIdSchema,
  }),
]);
export type DeviceE2ePayload = z.infer<typeof DeviceE2ePayloadSchema>;

export const RelayToDeviceMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("device.ready"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    deviceId: z.string(),
    runtimes: z.array(RuntimeMetadataSchema),
    /**
     * 这台电脑支持的 agent 种类（spec §8.4）。
     *
     * `null` 表示**这条消息的发送方不知道**：中继在 `device.authenticate` 之后也会回一条同名
     * `device.ready`（那份 `runtimes` 只是种子，而中继根本不知道电脑装没装 codex）。
     * 权威答案只能由 Host 给，所以它的 `device.ready` 必须是数组。
     *
     * 这不是兼容位：`null` 与“空数组”含义不同——空数组是“一台都不支持”，
     * 而 `null` 是“不知道”，手机后者不对能力做限制。
     */
    agents: z.array(AgentKindSchema).nullable(),
  }),
  // P2P 信令（M5）：Host→设备方向的 offer。与 DeviceE2ePayload 里的 request/answer 成对，
  // SDP 里已烧好全部 ICE 候选（非 trickle）。
  z.strictObject({
    type: z.literal("p2p.offer"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    sdp: z.string().min(1).max(16_384),
  }),
  /**
   * 当前生效的传输路径（spec §6.2 / §14 B4）。
   *
   * 由 Host 单方面宣布而不是双方协商：路径的可用性只有 Host 这一侧看得全（它同时握着
   * Relay 长连接和 LAN 监听），手机只需要跟着切。`rttMs` 只为显示，不参与任何决策。
   */
  z.strictObject({
    type: z.literal("device.path"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    path: PathKindSchema,
    rttMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({ type: z.literal("runtime.online"), runtime: RuntimeMetadataSchema }),
  z.strictObject({ type: z.literal("runtime.offline"), runtimeId: z.string(), reason: z.string() }),
  /** Host 服务不了这次范围请求：读盘失败、越界、或 artifact 身份在传输中变了。 */
  z.strictObject({
    type: z.literal("artifact.read.failed"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    transferId: TransferIdSchema,
    requestId: z.string().min(1).max(128),
    reason: z.string().min(1).max(256),
  }),
  // ── 上传（spec: 手机上传文件到电脑）的 Host 侧应答。
  /** 接受这次上传。`receivedBytes > 0` 表示命中了同一份 `.part`，续传从那里开始。 */
  z.strictObject({
    type: z.literal("file.upload.ready"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(128),
    uploadId: TransferIdSchema,
    chunkSize: z.number().int().positive().max(ARTIFACT_CHUNK_BYTES),
    receivedBytes: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
  }),
  /** 接收方驱动（ADR-0012）：Host 按自己的持久前缀要一块数据，手机只应答不推送。 */
  z.strictObject({
    type: z.literal("file.upload.read"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    uploadId: TransferIdSchema,
    offset: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
    length: z.number().int().positive().max(ARTIFACT_CHUNK_BYTES),
  }),
  /**
   * 持久前缀推进了。纯 UI 进度事件：chip 的百分比来源。
   *
   * 流控不需要它——Host 是拉取方，节奏天然自控；没有它传输也成立。
   */
  z.strictObject({
    type: z.literal("file.upload.progress"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    uploadId: TransferIdSchema,
    receivedBytes: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
  }),
  /** 只在 Host 自己算完 sha256 之后才发。 */
  z.strictObject({
    type: z.literal("file.upload.finished"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    uploadId: TransferIdSchema,
    path: z.string().min(1).max(4096),
    fileName: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
    sha256: z.string().regex(HASH_PATTERN),
    mimeType: z.string().max(255).optional(),
  }),
  z.strictObject({
    type: z.literal("file.upload.failed"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(128).optional(),
    uploadId: TransferIdSchema.optional(),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  }),
  // Host 网关（role=host）的上/下线。它不是进程，不进 runtime.online/offline 广播
  // （见 relay 的 role 过滤），但手机必须知道它换了进程：手机只在自家 socket.open 时发
  // HS1，Host 重启后手机的 WS 还开着、不重握手的话，Host 侧握手永远 not_ready——
  // UI 显示「已连接」而所有请求石沉大海。hostId 供手机过滤（广播发给所有设备）。
  z.strictObject({ type: z.literal("host.online"), hostId: z.string().min(1) }),
  z.strictObject({ type: z.literal("host.offline"), hostId: z.string().min(1), reason: z.string().optional() }),
  z.strictObject({ type: z.literal("runtime.event"), protocolVersion: z.literal(PROTOCOL_VERSION), runtimeId: z.string(), sequence: z.number().int().nonnegative(), event: RuntimeEventSchema }),
  // ── 进程激活（spec §8）的响应。`session.activated` 只证明进程已被拉起；会话真正上线
  // 由随后的 runtime.online / session.catalog 对账（进程经 loopback 自己注册回来）。
  z.strictObject({
    type: z.literal("session.archive.changed"),
    requestId: z.string().min(1).max(128).optional(),
    agentKind: AgentKindSchema,
    sessionId: z.string().min(1).max(256),
    archived: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("session.list.result"),
    requestId: z.string().min(1).max(128),
    sessions: z.array(AgentSessionSummarySchema).max(2_000),
    /** Backend configuration, including when the backend has no sessions. */
    currentProviders: z.array(z.strictObject({
      agentKind: AgentKindSchema,
      provider: z.string().min(1).max(128),
    })).max(2).optional(),
  }),
  z.strictObject({
    type: z.literal("session.browse.result"),
    requestId: z.string().min(1).max(128),
    path: z.string().max(4096),
    parent: z.string().max(4096).optional(),
    entries: z.array(BrowseEntrySchema).max(1_000),
  }),
  z.strictObject({
    type: z.literal("session.activated"),
    requestId: z.string().min(1).max(128),
    agentKind: AgentKindSchema,
    /** L2 新建时 Host 生成的新会话 id，手机后续拿它对账 runtime.online。 */
    sessionId: z.string().min(1).max(256).optional(),
    /** 实际生效的拉起形态（auto 降级后是 "headless"，手机据此标注「此会话无头」，§8.3）。 */
    spawnMode: z.enum(["tui", "headless"]),
    pid: z.number().int().positive().optional(),
  }),
  z.strictObject({ type: z.literal("protocol.error"), code: z.string(), message: z.string(), commandId: z.string().optional(), requestId: z.string().max(128).optional() }),
  V2FrameSchema,
]);
export type RelayToDeviceMessage = z.infer<typeof RelayToDeviceMessageSchema>;
export const RelayToRuntimeMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    // `features` 已删（ADR-0008）：它唯一的作用是宣告中继不会 strip `hdr.ch`，
    // 而仓库里从来没有代码读它。
    type: z.literal("runtime.ready"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runtimeId: z.string(),
  }),
  z.strictObject({ type: z.literal("runtime.resync"), runtimeId: z.string(), reason: z.string() }),
  // Host → runtime 的命令。**它不是 v1 兼容路径**：本机 Host 就是通过 loopback
  // （`LoopbackHostTransport` 继承 `RelayRuntimeTransport`，共用这份 schema）把手机的命令
  // 投给扩展的，而中继不再代传命令（命令只能走 E2E 密文）。
  z.strictObject({ type: z.literal("runtime.command"), protocolVersion: z.literal(PROTOCOL_VERSION), runtimeId: z.string(), commandId: z.string(), command: RuntimeCommandSchema }),
  // `transferId` 只在下载路由被中继丢弃/背压时带上：它让 Host 能立刻以确定的原因终止
  // 那一次传输并让手机带偏移重试，而不是空等 ack 超时、重传再被静默丢弃。
  z.strictObject({
    type: z.literal("protocol.error"),
    code: z.string(),
    message: z.string(),
    commandId: z.string().optional(),
    transferId: TransferIdSchema.optional(),
    /**
     * 转发被回绝时寻址的那台设备。v2 帧的载荷是端到端加密的，中继只看得到 `hdr.to`，
     * 所以 `device_offline` 的受方只能从它知道是谁不在了；没有它，Host 只能对着黑洞重传分片。
     */
    targetDeviceId: z.string().min(1).max(256).optional(),
  }),
  V2FrameSchema,
]);
export type RelayToRuntimeMessage = z.infer<typeof RelayToRuntimeMessageSchema>;

export function decodeJson(value: unknown): unknown {
  const text = typeof value === "string"
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value).toString("utf8")
      : String(value);
  return JSON.parse(text) as unknown;
}

/**
 * 出站逻辑多路复用（见该模块头注）。
 *
 * `hdr.ch` 只管序号：不管信封上写着哪个 channel，帧最终都要依次写进同一个 socket，
 * 所以「控制帧排在分片后面」这件事必须在**写 socket 之前**解决——让分片排队、控制插队。
 */
export * from "./outbound-mux.js";

/**
 * 写入层切片（见该模块头注）。
 *
 * 它与 `outbound-mux` 是同一个问题的两半：多路复用器决定「谁先走」，切片决定「一件有多大」
 * ——只有一件远小于水位时，水位才真的是个节拍器。
 */
export * from "./piece.js";

export * from "./session-sync.js";
