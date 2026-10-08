import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexClientRefreshCoordinator,
  FileCodexRefreshJournal,
  type CodexRefreshAction,
  type CodexRefreshDriver,
  type CodexRefreshJournal,
  type CodexRefreshJournalEntry,
  type CodexRefreshObservation,
  type CodexRefreshOperation,
  type CodexRefreshPlan,
  type CodexRefreshRequest,
  type CodexRefreshThread,
} from "./codex-client-refresh.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const request: CodexRefreshRequest = { operationId: "revert-1", backendId: "desktop", threadId: "parent", historyRevision: "generation-7" };
function thread(threadId: string, archived = false, loaded = true, subscribed = true): CodexRefreshThread {
  return { threadId, archived, loaded, subscribed, idle: true, queuedWork: false, pendingApproval: false };
}

function memoryJournal() {
  const entries = new Map<string, CodexRefreshJournalEntry>();
  const writes: CodexRefreshJournalEntry[] = [];
  const journal: CodexRefreshJournal = {
    list: async () => structuredClone([...entries.values()]),
    save: vi.fn<CodexRefreshJournal["save"]>(async entry => {
      writes.push(structuredClone(entry));
      entries.set(entry.request.operationId, structuredClone(entry));
    }),
  };
  return { journal, writes, entries };
}

function harness(kind: "desktop" | "tui" = "desktop") {
  const store = memoryJournal();
  const plan: CodexRefreshPlan = {
    client: kind === "desktop"
      ? { kind: "desktop", instanceId: "wrapper-start-1", compatibilityVersion: "26.930.7945", desktopHostId: "local" }
      : { kind: "tui", instanceId: "process-1", launchId: "launch-1", pid: 411, processStartedAt: "2026-10-08T00:00:00Z",
        cwd: "D:/repo", endpoint: "ws://127.0.0.1:5550", command: "D:/codex.exe", prefixArgs: [] },
    affected: [thread("parent")],
  };
  const observed: CodexRefreshObservation = {
    ownership: "verified", historyRevision: request.historyRevision, scopeComplete: true,
    concurrentAction: "none", threads: structuredClone(plan.affected),
    ...(kind === "tui" ? { tui: { original: "running", replacement: "not_started" } as const } : {}),
  };
  const actions: CodexRefreshAction[] = [];
  const performDefault = async (operation: CodexRefreshOperation, action: CodexRefreshAction): Promise<{ outcome: "applied" }> => {
    actions.push(structuredClone(action));
    if (action.kind === "archive") {
      for (const candidate of observed.threads) {
        if (!candidate.archived) { candidate.archived = true; candidate.archivedBy = operation.request.operationId; }
        if (candidate.loaded) { candidate.loaded = false; candidate.unloadedBy = operation.request.operationId; }
        if (candidate.subscribed) { candidate.subscribed = false; candidate.unsubscribedBy = operation.request.operationId; }
      }
    } else if (action.kind === "unarchive") observed.threads.find(candidate => candidate.threadId === action.threadId)!.archived = false;
    else if (action.kind === "load") observed.threads.find(candidate => candidate.threadId === action.threadId)!.loaded = true;
    else if (action.kind === "subscribe") observed.threads.find(candidate => candidate.threadId === action.threadId)!.subscribed = true;
    else if (action.kind === "close_tui") observed.tui = { original: "exited", closedBy: operation.request.operationId, replacement: "not_started" };
    else if (action.kind === "open_tui") {
      observed.tui!.replacement = "running";
      observed.tui!.replacementOperationId = operation.request.operationId;
    }
    return { outcome: "applied" };
  };
  const driver: CodexRefreshDriver = {
    prepare: vi.fn<CodexRefreshDriver["prepare"]>(async () => ({ ready: true, plan })),
    inspect: vi.fn(async () => structuredClone(observed)),
    perform: vi.fn(performDefault),
  };
  return { ...store, plan, observed, actions, driver, performDefault, coordinator: new CodexClientRefreshCoordinator(store.journal, driver) };
}

describe("Codex client refresh recovery", () => {
  it("persists every side effect first, restores the subtree, and waits for actual GUI hydration", async () => {
    const h = harness();
    h.plan.affected.push(thread("child"), thread("archived-child", true), thread("inactive-child", true, false, false));
    h.observed.threads = structuredClone(h.plan.affected);
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      const saved = h.entries.get(request.operationId) as CodexRefreshOperation;
      expect(saved.phase).not.toBe("prepared");
      expect(saved.inFlight).toEqual(action);
      return h.performDefault(operation, action);
    });
    expect(await h.coordinator.start(request)).toMatchObject({ status: "awaiting_confirmation", historyReverted: true });
    expect(h.actions).toEqual([
      { kind: "archive", threadId: "parent" },
      { kind: "unarchive", threadId: "parent" }, { kind: "unarchive", threadId: "child" },
      { kind: "load", threadId: "parent" }, { kind: "load", threadId: "child" }, { kind: "load", threadId: "archived-child" },
      { kind: "subscribe", threadId: "parent" }, { kind: "subscribe", threadId: "child" }, { kind: "subscribe", threadId: "archived-child" },
      { kind: "open_desktop" },
    ]);
    expect(h.observed.threads.find(candidate => candidate.threadId === "archived-child")!.archived).toBe(true);
    h.observed.hydratedHistoryRevision = "generation-6";
    expect((await h.coordinator.recover(request.operationId)).status).toBe("awaiting_confirmation");
    h.observed.hydratedHistoryRevision = request.historyRevision;
    expect((await h.coordinator.recover(request.operationId)).status).toBe("complete");
    const receipt = h.entries.get(request.operationId)!;
    expect(receipt.kind).toBe("receipt");
    expect(receipt).not.toHaveProperty("plan");
    expect(await h.coordinator.pending()).toEqual([]);
  });

  it("coalesces duplicate and reordered callers by the committed history revision", async () => {
    const h = harness();
    h.observed.hydratedHistoryRevision = request.historyRevision;
    const results = await Promise.all([
      h.coordinator.start(request),
      h.coordinator.start({ ...request, operationId: "notification-1" }),
      h.coordinator.start({ ...request, operationId: "reconnect-1" }),
    ]);
    expect(results.map(candidate => candidate.status)).toEqual(["complete", "complete", "complete"]);
    expect(h.actions.filter(action => action.kind === "archive")).toHaveLength(1);
    expect(h.actions.filter(action => action.kind === "open_desktop")).toHaveLength(1);
    expect(h.driver.prepare).toHaveBeenCalledTimes(1);
    expect(await h.coordinator.start({ ...request, threadId: "wrong" })).toMatchObject({ status: "manual_required", reason: "refresh_operation_identity_mismatch" });
  });

  it("restarts after an unknown archive result, inspects first, and never repeats archive", async () => {
    const h = harness();
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      await h.performDefault(operation, action);
      if (action.kind === "archive") throw new Error("RPC timeout after commit");
      return { outcome: "applied" };
    });
    expect(await h.coordinator.start(request)).toMatchObject({ status: "recovery_pending", reason: "client_refresh_action_result_unknown" });
    expect(h.actions).toEqual([{ kind: "archive", threadId: "parent" }]);
    const restarted = new CodexClientRefreshCoordinator(h.journal, h.driver);
    h.observed.inFlightStatus = "pending";
    expect((await restarted.recover(request.operationId)).status).toBe("recovery_pending");
    expect(h.actions).toHaveLength(1);
    h.observed.inFlightStatus = "applied";
    expect((await restarted.recover(request.operationId)).status).toBe("awaiting_confirmation");
    expect(h.actions.filter(action => action.kind === "archive")).toHaveLength(1);
    expect(h.actions.filter(action => action.kind === "unarchive")).toHaveLength(1);
  });

  it("compensates archive that failed after unloading, without claiming transcript refresh", async () => {
    const h = harness();
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      if (action.kind === "archive") {
        h.actions.push(action);
        h.observed.threads[0]!.loaded = false;
        h.observed.threads[0]!.unloadedBy = operation.request.operationId;
        h.observed.inFlightStatus = "partially_applied";
        throw new Error("unloaded but archive persistence failed");
      }
      return h.performDefault(operation, action);
    });
    expect(await h.coordinator.start(request)).toMatchObject({ status: "manual_required", reason: "history_reverted_client_archive_not_confirmed_original_state_restored" });
    expect(h.actions).toEqual([{ kind: "archive", threadId: "parent" }, { kind: "load", threadId: "parent" }]);
    expect(h.entries.get(request.operationId)!.kind).toBe("receipt");
  });

  it("does not race a still-pending archive with compensation or a second open", async () => {
    const h = harness();
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (_operation, action) => {
      h.actions.push(action);
      return { outcome: "unknown" };
    });
    expect((await h.coordinator.start(request)).status).toBe("recovery_pending");
    expect(h.actions).toEqual([{ kind: "archive", threadId: "parent" }]);
    h.observed.inFlightStatus = "pending";
    expect((await h.coordinator.recover(request.operationId)).status).toBe("recovery_pending");
    expect(h.actions).toHaveLength(1);
  });

  it("retains failed compensation, retries only that phase, and does not repeat successful archive", async () => {
    const h = harness();
    let attempts = 0;
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      if (action.kind === "unarchive" && attempts++ === 0) return { outcome: "not_applied", reason: "permission denied" };
      return h.performDefault(operation, action);
    });
    expect(await h.coordinator.start(request)).toMatchObject({ status: "recovery_pending", reason: "permission denied" });
    expect(h.observed.threads[0]!.archived).toBe(true);
    expect((await h.coordinator.pending())[0]!.phase).toBe("restoring");
    expect((await h.coordinator.recover(request.operationId)).status).toBe("awaiting_confirmation");
    expect(h.actions.filter(action => action.kind === "archive")).toHaveLength(1);
  });

  it("does not replay an open with an unknown result, including after Host restart", async () => {
    const h = harness();
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      if (action.kind === "open_desktop") { h.actions.push(action); return { outcome: "unknown" }; }
      return h.performDefault(operation, action);
    });
    expect((await h.coordinator.start(request)).status).toBe("recovery_pending");
    expect((await new CodexClientRefreshCoordinator(h.journal, h.driver).recover(request.operationId)).status).toBe("recovery_pending");
    expect(h.actions.filter(action => action.kind === "open_desktop")).toHaveLength(1);
    h.observed.inFlightStatus = "applied";
    expect((await h.coordinator.recover(request.operationId)).status).toBe("awaiting_confirmation");
  });

  it("does not report completion when an unattributed archive changes after restoration", async () => {
    const h = harness();
    await h.coordinator.start(request);
    h.observed.threads[0]!.archived = true;
    h.observed.threads[0]!.archivedBy = "manual-user";
    h.observed.hydratedHistoryRevision = request.historyRevision;
    expect(await h.coordinator.recover(request.operationId)).toMatchObject({ status: "manual_required", reason: "client_refresh_lifecycle_changed_after_restore" });
    expect(h.actions.filter(action => action.kind === "unarchive")).toHaveLength(1);
    expect((await h.coordinator.pending())[0]!.phase).toBe("confirming");
  });

  it.each(["lost", "ambiguous"] as const)("refuses %s ownership before any lifecycle mutation", async ownership => {
    const h = harness();
    h.observed.ownership = ownership;
    expect(await h.coordinator.start(request)).toMatchObject({ status: "manual_required", reason: "client_refresh_ownership_unverified" });
    expect(h.actions).toEqual([]);
  });

  it.each(["new_work", "manual_archive", "unknown"] as const)("stops compensation for concurrent %s", async concurrentAction => {
    const h = harness();
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      const outcome = await h.performDefault(operation, action);
      if (action.kind === "archive") h.observed.concurrentAction = concurrentAction;
      return outcome;
    });
    expect(await h.coordinator.start(request)).toMatchObject({ status: "manual_required", reason: `client_refresh_concurrent_${concurrentAction}` });
    expect(h.actions).toEqual([{ kind: "archive", threadId: "parent" }]);
    expect((await h.coordinator.pending())[0]!.phase).toBe("archive_requested");
  });

  it.each(["loaded", "archived", "subscribed"] as const)("refuses unattributed %s changes rather than inferring ownership", async field => {
    const h = harness();
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (_operation, action) => {
      h.actions.push(action);
      h.observed.threads[0]![field] = !h.observed.threads[0]![field];
      return { outcome: "applied" };
    });
    expect((await h.coordinator.start(request)).status).toBe("manual_required");
    expect(h.actions).toHaveLength(1);
  });

  it.each(["idle", "queuedWork", "pendingApproval"] as const)("checks %s for every affected child", async field => {
    const h = harness();
    h.plan.affected.push(thread("child", true));
    h.observed.threads = structuredClone(h.plan.affected);
    h.observed.threads[1]![field] = field !== "idle";
    expect(await h.coordinator.start(request)).toMatchObject({ status: "manual_required", reason: "client_refresh_subtree_busy" });
    expect(h.actions).toHaveLength(0);
  });

  it("refuses incomplete subtree and superseded history without closing clients", async () => {
    const h = harness();
    h.observed.scopeComplete = false;
    expect((await h.coordinator.start(request)).reason).toBe("client_refresh_subtree_unknown");
    h.observed.scopeComplete = true;
    h.observed.historyRevision = "generation-8";
    expect((await h.coordinator.recover(request.operationId)).reason).toBe("client_refresh_history_superseded");
    expect(h.actions).toHaveLength(0);
  });

  it("blocks overlapping subtree refreshes and returns explicit manual refresh for an unsupported driver", async () => {
    const h = harness();
    await h.coordinator.start(request);
    expect(await h.coordinator.start({ ...request, operationId: "revert-2", historyRevision: "generation-8" })).toMatchObject({ status: "recovery_pending", reason: "overlapping_client_refresh" });
    h.driver.prepare = vi.fn<CodexRefreshDriver["prepare"]>(async () => ({ ready: false, reason: "no trusted launch record" }));
    expect(await h.coordinator.start({ ...request, operationId: "unmanaged", threadId: "elsewhere" })).toMatchObject({ status: "manual_required", reason: "no trusted launch record" });
  });

  it("does not mutate when the pre-action journal write fails", async () => {
    const h = harness();
    const save = h.journal.save;
    h.journal.save = vi.fn<CodexRefreshJournal["save"]>(async entry => {
      if (entry.kind === "operation" && entry.inFlight !== undefined) throw new Error("disk full");
      await save(entry);
    });
    await expect(h.coordinator.start(request)).rejects.toThrow("disk full");
    expect(h.actions).toHaveLength(0);
    expect((h.entries.get(request.operationId) as CodexRefreshOperation).phase).toBe("prepared");
  });

  it("reopens only after verified TUI exit with the same saved launch settings", async () => {
    const h = harness("tui");
    let inspected = 0;
    h.driver.inspect = vi.fn(async () => { inspected += 1; return structuredClone(h.observed); });
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      expect(operation.plan.client).toEqual(h.plan.client);
      if (action.kind === "open_tui") {
        expect(inspected).toBeGreaterThan(1);
        expect(h.observed.tui!.original).toBe("exited");
      }
      return h.performDefault(operation, action);
    });
    expect((await h.coordinator.start(request)).status).toBe("awaiting_confirmation");
    expect(h.actions).toEqual([{ kind: "close_tui" }, { kind: "open_tui" }]);
    h.observed.hydratedHistoryRevision = request.historyRevision;
    expect((await h.coordinator.recover(request.operationId)).status).toBe("complete");
  });

  it("waits for exit and refuses to reopen a TUI whose exit belongs to another actor", async () => {
    const h = harness("tui");
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (_operation, action) => { h.actions.push(action); return { outcome: "applied" }; });
    expect((await h.coordinator.start(request)).reason).toBe("managed_tui_exit_not_confirmed");
    h.observed.tui!.original = "exited";
    expect((await h.coordinator.recover(request.operationId)).reason).toBe("managed_tui_exit_ownership_unknown");
    expect(h.actions).toEqual([{ kind: "close_tui" }]);
  });

  it("retries a proven failed TUI reopen without closing again", async () => {
    const h = harness("tui");
    let attempts = 0;
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      if (action.kind === "open_tui" && attempts++ === 0) return { outcome: "not_applied", reason: "launcher unavailable" };
      return h.performDefault(operation, action);
    });
    expect((await h.coordinator.start(request)).reason).toBe("launcher unavailable");
    expect((await h.coordinator.recover(request.operationId)).status).toBe("awaiting_confirmation");
    expect(h.actions.filter(action => action.kind === "close_tui")).toHaveLength(1);
    expect(h.actions.filter(action => action.kind === "open_tui")).toHaveLength(1);
  });

  it.each(["desktop", "tui"] as const)("retains a proven failed %s open if the Host exits after saving its outcome", async kind => {
    const h = harness(kind);
    const openKind = kind === "desktop" ? "open_desktop" : "open_tui";
    let attempts = 0;
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      if (action.kind === openKind && attempts++ === 0) {
        h.actions.push(action);
        return { outcome: "not_applied", reason: "launcher unavailable" };
      }
      return h.performDefault(operation, action);
    });
    const save = h.journal.save;
    let crashed = false;
    h.journal.save = vi.fn<CodexRefreshJournal["save"]>(async entry => {
      await save(entry);
      if (!crashed && entry.kind === "operation" && entry.inFlight?.kind === openKind && entry.inFlightOutcome === "not_applied") {
        crashed = true;
        throw new Error("Host exited after action outcome persisted");
      }
    });
    await expect(h.coordinator.start(request)).rejects.toThrow("Host exited after action outcome persisted");
    expect(h.entries.get(request.operationId)).toMatchObject({ inFlight: { kind: openKind }, inFlightOutcome: "not_applied" });
    const restarted = new CodexClientRefreshCoordinator(h.journal, h.driver);
    expect(await restarted.recover(request.operationId)).toMatchObject({ status: "recovery_pending", reason: "launcher unavailable" });
    expect((await restarted.recover(request.operationId)).status).toBe("awaiting_confirmation");
    expect(h.actions.filter(action => action.kind === openKind)).toHaveLength(2);
    expect(h.actions.filter(action => action.kind === (kind === "desktop" ? "archive" : "close_tui"))).toHaveLength(1);
  });

  it.each(["desktop", "tui"] as const)("atomically advances a settled failed %s open to its retry phase", async kind => {
    const h = harness(kind);
    const openKind = kind === "desktop" ? "open_desktop" : "open_tui";
    let attempts = 0;
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (operation, action) => {
      if (action.kind === openKind && attempts++ === 0) {
        h.actions.push(action);
        return { outcome: "unknown" };
      }
      return h.performDefault(operation, action);
    });
    expect((await h.coordinator.start(request)).status).toBe("recovery_pending");
    h.observed.inFlightStatus = "not_applied";
    const save = h.journal.save;
    let crashed = false;
    h.journal.save = vi.fn<CodexRefreshJournal["save"]>(async entry => {
      await save(entry);
      if (!crashed && entry.kind === "operation" && entry.inFlight === undefined) {
        crashed = true;
        throw new Error("Host exited after action settlement persisted");
      }
    });
    await expect(h.coordinator.recover(request.operationId)).rejects.toThrow("Host exited after action settlement persisted");
    expect(h.entries.get(request.operationId)).toMatchObject({ phase: kind === "desktop" ? "opening" : "reopening" });
    delete h.observed.inFlightStatus;
    expect((await new CodexClientRefreshCoordinator(h.journal, h.driver).recover(request.operationId)).status).toBe("awaiting_confirmation");
    expect(h.actions.filter(action => action.kind === openKind)).toHaveLength(2);
    expect(h.actions.filter(action => action.kind === (kind === "desktop" ? "archive" : "close_tui"))).toHaveLength(1);
  });

  it.each(["rpc", "inspection"] as const)("retains a failed TUI close proven by %s until the terminal receipt is saved", async source => {
    const h = harness("tui");
    h.driver.perform = vi.fn<CodexRefreshDriver["perform"]>(async (_operation, action) => {
      h.actions.push(action);
      return { outcome: source === "rpc" ? "not_applied" : "unknown" };
    });
    const save = h.journal.save;
    let crashed = false;
    h.journal.save = vi.fn<CodexRefreshJournal["save"]>(async entry => {
      if (!crashed && entry.kind === "receipt") {
        crashed = true;
        throw new Error("Host exited before terminal receipt persisted");
      }
      await save(entry);
    });
    if (source === "inspection") {
      expect((await h.coordinator.start(request)).status).toBe("recovery_pending");
      h.observed.inFlightStatus = "not_applied";
      await expect(h.coordinator.recover(request.operationId)).rejects.toThrow("Host exited before terminal receipt persisted");
    } else {
      await expect(h.coordinator.start(request)).rejects.toThrow("Host exited before terminal receipt persisted");
    }
    expect((await new CodexClientRefreshCoordinator(h.journal, h.driver).recover(request.operationId)).status).toBe("manual_required");
    expect(h.entries.get(request.operationId)!.kind).toBe("receipt");
    expect(h.actions).toEqual([{ kind: "close_tui" }]);
  });
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockReset();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "orbis-codex-refresh-"));
  directories.push(path);
  return path;
}

function journalName(operationId: string): string {
  return `sha256.${createHash("sha256").update(operationId).digest("hex")}.json`;
}

describe("file refresh journal", () => {
  it("atomically restores operations across coordinator instances and replaces recovery data with a receipt", async () => {
    const path = await directory();
    const h = harness();
    const journal = new FileCodexRefreshJournal(path);
    const first = new CodexClientRefreshCoordinator(journal, h.driver);
    expect((await first.start(request)).status).toBe("awaiting_confirmation");
    expect((await journal.list())[0]!.kind).toBe("operation");
    expect(await readdir(path)).toEqual([journalName(request.operationId)]);
    h.observed.hydratedHistoryRevision = request.historyRevision;
    expect((await new CodexClientRefreshCoordinator(new FileCodexRefreshJournal(path), h.driver).recover(request.operationId)).status).toBe("complete");
    expect((await journal.list())[0]!.kind).toBe("receipt");
    expect(await readdir(path)).toEqual([journalName(request.operationId)]);
  });

  it("leaves corrupt records untouched and blocks new mutations", async () => {
    const path = await directory();
    const original = "{\"schema\":1,\"kind\":\"operation\"}";
    await writeFile(join(path, "broken.json"), original);
    const h = harness();
    const coordinator = new CodexClientRefreshCoordinator(new FileCodexRefreshJournal(path), h.driver);
    await expect(coordinator.start(request)).rejects.toThrow("codex_refresh_journal_invalid");
    expect(h.driver.prepare).not.toHaveBeenCalled();
    expect(h.actions).toHaveLength(0);
    expect(await readFile(join(path, "broken.json"), "utf8")).toBe(original);
  });

  it("rejects path traversal and mismatched record filenames", async () => {
    const path = await directory();
    const h = harness();
    const journal = new FileCodexRefreshJournal(path);
    const coordinator = new CodexClientRefreshCoordinator(journal, h.driver);
    await expect(coordinator.start({ ...request, operationId: "../elsewhere" })).rejects.toThrow("codex_refresh_journal_invalid");
    await coordinator.start(request);
    const text = await readFile(join(path, journalName(request.operationId)), "utf8");
    await writeFile(join(path, "wrong.json"), text);
    await expect(journal.list()).rejects.toThrow("codex_refresh_journal_identity_mismatch");
  });

  it("stores distinct case-sensitive IDs without Windows filename collisions or reserved names", async () => {
    const path = await directory();
    const journal = new FileCodexRefreshJournal(path);
    const ids = ["revert-1", "Revert-1", "CON", "NUL", "a".repeat(128)];
    for (const operationId of ids) {
      await journal.save({ schema: 1, kind: "receipt", request: { ...request, operationId },
        result: { operationId, historyReverted: true, status: "complete" } });
    }
    expect((await journal.list()).map(entry => entry.request.operationId).sort()).toEqual([...ids].sort());
    expect((await readdir(path)).sort()).toEqual(ids.map(journalName).sort());
    expect(new Set(ids.map(id => journalName(id).toLowerCase())).size).toBe(ids.length);
  });

  it("preserves a legacy lower-case operation while saving and recovering its mixed-case neighbor", async () => {
    const path = await directory();
    const lower = harness();
    await lower.coordinator.start(request);
    const upper = harness();
    upper.plan.affected[0]!.threadId = "second";
    upper.observed.threads = structuredClone(upper.plan.affected);
    const upperRequest = { ...request, operationId: "Revert-1", threadId: "second" };
    await upper.coordinator.start(upperRequest);
    const legacy = JSON.stringify(lower.entries.get(request.operationId));
    await writeFile(join(path, "revert-1.json"), legacy);
    const journal = new FileCodexRefreshJournal(path);
    await journal.save(upper.entries.get(upperRequest.operationId)!);
    expect(await readFile(join(path, "revert-1.json"), "utf8")).toBe(legacy);
    expect(await journal.list()).toHaveLength(2);
    lower.observed.hydratedHistoryRevision = request.historyRevision;
    expect((await new CodexClientRefreshCoordinator(journal, lower.driver).recover(request.operationId)).status).toBe("complete");
    upper.observed.hydratedHistoryRevision = upperRequest.historyRevision;
    expect((await new CodexClientRefreshCoordinator(journal, upper.driver).recover(upperRequest.operationId)).status).toBe("complete");
    expect((await journal.list()).every(entry => entry.kind === "receipt")).toBe(true);
    expect((await readdir(path)).sort()).toEqual([journalName(request.operationId), journalName(upperRequest.operationId)].sort());
    expect(lower.actions.filter(action => action.kind === "archive")).toHaveLength(1);
    expect(upper.actions.filter(action => action.kind === "archive")).toHaveLength(1);
  });

  it("recovers the old operation if Host exit interrupts migration before the next record is written", async () => {
    const path = await directory();
    const h = harness();
    await h.coordinator.start(request);
    const old = h.entries.get(request.operationId)!;
    await writeFile(join(path, "revert-1.json"), JSON.stringify(old));
    h.observed.hydratedHistoryRevision = request.historyRevision;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination);
      throw new Error("Host exited after legacy record moved");
    });
    const journal = new FileCodexRefreshJournal(path);
    expect(await journal.list()).toEqual([old]);
    await expect(new CodexClientRefreshCoordinator(journal, h.driver).recover(request.operationId)).rejects.toThrow("Host exited after legacy record moved");
    expect(await readdir(path)).toEqual([journalName(request.operationId)]);
    expect(await journal.list()).toEqual([old]);
    expect((await new CodexClientRefreshCoordinator(new FileCodexRefreshJournal(path), h.driver).recover(request.operationId)).status).toBe("complete");
    expect((await journal.list())[0]!.kind).toBe("receipt");
    expect(h.actions.filter(action => action.kind === "archive")).toHaveLength(1);
  });

  it("refuses duplicate legacy and hashed operation IDs without overwriting either record", async () => {
    const path = await directory();
    const h = harness();
    await h.coordinator.start(request);
    const operation = h.entries.get(request.operationId)!;
    const original = JSON.stringify(operation);
    await writeFile(join(path, "revert-1.json"), original);
    await writeFile(join(path, journalName(request.operationId)), original);
    const journal = new FileCodexRefreshJournal(path);
    await expect(journal.list()).rejects.toThrow("codex_refresh_journal_duplicate_operation");
    h.observed.hydratedHistoryRevision = request.historyRevision;
    await h.coordinator.recover(request.operationId);
    await expect(journal.save(h.entries.get(request.operationId)!)).rejects.toThrow("codex_refresh_journal_duplicate_operation");
    expect(await readFile(join(path, "revert-1.json"), "utf8")).toBe(original);
    expect(await readFile(join(path, journalName(request.operationId)), "utf8")).toBe(original);
    expect((await readdir(path)).sort()).toEqual(["revert-1.json", journalName(request.operationId)].sort());
  });
});
