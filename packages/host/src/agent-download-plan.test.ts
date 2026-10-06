/**
 * 下载进度的三个不变量：
 * 1. 计划/探测失败只是"没有数字"，绝不能让安装失败或改变安装方式；
 * 2. 一个包只计一次字节，且只认 npm 日志里真正取完的那一行；
 * 3. 缓存在途字节计入进度，但整体只增不减、不越过总量。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createAgentDownloadTracker, npmCacheInflightBytes, parseLockTarballs, planAgentDownload, type AgentDownloadPlan } from "./agent-download-plan.js";

const lock = (packages: Record<string, unknown>): string => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, ...packages } });

describe("agent download plan", () => {
  it("takes tarball urls from the lockfile, skipping the root, duplicates and non-http entries", () => {
    const entries = parseLockTarballs(lock({
      "node_modules/@openai/codex": { version: "0.160.1", resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.160.1.tgz" },
      "node_modules/@openai/codex-win32-x64": { version: "0.160.1-win32-x64", resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.160.1-win32-x64.tgz" },
      "node_modules/dup": { version: "1.0.0", resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.160.1.tgz" },
      "node_modules/linked": { version: "1.0.0", resolved: "file:../local" },
      "node_modules/root-only": { version: "1.0.0" },
      "": { name: "root", resolved: "https://example.invalid/root.tgz" },
    }));
    expect(entries.map(entry => entry.url)).toEqual([
      "https://registry.npmjs.org/@openai/codex/-/codex-0.160.1.tgz",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.160.1-win32-x64.tgz",
    ]);
    // 名字从 lockfile 的路径段回推，供界面显示。
    expect(entries[1]?.name).toBe("@openai/codex-win32-x64");
  });

  it("counts a completed tarball once and ignores everything else npm logs", () => {
    const plan: AgentDownloadPlan = {
      totalBytes: 300,
      packages: [
        { name: "a", version: "1.0.0", url: "https://r/a.tgz", size: 100 },
        { name: "b", version: "1.0.0", url: "https://r/b.tgz", size: 200 },
      ],
    };
    const track = createAgentDownloadTracker(plan);
    expect(track("npm http fetch GET 200 https://registry.npmjs.org/npm 2815ms")).toBeUndefined();
    expect(track("added 1 package in 4s")).toBeUndefined();
    expect(track("npm http fetch GET 200 https://r/a.tgz 1234ms (cache miss)")).toMatchObject({ receivedBytes: 100, donePackages: 1, totalPackages: 2, totalBytes: 300 });
    // 同一行再来一次不得重复计数（npm 会为缓存命中再打一次同样的行）。
    expect(track("npm http fetch GET 200 https://r/a.tgz 12ms")).toBeUndefined();
    expect(track("npm http fetch GET 200 https://r/b.tgz 900ms")).toMatchObject({ receivedBytes: 300, donePackages: 2 });
  });

  it("reports no plan instead of failing when npm cannot be asked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbis-plan-fail-"));
    try {
      const plan = await planAgentDownload({
        run: async () => { throw new Error("npm exploded"); },
        npm: { command: "node", args: ["npm-cli.js"] },
        spec: "@openai/codex@latest",
        planDir: dir,
        signal: new AbortController().signal,
      });
      expect(plan).toBeUndefined();

      // 拿不到 lockfile 也一样：没有数字而已。
      const missing = await planAgentDownload({
        run: async () => ({ stdout: "", stderr: "" }),
        npm: { command: "node", args: ["npm-cli.js"] },
        spec: "@openai/codex@latest",
        planDir: dir,
        signal: new AbortController().signal,
      });
      expect(missing).toBeUndefined();

      // 有 lockfile 但一个大小都问不出来时仍然给出包数（进度只剩计数）。
      const planDir = await mkdtemp(join(tmpdir(), "orbis-plan-count-"));
      await writeFile(join(planDir, "package-lock.json"), lock({
        "node_modules/a": { version: "1.0.0", resolved: "https://r/a.tgz" },
      }));
      const counted = await planAgentDownload({
        run: async () => ({ stdout: "", stderr: "" }),
        npm: { command: "node", args: ["npm-cli.js"] },
        spec: "a@1.0.0",
        planDir,
        signal: new AbortController().signal,
        probe: async () => undefined,
      });
      expect(counted).toMatchObject({ totalBytes: 0, packages: [{ name: "a", url: "https://r/a.tgz" }] });
      await rm(planDir, { recursive: true, force: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps the package count when one size probe fails", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "orbis-plan-refuse-"));
    await writeFile(join(planDir, "package-lock.json"), lock({
      "node_modules/a": { version: "1.0.0", resolved: "https://r/a.tgz" },
      "node_modules/b": { version: "1.0.0", resolved: "https://r/b.tgz" },
    }));
    const plan = await planAgentDownload({
      run: async () => ({ stdout: "", stderr: "" }),
      npm: { command: "node", args: ["npm-cli.js"] },
      spec: "a@1.0.0",
      planDir,
      signal: new AbortController().signal,
      // a 问得到、b 问不到：整体仍然是可用计划，只是总字节偏小。
      probe: async url => { if (url.endsWith("b.tgz")) throw new Error("range request refused"); return 120; },
    });
    expect(plan).toMatchObject({ totalBytes: 120, packages: [{ name: "a", size: 120 }, { name: "b" }] });
    await rm(planDir, { recursive: true, force: true });
  });
});

describe("install progress wiring", () => {
  it("turns npm's fetch log into download progress events", async () => {
    vi.resetModules();
    const { installAgentPackage } = await import("./agent-installation.js");
    const plan: AgentDownloadPlan = { totalBytes: 500, packages: [{ name: "pi", version: "1.0.0", url: "https://r/pi.tgz", size: 500 }] };
    const progress: Array<{ stage: string; download?: { receivedBytes: number; totalBytes: number; donePackages: number; totalPackages: number } }> = [];
    const seen: string[] = [];

    // npm 会一边跑一边往 stderr 打 "http fetch GET 200 <tarball>"；安装函数必须把它翻成进度。
    const run = async (_command: string, _args: string[], options: { onStderr?: (chunk: string) => void }) => {
      options.onStderr?.("npm http fetch GET 200 https://r/pi.tgz 900ms (cache miss)\n");
      return { stdout: "", stderr: "" };
    };
    const planDir = await mkdtemp(join(tmpdir(), "orbis-install-progress-"));
    try {
      await expect(installAgentPackage(
        "pi", "1.0.0", planDir, new AbortController().signal,
        event => { seen.push(event.stage); progress.push(event); },
        { run, planDir, planDownload: async () => plan },
      )).rejects.toThrow();
    } finally { await rm(planDir, { recursive: true, force: true }); }

    const withDownload = progress.filter(entry => entry.download !== undefined);
    expect(withDownload[0]?.download).toMatchObject({ receivedBytes: 0, totalBytes: 500, donePackages: 0, totalPackages: 1 });
    expect(withDownload.at(-1)?.download).toMatchObject({ receivedBytes: 500, donePackages: 1 });
    expect(seen).toContain("downloading");
  });

  it("counts the bytes npm is still writing to its cache, never backwards and never past the total", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      const { installAgentPackage } = await import("./agent-installation.js");
      const plan: AgentDownloadPlan = { totalBytes: 1000, packages: [{ name: "codex", version: "9.9.9", url: "https://r/codex.tgz", size: 1000 }] };
      const received: number[] = [];
      let inflight = 0;
      // npm 只在包下完时才打日志：巨大 tarball 在途期间，唯一的数字来源是缓存里正在写盘的字节。
      const run = async (_command: string, _args: string[], options: { onStderr?: (chunk: string) => void }) => {
        inflight = 400;
        await vi.advanceTimersByTimeAsync(600);
        inflight = 200; // 采样抖动（包刚被移进 content-v2）不得让进度倒退
        await vi.advanceTimersByTimeAsync(600);
        options.onStderr?.("npm http fetch GET 200 https://r/codex.tgz 900ms (cache miss)\n");
        inflight = 9999; // 采样偏大也不得越过总量
        await vi.advanceTimersByTimeAsync(600);
        return { stdout: "", stderr: "" };
      };
      const planDir = await mkdtemp(join(tmpdir(), "orbis-install-inflight-"));
      try {
        await expect(installAgentPackage(
          "pi", "9.9.9", planDir, new AbortController().signal,
          event => { if (event.download) received.push(event.download.receivedBytes); },
          { run, planDir, planDownload: async () => plan, sampleInflightBytes: async () => inflight },
        )).rejects.toThrow();
      } finally { await rm(planDir, { recursive: true, force: true }); }

      expect(received[0]).toBe(0);
      expect(received).toContain(400);
      expect(received.at(-1)).toBe(1000);
      expect(received).toEqual([...received].sort((left, right) => left - right));
    } finally { vi.useRealTimers(); }
  });

  it("reads in-flight bytes from npm's cache tmp directory and reports zero when the cache is elsewhere", async () => {
    const cache = await mkdtemp(join(tmpdir(), "orbis-cache-"));
    try {
      expect(await npmCacheInflightBytes(cache)).toBe(0);
      const temporary = join(cache, "_cacache", "tmp");
      await mkdir(temporary, { recursive: true });
      await writeFile(join(temporary, "aa"), Buffer.alloc(300));
      await writeFile(join(temporary, "bb"), Buffer.alloc(200));
      expect(await npmCacheInflightBytes(cache)).toBe(500);
    } finally { await rm(cache, { recursive: true, force: true }); }
  });
});
