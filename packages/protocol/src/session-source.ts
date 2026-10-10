import { randomUUID } from "node:crypto";
import type {
  RemoteSessionEntry, RuntimeEvent, SessionCheckpoint, SessionLiveMessage, SessionLiveState,
  SessionLiveTool, SessionLiveTurn, SessionSourceEpoch,
} from "./index.js";
import { SESSION_SYNC_PAGE_BYTES, SESSION_SYNC_WRAPPER_BYTES } from "./session-sync.js";

/** Source-owned, transport-independent state. Adapters supply native history and exact identities. */
export class RecoverableSessionSource {
  readonly #sessionId: string;
  readonly #publish: (event: Extract<RuntimeEvent, { type: "session.patch" }>) => void;
  #epoch = randomUUID();
  #seq = 0;
  #ready = false;
  #complete = false;
  #head: string | null = null;
  #entries = new Map<string, RemoteSessionEntry>();
  #messages = new Map<string, SessionLiveMessage>();
  #tools = new Map<string, SessionLiveTool>();
  #turn: SessionLiveTurn | null = null;
  #depth = 0;
  #dirty = false;
  #committed: RemoteSessionEntry[] = [];

  constructor(sessionId: string, publish: (event: Extract<RuntimeEvent, { type: "session.patch" }>) => void) {
    this.#sessionId = sessionId;
    this.#publish = publish;
  }

  transaction(action: () => void): void {
    const before = this.#depth === 0 ? this.#fingerprint() : undefined;
    this.#depth++;
    try { action(); } finally {
      this.#depth--;
      if (this.#depth === 0 && this.#dirty) {
        if (before !== this.#fingerprint()) this.#flush();
        else { this.#dirty = false; this.#committed = []; }
      }
    }
  }

  #fingerprint(): string {
    return JSON.stringify([this.#epoch, this.#ready, this.#complete, this.#head, this.#turn, [...this.#messages.values()], [...this.#tools.values()]]);
  }

  /** Unknown is not empty. Retain observed output while a native read is in flight or failed. */
  setAvailability(ready: boolean, complete: boolean): void {
    if (ready === this.#ready && complete === this.#complete) return;
    this.#ready = ready;
    this.#complete = complete;
    this.#touch();
  }

  replaceLive(live: SessionLiveState): void {
    const current = { complete: this.#complete, turn: this.#turn, messages: [...this.#messages.values()], tools: [...this.#tools.values()] };
    if (JSON.stringify(current) === JSON.stringify(live)) return;
    this.#messages = new Map(live.messages.map(item => [item.message.messageId, structuredClone(item)]));
    this.#tools = new Map(live.tools.map(item => [item.toolCallId, structuredClone(item)]));
    this.#turn = structuredClone(live.turn);
    this.#complete = live.complete;
    this.#touch();
  }

  upsertMessage(item: SessionLiveMessage): void {
    if (JSON.stringify(this.#messages.get(item.message.messageId)) === JSON.stringify(item)) return;
    this.#messages.set(item.message.messageId, structuredClone(item));
    this.#touch();
  }

  /** Returns true for legacy lifecycle events consumed by the versioned source. */
  observe(event: RuntimeEvent): boolean {
    switch (event.type) {
      case "message.started":
      case "message.finished":
        this.upsertMessage({ message: event.message, finished: event.type === "message.finished", contentComplete: true });
        return true;
      case "message.delta": {
        const item = this.#messages.get(event.messageId);
        if (!item || item.finished) return true;
        const type = event.contentType ?? "text";
        const content = item.message.content;
        const index = event.contentIndex ?? Math.max(0, content.length - 1);
        const block = content[index];
        if (type === "tool_call") {
          // Pi supplies a full message for tool JSON; wire-only deltas cannot prove its structure.
          item.contentComplete = false;
        } else if (block?.type === type) block.text = (block.text ?? "") + event.delta;
        else content.push({ type, text: event.delta });
        this.#touch();
        return true;
      }
      case "turn.started":
        this.#turn = { turnId: event.turnId, startedAt: event.startedAt };
        this.#touch();
        return true;
      case "turn.finished":
        if (this.#turn?.turnId === event.turnId) this.#turn = null;
        this.#touch();
        return true;
      case "tool.started":
      case "tool.updated":
      case "tool.finished": {
        const detail = event.type === "tool.started" ? event.arguments
          : event.type === "tool.updated" ? event.partialResult : event.result;
        this.#tools.set(event.toolCallId, {
          toolCallId: event.toolCallId, toolName: event.toolName,
          state: event.type === "tool.started" ? "started" : event.type === "tool.updated" ? "updated" : "finished",
          ...(detail === undefined ? {} : { detail: structuredClone(detail) }),
          ...(event.type !== "tool.finished" ? {} : { isError: event.isError }),
        });
        this.#touch();
        return true;
      }
      default: return false;
    }
  }

  /** Commit history and remove its live twins at one version. Never infer identity from text. */
  reconcile(entries: readonly RemoteSessionEntry[], head: string | null,
    mappings: readonly { messageId: string; entryId: string }[] = []): void {
    this.transaction(() => {
      const next = new Map(entries.map(entry => [entry.entryId, entry]));
      if (next.size !== entries.length) throw new Error("duplicate_entry_id");
      const corrected = entries.some(entry => {
        const old = this.#entries.get(entry.entryId);
        return old !== undefined && JSON.stringify(old) !== JSON.stringify(entry);
      });
      const removed = [...this.#entries.keys()].some(id => !next.has(id));
      let ancestor = head;
      const visited = new Set<string>();
      while (ancestor !== null && ancestor !== this.#head && !visited.has(ancestor)) {
        visited.add(ancestor);
        ancestor = next.get(ancestor)?.parentId ?? null;
      }
      if (corrected || removed || (this.#head !== null && ancestor !== this.#head)) {
        this.#epoch = randomUUID();
        this.#seq = 0;
        // A ready patch cannot establish a new cache epoch. Publish unknown before recovery.
        const ready = this.#ready;
        this.#ready = false;
        this.#publish({ type: "session.patch", sessionId: this.#sessionId, source: { epoch: this.#epoch, seq: 1, ready: false },
          baseSeq: 0, seq: 1, checkpointId: `${this.#epoch}:1`, head: { leafId: null },
          headCompleteness: "unknown", live: { complete: false, turn: null, messages: [], tools: [] } });
        this.#seq = 1;
        this.#ready = ready;
        this.#dirty = true;
      }
      if (head !== this.#head) {
        for (const entry of entries) if (!this.#entries.has(entry.entryId)) this.#committed.push(structuredClone(entry));
      }
      // Filling older ancestor coverage is not a current-state transition and does not advance seq.
      if (corrected || removed || this.#head !== head) this.#dirty = true;
      this.#entries = new Map(entries.map(entry => [entry.entryId, structuredClone(entry)]));
      this.#head = head;
      for (const mapping of mappings) {
        const item = this.#messages.get(mapping.messageId);
        if (item && item.persistedEntryId !== mapping.entryId) { item.persistedEntryId = mapping.entryId; this.#dirty = true; }
      }
      const mapped = new Map(mappings.map(mapping => [mapping.messageId, mapping.entryId]));
      for (const entry of entries) {
        const message = entry.data.message;
        if (message === null || typeof message !== "object") continue;
        const raw = message as { messageId?: unknown; toolCallId?: unknown; role?: unknown };
        if (typeof raw.messageId === "string") mapped.set(raw.messageId, entry.entryId);
        if ((raw.role === "toolResult" || raw.role === "tool") && typeof raw.toolCallId === "string" && this.#tools.delete(raw.toolCallId)) this.#dirty = true;
      }
      const ids = new Set(entries.map(entry => entry.entryId));
      for (const [id, item] of this.#messages) {
        if (ids.has(id) || ids.has(item.persistedEntryId ?? mapped.get(id) ?? "")) {
          this.#messages.delete(id);
          this.#dirty = true;
        }
      }
    });
  }

  snapshot(): { version: SessionSourceEpoch; checkpoint: SessionCheckpoint; live: SessionLiveState } {
    if (this.#messages.size > 256 || this.#tools.size > 256) throw new Error("session_live_inventory_too_large");
    const complete = this.#ready && this.#complete;
    return {
      version: { epoch: this.#epoch, seq: this.#seq, ready: this.#ready },
      checkpoint: { checkpointId: `${this.#epoch}:${this.#seq}`, head: { leafId: this.#ready ? this.#head : null },
        headCompleteness: this.#ready ? "complete" : "unknown", inventoryComplete: complete },
      live: { complete, turn: structuredClone(this.#turn), messages: structuredClone([...this.#messages.values()]), tools: structuredClone([...this.#tools.values()]) },
    };
  }

  #touch(): void {
    this.#dirty = true;
    if (this.#depth === 0) this.#flush();
  }

  #flush(): void {
    this.#dirty = false;
    this.#seq++;
    if (this.#messages.size > 256 || this.#tools.size > 256) { this.#committed = []; return; }
    const snapshot = this.snapshot();
    const patch: Extract<RuntimeEvent, { type: "session.patch" }> = {
      type: "session.patch", sessionId: this.#sessionId, source: snapshot.version, baseSeq: this.#seq - 1, seq: this.#seq,
      checkpointId: snapshot.checkpoint.checkpointId, head: snapshot.checkpoint.head,
      headCompleteness: snapshot.checkpoint.headCompleteness, live: snapshot.live,
    };
    const committed = this.#committed;
    this.#committed = [];
    const withEntries = { ...patch, entries: committed };
    if (this.#ready && committed.length > 0 && committed.length <= 256 &&
      Buffer.byteLength(JSON.stringify(withEntries), "utf8") + SESSION_SYNC_WRAPPER_BYTES <= SESSION_SYNC_PAGE_BYTES) patch.entries = committed;
    // Oversize state remains recoverable as an explicit sync error, never a truncated complete inventory.
    if (patch.live.messages.length > 256 || patch.live.tools.length > 256 ||
      Buffer.byteLength(JSON.stringify(patch), "utf8") + SESSION_SYNC_WRAPPER_BYTES > SESSION_SYNC_PAGE_BYTES) return;
    this.#publish(patch);
  }
}
