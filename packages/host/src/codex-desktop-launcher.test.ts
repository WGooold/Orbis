/**
 * 端点文件是包装器与 Host 之间唯一的接口，所以它的校验就是接入面的校验：
 * 只认「活着的桥接进程」发布的「回环 ws」端点。写坏或写偏一个字节，Host 要么
 * 对着死端口反复重试，要么被指向一个不该连的地址。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { codexWrapperRoot, readCodexDesktopEndpoint, stageCodexWrapper } from "./codex-desktop-launcher.js";

async function descriptor(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orbis-desktop-endpoint-"));
  const path = join(dir, "codex-desktop-endpoint.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

describe("Codex desktop endpoint descriptor", () => {
  it("accepts only a live bridge publishing a loopback websocket", async () => {
    const alive = await descriptor({ schema: 1, url: "ws://127.0.0.1:55384", bridgePid: process.pid, codexPid: 1, startedAt: "2026-10-05T12:09:19.754Z" });
    expect(readCodexDesktopEndpoint(alive)).toEqual({ url: "ws://127.0.0.1:55384", bridgePid: process.pid });

    // 桥接进程没了：端点就是死的，认了它只会让状态停在「接入失败」。
    const dead = await descriptor({ schema: 1, url: "ws://127.0.0.1:55384", bridgePid: 0x7ffffff0 });
    expect(readCodexDesktopEndpoint(dead)).toBeUndefined();

    // 非回环地址不进 Host；半截 JSON 也一样当没有。
    const remote = await descriptor({ schema: 1, url: "ws://10.0.0.5:55384", bridgePid: process.pid });
    expect(readCodexDesktopEndpoint(remote)).toBeUndefined();
    const truncated = await descriptor('{"schema":1,"url":"ws://127.0.0.1:553');
    expect(readCodexDesktopEndpoint(truncated)).toBeUndefined();
    expect(readCodexDesktopEndpoint(join(tmpdir(), "orbis-missing-endpoint.json"))).toBeUndefined();
  });
});

// 包装器运行时必须落在 Host 安装目录之外：桌面版一启动就会把 launcher 与 node 锁到
// 会话结束，如果它们住在 runtime 里，Host 升级就替换不掉那两个文件。
describe("staged Codex wrapper runtime", () => {
  async function source() {
    const dir = await mkdtemp(join(tmpdir(), "orbis-wrapper-source-"));
    await mkdir(join(dir, "bin"), { recursive: true });
    await mkdir(join(dir, "node"), { recursive: true });
    await writeFile(join(dir, "bin", "codex-launcher.exe"), "launcher-bytes");
    await writeFile(join(dir, "node", "node.exe"), "node-bytes");
    await writeFile(join(dir, "wrapper.js"), "wrapper-script");
    return { launcher: join(dir, "bin", "codex-launcher.exe"), node: join(dir, "node", "node.exe"), script: join(dir, "wrapper.js") };
  }

  it("stages only the two files the desktop app locks, and only copies what changed", async () => {
    const wrapper = await source();
    const root = await mkdtemp(join(tmpdir(), "orbis-wrapper-staged-"));
    const staged = stageCodexWrapper(wrapper, root);

    // 固定布局：launcher 靠“相对自身”找 node 与脚本，换位置不能换形状。
    expect(staged.launcher).toBe(join(root, "bin", "codex-launcher.exe"));
    expect(staged.node).toBe(join(root, "node", "node.exe"));
    expect(staged.script).toBe(join(root, "packages", "host", "dist", "codex-desktop-wrapper.js"));
    await expect(readFile(staged.node, "utf8")).resolves.toBe("node-bytes");
    // 脚本位置是转发到安装目录里那份实现的 stub：模块与 node_modules 都还住在那儿。
    const stub = await readFile(staged.script, "utf8");
    expect(stub).toContain("import { main } from");
    expect(stub).toContain("wrapper.js");
    expect(stub).toContain("await main(process.argv.slice(2));");

    // 早就存在且没变的本份不重拷（node.exe 有 80MB+），改了才刷新。
    const beforeLauncher = (await stat(staged.launcher)).mtimeMs;
    const beforeStub = (await stat(staged.script)).mtimeMs;
    stageCodexWrapper(wrapper, root);
    expect((await stat(staged.launcher)).mtimeMs).toBe(beforeLauncher);
    expect((await stat(staged.script)).mtimeMs).toBe(beforeStub);
    await writeFile(wrapper.script, "wrapper-script-v2");
    stageCodexWrapper(wrapper, root);
    expect((await stat(staged.script)).mtimeMs).not.toBe(beforeStub);

    expect(codexWrapperRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toBe(join("C:\\Users\\x\\AppData\\Local", "Orbis", "wrapper"));
    expect(codexWrapperRoot({ ORBIS_CODEX_WRAPPER_ROOT: root })).toBe(root);
    expect(existsSync(staged.launcher)).toBe(true);
  });

  // Host 会先 stage 一次，拉起时又会把“当前包装器”交给 launchCodexDesktopThroughWrapper——
  // 那一层不能拿已经暂存的那份再 stage：stub 会指向它自己，包装器进程爆栈，桌面版自己的
  // app-server 起不来（应用退到内存兜底，表现是“组织设置无法安全加载”）。
  it("is idempotent when handed an already staged wrapper", async () => {
    const wrapper = await source();
    const root = await mkdtemp(join(tmpdir(), "orbis-wrapper-idempotent-"));
    const staged = stageCodexWrapper(wrapper, root);
    const again = stageCodexWrapper(staged, root);
    expect(again).toEqual(staged);
    const stub = await readFile(staged.script, "utf8");
    expect(stub).toContain("wrapper.js");
    expect(stub).not.toContain(staged.script.replaceAll("\\", "/"));
    expect(stub).not.toContain(staged.script.replaceAll("/", "\\"));
  });
});
