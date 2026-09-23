/**
 * Host 侧的 artifact 下载（spec §8.1）。
 *
 * 为什么是 Host 来服务：文件在这台机器的磁盘上，而 Host 常驻。正在跑的那个 Pi 进程
 * 只是「谁产生过这个文件」的记录者——它退出不等于文件不能下载。所以手机发来的
 * `file.download` / `artifact.download` 由 Host 就地读盘，按设备的范围请求应答。
 *
 * **只有一种传输模式：接收方驱动的范围下载（ADR-0005）。** 旧的 `stream`（16 帧滑窗 + 累计
 * ack）已删（ADR-0008）：它需要发送方持有窗口与重传定时器，而进度真相在接收方的磁盘上。
 */
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import {
  ARTIFACT_CHUNK_BYTES,
  PROTOCOL_VERSION,
  encodeArtifactChunkFrame,
  type RelayToDeviceMessage,
  type RemoteArtifact,
  type RuntimeCommand,
  type RuntimeEvent,
} from "@pi-remote/protocol";

/** 同时在跑的下载条数上限。这是防手滑，不是安全边界。 */
const DEFAULT_MAX_CONCURRENT = 4;
/** 索引里最多留多少个 artifact（超出按最久未见淘汰）。 */
const MAX_INDEX_ENTRIES = 500;
/** pull 传输多久没有任何 `artifact.read` 就回收（手机静默消失时的兜底）。 */
const PULL_IDLE_TIMEOUT_MS = 60_000;

type DownloadCommand = Extract<RuntimeCommand, { type: "file.download" | "artifact.download" }>;

export type HostDownloadServiceOptions = {
  /** 一条 `runtime.event` 发给某台设备。序号由调用方（Host）补齐。 */
  publishEvent: (deviceId: string, runtimeId: string, event: RuntimeEvent) => void;
  /** 一条 Host→设备的 E2E 控制载荷（不经 `runtime.event`，没有序号）。 */
  publishMessage?: (deviceId: string, message: RelayToDeviceMessage) => void;
  /** 一片 artifact 二进制帧发给某台设备。 */
  publishBinary: (deviceId: string, frame: Uint8Array) => void;
  /** artifact 索引落盘位置（`<stateDir>/artifacts.json`）。 */
  indexPath: string;
  log?: (line: string) => void;
  maxConcurrent?: number;
};

type IndexedArtifact = RemoteArtifact & { runtimeId: string; seenAt: number };

/** `RemoteArtifact.path` 是可选的，但 Host 服务下载的前提就是已解析出真实路径。 */
type ResolvedArtifact = RemoteArtifact & { path: string };

/**
 * 一条 receiver-driven 的范围下载（ADR-0005）。
 *
 * 刻意只留这五个字段：没有窗口、没有 ack、没有重试计数、不持文件句柄。
 * 每次 `artifact.read` 现场打开文件按范围读一段——一 MiB 的 I/O 面前，一次 open 的开销
 * 可以忽略，换来的是「设备静默消失绝不会漏一个 fd」。
 */
type ActivePull = {
  deviceId: string;
  runtimeId: string;
  commandId: string;
  transferId: string;
  artifact: ResolvedArtifact;
  startOffset: number;
  cancelled: boolean;
  lastActivityAt: number;
  /** 已服务的范围请求数（含重传），用来在完成日志里说清「传了多少次」。 */
  reads: number;
  startedAt: number;
};

type CommandRecord = {
  transferId: string | undefined;
  terminal: boolean;
};

const MIME_TYPES: Record<string, string> = {
  ".apk": "application/vnd.android.package-archive",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

/**
 * 把任意路径的 basename 洗成手机侧能接受的文件名
 * （不能含路径分隔符与控制字符——`RemoteArtifactSchema.fileName` 要求）。
 */
function safeDownloadFileName(path: string): string {
  const source = basename(path);
  let safe = "";
  for (const character of source) {
    const code = character.charCodeAt(0);
    const next = character === "/" || character === "\\" || code < 0x20 || code === 0x7f ? "_" : character;
    if (safe.length + next.length > 255) break;
    safe += next;
  }
  if (safe === "" || safe === "." || safe === "..") return "download";
  return safe;
}

async function sha256File(path: string, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(ARTIFACT_CHUNK_BYTES);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (result.bytesRead === 0) throw new Error("artifact_size_mismatch");
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}


/**
 * 读一段连续字节。短读（文件被换掉/截断）返回 `undefined`——由调用方回 `read.failed`，
 * 而不是把一段比请求短的字节当成成功发给设备。
 */
async function readRange(path: string, offset: number, length: number): Promise<Uint8Array | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const result = await handle.read(buffer, filled, length - filled, offset + filled);
      if (result.bytesRead === 0) break;
      filled += result.bytesRead;
    }
    return filled === length ? new Uint8Array(buffer) : undefined;
  } finally {
    await handle.close();
  }
}

export class HostDownloadService {
  readonly #options: HostDownloadServiceOptions;
  readonly #pulls = new Map<string, ActivePull>();
  readonly #commands = new Map<string, CommandRecord>();
  /** artifactId → 元数据（含 path）。来源是各个 runtime 上报的 `artifact.started`。 */
  readonly #index = new Map<string, IndexedArtifact>();
  #indexWriteChain: Promise<void> = Promise.resolve();

  constructor(options: HostDownloadServiceOptions) {
    this.#options = options;
  }

  /** 从盘上恢复索引：Host 重启后，老会话里的 artifact 仍然能下载。 */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#options.indexPath, "utf8")) as {
        version?: unknown;
        artifacts?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.artifacts)) return;
      for (const entry of parsed.artifacts) {
        const artifact = entry as Partial<IndexedArtifact>;
        if (typeof artifact.artifactId !== "string" || typeof artifact.path !== "string") continue;
        if (typeof artifact.size !== "number" || typeof artifact.sha256 !== "string") continue;
        if (typeof artifact.fileName !== "string" || typeof artifact.mimeType !== "string") continue;
        this.#index.set(artifact.artifactId, {
          artifactId: artifact.artifactId,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          sha256: artifact.sha256,
          path: artifact.path,
          runtimeId: typeof artifact.runtimeId === "string" ? artifact.runtimeId : "",
          seenAt: typeof artifact.seenAt === "number" ? artifact.seenAt : 0,
        });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.#options.log?.(`artifact 索引读取失败（按空索引继续）：${describe(error)}`);
      }
    }
  }

  /**
   * 记下一条 artifact 元数据。
   *
   * 调用方在事件转发路径上，所以这里只做记账 + 落盘。没有 `path` 的 artifact
   * （老版本 Pi 上报的）记下来也没用——那种只能回落到 runtime 自己去解析。
   */
  noteArtifact(runtimeId: string, artifact: RemoteArtifact): void {
    if (typeof artifact.path !== "string" || artifact.path === "") return;
    const previous = this.#index.get(artifact.artifactId);
    this.#index.set(artifact.artifactId, { ...artifact, runtimeId, seenAt: Date.now() });
    while (this.#index.size > MAX_INDEX_ENTRIES) {
      const oldest = [...this.#index.values()].sort((a, b) => a.seenAt - b.seenAt)[0];
      if (oldest === undefined) break;
      this.#index.delete(oldest.artifactId);
    }
    // 路径变了（同名 artifactId 不该发生，但真变了就得重写索引）。
    if (previous?.path !== artifact.path) this.#persistIndex();
  }

  /**
   * 由 Host 服务一条下载命令（spec §9.4：下载是 Host→APP，Host 是唯一服务方）。
   *
   * 拿下来了返回 `true` 并开始分片；服务不了（索引里没有、文件不在、偏移不合法、
   * 并发已满）返回 `false`，并给设备回一条 `artifact.failed`——**不再回落给某个
   * runtime**：下载这条路上 Host 就是权威，它读不到这个文件就是读不到，报「进程不在线」
   * 只会把排查方向带偏。
   */
  async offerDownload(
    deviceId: string,
    runtimeId: string,
    commandId: string,
    command: DownloadCommand,
  ): Promise<boolean> {
    const known = this.#commands.get(commandId);
    if (known !== undefined) {
      // 同一条命令重发（手机重连后重放）：把还活着的那次重新宣告一遍，不再开第二条。
      const existingPull = known.transferId === undefined ? undefined : this.#pulls.get(known.transferId);
      if (existingPull !== undefined) {
        this.#publishPullStarted(existingPull);
        return true;
      }
      if (!known.terminal) return true;
    }
    this.#sweepIdlePulls(Date.now());
    const max = this.#options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (this.#pulls.size >= max) {
      this.#options.log?.(`下载已达上限（${max}），拒绝 ${commandId}`);
      this.#failDownload(deviceId, runtimeId, commandId, "下载任务已达上限，请稍后重试");
      this.#commands.set(commandId, { transferId: undefined, terminal: true });
      this.#trimCommands();
      return false;
    }
    const artifact = await this.#resolve(command);
    if (artifact === undefined) {
      this.#options.log?.(`Host 无法读取下载目标：${command.type === "artifact.download" ? command.artifactId : command.path}`);
      this.#failDownload(deviceId, runtimeId, commandId, "电脑上找不到这个文件");
      this.#commands.set(commandId, { transferId: undefined, terminal: true });
      this.#trimCommands();
      return false;
    }
    const requestedOffset = command.offset ?? 0;
    if (requestedOffset < 0 || requestedOffset > artifact.size) {
      this.#failDownload(deviceId, runtimeId, commandId, "下载起点无效");
      this.#commands.set(commandId, { transferId: undefined, terminal: true });
      this.#trimCommands();
      return false;
    }
    const transferId = randomUUID();
    const active: ActivePull = {
      deviceId,
      runtimeId,
      commandId,
      transferId,
      artifact,
      startOffset: requestedOffset,
      cancelled: false,
      lastActivityAt: Date.now(),
      reads: 0,
      startedAt: Date.now(),
    };
    this.#pulls.set(transferId, active);
    this.#commands.set(commandId, { transferId, terminal: false });
    this.#trimCommands();
    this.#publishPullStarted(active);
    this.#options.log?.(
      `下载由 Host 服务：${artifact.fileName}（${artifact.size} 字节，从 ${requestedOffset} 开始）`,
    );
    return true;
  }

  /**
   * 一次 `artifact.read`：按范围读盘并回一个分片帧。
   *
   * 幂等：重复到达就重读重发，不做「发过没发过」的记忆。读盘期间传输被取消/回收时
   * 直接丢弃结果，不再发帧。
   */
  async handleRead(
    deviceId: string,
    request: { transferId: string; requestId: string; offset: number; length: number },
  ): Promise<void> {
    const active = this.#pulls.get(request.transferId);
    if (active === undefined || active.cancelled) {
      // 未知 transfer：Host 重启过、或这条传输已被回收/删除。必须**明确回绝**，
      // 否则设备会对着一个永远不存在的传输重传到天荒地老（旧流式模型里这叫 ack 黑洞）。
      this.#options.publishMessage?.(deviceId, {
        type: "artifact.read.failed",
        protocolVersion: PROTOCOL_VERSION,
        transferId: request.transferId,
        requestId: request.requestId,
        reason: "unknown_transfer",
      });
      return;
    }
    if (active.deviceId !== deviceId) return;
    active.lastActivityAt = Date.now();
    const end = request.offset + request.length;
    if (request.length < 1 || request.length > ARTIFACT_CHUNK_BYTES || end > active.artifact.size) {
      this.#publishReadFailed(active, request.requestId, "range_out_of_bounds");
      return;
    }
    const data = await readRange(active.artifact.path, request.offset, request.length).catch(() => undefined);
    // 读盘期间可能被取消/回收/换设备：结果作废，不发帧。
    if (this.#pulls.get(request.transferId) !== active || active.cancelled) return;
    if (data === undefined) {
      this.#publishReadFailed(active, request.requestId, "read_failed");
      return;
    }
    active.reads += 1;
    this.#options.publishBinary(active.deviceId, encodeArtifactChunkFrame({
      runtimeId: active.runtimeId,
      transferId: active.transferId,
      offset: request.offset,
      data,
    }));
  }

  /** 设备声明已完成（已校验 sha256 并发布）：释放该条 pull 的上下文。 */
  handleDone(deviceId: string, transferId: string): boolean {
    const active = this.#pulls.get(transferId);
    if (active === undefined || active.deviceId !== deviceId) return false;
    this.#pulls.delete(transferId);
    this.#commands.set(active.commandId, { transferId, terminal: true });
    this.#trimCommands();
    this.#options.log?.(
      `下载完成（pull）：${active.artifact.fileName} ${active.artifact.size} 字节，` +
      `${active.reads} 次范围请求，${Date.now() - active.startedAt}ms`,
    );
    return true;
  }

  #publishReadFailed(active: ActivePull, requestId: string, reason: string): void {
    this.#options.publishMessage?.(active.deviceId, {
      type: "artifact.read.failed",
      protocolVersion: PROTOCOL_VERSION,
      transferId: active.transferId,
      requestId,
      reason,
    });
  }

  #publishPullStarted(active: ActivePull): void {
    this.#options.publishEvent(active.deviceId, active.runtimeId, {
      type: "artifact.started",
      commandId: active.commandId,
      transferId: active.transferId,
      offset: active.startOffset,
      artifact: {
        artifactId: active.artifact.artifactId,
        fileName: active.artifact.fileName,
        mimeType: active.artifact.mimeType,
        size: active.artifact.size,
        sha256: active.artifact.sha256,
        ...(active.artifact.path === undefined ? {} : { path: active.artifact.path }),
      },
    });
  }

  /** 手机静默消失时回收 pull 上下文（不持资源，只是别让它占着并发名额）。 */
  #sweepIdlePulls(now: number): void {
    for (const [transferId, active] of [...this.#pulls]) {
      if (now - active.lastActivityAt <= PULL_IDLE_TIMEOUT_MS) continue;
      this.#pulls.delete(transferId);
      this.#commands.set(active.commandId, { transferId, terminal: true });
    }
  }

  /**
   * Host 服务不了这条下载：回一条失败的 `command.result`（手机按 pendingDownloads
   * 里的 commandId 把对应任务标失败）。**不用 `artifact.failed`**——那个事件要求
   * artifactId/transferId，而这里连传输都还没建立起来。
   */
  #failDownload(deviceId: string, runtimeId: string, commandId: string, error: string): void {
    this.#options.publishEvent(deviceId, runtimeId, {
      type: "command.result",
      commandId,
      ok: false,
      status: "failure",
      error,
    });
  }

  /** `artifact.cancel` 终止一条 pull。下载没有 ack：发起方的 `offset` 就是进度。 */
  handleTransferControl(deviceId: string, runtimeId: string, command: RuntimeCommand): boolean {
    if (command.type !== "artifact.cancel") return false;
    const pull = this.#pulls.get(command.transferId);
    if (pull === undefined) return false;
    if (pull.runtimeId !== runtimeId || pull.deviceId !== deviceId) return false;
    if (command.type === "artifact.cancel") {
      pull.cancelled = true;
      this.#pulls.delete(command.transferId);
      this.#commands.set(pull.commandId, { transferId: command.transferId, terminal: true });
      this.#trimCommands();
    }
    // pull 路径上没有 ack：进度由设备下一个 read 表达，忽略 ack 即可。
    return true;
  }

  /** 一台设备的链路没了：它名下的下载提前收场。 */
  releaseDevice(deviceId: string): void {
    for (const [transferId, pull] of [...this.#pulls]) {
      if (pull.deviceId !== deviceId) continue;
      pull.cancelled = true;
      this.#pulls.delete(transferId);
      this.#commands.set(pull.commandId, { transferId, terminal: true });
    }
    this.#trimCommands();
  }

  /**
   * 中继告知某条下载的转发路径没了（路由已被删/设备背压）。
   *
   * pull 路径上这仍然值得处理：分片是端到端 ack 重传的，而路由没了就永远不会到，
   * 设备会一直重试。这里以确定原因结束这条传输，手机重连后带已落盘偏移重试。
   */
  failTransferFromRelay(transferId: string, reason: string): boolean {
    const active = this.#pulls.get(transferId);
    if (active === undefined) return false;
    this.#options.log?.(`中继报告下载路径失效：${active.artifact.fileName} ${reason}`);
    this.#pulls.delete(transferId);
    this.#commands.set(active.commandId, { transferId, terminal: true });
    this.#trimCommands();
    // 用 `artifact.failed`（不是 `command.result`）：手机按 transferId 把这条任务标成可续传。
    this.#options.publishEvent(active.deviceId, active.runtimeId, {
      type: "artifact.failed",
      artifactId: active.artifact.artifactId,
      transferId,
      error: reason,
    });
    return true;
  }

  /**
   * 中继告知某台设备此刻不在线（v2 帧是端到端加密的，中继只能给出设备 id，给不出 transferId）。
   *
   * 该设备名下的传输立刻以确定原因收场：分片泵在收到回绝前已经排了一窗，不收场就会对着
   * 黑洞一窗一窗重传——实测一次 88MB 的断线下载能把 Host 日志刷到十几 MB，传输也不会结束。
   * 手机重连后由 APP 自己按已落盘偏移续传。
   */
  failDeviceTransfers(deviceId: string, reason: string): number {
    let failed = 0;
    for (const [transferId, pull] of [...this.#pulls]) {
      if (pull.deviceId !== deviceId) continue;
      this.#options.log?.(`中继报告设备离线：${pull.artifact.fileName} ${reason}（pull）`);
      pull.cancelled = true;
      this.#pulls.delete(transferId);
      this.#commands.set(pull.commandId, { transferId, terminal: true });
      failed += 1;
    }
    this.#trimCommands();
    return failed;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  async #resolve(command: DownloadCommand): Promise<ResolvedArtifact | undefined> {
    if (command.type === "artifact.download") {
      const known = this.#index.get(command.artifactId);
      if (known?.path === undefined || known.path === "") return undefined;
      return await this.#fromPath(known.path, known);
    }
    return await this.#fromPath(command.path, undefined);
  }

  /**
   * 把一条本地路径变成一个可流式下载的 artifact。
   *
   * `sha256` 是手机侧校验的硬要求（`artifact.started` 里缺它会被判成「无法安全处理」），
   * 索引里没有现成摘要时得现算——大文件会花上几百毫秒，这是它唯一的代价。
   */
  async #fromPath(path: string, known: RemoteArtifact | undefined): Promise<ResolvedArtifact | undefined> {
    try {
      const info = await stat(path);
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) return undefined;
      const fileName = known?.fileName ?? safeDownloadFileName(path);
      const mimeType = known?.mimeType ?? MIME_TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
      const sha256 = known !== undefined && known.size === info.size && known.sha256 !== ""
        ? known.sha256
        : await sha256File(path, info.size);
      return {
        artifactId: known?.artifactId ?? randomUUID(),
        fileName,
        mimeType,
        size: info.size,
        sha256,
        path,
      };
    } catch {
      // 文件不在、没权限、或不是普通文件：都不该在这里报错，交给调用方回落。
      return undefined;
    }
  }

  #trimCommands(): void {
    while (this.#commands.size > 256) {
      const oldest = this.#commands.keys().next();
      if (oldest.done === true) return;
      this.#commands.delete(oldest.value);
    }
  }

  #persistIndex(): void {
    const snapshot = { version: 1 as const, artifacts: [...this.#index.values()] };
    const path = this.#options.indexPath;
    const temporary = `${path}.${process.pid}.tmp`;
    this.#indexWriteChain = this.#indexWriteChain
      .then(async () => {
        await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
        await rename(temporary, path);
      })
      .catch((error: unknown) => {
        this.#options.log?.(`artifact 索引写入失败：${describe(error)}`);
      });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** artifact 索引文件的默认位置。 */
export function hostArtifactIndexPath(stateDir: string): string {
  return join(stateDir, "artifacts.json");
}
