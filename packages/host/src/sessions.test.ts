/**
 * 会话扫描与目录浏览（spec §8.1）的单元验证。
 *
 * 核心契约：**cwd 的权威来源是会话文件首行**，目录名的有损编码只用于分组，绝不反解。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { browseDirectory, listPiSessions } from "./sessions.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** 造一个 encoded 目录 + 会话文件。文件名形如 `<ts>_<uuid>.jsonl`。 */
async function writeSession(root: string, cwd: string, sessionId: string, name?: string): Promise<string> {
  const encoded = `--${cwd.replaceAll(/[\\/:]/gu, "-")}--`;
  const groupDir = join(root, encoded);
  await mkdir(groupDir, { recursive: true });
  const file = join(groupDir, `2099-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2099-01-01T00:00:00.000Z",
    cwd,
  };
  if (name !== undefined) header.name = name;
  await writeFile(file, `${JSON.stringify(header)}\n{"type":"message","id":"m1"}\n`, "utf8");
  return file;
}

describe("listPiSessions", () => {
  it("从会话文件首行读出 id 与 cwd，目录从不反解", async () => {
    const root = await tempRoot();
    const cwd = join(root, "some-project");
    await writeSession(root, cwd, "11111111-2222-3333-4444-555555555555");

    const scan = await listPiSessions({ root });
    expect(scan.cwds.has(cwd.toUpperCase()) || scan.cwds.has(cwd)).toBe(true);
    expect(scan.sessions).toHaveLength(1);
    const entry = scan.sessions[0]!;
    expect(entry.agentKind).toBe("pi");
    expect(entry.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(entry.cwd).toBe(cwd);
    expect(scan.files.get(entry.sessionId)).toMatch(/11111111-2222-3333-4444-555555555555\.jsonl$/);
  });

  it("cwd 含连字符时不被目录名编码骗到", async () => {
    const root = await tempRoot();
    // 目录名编码后 `D--a-b-c--` 可能对应多种真实路径；只有文件里的 cwd 是权威。
    const cwd = "D:\\a-b-c";
    await writeSession(root, cwd, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const scan = await listPiSessions({ root });
    expect(scan.sessions[0]?.cwd).toBe(cwd);
  });

  it("summaries: false 只取 cwd 集合，不逐文件扫描", async () => {
    const root = await tempRoot();
    await writeSession(root, join(root, "proj"), "11111111-2222-3333-4444-555555555555");

    const scan = await listPiSessions({ root, summaries: false });
    expect(scan.sessions).toEqual([]);
    expect(scan.files.size).toBe(0);
    expect(scan.cwds.size).toBe(1);
  });

  it("根目录不存在时返回空，而不是抛错", async () => {
    const scan = await listPiSessions({ root: join(await tempRoot(), "nope") });
    expect(scan.sessions).toEqual([]);
    expect(scan.cwds.size).toBe(0);
  });

  it("非 session 首行的文件被跳过", async () => {
    const root = await tempRoot();
    const groupDir = join(root, "--junk--");
    await mkdir(groupDir);
    await writeFile(join(groupDir, "x.jsonl"), "not json\n", "utf8");

    const scan = await listPiSessions({ root });
    expect(scan.sessions).toEqual([]);
  });
});

describe("browseDirectory", () => {
  it("空路径返回盘符（Windows），其中包含本目录所在盘", async () => {
    const { platform } = await import("node:os");
    const root = await tempRoot();
    const result = await browseDirectory(undefined, new Set());
    if (platform() === "win32") {
      expect(result.path).toBe("");
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries.every((entry) => entry.isDir)).toBe(true);
      const rootDrive = `${root.slice(0, 2).toUpperCase()}\\`;
      expect(result.entries.some((entry) => entry.name.toUpperCase() === rootDrive)).toBe(true);
    } else {
      expect(result.entries).toEqual([{ name: "/", isDir: true, hasSessions: false }]);
    }
  });

  it("列出子目录并标记 hasSessions", async () => {
    const root = await tempRoot();
    const project = join(root, "with-history");
    const empty = join(root, "empty");
    await mkdir(project);
    await mkdir(empty);
    await writeFile(join(project, "file.txt"), "x", "utf8");
    await writeFile(join(root, "report 中文.txt"), "download me", "utf8");

    const result = await browseDirectory(root, new Set([project.toUpperCase()]));
    expect(result.path).toBe(root);
    expect(result.entries).toContainEqual({ name: "with-history", isDir: true, hasSessions: true });
    expect(result.entries).toContainEqual({ name: "empty", isDir: true, hasSessions: false });
    expect(result.entries).toContainEqual({ name: "report 中文.txt", isDir: false, hasSessions: false });
    expect(result.entries.map((entry) => entry.isDir)).toEqual([true, true, false]);
    expect(result.parent).toBeDefined();
  });

  it("目录里没有任何子目录时返回空 entries，parent 指向上级", async () => {
    const root = await tempRoot();
    const leaf = join(root, "leaf");
    await mkdir(leaf);

    const result = await browseDirectory(leaf, new Set());
    expect(result.entries).toEqual([]);
    expect(result.parent).toBe(root);
  });

  it("文件目录可以逐层浏览，并返回可直接下载的原始文件名", async () => {
    const root = await tempRoot();
    const nested = join(root, "build output");
    await mkdir(nested);
    await writeFile(join(nested, "应用 v1.apk"), "apk", "utf8");
    const result = await browseDirectory(nested, new Set());
    expect(result.entries).toEqual([{ name: "应用 v1.apk", isDir: false, hasSessions: false }]);
    expect(result.path).toBe(nested);
    expect(result.parent).toBe(root);
    await expect(browseDirectory(join(root, "missing"), new Set())).rejects.toThrow();
  });
});
