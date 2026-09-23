/**
 * Host 的 loopback 端点（spec §7.3）。
 *
 * 重点不是消息处理（端到端已经覆盖），而是**发现文件的生命周期**：
 * 它必须在服务起来之后出现、在服务停下之前消失。留着一个指向死端口的文件，
 * 扩展会照它连上去然后空等——那是这条通道最容易踩、也最难查的坑。
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LOOPBACK_DESCRIPTOR_FILE, LoopbackDescriptorSchema } from "@pi-remote/protocol";

import { HostLoopbackServer } from "./loopback-server.js";

describe("HostLoopbackServer 的发现文件", () => {
  let dir: string | undefined;
  let server: HostLoopbackServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("启动时写 0600 的发现文件，停止时删掉它", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-remote-loopback-"));
    server = new HostLoopbackServer({ stateDir: dir, hostId: "host-1" });
    const descriptor = await server.start();

    const path = join(dir, LOOPBACK_DESCRIPTOR_FILE);
    const written = JSON.parse(await readFile(path, "utf8")) as unknown;
    expect(LoopbackDescriptorSchema.parse(written)).toEqual(descriptor);
    expect(descriptor.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/u);
    expect(descriptor.pid).toBe(process.pid);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    await server.stop();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
