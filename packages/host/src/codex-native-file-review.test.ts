import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentKey, RuntimeEvent, TurnChangeSummary } from "@orbis/protocol";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";
import { TurnFileChangeService } from "./turn-file-change-service.js";
import { TurnChangeCoordinator } from "./turn-change-coordinator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function harness(desktop: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "orbis-native-review-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const events: RuntimeEvent[] = [], summaries: TurnChangeSummary[] = [];
  const agent: AgentKey = { hostId: "host", agentKind: desktop ? "codexDesktop" : "codex", sessionId: desktop ? "codex-desktop:thread" : "thread" };
  const server = { mode: desktop ? "desktop" : "owned", notify: vi.fn(), request: vi.fn(async (method: string) => {
    if (method === "thread/resume") return { thread: { id: "thread", cwd, status: { type: "idle" } } };
    return { data: [] };
  }) } as unknown as CodexAppServer;
  const service = new TurnFileChangeService({ directory: join(directory, "state"), scope: () => agent,
    send: (_device, _runtime, event) => { events.push(event); return true; },
    publish: (_runtime, summary) => { summaries.push(structuredClone(summary)); } });
  await service.initialize();
  const coordinator = new TurnChangeCoordinator(service, () => agent,
    () => ({ runtimeId: "runtime", cwd, name: "Codex", status: "running" }));
  const runtime = new CodexRuntime({ server, rolloutRoot: directory, onEvent: event => {
    events.push(event); coordinator.observe(runtime.runtimeIdFor("thread"), event);
  } });
  runtime.onFileChangeEvidence = (id, evidence) => { void coordinator.observeNative(id, evidence); };
  if (desktop) runtime.seedDesktopThreads(["thread"]);
  await runtime.activate({ type: "resume", sessionId: agent.sessionId });
  cleanups.push(async () => { server.onExit?.(0); await coordinator.close(); await service.close(); await rm(directory, { recursive: true, force: true }); });
  const notify = (method: string, value: object) => server.onNotification?.(method, { threadId: "thread", turnId: "turn", ...value });
  const start = () => notify("turn/started", { turn: { id: "turn", startedAt: 1 } });
  const finish = () => notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  return { runtime, service, summaries, events, notify, start, finish, cwd, agent };
}
const patch = (value: string) => `--- a/own.txt\n+++ b/own.txt\n@@ -1 +1 @@\n-original\n+${value}\n`;

describe("Codex native review adapter and durable service", () => {
  it.each([false, true])("uses only committed native revisions, excludes workspace/proposal text and freezes after completion (desktop=%s)", async desktop => {
    const h = await harness(desktop); h.start();
    h.notify("item/started", { item: { type: "fileChange", id: "tool", status: "inProgress", changes: [{ path: "proposal.txt", diff: "UNCOMMITTED_PROPOSAL" }] } });
    h.notify("item/fileChange/patchUpdated", { itemId: "tool", changes: [{ path: "proposal.txt", diff: "UNCOMMITTED_PROPOSAL" }] });
    await writeFile(join(h.cwd, "external.txt"), "EXTERNAL_WORKSPACE_WRITE");
    h.notify("turn/diff/updated", { diff: patch("middle") });
    h.notify("turn/diff/updated", { turnId: "stale", diff: patch("STALE_WRONG_TURN") });
    h.notify("turn/diff/updated", { diff: patch("COMMITTED_FINAL") });
    h.notify("item/completed", { item: { type: "fileChange", id: "tool", status: "completed", changes: [] } });
    h.finish();
    await vi.waitFor(() => expect(h.summaries.at(-1)?.state).toBe("ready"));
    const summary = h.summaries.at(-1)!;
    expect(summary).toMatchObject({ attribution: "native-tool", scope: "native-file-tools", coverage: "partial", fileCount: 1,
      preview: [{ path: "own.txt", additions: 1, deletions: 1 }] });
    expect(h.events.some(event => event.type === "session.change.detail.page")).toBe(false);
    expect(JSON.stringify(h.summaries)).not.toContain("COMMITTED_FINAL");
    h.notify("turn/diff/updated", { diff: patch("LATE_AFTER_COMPLETION") });
    await h.service.request("phone", h.runtime.runtimeIdFor("thread"), { type: "session.change.detail.read",
      runtimeId: h.runtime.runtimeIdFor("thread"), agent: h.agent, requestId: "read", viewerId: "viewer", readId: null,
      changeSetId: summary.changeSetId, manifestVersion: summary.manifestVersion, fileId: summary.preview[0]!.fileId,
      contentVersion: summary.preview[0]!.contentVersion, cursor: null, maxBytes: 1024 });
    expect(h.events.at(-1)).toMatchObject({ type: "session.change.detail.page", text: expect.stringContaining("+COMMITTED_FINAL\n") });
    const text = JSON.stringify(h.events.at(-1));
    for (const absent of ["EXTERNAL_WORKSPACE_WRITE", "UNCOMMITTED_PROPOSAL", "STALE_WRONG_TURN", "LATE_AFTER_COMPLETION"]) expect(text).not.toContain(absent);
  });
  it.each([false, true])("does not treat a declined proposal as an actual file change (desktop=%s)", async desktop => {
    const h = await harness(desktop); h.start();
    h.notify("item/started", { item: { type: "fileChange", id: "tool", status: "inProgress", changes: [{ path: "proposal.txt", diff: patch("proposed") }] } });
    h.notify("item/completed", { item: { type: "fileChange", id: "tool", status: "declined", changes: [{ path: "proposal.txt", diff: patch("proposed") }] } });
    h.finish();
    await vi.waitFor(() => expect(h.summaries.at(-1)?.state).toBe("ready"));
    expect(h.summaries.at(-1)).toMatchObject({ fileCount: 0, preview: [], attribution: "native-tool", coverage: "partial" });
  });
  it.each([false, true])("declares native evidence unavailable when a completed file tool has no usable diff (desktop=%s)", async desktop => {
    const h = await harness(desktop); h.start();
    h.notify("item/completed", { item: { type: "fileChange", id: "tool", status: "completed", changes: [] } });
    h.finish();
    await vi.waitFor(() => expect(h.summaries.at(-1)?.state).toBe("unavailable"));
    expect(h.summaries.at(-1)).toMatchObject({ fileCount: null, preview: [], attribution: "native-tool",
      reasons: expect.arrayContaining(["native-diff-not-observed"]) });
  });
  it.each([false, true])("keeps an unfinished proposal unknown instead of inferring successful zero changes (desktop=%s)", async desktop => {
    const h = await harness(desktop); h.start();
    h.notify("item/started", { item: { type: "fileChange", id: "tool", status: "inProgress", changes: [] } });
    h.finish();
    await vi.waitFor(() => expect(h.summaries.at(-1)?.state).toBe("unavailable"));
    expect(h.summaries.at(-1)).toMatchObject({ fileCount: null, preview: [], coverage: "unavailable" });
  });
});
