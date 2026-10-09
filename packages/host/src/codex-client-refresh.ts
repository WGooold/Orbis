import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** A committed revert's identity, not a request to perform another revert. */
export type CodexRefreshRequest = {
  operationId: string;
  backendId: string;
  threadId: string;
  historyRevision: string;
};

export type CodexRefreshThread = {
  threadId: string;
  archived: boolean;
  loaded: boolean;
  subscribed: boolean;
  idle: boolean;
  queuedWork: boolean;
  pendingApproval: boolean;
};

export type CodexRefreshClient = {
  kind: "desktop";
  /** Verified wrapper incarnation, not just its endpoint or a reusable PID. */
  instanceId: string;
  compatibilityVersion: string;
  /** A verified desktop route; an Orbis runtime ID is not a desktop host ID. */
  desktopHostId: string;
} | {
  kind: "tui";
  instanceId: string;
  launchId: string;
  pid: number;
  processStartedAt: string;
  cwd: string;
  endpoint: string;
  command: string;
  prefixArgs: string[];
};

export type CodexRefreshPlan = {
  client: CodexRefreshClient;
  /** The complete native archive subtree, including archived but loaded children. */
  affected: CodexRefreshThread[];
};

export type CodexRefreshAction =
  | { kind: "archive" | "unarchive" | "load" | "subscribe"; threadId: string }
  | { kind: "open_desktop" | "close_tui" | "open_tui" };

type Phase = "prepared" | "archive_requested" | "restoring" | "opening"
  | "open_requested" | "close_requested" | "reopening" | "reopen_requested" | "confirming";

export type CodexRefreshOperation = {
  schema: 1;
  kind: "operation";
  request: CodexRefreshRequest;
  plan: CodexRefreshPlan;
  phase: Phase;
  archiveConfirmed: boolean;
  /** Written before the side effect. Recovery must inspect it, never blindly replay it. */
  inFlight?: CodexRefreshAction;
  /** Retain a known outcome until its next phase or terminal receipt is durable. */
  inFlightOutcome?: "applied" | "not_applied";
  problem?: string;
};

export type CodexRefreshResult = {
  operationId: string;
  historyReverted: true;
  status: "complete" | "awaiting_confirmation" | "recovery_pending" | "manual_required";
  reason?: string;
};

/** A small deduplication receipt replaces the recovery plan after a terminal outcome. */
export type CodexRefreshReceipt = {
  schema: 1;
  kind: "receipt";
  request: CodexRefreshRequest;
  result: CodexRefreshResult;
};

export type CodexRefreshJournalEntry = CodexRefreshOperation | CodexRefreshReceipt;
/** One coordinator must own each journal; atomic saves do not provide a multi-writer transaction. */
export interface CodexRefreshJournal {
  list(): Promise<CodexRefreshJournalEntry[]>;
  save(entry: CodexRefreshJournalEntry): Promise<void>;
}

export type CodexRefreshObservation = {
  /** Both the original client incarnation and its current target thread were verified. */
  ownership: "verified" | "lost" | "ambiguous";
  historyRevision: string;
  scopeComplete: boolean;
  concurrentAction: "none" | "new_work" | "manual_archive" | "unknown";
  threads: Array<CodexRefreshThread & {
    /** Provenance must come from the driver, not be inferred from before/after values. */
    archivedBy?: string;
    unloadedBy?: string;
    unsubscribedBy?: string;
  }>;
  /** This is a client hydration acknowledgement, NOT thread/resume or open RPC success. */
  hydratedHistoryRevision?: string;
  tui?: {
    original: "running" | "exited" | "unknown";
    closedBy?: string;
    replacement: "not_started" | "running" | "unknown";
    replacementOperationId?: string;
  };
  /** Settled requests may have only partial effects; pending/unknown may still change state. */
  inFlightStatus?: "applied" | "partially_applied" | "not_applied" | "pending" | "unknown";
};

export interface CodexRefreshDriver {
  /** Must refuse ambiguous ownership, incomplete subtree discovery, and unsupported clients. */
  prepare(request: CodexRefreshRequest): Promise<
    { ready: true; plan: CodexRefreshPlan } | { ready: false; reason: string }
  >;
  inspect(operation: CodexRefreshOperation): Promise<CodexRefreshObservation>;
  /**
   * Revalidate ownership, history revision and idle conditions immediately before mutating.
   * TUI open uses the saved CLI/cwd/endpoint and a durable operation-specific launch identity.
   * load/subscribe must preserve archive state and only restore this backend's association.
   * not_applied guarantees NO side effect; a timeout or thrown exception means unknown.
   * No implementation may use process-name/argv matching as proof of TUI ownership.
   */
  perform(operation: CodexRefreshOperation, action: CodexRefreshAction): Promise<
    { outcome: "applied" | "not_applied" | "unknown"; reason?: string }
  >;
}

/**
 * ADR-0023 refresh/recovery only. There deliberately is no thread/revert capability here.
 * Native ownership/hydration adapters are separate; callers must not invent their evidence.
 * Serialization covers this instance only. Callers must ensure exclusive journal ownership
 * across coordinator instances and processes, including recovery during Host startup.
 */
export class CodexClientRefreshCoordinator {
  readonly #journal: CodexRefreshJournal;
  readonly #driver: CodexRefreshDriver;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(journal: CodexRefreshJournal, driver: CodexRefreshDriver) {
    this.#journal = journal;
    this.#driver = driver;
  }

  start(request: CodexRefreshRequest): Promise<CodexRefreshResult> {
    return this.#serialize(async () => {
      validateRequest(request);
      const entries = await this.#journal.list();
      const existing = entries.find(entry => entry.request.operationId === request.operationId);
      if (existing !== undefined) {
        if (!sameRequest(existing.request, request)) return result(request, "manual_required", "refresh_operation_identity_mismatch");
        return existing.kind === "receipt" ? existing.result : this.#drive(existing);
      }
      const duplicate = entries.find(entry => entry.kind === "operation" && entry.request.backendId === request.backendId
        && entry.request.threadId === request.threadId && entry.request.historyRevision === request.historyRevision);
      if (duplicate !== undefined) return duplicate.kind === "receipt" ? duplicate.result : this.#drive(duplicate);
      const prepared = await this.#driver.prepare(request);
      if (!prepared.ready) return result(request, "manual_required", prepared.reason);
      validatePlan(prepared.plan, request);
      // Serializing this coordinator also prevents two overlapping subtree refreshes.
      if (entries.some(entry => entry.kind === "operation" && entry.request.backendId === request.backendId
        && entry.plan.affected.some(thread => prepared.plan.affected.some(candidate => candidate.threadId === thread.threadId)))) {
        return result(request, "recovery_pending", "overlapping_client_refresh");
      }
      const operation: CodexRefreshOperation = {
        schema: 1, kind: "operation", request: structuredClone(request), plan: structuredClone(prepared.plan),
        phase: "prepared", archiveConfirmed: false,
      };
      await this.#journal.save(operation);
      return this.#drive(operation);
    });
  }

  recover(operationId: string): Promise<CodexRefreshResult> {
    return this.#serialize(async () => {
      const entry = (await this.#journal.list()).find(candidate => candidate.request.operationId === operationId);
      if (entry === undefined) throw new Error("codex_refresh_operation_not_found");
      return entry.kind === "receipt" ? entry.result : this.#drive(entry);
    });
  }

  /** Load these before enabling discovery/watchdogs after reconnect or Host startup. */
  pending(): Promise<CodexRefreshOperation[]> {
    return this.#serialize(async () => (await this.#journal.list()).filter(
      (entry): entry is CodexRefreshOperation => entry.kind === "operation",
    ));
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(work);
    this.#serial = next.catch(() => undefined);
    return next;
  }

  async #drive(operation: CodexRefreshOperation): Promise<CodexRefreshResult> {
    // A restoration needs at most three actions per affected thread, plus client transitions.
    for (let steps = 0; steps < operation.plan.affected.length * 3 + 12; steps += 1) {
      let observed: CodexRefreshObservation;
      try { observed = await this.#driver.inspect(structuredClone(operation)); }
      catch (error) { return this.#problem(operation, "recovery_pending", `refresh_inspection_failed: ${describe(error)}`); }
      const unsafe = unsafeObservation(operation, observed);
      if (unsafe !== undefined) {
        // A restored client may legitimately start new work before hydration is observed.
        // End that obsolete confirmation record; it must not block a later real revert to
        // the same retained prefix. Never discard an operation with unfinished side effects.
        if (operation.phase === "confirming" && operation.inFlight === undefined
          && observed.ownership === "verified" && observed.scopeComplete && sameOriginalState(operation, observed)) {
          return this.#finish(operation, "manual_required", unsafe);
        }
        return this.#problem(operation, "manual_required", unsafe);
      }
      const target = observed.threads.find(thread => thread.threadId === operation.request.threadId)!;
      if (operation.plan.client.kind === "desktop" && ["opening", "open_requested", "confirming"].includes(operation.phase)
        && !sameOriginalState(operation, observed)) {
        // A new Host connection has no subscription even when native loading and archive
        // state were fully restored. Restore only its own proven association, without
        // repeating archive or touching a GUI that has begun new work.
        const subscriptionOnly = operation.plan.affected.every(original => {
          const current = observed.threads.find(t => t.threadId === original.threadId)!;
          return current.archived === original.archived && current.loaded === original.loaded
            && (current.subscribed === original.subscribed || original.subscribed && !current.subscribed
              && current.unsubscribedBy === operation.request.operationId);
        });
        if (subscriptionOnly && operation.inFlight === undefined) {
          operation.phase = "restoring";
          await this.#save(operation);
          continue;
        }
        return this.#problem(operation, "manual_required", "client_refresh_lifecycle_changed_after_restore");
      }
      if (operation.inFlight !== undefined) {
        const settled = operation.inFlightOutcome ?? observed.inFlightStatus;
        if (settled !== "applied" && settled !== "partially_applied" && settled !== "not_applied") {
          return this.#problem(operation, "recovery_pending", "client_refresh_action_result_unknown");
        }
        const notApplied = settled === "not_applied";
        const action = operation.inFlight;
        if (notApplied && action.kind === "close_tui") return this.#finish(operation, "manual_required", "managed_tui_close_not_applied");
        delete operation.inFlight;
        delete operation.inFlightOutcome;
        if (notApplied && (action.kind === "open_tui" || action.kind === "open_desktop")) {
          operation.phase = action.kind === "open_tui" ? "reopening" : "opening";
          await this.#save(operation);
          return this.#problem(operation, "recovery_pending", operation.problem ?? "client_refresh_open_not_applied");
        }
        await this.#save(operation);
      }

      switch (operation.phase) {
        case "prepared": {
          if (!sameOriginalState(operation, observed)) return this.#problem(operation, "manual_required", "refresh_state_changed_before_start");
          const desktop = operation.plan.client.kind === "desktop";
          const action: CodexRefreshAction = desktop ? { kind: "archive", threadId: target.threadId } : { kind: "close_tui" };
          if (!desktop && observed.tui?.original !== "running") return this.#problem(operation, "manual_required", "managed_tui_not_running");
          const outcome = await this.#act(operation, action, desktop ? "archive_requested" : "close_requested");
          if (outcome === "not_applied") return this.#finish(operation, "manual_required", operation.problem ?? "client_refresh_not_applied");
          break;
        }
        case "archive_requested":
          // Even archive failure can have unloaded the thread. Never issue archive again.
          if (target.archived && target.archivedBy === operation.request.operationId) operation.archiveConfirmed = true;
          operation.phase = "restoring";
          await this.#save(operation);
          break;
        case "restoring": {
          if (target.archived && target.archivedBy === operation.request.operationId) {
            operation.archiveConfirmed = true;
            await this.#save(operation);
          }
          const restore = restorationAction(operation, observed);
          if (typeof restore === "string") return this.#problem(operation, "manual_required", restore);
          if (restore !== undefined) {
            const before = JSON.stringify(observed.threads);
            const outcome = await this.#act(operation, restore, "restoring");
            if (outcome !== "applied") return this.#problem(operation, "recovery_pending", operation.problem ?? "refresh_restore_result_unknown");
            // An acknowledged no-op must not spin forever or be reported as compensation.
            let after: CodexRefreshObservation;
            try { after = await this.#driver.inspect(structuredClone(operation)); }
            catch (error) { return this.#problem(operation, "recovery_pending", `refresh_inspection_failed: ${describe(error)}`); }
            if (JSON.stringify(after.threads) === before) return this.#problem(operation, "recovery_pending", "refresh_restore_not_observed");
            break;
          }
          if (!operation.archiveConfirmed) {
            return this.#finish(operation, "manual_required", "history_reverted_client_archive_not_confirmed_original_state_restored");
          }
          operation.phase = "opening";
          await this.#save(operation);
          break;
        }
        case "opening": {
          await this.#act(operation, { kind: "open_desktop" }, "open_requested");
          break;
        }
        case "close_requested": {
          if (observed.tui?.original !== "exited") return this.#problem(operation, "recovery_pending", "managed_tui_exit_not_confirmed");
          if (observed.tui.closedBy !== operation.request.operationId) return this.#problem(operation, "manual_required", "managed_tui_exit_ownership_unknown");
          operation.phase = "reopening";
          await this.#save(operation);
          break;
        }
        case "reopening": {
          if (observed.tui?.original !== "exited" || observed.tui.closedBy !== operation.request.operationId) {
            return this.#problem(operation, "manual_required", "managed_tui_exit_ownership_unknown");
          }
          if (observed.tui.replacement !== "not_started") return this.#problem(operation, "manual_required", "managed_tui_replacement_ownership_unknown");
          await this.#act(operation, { kind: "open_tui" }, "reopen_requested");
          break;
        }
        case "reopen_requested":
          if (observed.tui?.replacement !== "running" || observed.tui.replacementOperationId !== operation.request.operationId) {
            return this.#problem(operation, "recovery_pending", "managed_tui_replacement_not_confirmed");
          }
          operation.phase = "confirming";
          await this.#save(operation);
          break;
        case "open_requested":
          operation.phase = "confirming";
          await this.#save(operation);
          break;
        case "confirming":
          if (!target.loaded || !target.subscribed || observed.hydratedHistoryRevision !== operation.request.historyRevision) {
            return this.#problem(operation, "awaiting_confirmation", "client_hydration_not_confirmed");
          }
          if (operation.plan.client.kind === "tui" && (observed.tui?.original !== "exited"
            || observed.tui.replacement !== "running" || observed.tui.replacementOperationId !== operation.request.operationId)) {
            return this.#problem(operation, "manual_required", "managed_tui_replacement_ownership_unknown");
          }
          return this.#finish(operation, "complete");
      }
    }
    return this.#problem(operation, "recovery_pending", "refresh_state_did_not_converge");
  }

  async #act(operation: CodexRefreshOperation, action: CodexRefreshAction, phase: Phase): Promise<"applied" | "not_applied" | "unknown"> {
    operation.phase = phase;
    operation.inFlight = action;
    delete operation.inFlightOutcome;
    delete operation.problem;
    await this.#save(operation); // Failure here MUST prevent the side effect.
    let outcome: Awaited<ReturnType<CodexRefreshDriver["perform"]>>;
    try { outcome = await this.#driver.perform(structuredClone(operation), action); }
    catch (error) { outcome = { outcome: "unknown", reason: describe(error) }; }
    if (outcome.outcome !== "unknown") operation.inFlightOutcome = outcome.outcome;
    if (outcome.reason !== undefined) operation.problem = outcome.reason;
    await this.#save(operation);
    return outcome.outcome;
  }

  async #save(operation: CodexRefreshOperation): Promise<void> {
    await this.#journal.save(structuredClone(operation));
  }

  async #problem(operation: CodexRefreshOperation, status: CodexRefreshResult["status"], reason: string): Promise<CodexRefreshResult> {
    operation.problem = reason;
    await this.#save(operation);
    return result(operation.request, status, reason);
  }

  async #finish(operation: CodexRefreshOperation, status: "complete" | "manual_required", reason?: string): Promise<CodexRefreshResult> {
    const completed = result(operation.request, status, reason);
    // Retain only the idempotency receipt; discard original lifecycle/ownership recovery data.
    await this.#journal.save({ schema: 1, kind: "receipt", request: operation.request, result: completed });
    return completed;
  }
}

function result(request: CodexRefreshRequest, status: CodexRefreshResult["status"], reason?: string): CodexRefreshResult {
  return { operationId: request.operationId, historyReverted: true, status, ...(reason === undefined ? {} : { reason }) };
}

function sameRequest(left: CodexRefreshRequest, right: CodexRefreshRequest): boolean {
  return left.operationId === right.operationId && left.backendId === right.backendId
    && left.threadId === right.threadId && left.historyRevision === right.historyRevision;
}

function sameOriginalState(operation: CodexRefreshOperation, observed: CodexRefreshObservation): boolean {
  return operation.plan.affected.every(original => {
    const current = observed.threads.find(thread => thread.threadId === original.threadId);
    return current !== undefined && original.archived === current.archived && original.loaded === current.loaded && original.subscribed === current.subscribed;
  });
}

function unsafeObservation(operation: CodexRefreshOperation, observed: CodexRefreshObservation): string | undefined {
  if (observed.ownership !== "verified") return "client_refresh_ownership_unverified";
  if (observed.historyRevision !== operation.request.historyRevision) return "client_refresh_history_superseded";
  if (observed.concurrentAction !== "none") return `client_refresh_concurrent_${observed.concurrentAction}`;
  if (!observed.scopeComplete || observed.threads.length !== operation.plan.affected.length
    || new Set(observed.threads.map(thread => thread.threadId)).size !== observed.threads.length
    || operation.plan.affected.some(original => !observed.threads.some(thread => thread.threadId === original.threadId))) {
    return "client_refresh_subtree_unknown";
  }
  if (observed.threads.some(thread => !thread.idle || thread.queuedWork || thread.pendingApproval)) return "client_refresh_subtree_busy";
  return undefined;
}

function restorationAction(operation: CodexRefreshOperation, observed: CodexRefreshObservation): CodexRefreshAction | string | undefined {
  const changes: CodexRefreshAction[] = [];
  for (const original of operation.plan.affected) {
    const current = observed.threads.find(thread => thread.threadId === original.threadId)!;
    if (original.archived !== current.archived) {
      if (original.archived || current.archivedBy !== operation.request.operationId) return "client_refresh_archive_change_ownership_unknown";
      changes.push({ kind: "unarchive", threadId: current.threadId });
    }
    if (original.loaded !== current.loaded) {
      if (!original.loaded || current.unloadedBy !== operation.request.operationId) return "client_refresh_load_change_ownership_unknown";
      changes.push({ kind: "load", threadId: current.threadId });
    }
    if (original.subscribed !== current.subscribed) {
      if (!original.subscribed || current.unsubscribedBy !== operation.request.operationId) return "client_refresh_subscription_change_ownership_unknown";
      changes.push({ kind: "subscribe", threadId: current.threadId });
    }
  }
  // Restore archive states across the whole subtree before any resume/loading operations.
  return changes.find(action => action.kind === "unarchive") ?? changes.find(action => action.kind === "load") ?? changes[0];
}

/**
 * Atomic writes without a locking protocol: one coordinator/process must own the directory.
 * Invalid or duplicate records fail closed and are left untouched for diagnosis.
 */
export class FileCodexRefreshJournal implements CodexRefreshJournal {
  readonly #directory: string;
  constructor(directory: string) { this.#directory = directory; }

  async list(): Promise<CodexRefreshJournalEntry[]> {
    let names: string[];
    try { names = await readdir(this.#directory); }
    catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
    const entries = await Promise.all(names.filter(name => name.endsWith(".json")).map(
      name => readJournalEntry(this.#directory, name),
    ));
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.request.operationId)) throw new Error("codex_refresh_journal_duplicate_operation");
      ids.add(entry.request.operationId);
    }
    return entries;
  }

  async save(entry: CodexRefreshJournalEntry): Promise<void> {
    validateEntry(entry);
    await mkdir(this.#directory, { recursive: true });
    const name = journalFilename(entry.request.operationId);
    const legacyName = `${entry.request.operationId}.json`;
    const candidates = (await readdir(this.#directory)).filter(candidate => candidate.toLowerCase() === name
      || candidate.toLowerCase() === legacyName.toLowerCase());
    const records = await Promise.all(candidates.map(async candidate => ({
      name: candidate, entry: await readJournalEntry(this.#directory, candidate),
    })));
    const existing = records.filter(record => record.entry.request.operationId === entry.request.operationId);
    if (existing.length > 1) throw new Error("codex_refresh_journal_duplicate_operation");
    if (existing.some(record => !sameRequest(record.entry.request, entry.request))
      || records.some(record => record.name === name && record.entry.request.operationId !== entry.request.operationId)) {
      throw new Error("codex_refresh_journal_identity_mismatch");
    }
    const destination = join(this.#directory, name);
    // Moving the old record first leaves one recoverable record if updating it is interrupted.
    if (existing[0] !== undefined && existing[0].name !== name) await rename(join(this.#directory, existing[0].name), destination);
    const temporary = join(this.#directory, `${name}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(entry)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
}

function journalFilename(operationId: string): string {
  // The dot excludes overlap with legacy IDs, whose allowed alphabet contains no dots.
  return `sha256.${createHash("sha256").update(operationId, "utf8").digest("hex")}.json`;
}

async function readJournalEntry(directory: string, name: string): Promise<CodexRefreshJournalEntry> {
  const entry: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
  validateEntry(entry);
  if (name !== journalFilename(entry.request.operationId) && name !== `${entry.request.operationId}.json`) {
    throw new Error("codex_refresh_journal_identity_mismatch");
  }
  return entry;
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown): unknown { return error !== null && typeof error === "object" && "code" in error ? error.code : undefined; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 8_192; }
function invalid(): never { throw new Error("codex_refresh_journal_invalid"); }

function validateRequest(value: unknown): asserts value is CodexRefreshRequest {
  if (!record(value) || !string(value.operationId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.operationId)
    || !string(value.backendId) || !string(value.threadId) || !string(value.historyRevision)) invalid();
}

function validatePlan(value: unknown, request: CodexRefreshRequest): asserts value is CodexRefreshPlan {
  if (!record(value) || !record(value.client) || !string(value.client.instanceId)
    || !Array.isArray(value.affected) || value.affected.length === 0 || value.affected.length > 512) invalid();
  const client = value.client;
  if (client.kind === "desktop") {
    if (!string(client.compatibilityVersion) || !string(client.desktopHostId)) invalid();
  } else if (client.kind === "tui") {
    if (!string(client.launchId) || !Number.isSafeInteger(client.pid) || Number(client.pid) <= 0
      || !string(client.processStartedAt) || !string(client.cwd) || !string(client.endpoint) || !string(client.command)
      || !Array.isArray(client.prefixArgs) || !client.prefixArgs.every(value => typeof value === "string")) invalid();
  } else invalid();
  const ids = new Set<string>();
  for (const thread of value.affected) {
    if (!record(thread) || !string(thread.threadId) || ids.has(thread.threadId)
      || ["archived", "loaded", "subscribed", "idle", "queuedWork", "pendingApproval"].some(key => typeof thread[key] !== "boolean")
      || !thread.idle || thread.queuedWork || thread.pendingApproval) invalid();
    ids.add(thread.threadId);
  }
  const target = value.affected.find(thread => thread.threadId === request.threadId) as CodexRefreshThread | undefined;
  if (target === undefined || target.archived || !target.loaded || !target.subscribed) invalid();
  if (client.kind === "tui" && value.affected.length !== 1) invalid();
}

function validateEntry(value: unknown): asserts value is CodexRefreshJournalEntry {
  if (!record(value) || value.schema !== 1) invalid();
  validateRequest(value.request);
  if (value.kind === "receipt") {
    if (!record(value.result) || value.result.operationId !== value.request.operationId || value.result.historyReverted !== true
      || (value.result.status !== "complete" && value.result.status !== "manual_required")
      || (value.result.reason !== undefined && !string(value.result.reason))) invalid();
    return;
  }
  if (value.kind !== "operation") invalid();
  validatePlan(value.plan, value.request);
  if (!["prepared", "archive_requested", "restoring", "opening", "open_requested", "close_requested", "reopening", "reopen_requested", "confirming"].includes(String(value.phase))
    || typeof value.archiveConfirmed !== "boolean" || (value.problem !== undefined && !string(value.problem))) invalid();
  if (value.inFlight !== undefined) {
    if (!record(value.inFlight)) invalid();
    const action = value.inFlight;
    if (["archive", "unarchive", "load", "subscribe"].includes(String(action.kind))) {
      if (!string(action.threadId) || !value.plan.affected.some(thread => thread.threadId === action.threadId)) invalid();
    } else if (!["open_desktop", "close_tui", "open_tui"].includes(String(action.kind))) invalid();
    const phaseByAction: Record<string, Phase> = {
      archive: "archive_requested", unarchive: "restoring", load: "restoring", subscribe: "restoring",
      open_desktop: "open_requested", close_tui: "close_requested", open_tui: "reopen_requested",
    };
    if (phaseByAction[String(action.kind)] !== value.phase) invalid();
  }
  if (value.inFlightOutcome !== undefined
    && (value.inFlight === undefined || (value.inFlightOutcome !== "applied" && value.inFlightOutcome !== "not_applied"))) invalid();
  const desktop = value.plan.client.kind === "desktop";
  if ((!desktop && ["archive_requested", "restoring", "opening", "open_requested"].includes(String(value.phase)))
    || (desktop && ["close_requested", "reopening", "reopen_requested"].includes(String(value.phase)))) invalid();
}
