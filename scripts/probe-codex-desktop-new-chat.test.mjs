import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * 探针的判定逻辑决定「一次发送产生两个会话」该记在桌面版还是 Orbis 头上，
 * 判错会把修复方向带偏。这里只跑 `--self-test`：喂合成的 otel span 与线程状态，
 * 断言三种结论各自成立；不接真实桌面版、不调模型、不写用户目录。
 */
describe("Codex 桌面版新会话探针", () => {
  it("解析原生日志并在双线程 / Orbis 自建 / 单线程三种场景给出对应结论", () => {
    const result = spawnSync(process.execPath, ["--no-warnings", "scripts/probe-codex-desktop-new-chat.mjs", "--self-test"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("自检通过");
    expect(result.stdout).not.toContain("FAIL");
    expect(result.stdout).toContain("解析 thread/start 的线程与客户端");
    expect(result.stdout).toContain("识别出「一个空草稿 + 一个真正执行」");
  });
});
