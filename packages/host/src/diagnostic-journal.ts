import type { DiagnosticPage, DiagnosticRecord } from "@pi-remote/protocol";

/**
 * 有界诊断记录（ADR-0032 模块 23）。
 *
 * 三条纪律：
 * - **有界**：条数上限 + 保留窗口，超出就淘汰；淘汰必须能被客户端看见（`truncated`），
 *   不能让「翻页翻不到」冒充「这里本来就没有记录」。
 * - **游标读取**：游标是不透明字符串，指向「我已经看到哪一条」；游标太旧（它指向的记录已被
 *   淘汰）时返回当前窗口并置 `truncated`，而不是静默从头开始。
 * - **只记事实**：正文、凭据、脚本不进这里；写不进去也不影响被记录的那次操作。
 */

export type DiagnosticAppendInput = Omit<DiagnosticRecord, "recordId" | "at"> & {
  readonly recordId?: string;
  readonly at?: number;
};

export type DiagnosticPageRequest = {
  /** 上次返回的 `nextCursor`；不传表示从当前保留窗口的最旧一条开始。 */
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly category?: string;
  readonly severity?: DiagnosticRecord["severity"];
  readonly sessionId?: string;
};

export type DiagnosticJournalOptions = {
  readonly maxRecords?: number;
  readonly retentionMs?: number;
  readonly now?: () => number;
  /** 单次读取的条数上限。 */
  readonly maxPageSize?: number;
  /** 落盘钩子；不传就是纯内存，进程重启即丢。 */
  readonly persistence?: DiagnosticJournalPersistence;
};

/**
 * 持久化钩子（ADR-0032 模块 23）：Journal 只决定**什么时候**该写，写到哪儿由调用方决定。
 *
 * 三个动作都必须自己吞掉失败——记录落盘失败不该让被记录的那次操作失败；失败次数记进
 * `stats().persistFailures`，这样「盘上少了一段」是能被看见的缺口，而不是无声的丢失。
 */
export type DiagnosticJournalPersistence = {
  readonly load: () => readonly DiagnosticRecord[];
  readonly append: (record: DiagnosticRecord) => void;
  readonly rewrite: (records: readonly DiagnosticRecord[]) => void;
};

const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PAGE_SIZE = 500;

type Entry = { readonly seq: number; readonly record: DiagnosticRecord };

export class DiagnosticJournal {
  readonly #maxRecords: number;
  readonly #retentionMs: number;
  readonly #maxPageSize: number;
  readonly #now: () => number;
  readonly #persistence: DiagnosticJournalPersistence | undefined;
  #entries: Entry[] = [];
  #seq = 0;
  #dropped = 0;
  #counter = 0;
  #persistFailures = 0;

  constructor(options: DiagnosticJournalOptions = {}) {
    this.#maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
    this.#retentionMs = Math.max(1, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.#maxPageSize = Math.max(1, options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE);
    this.#now = options.now ?? Date.now;
    this.#persistence = options.persistence;
    this.#restore();
  }

  /**
   * 读回上一次运行留下的记录。读失败不能让 Host 起不来：诊断是旁路，缺一段就记一次缺口。
   */
  #restore(): void {
    if (this.#persistence === undefined) return;
    let stored: readonly DiagnosticRecord[];
    try {
      stored = this.#persistence.load();
    } catch {
      this.#persistFailures += 1;
      return;
    }
    for (const record of stored) {
      this.#seq += 1;
      this.#counter += 1;
      this.#entries.push({ seq: this.#seq, record });
    }
    this.#evict();
  }

  /** 追加一条记录。返回写下的记录；调用方拿它做日志或断言。 */
  append(input: DiagnosticAppendInput): DiagnosticRecord {
    const at = input.at ?? this.#now();
    this.#counter += 1;
    const record: DiagnosticRecord = {
      recordId: input.recordId ?? `${at.toString(36)}-${this.#counter.toString(36)}`,
      scope: input.scope,
      agentKind: input.agentKind,
      sessionId: input.sessionId,
      category: input.category,
      severity: input.severity,
      message: input.message,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      at,
    };
    this.#seq += 1;
    this.#entries.push({ seq: this.#seq, record });
    // 淘汰会改变盘上那份的内容，所以两种情况各写一次，而不是先追加再整体重写。
    if (this.#evict() > 0) this.#rewriteAll();
    else this.#appendOne(record);
    return record;
  }

  /**
   * 读一页。游标太旧或指向已淘汰的位置时，`truncated` 为 true。
   *
   * **方向**：页从保留窗口里**最旧**一条开始，往后（更新）取 `limit` 条；`nextCursor` 因此指向
   * 「比这一页更新的还没读的那些」，为 null 表示已经追平最新。客户端别把它当成「还有更早的」——
   * 那会让界面把「一页里最新的一条」说成「最近的一条」。
   */
  page(request: DiagnosticPageRequest = {}): DiagnosticPage {
    this.#evict();
    const limit = Math.min(Math.max(1, request.limit ?? this.#maxPageSize), this.#maxPageSize);
    const from = this.#decodeCursor(request.cursor);
    const oldest = this.#entries[0]?.seq ?? this.#seq + 1;
    // 游标落后于保留窗口：中间那一段已经被淘汰，如实报告缺口。
    const truncated = from !== undefined && from + 1 < oldest;
    const startSeq = from === undefined ? oldest : Math.max(from + 1, oldest);
    const matched: DiagnosticRecord[] = [];
    let lastSeq = startSeq - 1;
    for (const entry of this.#entries) {
      if (entry.seq < startSeq) continue;
      if (matched.length >= limit) break;
      if (!this.#matches(entry.record, request)) {
        // 被过滤掉的记录也算「看过了」，游标必须越过它，否则下一页会原地打转。
        lastSeq = entry.seq;
        continue;
      }
      matched.push(entry.record);
      lastSeq = entry.seq;
    }
    const consumed = this.#entries.length > 0 && lastSeq >= this.#entries[this.#entries.length - 1]!.seq;
    const nextCursor = consumed ? null : this.#encodeCursor(lastSeq < startSeq - 1 ? startSeq - 1 : lastSeq);
    return { records: matched, nextCursor, truncated };
  }

  /** 线程/会话结束时按作用域清掉：留着的记录只会变成误导。 */
  forgetSession(sessionId: string): number {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter(entry => entry.record.sessionId !== sessionId);
    const removed = before - this.#entries.length;
    if (removed > 0) this.#rewriteAll();
    return removed;
  }

  stats(): { records: number; dropped: number; persistFailures: number; oldestAt: number | null; newestAt: number | null } {
    return {
      records: this.#entries.length,
      dropped: this.#dropped,
      // 落盘失败次数：>0 表示盘上那份比内存里这份少，读盘的人必须知道有缺口。
      persistFailures: this.#persistFailures,
      oldestAt: this.#entries[0]?.record.at ?? null,
      newestAt: this.#entries[this.#entries.length - 1]?.record.at ?? null,
    };
  }

  #matches(record: DiagnosticRecord, request: DiagnosticPageRequest): boolean {
    if (request.category !== undefined && record.category !== request.category) return false;
    if (request.severity !== undefined && record.severity !== request.severity) return false;
    if (request.sessionId !== undefined && record.sessionId !== request.sessionId) return false;
    return true;
  }

  /** 条数上限与保留窗口：先按时间淘汰，再按条数淘汰最旧的。返回淘汰条数。 */
  #evict(): number {
    const droppedBefore = this.#dropped;
    const cutoff = this.#now() - this.#retentionMs;
    const expired = this.#entries.findIndex(entry => entry.record.at >= cutoff);
    if (expired > 0) {
      this.#dropped += expired;
      this.#entries = this.#entries.slice(expired);
    } else if (expired < 0 && this.#entries.length > 0) {
      this.#dropped += this.#entries.length;
      this.#entries = [];
    }
    if (this.#entries.length > this.#maxRecords) {
      const excess = this.#entries.length - this.#maxRecords;
      this.#dropped += excess;
      this.#entries = this.#entries.slice(excess);
    }
    return this.#dropped - droppedBefore;
  }

  #appendOne(record: DiagnosticRecord): void {
    if (this.#persistence === undefined) return;
    try {
      this.#persistence.append(record);
    } catch {
      this.#persistFailures += 1;
    }
  }

  #rewriteAll(): void {
    if (this.#persistence === undefined) return;
    try {
      this.#persistence.rewrite(this.#entries.map(entry => entry.record));
    } catch {
      this.#persistFailures += 1;
    }
  }

  #encodeCursor(seq: number): string {
    return Buffer.from(`r1:${seq}`, "utf8").toString("base64url");
  }

  #decodeCursor(cursor: string | null | undefined): number | undefined {
    if (cursor === null || cursor === undefined || cursor === "") return undefined;
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^r1:(\d+)$/.exec(text);
    if (match === null) return undefined;
    const seq = Number(match[1]);
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
  }
}
