import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RuntimeEventSchema, type AgentKey, type RuntimeEvent, type TurnChangeSummary, type FileChangeDetailReadRequest } from "@orbis/protocol";
import { TurnFileChangeService } from "./turn-file-change-service.js";
import * as snapshots from "./turn-file-change-snapshot.js";

const agent: AgentKey = { hostId: "host", agentKind: "codex", sessionId: "session" };
const runtimeId = "runtime";
let directory: string, workspace: string, service: TurnFileChangeService;
let events: RuntimeEvent[], summaries: TurnChangeSummary[];
const options = () => ({ directory: join(directory, "state"), scope: () => agent,
  send: (_device: string, _runtime: string, event: RuntimeEvent) => { events.push(RuntimeEventSchema.parse(event)); return true; },
  publish: (_runtime: string, summary: TurnChangeSummary) => { summaries.push(structuredClone(summary)); } });
const begin = async (turn = "turn-1", reliable = true): Promise<void> => {
  await service.begin({ runtimeId, agent, cwd: workspace, reviewTurnId: turn, reliable });
  service.observeTurn(runtimeId, `native-${turn}`);
};
const finish = async (anchor = "entry-1"): Promise<TurnChangeSummary> => {
  await service.finish(runtimeId, { anchorEntryId: anchor, outcome: "completed" }); await service.settled();
  return summaries.at(-1)!;
};
const detail = (summary: TurnChangeSummary, fileIndex = 0, cursor: string | null = null): FileChangeDetailReadRequest => ({
  type: "session.change.detail.read", runtimeId, agent, requestId: randomUUID(), viewerId: randomUUID(), readId: null, cursor, maxBytes: 1024,
  changeSetId: summary.changeSetId, manifestVersion: summary.manifestVersion, fileId: summary.preview[fileIndex]!.fileId, contentVersion: summary.preview[fileIndex]!.contentVersion,
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "orbis-turn-changes-")); workspace = join(directory, "workspace"); await mkdir(workspace);
  events = []; summaries = []; service = new TurnFileChangeService(options()); await service.initialize();
});
afterEach(async () => { vi.restoreAllMocks(); await service.close(); await rm(directory, { recursive: true, force: true }); });

describe("Host turn file changes", () => {
  it("compares real dirty baselines, net changes, deletions and new files without changing Git", async () => {
    execFileSync("git", ["init", "-q", workspace]);
    await writeFile(join(workspace, "dirty.txt"), "already dirty\n"); await writeFile(join(workspace, "deleted.txt"), "old\n");
    await writeFile(join(workspace, "same.txt"), "same\n");
    execFileSync("git", ["-C", workspace, "add", "."]);
    const index = await readFile(join(workspace, ".git", "index"));
    await begin();
    await writeFile(join(workspace, "dirty.txt"), "new\n");
    await writeFile(join(workspace, "same.txt"), "temporary\n"); await writeFile(join(workspace, "same.txt"), "same\n");
    await writeFile(join(workspace, "ephemeral.txt"), "gone\n"); await rm(join(workspace, "ephemeral.txt"));
    await rm(join(workspace, "deleted.txt")); await writeFile(join(workspace, "new.txt"), "one\ntwo\n");
    const summary = await finish();
    expect(summary).toMatchObject({ state: "ready", coverage: "complete", fileCount: 3, addedFiles: 1, deletedFiles: 1, modifiedFiles: 1, additions: 3, deletions: 2, sourceTurnIds: ["native-turn-1"] });
    expect(summary.preview.map(file => file.path)).toEqual(["deleted.txt", "dirty.txt", "new.txt"]);
    expect(await readFile(join(workspace, ".git", "index"))).toEqual(index);
    expect(events).toHaveLength(0); // summary publication is metadata only, never a detail transfer
  });
  it("disables repository fsmonitor hooks and the untracked cache while enumerating", async () => {
    execFileSync("git", ["init", "-q", workspace]);
    await writeFile(join(workspace, "tracked.txt"), "before\n");
    execFileSync("git", ["-C", workspace, "add", "tracked.txt"]);
    const hook = join(directory, "fsmonitor-hook"), marker = `${hook}.marker`;
    await writeFile(hook, '#!/bin/sh\nprintf "called\\n" > "$0.marker"\nprintf "token\\0"\n'); await chmod(hook, 0o700);
    execFileSync("git", ["-C", workspace, "config", "core.fsmonitor", hook]);
    execFileSync("git", ["-C", workspace, "config", "core.untrackedCache", "true"]);
    execFileSync("git", ["-C", workspace, "update-index", "--fsmonitor"]);
    await rm(marker, { force: true });
    execFileSync("git", ["-C", workspace, "ls-files", "--cached", "--others", "--exclude-standard"]);
    expect(await readFile(marker, "utf8")).toBe("called\n"); // Prove the fixture really executes without the override.
    await rm(marker); const index = await readFile(join(workspace, ".git", "index"));
    await begin(); await writeFile(join(workspace, "tracked.txt"), "after\n"); const summary = await finish();
    expect(summary).toMatchObject({ coverage: "complete", fileCount: 1, additions: 1, deletions: 1 });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(workspace, ".git", "index"))).toEqual(index);
  });
  it("limits actual detail reads to four globally, including cancelled reads until they settle", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "new\n"); const summary = await finish();
    const originalRead = snapshots.readCapturedText;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(snapshots, "readCapturedText").mockImplementation(async (...args) => { await gate; return originalRead(...args); });
    const requests = Array.from({ length: 4 }, () => detail(summary));
    const pending = requests.map((request, index) => service.request(`phone-${index}`, runtimeId, request));
    try {
      const fifth = detail(summary);
      await service.request("phone-5", runtimeId, fifth);
      expect(events.at(-1)).toMatchObject({ requestId: fifth.requestId, reason: "busy" });
      await service.request("phone-0", runtimeId, { type: "session.change.detail.cancel", runtimeId, requestId: "cancel", viewerId: requests[0]!.viewerId, readId: null });
      const afterCancel = detail(summary); await service.request("phone-5", runtimeId, afterCancel);
      expect(events.at(-1)).toMatchObject({ requestId: afterCancel.requestId, reason: "busy" });
      release(); await Promise.all(pending);
      expect(events.some(event => event.type === "session.change.detail.page" && event.requestId === requests[0]!.requestId)).toBe(false);
      expect(events.filter(event => event.type === "session.change.detail.page")).toHaveLength(3);
      const retry = detail(summary); await service.request("phone-5", runtimeId, retry);
      expect(events.at(-1)).toMatchObject({ type: "session.change.detail.page", requestId: retry.requestId });
    } finally { release(); await Promise.all(pending); }
  });
  it("renews an idle detail lease only for the same device, runtime, viewer and comparison", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "a".repeat(3000)); await writeFile(join(workspace, "b.txt"), "b".repeat(3000)); const summary = await finish();
    const first = detail(summary); await service.request("phone", runtimeId, first);
    const page = events.at(-1)!; if (page.type !== "session.change.detail.page") throw new Error("page_missing");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const next = { ...first, requestId: "renew", cursor: page.nextCursor, readId: page.readId };
    await service.request("another-phone", runtimeId, { ...next, requestId: "wrong-device" });
    expect(events.at(-1)).toMatchObject({ requestId: "wrong-device", reason: "expired" });
    await service.request("phone", runtimeId, { ...next, requestId: "wrong-viewer", viewerId: "another-viewer" });
    expect(events.at(-1)).toMatchObject({ requestId: "wrong-viewer", reason: "expired" });
    await service.request("phone", "another-runtime", { ...next, requestId: "wrong-runtime", runtimeId: "another-runtime" });
    expect(events.at(-1)).toMatchObject({ requestId: "wrong-runtime", reason: "expired" });
    await service.request("phone", runtimeId, { ...next, requestId: "wrong-comparison", fileId: summary.preview[1]!.fileId, contentVersion: summary.preview[1]!.contentVersion });
    expect(events.at(-1)).toMatchObject({ requestId: "wrong-comparison", reason: "expired" });
    await service.request("phone", runtimeId, { ...next, requestId: "wrong-cursor", cursor: "0.invalid" });
    expect(events.at(-1)).toMatchObject({ requestId: "wrong-cursor", reason: "invalid-cursor" });
    await service.request("phone", runtimeId, next);
    expect(events.at(-1)).toMatchObject({ type: "session.change.detail.page", requestId: "renew", readId: page.readId });
  });
  it("does not let an expired lease keep obsolete content alive or revive evicted versions", async () => {
    await service.close(); service = new TurnFileChangeService({ ...options(), retentionMs: 60_000 });
    await begin(); await writeFile(join(workspace, "a.txt"), "a".repeat(3000)); const summary = await finish();
    const first = detail(summary); await service.request("phone", runtimeId, first);
    const page = events.at(-1)!; if (page.type !== "session.change.detail.page") throw new Error("page_missing");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    await begin("next-turn"); await finish("next-anchor"); // Maintenance expires old bytes, not retained metadata.
    await service.request("phone", runtimeId, { ...first, requestId: "evicted-old-lease", cursor: page.nextCursor, readId: page.readId });
    expect(events.at(-1)).toMatchObject({ requestId: "evicted-old-lease", reason: "expired" });
    await service.request("phone", runtimeId, { ...first, requestId: "evicted-new-lease", cursor: page.nextCursor, readId: null });
    expect(events.at(-1)).toMatchObject({ requestId: "evicted-new-lease", reason: "expired" });
  });
  it("retains the per-device two-read and per-viewer single-read limits", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "new\n"); const summary = await finish();
    const originalRead = snapshots.readCapturedText;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(snapshots, "readCapturedText").mockImplementation(async (...args) => { await gate; return originalRead(...args); });
    const first = detail(summary), second = detail(summary);
    const pending = [service.request("phone", runtimeId, first)];
    try {
      const duplicate = { ...first, requestId: "duplicate" }; await service.request("phone", runtimeId, duplicate);
      expect(events.at(-1)).toMatchObject({ requestId: "duplicate", reason: "busy" });
      pending.push(service.request("phone", runtimeId, second));
      const third = detail(summary); await service.request("phone", runtimeId, third);
      expect(events.at(-1)).toMatchObject({ requestId: third.requestId, reason: "busy" });
      release(); await Promise.all(pending);
      expect(events.filter(event => event.type === "session.change.detail.page")).toHaveLength(2);
    } finally { release(); await Promise.all(pending); }
  });
  it("keeps historical bytes after another turn and Host restart", async () => {
    await writeFile(join(workspace, "a.txt"), "before\n"); await begin(); await writeFile(join(workspace, "a.txt"), "after\n");
    const first = await finish();
    await begin("turn-2"); await writeFile(join(workspace, "a.txt"), "much later\n"); await finish("entry-2");
    await service.close(); service = new TurnFileChangeService(options()); await service.initialize();
    await service.request("phone", runtimeId, detail(first));
    const page = events.at(-1)!;
    expect(page.type).toBe("session.change.detail.page");
    if (page.type === "session.change.detail.page") { expect(page.text).toContain("-before\n+after\n"); expect(page.text).not.toContain("much later"); }
  });
  it("lists only requested visible anchors or native aliases and never includes contents", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "SECRET_CONTENT\n"); const summary = await finish();
    await service.request("phone", runtimeId, { type: "session.changes.list", runtimeId, agent, requestId: "list", entryIds: [], turnIds: [] });
    expect(events.at(-1)).toMatchObject({ summaries: [], nextCursor: null });
    await service.request("phone", runtimeId, { type: "session.changes.list", runtimeId, agent, requestId: "list2", entryIds: [], turnIds: ["native-turn-1"] });
    expect(events.at(-1)).toMatchObject({ summaries: [summary] });
    expect(JSON.stringify(events)).not.toContain("SECRET_CONTENT");
    await service.request("phone", runtimeId, { type: "session.changes.read", runtimeId, agent, requestId: "manifest", changeSetId: summary.changeSetId, manifestVersion: 1, cursor: null, maxItems: 100 });
    expect(events.at(-1)).toMatchObject({ totalCount: 1, nextCursor: null });
    expect(JSON.stringify(events)).not.toContain("SECRET_CONTENT");
  });
  it("pages Unicode/escaped long lines within wire budget and resumes after cancelling a lease", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), '😀\t"\\'.repeat(30_000)); const summary = await finish();
    let request = { ...detail(summary), maxBytes: 48 * 1024 };
    let text = "", pages = 0;
    do {
      await service.request("phone", runtimeId, request); const page = events.at(-1)!;
      expect(page.type).toBe("session.change.detail.page"); if (page.type !== "session.change.detail.page") throw new Error("page_missing");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(60 * 1024);
      text += page.text; pages++;
      await service.request("phone", runtimeId, { type: "session.change.detail.cancel", requestId: randomUUID(), runtimeId, viewerId: request.viewerId, readId: page.readId });
      request = { ...request, requestId: randomUUID(), viewerId: randomUUID(), cursor: page.nextCursor, readId: null };
    } while (request.cursor !== null);
    expect(pages).toBeGreaterThan(1); expect(text).toContain('😀\t"\\'.repeat(30_000)); expect(text).toContain("No newline at end of file");
  });
  it("rejects cross-session, changed versions, and cursors from other files", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "x".repeat(2000)); await writeFile(join(workspace, "b.txt"), "y".repeat(2000)); const summary = await finish();
    await service.request("phone", runtimeId, { ...detail(summary), agent: { ...agent, sessionId: "other" } });
    expect(events.at(-1)).toMatchObject({ reason: "scope-mismatch" });
    await service.request("phone", runtimeId, { ...detail(summary), contentVersion: "wrong" });
    expect(events.at(-1)).toMatchObject({ reason: "version-mismatch" });
    await service.request("phone", runtimeId, detail(summary)); const page = events.at(-1)!;
    if (page.type !== "session.change.detail.page") throw new Error("page_missing");
    await service.request("phone", runtimeId, detail(summary, 1, page.nextCursor));
    expect(events.at(-1)).toMatchObject({ reason: "invalid-cursor" });
  });
  it("declares observed-only and incomplete capture rather than inventing additions", async () => {
    await service.close(); service = new TurnFileChangeService({ ...options(), captureBudget: { maxEntries: 1 } });
    await writeFile(join(workspace, "a.txt"), "old\n"); await writeFile(join(workspace, "b.txt"), "old\n");
    await begin("partial", false); await writeFile(join(workspace, "a.txt"), "new\n"); const summary = await finish();
    expect(summary.coverage).toBe("partial"); expect(summary.reasons).toContain("start-boundary-unconfirmed"); expect(summary.reasons).toContain("capture-entry-budget");
  });
  it("does not traverse symlinks and distinguishes binary and oversize metadata", async () => {
    await service.close(); service = new TurnFileChangeService({ ...options(), captureBudget: { maxFileBytes: 100 } });
    await writeFile(join(directory, "outside"), "secret"); await begin();
    await symlink(join(directory, "outside"), join(workspace, "link")); await writeFile(join(workspace, "binary"), Buffer.from([0, 1, 2])); await writeFile(join(workspace, "large"), "x".repeat(101));
    const summary = await finish();
    expect(summary.preview.map(file => [file.path, file.detail])).toEqual([["binary", "binary"], ["large", "too-large"], ["link", "unsupported"]]);
    expect(summary.additions).toBeNull(); expect(summary.fileCount).toBe(3);
  });
  it("reports rename as a deletion and addition without guessing identity", async () => {
    await writeFile(join(workspace, "old.txt"), "same\n"); await begin(); await rename(join(workspace, "old.txt"), join(workspace, "new.txt"));
    expect(await finish()).toMatchObject({ fileCount: 2, addedFiles: 1, deletedFiles: 1 });
  });
  it("preserves a UTF-8 BOM and distinguishes an added empty file from no changes", async () => {
    await begin(); await writeFile(join(workspace, "bom.txt"), "\ufeffhello\n"); await writeFile(join(workspace, "empty.txt"), "");
    const summary = await finish(); expect(summary.fileCount).toBe(2);
    expect(summary.preview[1]).toMatchObject({ path: "empty.txt", changeKind: "added", additions: 0, deletions: 0 });
    await service.request("phone", runtimeId, detail(summary));
    const page = events.at(-1)!; if (page.type !== "session.change.detail.page") throw new Error("page_missing");
    expect(page.text).toContain("+\ufeffhello\n");
    await begin("unchanged"); expect(await finish("entry-2")).toMatchObject({ fileCount: 0, additions: 0, deletions: 0 });
  });
  it("keeps metadata when content budget is exhausted and bounds stored bytes", async () => {
    await service.close(); service = new TurnFileChangeService({ ...options(), maxStorageBytes: 5 });
    await begin(); await writeFile(join(workspace, "a.txt"), "larger than quota\n");
    const summary = await finish();
    expect(summary).toMatchObject({ coverage: "partial", fileCount: 1 });
    expect(summary.reasons).toContain("content-storage-budget");
    expect(summary.preview[0]).toMatchObject({ changeKind: "added", detail: "not-captured", additions: null });
  });
  it("marks native overlap without changing the immutable comparison identity", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "new\n"); const before = summaries.at(-1)!;
    service.markUnreliable(runtimeId, "next-turn-started-before-end-capture", "turn-1");
    const summary = await finish();
    expect(summary.coverage).toBe("partial"); expect(summary.changeSetId).toBe(before.changeSetId);
    expect(summary.reasons).toContain("next-turn-started-before-end-capture");
  });
  it("publishes monotonically versioned durable summaries and keeps the revision on restart", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "new\n"); const ready = await finish();
    service.observeAnchor(runtimeId, "turn-1", "late-canonical-anchor"); await service.settled();
    const revisions = summaries.map(summary => summary.revision);
    expect(revisions.length).toBeGreaterThanOrEqual(4);
    expect(revisions.every((revision, index) => revision > (revisions[index - 1] ?? 0))).toBe(true);
    const latest = summaries.at(-1)!;
    expect(latest.manifestVersion).toBe(ready.manifestVersion);
    expect(JSON.parse(await readFile(join(directory, "state", "records", latest.changeSetId + ".json"), "utf8")).summary.revision).toBe(latest.revision);
    await service.close(); service = new TurnFileChangeService(options()); await service.initialize();
    await service.request("phone", runtimeId, { type: "session.changes.list", agent, runtimeId, requestId: "durable", entryIds: ["late-canonical-anchor"], turnIds: [] });
    expect(events.at(-1)).toMatchObject({ summaries: [{ revision: latest.revision, state: "ready", anchorEntryId: "late-canonical-anchor" }] });
  });
  it("stops pending comparisons promptly while retaining completed history", async () => {
    await begin("completed"); await writeFile(join(workspace, "a.txt"), "completed content\n"); const completed = await finish("completed-anchor");
    await begin("stopping");
    for (let i = 0; i < 20; i++) await writeFile(join(workspace, `pending-${i}.txt`), `new-${i}\n`);
    await service.finish(runtimeId, { anchorEntryId: "stopping-anchor", outcome: "completed" });
    const started = Date.now(); await service.close(); expect(Date.now() - started).toBeLessThan(2500);
    service = new TurnFileChangeService(options()); await service.initialize();
    await service.request("phone", runtimeId, { type: "session.changes.list", agent, runtimeId, requestId: "stopped", entryIds: ["stopping-anchor"], turnIds: [] });
    expect(events.at(-1)).toMatchObject({ summaries: [{ state: "unavailable", reasons: ["host-stopped-before-comparison"] }] });
    await service.request("phone", runtimeId, detail(completed)); expect(events.at(-1)?.type).toBe("session.change.detail.page");
  });
  it("records an orphan finish as unavailable rather than an empty synthetic turn", async () => {
    await writeFile(join(workspace, "already-written.txt"), "changes happened before attachment\n");
    await service.begin({ runtimeId, agent, cwd: workspace, reviewTurnId: "orphan", reliable: false, capture: false });
    service.observeTurn(runtimeId, "native-orphan"); const summary = await finish();
    expect(summary).toMatchObject({ state: "unavailable", coverage: "unavailable", fileCount: null, additions: null,
      deletions: null, reasons: ["start-not-captured"], preview: [], sourceTurnIds: ["native-orphan"] });
  });
  it("keeps cancelled-turn modifications and marks interrupted captures unavailable after restart", async () => {
    await begin(); await writeFile(join(workspace, "a.txt"), "partial\n");
    await service.finish(runtimeId, { outcome: "cancelled" }); await service.settled();
    expect(summaries.at(-1)).toMatchObject({ outcome: "cancelled", fileCount: 1 });
    await begin("interrupted"); await service.close(); service = new TurnFileChangeService(options()); await service.initialize();
    await service.request("phone", runtimeId, { type: "session.changes.list", agent, runtimeId, requestId: "recover", entryIds: [], turnIds: ["interrupted"] });
    expect(events.at(-1)).toMatchObject({ summaries: [{ state: "unavailable", coverage: "unavailable", reasons: ["host-restarted-during-capture"] }] });
  });
});
