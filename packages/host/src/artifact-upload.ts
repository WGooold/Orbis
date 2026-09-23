/**
 * Host 侧的 artifact 上传：手机把文件推到这台机器上（spec: docs/adr/0012-receiver-driven-upload.md）。
 *
 * 与 `artifact-download.ts` 镜像对称，但**角色对调**：
 *
 * - 下载是「接收方出题、发送方应答」——设备按范围索取，Host 无状态地读盘回一段
 *   （ADR-0005）。接收方之所以能驱动，是因为它知道自己缺哪一段。
 * - 上传同样由接收方驱动（ADR-0012）：手机先声明文件，Host 按 `.part` 的持久前缀
 *   发 read 拉取缺少的字节；收齐后由 Host 校验、落地并通知完成。
 *
 * 两件事仍然和下载一致，因为它们与方向无关：
 * - **持久前缀是唯一续传基准**：`.part` 的长度就是「电脑上确实已经有了多少字节」。
 * - **校验权在接收方**：`finished` 只在 Host 自己算完 sha256 之后才发。手机说的哈希不算数。
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

import {
  ARTIFACT_CHUNK_BYTES,
  MAX_UPLOAD_BYTES,
  PROTOCOL_VERSION,
  decodeArtifactChunkFrame,
  type ArtifactChunkFrame,
  type DeviceE2ePayload,
  type RelayToDeviceMessage,
} from "@pi-remote/protocol";

/** 多久没有分片到达就释放句柄。文件越大停顿越常见，所以比下载的 60s 宽。 */
const IDLE_TIMEOUT_MS = 10 * 60_000;
/** `progress` 的默认阈值与节拍：取先到者。纯 UI 进度，不参与流控。 */
const PROGRESS_THRESHOLD_BYTES = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 500;
/** 索引里最多留多少条未完成上传。 */
const MAX_INDEX_ENTRIES = 500;
/** 拉取节拍：每 200ms 巡一遍进行中的上传，缺数据就发 read。 */
const PULL_TICK_MS = 200;
/** read 发出后多久没等到数据就重发同一个 read（数据应答丢了/手机流被占）。 */
const REREQUEST_MS = 1_000;

type UploadInit = Extract<DeviceE2ePayload, { type: "file.upload.init" }>;

export type HostUploadServiceOptions = {
  /** 一条 Host→设备的 E2E 控制载荷。 */
  publishMessage: (deviceId: string, message: RelayToDeviceMessage) => void;
  /** 未完成上传的索引落盘位置（`<stateDir>/uploads.json`）。 */
  indexPath: string;
  log?: (line: string) => void;
  progressThresholdBytes?: number;
  progressIntervalMs?: number;
  idleTimeoutMs?: number;
};

/**
 * 一条进行中的上传。
 *
 * 与下载的 `ActivePull` 不同，这里**持有文件句柄**：上传是写，每片都 open/close 会把
 * I/O 开销压到分片本身之上。代价是空闲时必须回收，所以有 `#sweepIdle`。
 */
type ActiveUpload = {
  deviceId: string;
  uploadId: string;
  runtimeId: string;
  directory: string;
  fileName: string;
  mimeType: string | undefined;
  size: number;
  sha256: string;
  partPath: string;
  partKey: string;
  handle: FileHandle;
  durableBytes: number;
  lastProgressBytes: number;
  lastProgressAt: number;
  lastActivityAt: number;
  /** 收到的数据块数（含重复应答），完成日志用它说清拉了多少次。 */
  chunks: number;
  startedAt: number;
  cancelled: boolean;
  /** 串行链：偏移判定与写盘必须在同一根链上（见 `handleData`）。 */
  writeChain: Promise<void>;
  /** 已发出、还没等到应答的 read。同一时刻每条上传至多一个在途请求。 */
  outstanding: { offset: number; length: number; sentAt: number } | undefined;
  /** 落地校验进行中：之后的重复应答一律忽略，别把落地完的传输再翻出来写。 */
  completing: boolean;
};

/** 未完成上传的持久记录：Host 重启后靠它续传。 */
type IndexedUpload = {
  partKey: string;
  deviceId: string;
  runtimeId: string;
  directory: string;
  fileName: string;
  mimeType?: string;
  size: number;
  sha256: string;
  updatedAt: number;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `.part` 的稳定身份。
 *
 * 必须跨进程稳定，否则 Host 一重启就找不到已有的临时文件，续传退化成重传整个文件。
 * 内容身份（谁上传的、落到哪、叫什么、多大、什么哈希）比 `uploadId` 合适——`uploadId`
 * 是每次 `init` 新分配的。
 */
function partKeyFor(input: {
  runtimeId: string;
  directory: string;
  fileName: string;
  size: number;
  sha256: string;
}): string {
  return createHash("sha256")
    .update([input.runtimeId, input.directory, input.fileName, String(input.size), input.sha256].join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/** 目标文件已存在时退让成 `name (1).ext`，与手机侧下载落地的命名习惯一致。 */
async function uniqueTargetPath(directory: string, fileName: string): Promise<string> {
  const extension = extname(fileName);
  const stem = extension === "" ? fileName : fileName.slice(0, -extension.length);
  let candidate = join(directory, fileName);
  let suffix = 1;
  for (;;) {
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
    candidate = join(directory, `${stem} (${suffix})${extension}`);
    suffix += 1;
  }
}

export class HostUploadService {
  readonly #options: HostUploadServiceOptions;
  /** uploadId → 进行中。 */
  readonly #uploads = new Map<string, ActiveUpload>();
  /** partKey → 未完成记录（含没有活句柄的）。 */
  readonly #index = new Map<string, IndexedUpload>();
  /**
   * 所有**脱离调用栈**的后台工作（索引写盘、句柄关闭）都串在这一条链上。
   *
   * 串行有两个理由：索引写要保序（先写后写倒过来就是把旧状态盖在新状态上），
   * 而 `flush()` 因此只需等一个东西就能确定盘上不再有动静。
   */
  #background: Promise<void> = Promise.resolve();

  constructor(options: HostUploadServiceOptions) {
    this.#options = options;
    // 接收方驱动（ADR-0012）：数据是拉来的。这个定时器就是「拉」的发动机——
    // 每拍巡一遍进行中的上传，持久前缀没到顶且没有在途 read，就发一个 read。
    this.#pullTimer = setInterval(() => this.#pullTick(), PULL_TICK_MS);
    this.#pullTimer.unref?.();
  }

  readonly #pullTimer: NodeJS.Timeout;

  /** 停掉拉取定时器（测试收尾 / 服务下线）。已打开的句柄走 `flush()` 之后的正常回收。 */
  close(): void {
    clearInterval(this.#pullTimer);
  }

  /**
   * 等盘上所有后台工作落定，之后调用方才能动这些文件。
   *
   * 必须调的场景是**删除状态目录之前**（测试的 `afterEach`）。不调就会在 Windows 上偶发
   * `ENOTEMPTY: directory not empty, rmdir`：索引是先写 `.tmp` 再 rename 的，删目录如果撞上
   * 这一步、或者撞上还没关掉的句柄，`rmdir` 就会失败。那是**时序**不是漏删——重试只是把噪音
   * 盖住，该等就等。
   */
  async flush(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.#background;
      await seen;
    } while (seen !== this.#background);
  }

  #track(work: Promise<unknown>): void {
    this.#background = this.#background.then(() => work).then(
      () => undefined,
      () => undefined,
    );
  }

  /** 从盘上恢复未完成上传：Host 重启后这些 `.part` 还能接着写。 */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#options.indexPath, "utf8")) as {
        version?: unknown;
        uploads?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.uploads)) return;
      for (const entry of parsed.uploads) {
        const upload = entry as Partial<IndexedUpload>;
        if (typeof upload.partKey !== "string" || typeof upload.directory !== "string") continue;
        if (typeof upload.fileName !== "string" || typeof upload.runtimeId !== "string") continue;
        if (typeof upload.deviceId !== "string") continue;
        if (typeof upload.size !== "number" || typeof upload.sha256 !== "string") continue;
        this.#index.set(upload.partKey, {
          partKey: upload.partKey,
          deviceId: upload.deviceId,
          runtimeId: upload.runtimeId,
          directory: upload.directory,
          fileName: upload.fileName,
          ...(typeof upload.mimeType === "string" ? { mimeType: upload.mimeType } : {}),
          size: upload.size,
          sha256: upload.sha256,
          updatedAt: typeof upload.updatedAt === "number" ? upload.updatedAt : 0,
        });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.#options.log?.(`上传索引读取失败（按空索引继续）：${describe(error)}`);
      }
    }
  }

  /** `.part` 的存放目录（与所有上传共用，文件名是 partKey）。 */
  #partsDirectory(): string {
    return join(this.#options.indexPath, "..", "uploads");
  }

  #partPath(partKey: string): string {
    return join(this.#partsDirectory(), `${partKey}.part`);
  }

  /**
   * 受理一次上传。
   *
   * 续传判据是**内容身份**而不是 `uploadId`：同一次上传在手机重试、Host 重启之后会拿到
   * 新的 `uploadId`，但内容身份不变，于是命中同一个 `.part`，从它的长度接着写。
   */
  async handleInit(deviceId: string, message: UploadInit): Promise<void> {
    // 与下载的 `offerDownload` 同一手法：不做常驻定时器，新上传来了就顺手清扫一下
    // 再也不会继续的那些句柄。
    this.#sweepIdle(Date.now());
    const fail = (code: string, text: string): void => {
      this.#options.publishMessage(deviceId, {
        type: "file.upload.failed",
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        code,
        message: text,
      });
    };
    if (message.size > MAX_UPLOAD_BYTES) {
      fail("upload_too_large", `文件超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB 上限`);
      return;
    }
    if (!isAbsolute(message.directory)) {
      fail("invalid_request", "落地目录必须是绝对路径");
      return;
    }
    let directory: string;
    try {
      // 手机给的是 `<cwd>/.pi-remote-uploads`，这一层通常还不存在。
      await mkdir(message.directory, { recursive: true });
      const info = await stat(message.directory);
      if (!info.isDirectory()) throw new Error("not a directory");
      directory = message.directory;
    } catch (error) {
      this.#options.log?.(`上传落地目录不可用 ${message.directory}：${describe(error)}`);
      fail("invalid_request", "落地目录不可用");
      return;
    }

    const partKey = partKeyFor({
      runtimeId: message.runtimeId,
      directory,
      fileName: message.fileName,
      size: message.size,
      sha256: message.sha256,
    });
    const partPath = this.#partPath(partKey);
    let receivedBytes = 0;
    try {
      const info = await stat(partPath);
      // 比声明还大的临时文件只可能来自上一次内容不同的上传（哈希相同却更长是不可能的）。
      // 这种情况不能信它，从 0 重来。
      receivedBytes = info.size <= message.size ? info.size : 0;
    } catch {
      receivedBytes = 0;
    }

    let handle: FileHandle;
    try {
      await mkdir(this.#partsDirectory(), { recursive: true });
      handle = await open(partPath, "r+").catch(async () => {
        const created = await open(partPath, "w+");
        return created;
      });
      if (receivedBytes === 0) await handle.truncate(0);
      else await handle.truncate(receivedBytes);
    } catch (error) {
      this.#options.log?.(`上传临时文件不可写 ${partPath}：${describe(error)}`);
      fail("write_failed", "电脑端无法创建临时文件");
      return;
    }

    // 同一条上传重来时（手机重试、或 init 重发）关掉旧句柄，别漏 fd。
    for (const [uploadId, active] of this.#uploads) {
      if (active.partKey !== partKey) continue;
      this.#uploads.delete(uploadId);
      await active.handle.close().catch(() => {});
    }

    const uploadId = randomUUID();
    const now = Date.now();
    this.#uploads.set(uploadId, {
      deviceId,
      uploadId,
      runtimeId: message.runtimeId,
      directory,
      fileName: message.fileName,
      mimeType: message.mimeType,
      size: message.size,
      sha256: message.sha256,
      partPath,
      partKey,
      handle,
      durableBytes: receivedBytes,
      lastProgressBytes: receivedBytes,
      lastProgressAt: now,
      lastActivityAt: now,
      chunks: 0,
      startedAt: now,
      cancelled: false,
      writeChain: Promise.resolve(),
      outstanding: undefined,
      completing: false,
    });
    this.#index.set(partKey, {
      partKey,
      deviceId,
      runtimeId: message.runtimeId,
      directory,
      fileName: message.fileName,
      ...(message.mimeType === undefined ? {} : { mimeType: message.mimeType }),
      size: message.size,
      sha256: message.sha256,
      updatedAt: now,
    });
    this.#trimIndex();
    this.#persistIndex();

    this.#options.publishMessage(deviceId, {
      type: "file.upload.ready",
      protocolVersion: PROTOCOL_VERSION,
      requestId: message.requestId,
      uploadId,
      chunkSize: ARTIFACT_CHUNK_BYTES,
      receivedBytes,
    });
    this.#options.log?.(
      `上传受理：${message.fileName}（${message.size} 字节，从 ${receivedBytes} 开始，uploadId=${uploadId}）`,
    );
  }

  /**
   * read 的应答到达。只有**在途请求**指向的那一块会被接受：偏移对不上（迟到/重复的
   * 应答）直接忽略——拉取循环会对齐，不需要 NACK。
   *
   * 写盘仍排在**串行链**上：`durableBytes` 在写完成后才推进，判定与写入必须在同一根链上。
   */
  handleData(deviceId: string, frame: Uint8Array): void {
    let decoded: ArtifactChunkFrame;
    try {
      decoded = decodeArtifactChunkFrame(frame);
    } catch {
      this.#options.log?.(`忽略一条无法解码的上传数据（${frame.byteLength} 字节）`);
      return;
    }
    const active = this.#uploads.get(decoded.transferId);
    if (active === undefined || active.deviceId !== deviceId) {
      // 未知传输：明确回绝，而不是静默丢弃——手机据此重新 advertise（对齐 artifact.read.failed）。
      this.#options.publishMessage(deviceId, {
        type: "file.upload.failed",
        protocolVersion: PROTOCOL_VERSION,
        uploadId: decoded.transferId,
        code: "unknown_transfer",
        message: "上传已不在电脑端，请重新发起",
      });
      return;
    }
    if (active.cancelled || active.completing) return;
    const outstanding = active.outstanding;
    if (outstanding === undefined || decoded.offset !== outstanding.offset) {
      // 迟到/重复的应答：这块不是当前要的。拉取循环自己会对齐，不用回话。
      return;
    }
    active.outstanding = undefined;
    active.lastActivityAt = Date.now();
    active.chunks += 1;
    active.writeChain = active.writeChain
      .then(() => this.#acceptChunk(active, decoded))
      .catch((error: unknown) => {
        this.#options.log?.(`上传数据处理失败 ${active.fileName}：${describe(error)}`);
      });
  }

  /**
   * 拉取发动机：每 200ms 巡一遍进行中的上传。持久前缀没到顶、没有在途 read、
   * 上一次 read 也没超时，就按 `durableBytes` 发一个 read。
   *
   * 流控就是「一次只拉一块」：中继路径上手机的上行被灌满时，websocket 的 pong 会排在
   * 数据后面迟到、被中继心跳判死——在途压到 1 块，心跳永远有路可走。
   */
  #pullTick(): void {
    const now = Date.now();
    for (const active of this.#uploads.values()) {
      if (active.cancelled || active.completing) continue;
      // 完整前缀也可能来自续传或空文件，不能等「下一片」才触发收尾。
      if (active.durableBytes >= active.size) {
        this.#track(this.#finalize(active));
        continue;
      }
      const outstanding = active.outstanding;
      if (outstanding !== undefined && now - outstanding.sentAt < REREQUEST_MS) continue;
      const length = Math.min(ARTIFACT_CHUNK_BYTES, active.size - active.durableBytes);
      active.outstanding = { offset: active.durableBytes, length, sentAt: now };
      this.#options.publishMessage(active.deviceId, {
        type: "file.upload.read",
        protocolVersion: PROTOCOL_VERSION,
        uploadId: active.uploadId,
        offset: active.durableBytes,
        length,
      });
    }
  }

  /** 在串行链上判定偏移并写入。只有这里能推进 `durableBytes`。 */
  async #acceptChunk(active: ActiveUpload, frame: ArtifactChunkFrame): Promise<void> {
    if (active.cancelled || active.completing) return;
    const end = frame.offset + frame.data.byteLength;
    if (end > active.size) {
      this.#options.log?.(`上传数据越界：${active.fileName} offset=${frame.offset} 超出 ${active.size}`);
      return;
    }
    if (frame.offset !== active.durableBytes) {
      // 迟到/重复应答：前缀没动。忽略，等拉取循环自己补。
      return;
    }
    await this.#append(active, frame);
  }

  async #append(active: ActiveUpload, frame: ArtifactChunkFrame): Promise<void> {
    try {
      await active.handle.write(Buffer.from(frame.data), 0, frame.data.byteLength, active.durableBytes);
    } catch (error) {
      this.#options.log?.(`上传写盘失败 ${active.fileName}：${describe(error)}`);
      this.#failActive(active, "write_failed", "电脑端写盘失败");
      return;
    }
    // 句柄拿到了字节，但「持久前缀」是在这里才推进的：write 成功返回说明数据已交给内核。
    // 真正的内容正确性由收尾时的 sha256 兜底。
    active.durableBytes += frame.data.byteLength;
    this.#index.set(active.partKey, { ...this.#index.get(active.partKey)!, updatedAt: Date.now() });
    this.#publishProgress(active);
  }

  #publishProgress(active: ActiveUpload): void {
    const now = Date.now();
    const threshold = this.#options.progressThresholdBytes ?? PROGRESS_THRESHOLD_BYTES;
    const interval = this.#options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    if (active.durableBytes - active.lastProgressBytes < threshold && now - active.lastProgressAt < interval) {
      return;
    }
    active.lastProgressBytes = active.durableBytes;
    active.lastProgressAt = now;
    this.#options.publishMessage(active.deviceId, {
      type: "file.upload.progress",
      protocolVersion: PROTOCOL_VERSION,
      uploadId: active.uploadId,
      receivedBytes: active.durableBytes,
    });
  }

  /**
   * 收尾（接收方驱动的完成判定）：持久前缀到达 `size` 时由拉取循环触发，**不再需要
   * 手机喊 done**——Host 自己知道已经收齐了。
   *
   * **校验在这里**：Host 自己算 sha256，对得上才改名落地。哈希不对就删 `.part` 重来
   * （内容不可信，留着只会让下次续传出错）。
   */
  async #finalize(active: ActiveUpload): Promise<void> {
    if (active.completing) return;
    active.completing = true;
    const deviceId = active.deviceId;
    const uploadId = active.uploadId;
    // 先把写链排空：最后一片的 await write 可能还没回来。
    await active.writeChain.catch(() => {});
    await active.handle.close().catch(() => {});
    this.#uploads.delete(uploadId);

    let actual: string;
    try {
      actual = await this.#sha256File(active.partPath);
    } catch (error) {
      this.#options.log?.(`上传校验读盘失败 ${active.fileName}：${describe(error)}`);
      this.#options.publishMessage(deviceId, {
        type: "file.upload.failed",
        protocolVersion: PROTOCOL_VERSION,
        uploadId,
        code: "write_failed",
        message: "电脑端读不回临时文件",
      });
      return;
    }
    if (actual !== active.sha256) {
      // 内容不对说明这一份临时文件不可信：删掉重来，留着只会让下次续传出错。
      this.#index.delete(active.partKey);
      await rm(active.partPath, { force: true }).catch(() => {});
      this.#persistIndex();
      this.#options.log?.(`上传校验失败：${active.fileName} 期望 ${active.sha256} 实际 ${actual}`);
      this.#options.publishMessage(deviceId, {
        type: "file.upload.failed",
        protocolVersion: PROTOCOL_VERSION,
        uploadId,
        code: "hash_mismatch",
        message: "文件校验失败，请重新发送",
      });
      return;
    }

    let path: string;
    try {
      path = await uniqueTargetPath(active.directory, active.fileName);
      try {
        await rename(active.partPath, path);
      } catch (error) {
        // Windows 的 rename 不能跨盘（EXDEV）：`.part` 存放在 Host 自己的目录（通常 C 盘），
        // 落盘目标在 runtime 的 cwd（这里就是 D 盘）。跨盘时复制再删源，语义等价。
        if ((error as { code?: unknown }).code !== "EXDEV") throw error;
        await copyFile(active.partPath, path);
        await rm(active.partPath, { force: true });
      }
    } catch (error) {
      this.#options.log?.(`上传落地失败 ${active.fileName}：${describe(error)}`);
      this.#options.publishMessage(deviceId, {
        type: "file.upload.failed",
        protocolVersion: PROTOCOL_VERSION,
        uploadId,
        code: "write_failed",
        message: "电脑端无法保存文件",
      });
      return;
    }
    this.#index.delete(active.partKey);
    this.#persistIndex();

    const elapsed = Date.now() - active.startedAt;
    const seconds = Math.max(elapsed, 1) / 1000;
    this.#options.log?.(
      `上传完成：${active.fileName} ${active.size} 字节，${active.chunks} 次拉取，` +
      `${elapsed}ms，${Math.round(active.size / seconds / 1024)} KiB/s，落盘 ${path}`,
    );
    this.#options.publishMessage(deviceId, {
      type: "file.upload.finished",
      protocolVersion: PROTOCOL_VERSION,
      uploadId,
      path,
      fileName: active.fileName,
      size: active.size,
      sha256: active.sha256,
      ...(active.mimeType === undefined ? {} : { mimeType: active.mimeType }),
    });
  }

  /** 手机主动放弃。不回收就能一直占着 `.part` 和句柄。 */
  async handleCancel(deviceId: string, uploadId: string): Promise<void> {
    const active = this.#uploads.get(uploadId);
    if (active === undefined || active.deviceId !== deviceId) return;
    active.cancelled = true;
    this.#uploads.delete(uploadId);
    await active.handle.close().catch(() => {});
    this.#index.delete(active.partKey);
    await rm(active.partPath, { force: true }).catch(() => {});
    this.#persistIndex();
    this.#options.log?.(`上传取消：${active.fileName}`);
  }

  /**
   * 设备断开：释放句柄但**保留 `.part`**。
   *
   * 断开不等于放弃——手机重连后会重新 `init`，命中同一个内容身份就能接着写。
   */
  releaseDevice(deviceId: string, reason: string): void {
    for (const [uploadId, active] of [...this.#uploads]) {
      if (active.deviceId !== deviceId) continue;
      this.#uploads.delete(uploadId);
      this.#track(active.handle.close());
      this.#options.log?.(
        `设备离线，暂停上传 ${active.fileName}（${active.durableBytes}/${active.size} 字节，保留待续传）：${reason}`,
      );
    }
    this.#persistIndex();
  }

  /** 空闲回收：句柄不能跟着一条再也不会继续的上传一直开着。 */
  #sweepIdle(now: number): void {
    const timeout = this.#options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    for (const [uploadId, active] of [...this.#uploads]) {
      if (now - active.lastActivityAt < timeout) continue;
      this.#uploads.delete(uploadId);
      this.#track(active.handle.close());
      this.#options.log?.(
        `上传空闲回收：${active.fileName}（${active.durableBytes}/${active.size} 字节，保留待续传）`,
      );
    }
  }

  #failActive(active: ActiveUpload, code: string, message: string): void {
    this.#uploads.delete(active.uploadId);
    this.#track(active.handle.close());
    this.#options.publishMessage(active.deviceId, {
      type: "file.upload.failed",
      protocolVersion: PROTOCOL_VERSION,
      uploadId: active.uploadId,
      code,
      message,
    });
  }

  async #sha256File(path: string): Promise<string> {
    const digest = createHash("sha256");
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead <= 0) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return digest.digest("hex");
  }

  #trimIndex(): void {
    while (this.#index.size > MAX_INDEX_ENTRIES) {
      const oldest = [...this.#index.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest === undefined) break;
      this.#index.delete(oldest.partKey);
    }
  }

  #persistIndex(): void {
    const payload = JSON.stringify({ version: 1, uploads: [...this.#index.values()] });
    this.#track(
      (async () => {
        await mkdir(join(this.#options.indexPath, ".."), { recursive: true });
        const temporary = `${this.#options.indexPath}.tmp`;
        await writeFile(temporary, payload, "utf8");
        await rename(temporary, this.#options.indexPath);
      })().catch((error: unknown) => {
        this.#options.log?.(`上传索引写入失败：${describe(error)}`);
      }),
    );
  }
}

/** 上传索引文件的默认位置。 */
export function hostUploadIndexPath(stateDir: string): string {
  return join(stateDir, "uploads.json");
}
