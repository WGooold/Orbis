import { randomUUID } from "node:crypto";
import { WIRE_FIELD_LIMIT_BYTES, truncateWireLive } from "./wire-truncate.js";
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
  /** 最近一次真正发布出去的状态；`snapshot()` 在变化未发出时原样返回它（见 snapshot 注释）。 */
  #published: { seq: number; ready: boolean; complete: boolean; head: string | null; live: SessionLiveState } | undefined;
  #committed: RemoteSessionEntry[] = [];
  #boundaryParentId: string | null = null;

  /**
   * `coalesceMs > 0` 时，状态变化最多每 N 毫秒发布一条 patch（ADR-0035 §15）。
   *
   * 流式输出会把"每个 token 一次 patch"推给手机：90 次/秒的 `session.patch` 让手机每次都要
   * 重新投影整段会话（现场 5s 内 450 帧、CPU 207%、每 2 秒一次 GC、滚动掉帧 39%）。
   * 合并只影响**发布节奏**：状态仍完整保存在源端，seq 只在真正发布时推进，序列保持连续。
   * 默认 0 = 同步发布，既有调用方与测试行为不变。
   */
  constructor(
    sessionId: string,
    publish: (event: Extract<RuntimeEvent, { type: "session.patch" }>) => void,
    options: { coalesceMs?: number } = {},
  ) {
    this.#sessionId = sessionId;
    this.#publish = publish;
    this.#coalesceMs = options.coalesceMs ?? 0;
  }

  /** 合并窗口（毫秒）；0 表示关闭。 */
  #coalesceMs = 0;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 把这次状态变化排进合并窗口。
   *
   * 任何要在响应里携带 `source.seq` 的路径都必须先 `flushPending()`：窗口会把"版本号的最终值"
   * 推迟到窗口结束，读早了客户端就会拿着一个马上失效的 knownState 去请求（永远回不了 unchanged）。
   */
  #requestFlush(): void {
    if (this.#coalesceMs <= 0) { this.#flush(); return; }
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      if (this.#dirty) this.#flush();
    }, this.#coalesceMs);
    this.#flushTimer.unref?.();
  }

  /** 立刻发布挂起的窗口（ADR-0035 §15 的配套不变量）。 */
  flushPending(): void {
    if (this.#flushTimer !== undefined) { clearTimeout(this.#flushTimer); this.#flushTimer = undefined; }
    // 没有定时器也可能是脏的：#flush 因预算回滚后会清掉 #dirty 而不留定时器。
    if (this.#dirty) this.#flush();
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
          this.#requestFlush();
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
        const handshakeLive: SessionLiveState = { complete: false, turn: null, messages: [], tools: [] };
        this.#published = { seq: 1, ready: false, complete: false, head: null, live: handshakeLive };
        this.#publish({ type: "session.patch", sessionId: this.#sessionId, source: { epoch: this.#epoch, seq: 1, ready: false },
          baseSeq: 0, seq: 1, checkpointId: `${this.#epoch}:1`, head: { leafId: null },
          headCompleteness: "unknown", live: handshakeLive });
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
    const live: SessionLiveState = { complete: false, turn: null, messages: [], tools: [] };
    this.#published = { seq: 1, ready: false, complete: false, head: null, live };
    this.#publish({
      type: "session.patch", sessionId: this.#sessionId,
      source: { epoch: this.#epoch, seq: 1, ready: false }, baseSeq: 0, seq: 1,
      checkpointId: `${this.#epoch}:1`, head: { leafId: null }, headCompleteness: "unknown",
      live,
    });
  }

  /**
   * 源端的**当前**状态（可能还没发布出去）。要发 `session.sync` 响应时用 [published]：
   * `seq` 只标识已经发出去的那一版（ADR-0026）。
   */
  snapshot(): { version: SessionSourceEpoch; checkpoint: SessionCheckpoint; live: SessionLiveState } {
    if (this.#messages.size > 256 || this.#tools.size > 256) throw new Error("session_live_inventory_too_large");
    return this.#currentSnapshot();
  }

  /**
   * **已发布**的那一版状态：对端（Host/手机）手里保存的就是它。
   *
   * ADR-0026：`seq` 是状态的标识，不是计数器。合并窗口里还没发出去的变化、或上一次 `#flush`
   * 因超出线路预算回滚时，当前状态已经不再是 `#seq` 所指的那一版。以前同步响应用 `snapshot()`
   * 如实返回当前状态，同一个 `seq` 就带着两份不同的 head/live 出去，Host 的
   * `AgentConversationState.accept` 以 `same_seq_state_mismatch` 拒收整条 preview
   * （现场：流式输出期间每 10–50 秒一条 `session_sync_model_rejected`，聊天页停在旧内容，
   * 直到本轮结束、live 缩小后才恢复）。
   */
  published(): { version: SessionSourceEpoch; checkpoint: SessionCheckpoint; live: SessionLiveState } {
    if (this.#published !== undefined && this.#published.seq === this.#seq) return this.#publishedSnapshot(this.#published);
    return this.snapshot();
  }

  #currentSnapshot(): { version: SessionSourceEpoch; checkpoint: SessionCheckpoint; live: SessionLiveState } {
    const complete = this.#ready && this.#complete;
    return {
      version: { epoch: this.#epoch, seq: this.#seq, ready: this.#ready },
      checkpoint: { checkpointId: `${this.#epoch}:${this.#seq}`, head: { leafId: this.#ready ? this.#head : null },
        headCompleteness: this.#ready ? "complete" : "unknown", inventoryComplete: complete },
      live: { complete, turn: structuredClone(this.#turn), messages: structuredClone([...this.#messages.values()]), tools: structuredClone([...this.#tools.values()]) },
    };
  }

  /** 已发布那一版的原样投影：与对端手里那份逐字段一致（含线路截断）。 */
  #publishedSnapshot(published: { seq: number; ready: boolean; complete: boolean; head: string | null; live: SessionLiveState }): {
    version: SessionSourceEpoch; checkpoint: SessionCheckpoint; live: SessionLiveState;
  } {
    const complete = published.ready && published.complete;
    return {
      version: { epoch: this.#epoch, seq: published.seq, ready: published.ready },
      checkpoint: { checkpointId: `${this.#epoch}:${published.seq}`,
        head: { leafId: published.ready ? published.head : null },
        headCompleteness: published.ready ? "complete" : "unknown", inventoryComplete: complete },
      live: structuredClone(published.live),
    };
  }

  #touch(): void {
    this.#dirty = true;
    if (this.#depth === 0) this.#requestFlush();
  }

  /**
   * 构造有界 patch。流式正文过大时缩紧正文预算，已 reconcile 的历史条目仍必须随连续 seq 发出；
   * 如果连空 live 都超预算，就先仅发 canonical 条目，live 状态随后在 sync/checkpoint 收敛。
   */
  #flush(): void {
    if (process.env.ORBIS_SEQ_DEBUG) { try { appendFileSync(process.env.ORBIS_SEQ_DEBUG, `FLUSH ${this.#sessionId.slice(0, 24)} seq=${this.#seq + 1} ready=${this.#ready} complete=${this.#complete} committed=${this.#committed.length} msg=${this.#messages.size} tools=${this.#tools.size} turn=${this.#turn?.turnId ?? "-"}\n`); } catch { /* debug only */ } }
    this.#dirty = false;
    if (this.#messages.size > 256 || this.#tools.size > 256) { this.#committed = []; return; }
    const current = this.#currentSnapshot();
    const committed = this.#committed;
    if (this.#ready && committed.length > 256) return;
    // If canonical entries are pending, never publish the new head without them. Otherwise the
    // receiver cannot build the parent chain and its projection becomes empty.
    const batches: readonly RemoteSessionEntry[][] = this.#ready && committed.length > 0
      ? [committed] : [[]];
    let chosen: { patch: Extract<RuntimeEvent, { type: "session.patch" }>; entryCount: number } | undefined;
    for (const batch of batches) {
      for (let limit = WIRE_FIELD_LIMIT_BYTES; ; limit = Math.floor(limit / 2)) {
        const live = limit === WIRE_FIELD_LIMIT_BYTES
          ? structuredClone(current.live)
          : truncateWireLive(structuredClone(current.live), limit);
        const patch: Extract<RuntimeEvent, { type: "session.patch" }> = {
          type: "session.patch", sessionId: this.#sessionId, source: current.version,
          baseSeq: this.#seq, seq: this.#seq + 1,
          checkpointId: `${this.#epoch}:${this.#seq + 1}`, head: current.checkpoint.head,
          headCompleteness: current.checkpoint.headCompleteness, live,
        };
        if (batch.length > 0) {
          patch.entries = [...batch];
          const display = displayBatchFor(batch, this.#entries, this.#head, { boundaryParentId: this.#boundaryParentId });
          if (display !== undefined) patch.display = display;
        }
        if (Buffer.byteLength(JSON.stringify(patch), "utf8") + SESSION_SYNC_WRAPPER_BYTES <= SESSION_SYNC_PAGE_BYTES) {
          chosen = { patch, entryCount: batch.length };
          break;
        }
        if (limit <= 2 * 1024) break;
      }
      if (chosen !== undefined) break;
    }
    // Nothing was published, so retain committed rows and version. A later state change retries.
    if (chosen === undefined) return;
    this.#seq += 1;
    chosen.patch.seq = this.#seq;
    chosen.patch.source = { ...current.version, seq: this.#seq };
    chosen.patch.checkpointId = `${this.#epoch}:${this.#seq}`;
    this.#committed = [];
    this.#published = { seq: this.#seq, ready: this.#ready, complete: this.#complete, head: this.#head, live: chosen.patch.live };
    this.#publish(chosen.patch);
  }
}
