import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { PiBackend } from "./agent-backend.js";
import { piArchiveRoot, SessionArchiveError, setPiSessionArchived } from "./session-archive.js";
import { listPiSessions } from "./sessions.js";
import { SessionSpawner } from "./spawner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-archive-"));
  roots.push(dir);
  const root = join(dir, "sessions");
  const group = "--project--";
  const sessionId = "test-session";
  const contents = `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: dir })}\n` +
    `${JSON.stringify({ type: "message", id: "entry", parentId: null, message: { role: "user", content: "Keep this history" } })}\n`;
  const file = join(root, group, "session.jsonl");
  const archivedFile = join(piArchiveRoot(root), group, "session.jsonl");
  await mkdir(join(root, group), { recursive: true });
  await writeFile(file, contents);
  return { root, sessionId, file, archivedFile, contents };
}

it("moving and restoring preserve all history without clobbering files, including interrupted moves and retries", async () => {
  const { root, sessionId, file, archivedFile, contents } = await fixture();
  const options = { root, assertIdle: () => {} };
  await setPiSessionArchived(sessionId, true, options);
  expect((await listPiSessions({ root })).sessions).toEqual([]);
  expect((await listPiSessions({ root: piArchiveRoot(root) })).sessions[0]?.sessionId).toBe(sessionId);
  expect(await readFile(archivedFile, "utf8")).toBe(contents);
  await setPiSessionArchived(sessionId, true, options);
  await setPiSessionArchived(sessionId, false, options);
  await setPiSessionArchived(sessionId, false, options);
  expect(await readFile(file, "utf8")).toBe(contents);

  await writeFile(archivedFile, "an unrelated file");
  await expect(setPiSessionArchived(sessionId, true, options)).rejects.toMatchObject({ code: "session_conflict" });
  expect(await readFile(file, "utf8")).toBe(contents);
  expect(await readFile(archivedFile, "utf8")).toBe("an unrelated file");
  await rm(archivedFile);

  // Simulate termination after destination creation, before source removal.
  await link(file, archivedFile);
  await setPiSessionArchived(sessionId, true, options);
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(archivedFile, "utf8")).toBe(contents);

  await writeFile(file, "a conflicting restored path");
  await expect(setPiSessionArchived(sessionId, false, options)).rejects.toMatchObject({ code: "session_conflict" });
  expect(await readFile(file, "utf8")).toBe("a conflicting restored path");
  expect(await readFile(archivedFile, "utf8")).toBe(contents);
  await expect(setPiSessionArchived("../unknown", true, options)).rejects.toMatchObject({ code: "session_not_found" });
});

it("a Pi session still owned by a runtime cannot be moved", async () => {
  const { root, sessionId, file, contents } = await fixture();
  const backend = new PiBackend({
    sessionsRoot: root,
    spawner: new SessionSpawner(),
    runtimeIds: () => ["runtime"],
    sessionIsOnline: (id) => id === sessionId,
    sendCommand: () => false,
  });
  await expect(backend.setArchived(sessionId, true)).rejects.toBeInstanceOf(SessionArchiveError);
  expect(await readFile(file, "utf8")).toBe(contents);
  expect(await backend.catalog(true)).toEqual([]);
});
