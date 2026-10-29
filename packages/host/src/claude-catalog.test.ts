import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeArchiveStore, ClaudeSessionCatalog } from "./claude-catalog.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orbis-claude-catalog-"));
  roots.push(root);
  return root;
}
const rows = (...items: unknown[]) => items.map(item => JSON.stringify(item)).join("\n") + "\n";

describe("ClaudeSessionCatalog", () => {
  it("lists main Sessions newest first with directory, title and first prompt", async () => {
    const config = await temp();
    const project = join(config, "projects", "-repo");
    await mkdir(join(project, "older", "subagents"), { recursive: true });
    await writeFile(join(project, "older.jsonl"), rows(
      { type: "permission-mode", permissionMode: "default", sessionId: "older" },
      { type: "user", uuid: "u", isMeta: true, cwd: "/repo", timestamp: "2026-10-01T00:00:00.000Z", message: { content: "<local-command-caveat>" } },
      { type: "user", uuid: "u2", cwd: "/repo", timestamp: "2026-10-01T00:00:01.000Z", message: { content: "<command-name>/init</command-name><command-args></command-args>" } },
      { type: "ai-title", aiTitle: "Init the repo", sessionId: "older" },
    ));
    await writeFile(join(project, "older", "subagents", "agent-1.jsonl"), rows({ type: "user", cwd: "/repo", message: { content: "x" } }));
    await writeFile(join(project, "newer.jsonl"), rows(
      { type: "user", uuid: "u", cwd: "/repo/app", timestamp: "2026-10-02T00:00:00.000Z", message: { content: [{ type: "text", text: "  修复登录  " }] } },
      { type: "assistant", uuid: "a", cwd: "/repo/app", message: { content: [] } },
      { type: "custom-title", customTitle: "登录修复", sessionId: "newer" },
      { type: "ai-title", aiTitle: "Fix login", sessionId: "newer" },
    ));
    // Metadata alone is not a conversation.
    await writeFile(join(project, "empty.jsonl"), rows({ type: "permission-mode", permissionMode: "default", cwd: "/repo" }));
    await writeFile(join(project, "notes.txt"), "not a transcript");
    await utimes(join(project, "older.jsonl"), new Date(1_000_000), new Date(1_000_000));

    const sessions = await new ClaudeSessionCatalog().scan([config, join(config, "missing")]);
    expect(sessions).toEqual([
      expect.objectContaining({ sessionId: "newer", cwd: "/repo/app", name: "登录修复", firstMessage: "修复登录", createdAt: Date.parse("2026-10-02T00:00:00.000Z") }),
      expect.objectContaining({ sessionId: "older", cwd: "/repo", name: "Init the repo", firstMessage: "/init", modifiedAt: 1_000_000 }),
    ]);
    expect(sessions.every(session => Number.isInteger(session.modifiedAt))).toBe(true);
  });

  it("reads a large transcript's title from its tail and re-reads only changed files", async () => {
    const config = await temp();
    const project = join(config, "projects", "-big");
    await mkdir(project, { recursive: true });
    const path = join(project, "big.jsonl");
    const padding = { type: "assistant", uuid: "pad", cwd: "/big", message: { content: [{ type: "text", text: "x".repeat(70_000) }] } };
    await writeFile(path, rows({ type: "user", uuid: "u", cwd: "/big", message: { content: "start" } }, padding, { type: "ai-title", aiTitle: "Tail title" }));
    const catalog = new ClaudeSessionCatalog();
    expect(await catalog.find("big", [config])).toMatchObject({ name: "Tail title", firstMessage: "start" });
    await writeFile(path, rows({ type: "user", uuid: "u", cwd: "/big", message: { content: "start" } }, padding, { type: "custom-title", customTitle: "Renamed" }));
    expect(await catalog.find("big", [config])).toMatchObject({ name: "Renamed" });
  });
});

describe("ClaudeArchiveStore", () => {
  it("persists archived Session ids without touching transcripts", async () => {
    const dir = await temp();
    const path = join(dir, "state", "claude-archive.json");
    const store = new ClaudeArchiveStore(path);
    expect([...await store.archived()]).toEqual([]);
    await store.set("b-session", true);
    await store.set("a-session", true);
    await store.set("b-session", false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, sessionIds: ["a-session"] });
    expect([...await new ClaudeArchiveStore(path).archived()]).toEqual(["a-session"]);
  });
});
