import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type {
  RemoteSessionEntry, RuntimeEvent, SessionCheckpoint, SessionLiveMessage, SessionLiveState,
  SessionLiveTool, SessionLiveTurn, SessionSourceEpoch,
} from "./index.js";
import { SESSION_SYNC_PAGE_BYTES, SESSION_SYNC_WRAPPER_BYTES } from "./session-sync.js";
import { displayBatchFor } from "./display-entries.js";

/**
 * 一条 Entry 线上表示的指纹（ADR-0035 §1）。
 *
 * 只服务一种情况：同一个 entryId 换了个对象。各适配层对「没变」的条目给的是同一个对象，
 * 所以常态是 WeakMap 命中；缓存也让重复比较不再序列化。
 */
const ENTRY_FINGERPRINTS = new WeakMap<object, string>();
function entryFingerprint(entry: RemoteSessionEntry): string {
  const cached = ENTRY_FINGERPRINTS.get(entry);
  if (cached !== undefined) return cached;
  const value = [entry.entryId, entry.parentId ?? "", entry.type, entry.timestamp, JSON.stringify(entry.data)].join("\u0000");
  ENTRY_FINGERPRINTS.set(entry, value);
  return value;
}

/**
 * live 正文的**下界**字节数（ADR-0035 §13）。
 *
 * 只用来判断「这条 live 已经大到任何 patch 都不可能装下」：JSON 转义只会让实际更大，
 * 所以下界超预算就一定超预算。低估的后果只是退回旧行为（构造完再丢弃），不会出错。
 */
function contentLowerBound(content: readonly unknown[]): number {
  let size = 2;
  for (const block of content) {
    if (typeof block !== "object" || block === null) { size += 4; continue; }
    const text = (block as { text?: unknown }).text;
    size += 16 + (typeof text === "string" ? text.length : 0);
  }
  return size;
}

/** 工具载荷的精确 JSON 字节数（写入时算一次；它本来就要被发出去）。 */
function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    return 0;
  }
}

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
  /**
   * live 条目的修订号（ADR-0035 §12）。
   *
   * 事务边界只比较 `id:rev`，不扫正文：写入条目时 +1，因此「写过」= 变了。
   * 误判方向固定为「多发一次 patch」（内容相同），不会是「漏发」。
   */
  #revision = 0;
  #messageRevs = new Map<string, number>();
  #toolRevs = new Map<string, number>();
  /** 每条 live 的字节数：§13 用来在构造 patch 之前判断它是否一定装不下。 */
  #messageBytes = new Map<string, number>();
  #toolBytes = new Map<string, number>();
  #turn: SessionLiveTurn | null = null;
  #depth = 0;
  #dirty = false;
  #committed: RemoteSessionEntry[] = [];
  #boundaryParentId: string | null = null;

  constructor(sessionId: string, publish: (event: Extract<RuntimeEvent, { type: "session.patch" }>) => void) {
    this.#sessionId = sessionId;
    this.#publish = publish;
  }

  /**
   * ADR-0035 §7/§12：事务不再序列化整份 live，只比较标量与各条目的修订号。
   *
   * 净效果为零的事务（适配层先清空 live 再补回来）不能推进 seq——客户端的 knownState
   * 依赖它（ADR-0026）。比较修订号能做到这一点且不扫正文。
   */
  transaction(action: () => void): void {
    const before = this.#depth === 0 ? this.#liveToken() : undefined;
    this.#depth++;
    try { action(); } finally {
      this.#depth--;
      if (this.#depth === 0 && this.#dirty) {
        // 事务内的临时改写（例如适配层先清空 live 再补回来）净效果为零时不能推进 seq：
        // 客户端的 knownState 依据 seq，白推进一次就永远对不上（ADR-0026）。
        if (before !== undefined && before === this.#liveToken()) {
          this.#dirty = false;
          this.#committed = [];
        } else {
          this.#flush();
        }
      }
    }
  }

  /** O(live 条目数) 的状态指纹：不碰正文，只看 id、布尔位与修订号。 */
  #liveToken(): string {
    const parts: string[] = [
      this.#epoch,
      this.#ready ? "1" : "0",
      this.#complete ? "1" : "0",
      this.#head ?? "-",
      this.#turn === null ? "-" : `${this.#turn.turnId}:${this.#turn.startedAt}:${this.#turn.durationMs ?? ""}`,
    ];
    for (const item of this.#messages.values()) {
      parts.push(`m:${item.message.messageId}:${this.#messageRevs.get(item.message.messageId) ?? 0}`);
    }
    for (const tool of this.#tools.values()) {
      parts.push(`t:${tool.toolCallId}:${this.#toolRevs.get(tool.toolCallId) ?? 0}`);
    }
    parts.sort();
    return parts.join("|");
  }

  /**
   * 声明「原生历史到此为止」的已验证边界（那条边界父条目的 id）。
   *
   * 有界读取（只加载了尾部若干条目）的分支靠它把起点说清楚：显示投影因此不会把「更旧的条目
   * 还没加载」误报成缺父，也不会因为缺父而整段不发显示结果。null 表示没有边界。
   */
  setHistoryBoundary(parentId: string | null): void {
    this.#boundaryParentId = parentId;
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
    this.#messageRevs = new Map(live.messages.map(item => [item.message.messageId, this.#nextRev()]));
    this.#toolRevs = new Map(live.tools.map(item => [item.toolCallId, this.#nextRev()]));
    this.#messageBytes = new Map(live.messages.map(item => [item.message.messageId, contentLowerBound(item.message.content)]));
    this.#toolBytes = new Map(live.tools.map(item => [item.toolCallId, jsonBytes(item.detail)]));
    this.#turn = structuredClone(live.turn);
    this.#complete = live.complete;
    this.#touch();
  }

  /**
   * ADR-0035 §12：每个 token 都会走这里，写入只做常数级工作——记修订号与体量，不扫正文。
   *
   * 代价是「写了又改回同一内容」会被算作变化（多推一次 seq、客户端多做一次 preview），
   * 方向是安全的：多发不等于漏发。
   */
  upsertMessage(item: SessionLiveMessage): void {
    this.#messages.set(item.message.messageId, item);
    this.#messageRevs.set(item.message.messageId, this.#nextRev());
    this.#messageBytes.set(item.message.messageId, contentLowerBound(item.message.content));
    this.#touch();
  }

  #nextRev(): number {
    this.#revision += 1;
    return this.#revision;
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
        this.#messageRevs.set(event.messageId, this.#nextRev());
        this.#messageBytes.set(event.messageId, contentLowerBound(content));
        this.#touch();
        return true;
      }
      case "turn.started":
        // 重复投递同一帧不是状态变化：推进 seq 会让客户端的 knownState 永远对不上（ADR-0026）。
        if (this.#turn?.turnId === event.turnId && this.#turn.startedAt === event.startedAt &&
          this.#turn.durationMs === undefined) return true;
        this.#turn = { turnId: event.turnId, startedAt: event.startedAt };
        this.#touch();
        return true;
      case "turn.finished":
        if (this.#turn?.turnId === event.turnId && this.#turn.startedAt === event.startedAt &&
          this.#turn.durationMs === event.durationMs) return true;
        this.#turn = { turnId: event.turnId, startedAt: event.startedAt, durationMs: event.durationMs };
        this.#touch();
        return true;
      case "tool.started":
      case "tool.updated":
      case "tool.finished": {
        const detail = event.type === "tool.started" ? event.arguments
          : event.type === "tool.updated" ? event.partialResult : event.result;
        const state = event.type === "tool.started" ? "started" : event.type === "tool.updated" ? "updated" : "finished";
        const existing = this.#tools.get(event.toolCallId);
        // 同一帧被重复投递（适配层每次 sync 重放快照）不是状态变化。工具载荷通常很小，
        // 一次 JSON 比较换来「重复投递不推进 seq」这条不变量。
        if (existing !== undefined && existing.toolName === event.toolName && existing.state === state &&
          existing.isError === (event.type === "tool.finished" ? event.isError : undefined) &&
          JSON.stringify(existing.detail ?? null) === JSON.stringify(detail ?? null)) return true;
        this.#tools.set(event.toolCallId, {
          toolCallId: event.toolCallId, toolName: event.toolName,
          state,
          ...(detail === undefined ? {} : { detail: structuredClone(detail) }),
          ...(event.type !== "tool.finished" ? {} : { isError: event.isError }),
        });
        this.#toolRevs.set(event.toolCallId, this.#nextRev());
        this.#toolBytes.set(event.toolCallId, jsonBytes(detail));
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
      const next = new Map<string, RemoteSessionEntry>();
      for (const entry of entries) {
        if (next.has(entry.entryId)) throw new Error("duplicate_entry_id");
        next.set(entry.entryId, entry);
      }
      // ADR-0035 §1/§2：引用相同就是没变（各适配层对未变条目给的是同一对象）；
      // 只有同一个 id 换了对象才付一次指纹比较，且比较结果会缓存。
      let corrected = false;
      for (const [id, entry] of next) {
        const old = this.#entries.get(id);
        if (old === undefined || old === entry) continue;
        if (entryFingerprint(old) !== entryFingerprint(entry)) { corrected = true; break; }
      }
      let removed = false;
      if (!corrected) {
        for (const id of this.#entries.keys()) if (!next.has(id)) { removed = true; break; }
      }
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
        for (const [id, entry] of next) if (!this.#entries.has(id)) this.#committed.push(structuredClone(entry));
      }
      // Filling older ancestor coverage is not a current-state transition and does not advance seq.
      if (corrected || removed || this.#head !== head) this.#dirty = true;
      // ADR-0035 §2：只 clone 新条目与 corrected 条目；未变化的保持原引用（不 clone、不比较）。
      for (const [id, entry] of next) {
        const old = this.#entries.get(id);
        if (old === entry) continue;
        // 存引用而不是克隆：适配层约定 Entry 不可变、修正时换新对象（ADR-0035 §2）。
        // 这是「未变化 → O(1)」能成立的前提；克隆会让每次 reconcile 都对全历史做指纹比较。
        if (old === undefined || entryFingerprint(old) !== entryFingerprint(entry)) {
          this.#entries.set(id, entry);
        }
      }
      for (const id of [...this.#entries.keys()]) if (!next.has(id)) this.#entries.delete(id);
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
        if ((raw.role === "toolResult" || raw.role === "tool") && typeof raw.toolCallId === "string" && this.#tools.delete(raw.toolCallId)) {
          this.#toolRevs.delete(raw.toolCallId);
          this.#toolBytes.delete(raw.toolCallId);
          this.#dirty = true;
        }
      }
      const ids = new Set(entries.map(entry => entry.entryId));
      for (const [id, item] of this.#messages) {
        if (ids.has(id) || ids.has(item.persistedEntryId ?? mapped.get(id) ?? "")) {
          this.#messages.delete(id);
          this.#messageRevs.delete(id);
          this.#messageBytes.delete(id);
          this.#dirty = true;
        }
      }
    });
  }

  /**
   * ADR-0035 §9：发件积压排空后重新建立基线。
   *
   * 换新 epoch、先发一帧 unknown，让 Host 丢掉对着旧 seq 链的任何期待；下一次
   * `reconcile` + `setAvailability(true, …)` 会把权威基线重新发出去。
   */
  reestablish(): void {
    this.#epoch = randomUUID();
    this.#seq = 1;
    this.#committed = [];
    this.#ready = false;
    this.#dirty = false;
    this.#publish({
      type: "session.patch", sessionId: this.#sessionId,
      source: { epoch: this.#epoch, seq: 1, ready: false }, baseSeq: 0, seq: 1,
      checkpointId: `${this.#epoch}:1`, head: { leafId: null }, headCompleteness: "unknown",
      live: { complete: false, turn: null, messages: [], tools: [] },
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

  /** live 序列化后的下界字节数（ADR-0035 §13）；O(live 条目数)，不碰正文。 */
  #liveLowerBoundBytes(): number {
    let total = 128;
    for (const id of this.#messages.keys()) total += this.#messageBytes.get(id) ?? 0;
    for (const id of this.#tools.keys()) total += this.#toolBytes.get(id) ?? 0;
    return total;
  }

  #touch(): void {
    this.#dirty = true;
    if (this.#depth === 0) this.#flush();
  }

  #flush(): void {
    if (process.env.ORBIS_SEQ_DEBUG) { try { appendFileSync(process.env.ORBIS_SEQ_DEBUG, `FLUSH ${this.#sessionId.slice(0, 24)} seq=${this.#seq + 1} ready=${this.#ready} complete=${this.#complete} committed=${this.#committed.length} msg=${this.#messages.size} tools=${this.#tools.size} turn=${this.#turn?.turnId ?? "-"}\n`); } catch { /* debug only */ } }
    this.#dirty = false;
    if (this.#messages.size > 256 || this.#tools.size > 256) { this.#committed = []; return; }
    // ADR-0035 §13：先用 O(条目数) 的**下界**预判预算，超了就跳过构造（别再白 clone + stringify）。
    if (this.#liveLowerBoundBytes() > SESSION_SYNC_PAGE_BYTES - SESSION_SYNC_WRAPPER_BYTES) {
      this.#committed = [];
      return;
    }
    // 只有真的会发布时才推进版本：Host 要求 baseSeq === 上一版 seq，跳过时推进会留下永久缺口，
    // 之后每一条 patch 都会被拒绝（现场表现为 Host 诊断里每秒两条 Rejected conversation transaction）。
    this.#seq++;
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
      Buffer.byteLength(JSON.stringify(withEntries), "utf8") + SESSION_SYNC_WRAPPER_BYTES <= SESSION_SYNC_PAGE_BYTES) {
      patch.entries = committed;
      // 显示投影与这批条目绑定同一来源版本，跟着同一份 patch 走：客户端因此不必解释原生形状。
      const display = displayBatchFor(committed, this.#entries, this.#head, { boundaryParentId: this.#boundaryParentId });
      if (display !== undefined) patch.display = display;
    }
    // Oversize state remains recoverable as an explicit sync error, never a truncated complete inventory.
    // 精确检查也可能在粗略预判之后才判超（少数字符的转义膨胀）：同样回滚版本，不留缺口。
    if (patch.live.messages.length > 256 || patch.live.tools.length > 256 ||
      Buffer.byteLength(JSON.stringify(patch), "utf8") + SESSION_SYNC_WRAPPER_BYTES > SESSION_SYNC_PAGE_BYTES) {
      this.#seq -= 1;
      return;
    }
    this.#publish(patch);
  }
}
