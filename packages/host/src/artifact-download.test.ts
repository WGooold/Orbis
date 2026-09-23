import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@pi-remote/protocol";

import { HostDownloadService } from "./artifact-download.js";

const setup = async (): Promise<{
  service: HostDownloadService;
  events: RuntimeEvent[];
  frames: Uint8Array[];
  stateDir: string;
}> => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-remote-download-"));
  const events: RuntimeEvent[] = [];
  const frames: Uint8Array[] = [];
  const service = new HostDownloadService({
    indexPath: join(stateDir, "artifacts.json"),
    publishEvent: (_deviceId, _runtimeId, event) => events.push(event),
    publishBinary: (_deviceId, frame) => frames.push(frame),
  });
  return { service, events, frames, stateDir };
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("HostDownloadService relay failure handling", () => {
  it("中继报告路径失效时按错误码终止该传输（不等 ack 超时）", async () => {
    const { service, events, stateDir } = await setup();
    cleanup = async () => {};

    const filePath = join(stateDir, "report.bin");
    await writeFile(filePath, Buffer.alloc(4 * 1024 * 1024, 0x5a));

    await service.offerDownload("device-1", "runtime-1", "cmd-1", {
      type: "file.download",
      path: filePath,
    });
    await wait(20);
    const started = events.find((event) => event.type === "artifact.started");
    expect(started).toBeDefined();
    const transferId = started?.type === "artifact.started" ? started.transferId : "";

    // 传输正在进行。中继回执说这条路没了——Host 必须立刻以它的错误码收场，
    // 而不是继续等 ack、重传，最后报一个方向错误的 artifact_ack_timeout。
    expect(service.failTransferFromRelay(transferId, "transfer_route_lost")).toBe(true);
    await wait(50);
    const failed = events.find((event) => event.type === "artifact.failed");
    expect(failed).toBeDefined();
    expect(failed?.type === "artifact.failed" ? failed.error : "").toBe("transfer_route_lost");

    // 未知 transferId：不动任何东西，也不抛。
    expect(service.failTransferFromRelay("nope", "transfer_route_lost")).toBe(false);
  });

});
