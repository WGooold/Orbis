import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ARTIFACT_CHUNK_BYTES, PROTOCOL_VERSION, encodeArtifactChunkFrame, type RelayToDeviceMessage } from "@pi-remote/protocol";

import { HostUploadService } from "./artifact-upload.js";

const hash = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

type UploadRead = Extract<RelayToDeviceMessage, { type: "file.upload.read" }>;

describe("HostUploadService（接收方驱动：Host 拉，手机应答）", () => {
  let stateDir: string | undefined;
  const services: HostUploadService[] = [];

  const service = (messages: RelayToDeviceMessage[]): HostUploadService => {
    const created = new HostUploadService({
      indexPath: join(stateDir ?? "", "uploads.json"),
      publishMessage: (_deviceId, message) => messages.push(message),
    });
    services.push(created);
    return created;
  };

  afterEach(async () => {
    for (const created of services.splice(0)) {
      created.close();
      created.releaseDevice("device-a", "test cleanup");
      await created.flush();
    }
    // 服务里有脱离调用栈的写（索引 `.tmp` → rename、句柄关闭）。删目录前先让它们落定，
    // 否则 Windows 上会偶发 `ENOTEMPTY: directory not empty, rmdir` —— 那是时序不是漏删，
    // 重试只会把这个噪音盖住。
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  });

  const init = (data: Uint8Array) => ({
    type: "file.upload.init" as const,
    protocolVersion: PROTOCOL_VERSION,
    requestId: "req-1",
    runtimeId: "runtime-a",
    directory: join(stateDir ?? "", ".pi-remote-uploads"),
    fileName: "file.bin",
    size: data.byteLength,
    sha256: hash(data),
  });

  const readRequests = (messages: RelayToDeviceMessage[]): UploadRead[] =>
    messages.filter((message): message is UploadRead => message.type === "file.upload.read");

  /** 等待谓词成立（拉取定时器是真实间隔，轮询比赌时序稳）。 */
  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(predicate()).toBe(true);
  };

  /** 把「已收到但还没应答」的 read 全部用内容应答掉。partial 表示只回一半（模拟中途断开）。 */
  const serveReads = (
    uploads: HostUploadService,
    deviceId: string,
    messages: RelayToDeviceMessage[],
    data: Uint8Array,
    served: Set<number>,
    partial = false,
  ): void => {
    const reads = readRequests(messages);
    for (let index = 0; index < reads.length; index += 1) {
      if (served.has(index)) continue;
      served.add(index);
      const read = reads[index];
      if (read === undefined) continue;
      const slice = data.subarray(read.offset, read.offset + read.length);
      uploads.handleData(
        deviceId,
        encodeArtifactChunkFrame({
          runtimeId: "runtime-a",
          transferId: read.uploadId,
          offset: read.offset,
          data: partial ? slice.subarray(0, Math.max(1, Math.floor(slice.byteLength / 2))) : slice,
        }),
      );
    }
  };

  // 这条不变量撑起「断线可续传」：`.part` 的身份必须跨进程稳定，否则 Host 一重启就找不到
  // 已经收下的字节，手机白传一遍。用「新实例 + 同一份索引」模拟重启。
  it("resumes from the durable prefix after a Host restart", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-upload-"));
    const data = new Uint8Array(ARTIFACT_CHUNK_BYTES + 2048).map((_, index) => index % 251);

    const first: RelayToDeviceMessage[] = [];
    const before = service(first);
    await before.load();
    const request = init(data);
    await before.handleInit("device-a", request);
    const ready = first.find((message) => message.type === "file.upload.ready");
    expect(ready).toMatchObject({ receivedBytes: 0 });

    // 只应答第一块的一部分：持久前缀停在半途，制造「断在中间」的状态。
    const servedA = new Set<number>();
    await waitFor(() => readRequests(first).length > 0);
    serveReads(before, "device-a", first, data, servedA, true);
    await waitFor(() => readRequests(first).length > servedA.size);
    before.releaseDevice("device-a", "test");
    before.close();
    await before.flush();

    // 「重启」：新实例读同一份索引，ready 带上持久前缀。
    const second: RelayToDeviceMessage[] = [];
    const after = service(second);
    await after.load();
    await after.handleInit("device-a", request);
    const resumed = second.find((message) => message.type === "file.upload.ready");
    expect(resumed!.type).toBe("file.upload.ready");
    expect((resumed as { receivedBytes: number }).receivedBytes).toBeGreaterThan(0);
    expect((resumed as { receivedBytes: number }).receivedBytes).toBeLessThan(data.byteLength);

    // 全量应答剩下的 read，Host 拉满后自己收尾——不再需要手机喊 done。
    const servedB = new Set<number>();
    await waitFor(() => {
      serveReads(after, "device-a", second, data, servedB);
      return second.some((message) => message.type === "file.upload.finished");
    });
    const finished = second.find((message) => message.type === "file.upload.finished");
    expect(finished).toMatchObject({ type: "file.upload.finished", size: data.byteLength });
    const path = (finished as { path: string }).path;
    expect(new Uint8Array(await readFile(path))).toEqual(data);
    await after.flush();

    // 最后一片已经写入、但尚未发布时重启，以及空文件：都没有下一片来触发收尾。
    for (const completeData of [Buffer.from("received before restart"), Buffer.alloc(0)]) {
      const completeRequest = { ...init(completeData), fileName: `complete-${completeData.length}.bin` };
      const staged = service([]);
      staged.close(); // 留下尚未由拉取循环收尾的 .part，模拟重启边界。
      await staged.handleInit("device-a", completeRequest);
      staged.releaseDevice("device-a", "restart");
      await staged.flush();
      const parts = await readdir(join(stateDir, "uploads"));
      expect(parts).toHaveLength(1);
      await writeFile(join(stateDir, "uploads", parts[0]!), completeData);

      const recoveredMessages: RelayToDeviceMessage[] = [];
      const recovered = service(recoveredMessages);
      await recovered.load();
      await recovered.handleInit("device-a", completeRequest);
      expect(recoveredMessages).toContainEqual(expect.objectContaining({
        type: "file.upload.ready", receivedBytes: completeData.length,
      }));
      await waitFor(() => recoveredMessages.some((message) => message.type === "file.upload.finished"));
      const completed = recoveredMessages.find((message) => message.type === "file.upload.finished");
      if (completed?.type !== "file.upload.finished") throw new Error("missing finished");
      expect(await readFile(completed.path)).toEqual(completeData);
      expect(readRequests(recoveredMessages)).toHaveLength(0);
      recovered.close();
      await recovered.flush();
    }
  });

  it("refuses data from a device that does not own the upload", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-upload-"));
    const data = new Uint8Array(2048);
    const messages: RelayToDeviceMessage[] = [];
    const uploads = service(messages);
    await uploads.load();
    await uploads.handleInit("device-a", init(data));

    const served = new Set<number>();
    await waitFor(() => readRequests(messages).length > 0);
    const firstRead = readRequests(messages)[0]!;
    uploads.handleData("device-b", encodeArtifactChunkFrame({
      runtimeId: "runtime-a", transferId: firstRead.uploadId, offset: firstRead.offset, data: data.subarray(0, 1024),
    }));
    expect(messages.at(-1)).toMatchObject({ type: "file.upload.failed", code: "unknown_transfer" });

    // 真主人应答之后仍然能成功：上面那条不能把上传弄坏。
    await waitFor(() => readRequests(messages).length > 0);
    for (let index = 0; index < readRequests(messages).length; index += 1) {
      if (served.has(index)) continue;
      served.add(index);
      const read = readRequests(messages)[index];
      if (read === undefined) continue;
      uploads.handleData("device-a", encodeArtifactChunkFrame({
        runtimeId: "runtime-a", transferId: read.uploadId, offset: read.offset, data: data.subarray(read.offset, read.offset + read.length),
      }));
    }
    await waitFor(() => messages.some((message) => message.type === "file.upload.finished"));
    expect(messages.at(-1)).toMatchObject({ type: "file.upload.finished" });
  });

  // 删除状态目录（测试收尾、Host 换目录）之前必须先 `flush()`：索引是写 `.tmp` 再 rename 的，
  // 不等就会撞上「刚要落地的那一步」，在 Windows 上表现为 ENOTEMPTY。这条用例不赌时序，
  // 直接钉死「flush 回来之后盘上已是终态」。
  it("flush 之后索引已落盘，不留 .tmp 残骸", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-upload-"));
    const data = new Uint8Array(1024).fill(3);
    const uploads = service([]);
    await uploads.load();
    await uploads.handleInit("device-a", init(data));

    await uploads.flush();

    const entries = await readdir(stateDir);
    expect(entries).toContain("uploads.json");
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps a mismatched upload out of the destination", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-upload-"));
    const data = new Uint8Array(1024).fill(7);
    const messages: RelayToDeviceMessage[] = [];
    const uploads = service(messages);
    await uploads.load();
    await uploads.handleInit("device-a", init(data));

    const tampered = Uint8Array.from(data);
    tampered[0] = 0xff;
    const served = new Set<number>();
    await waitFor(() => readRequests(messages).length > 0);
    await waitFor(() => {
      const reads = readRequests(messages);
      for (let index = 0; index < reads.length; index += 1) {
        if (served.has(index)) continue;
        served.add(index);
        const read = reads[index];
        if (read === undefined) continue;
        uploads.handleData("device-a", encodeArtifactChunkFrame({
          runtimeId: "runtime-a", transferId: read.uploadId, offset: read.offset,
          data: tampered.subarray(read.offset, read.offset + read.length),
        }));
      }
      return messages.some((message) => message.type === "file.upload.failed");
    });

    expect(messages.at(-1)).toMatchObject({ type: "file.upload.failed", code: "hash_mismatch" });
    // 坏内容不许以最终名字出现；临时文件也要清掉，否则下次续传会接着写坏前缀。
    await expect(stat(join(stateDir, ".pi-remote-uploads", "file.bin"))).rejects.toThrow();
  });
});
