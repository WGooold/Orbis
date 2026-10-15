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
  #entries: Entry[] = [];
  #seq = 0;
  #dropped = 0;
  #counter = 0;

  constructor(options: DiagnosticJournalOptions = {}) {
    this.#maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
    this.#retentionMs = Math.max(1, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.#maxPageSize = Math.max(1, options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE);
    this.#now = options.now ?? Date.now;
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
    this.#evict();
    return record;
  }

  /** 读一页。游标太旧或指向已淘汰的位置时，`truncated` 为 true。 */
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
    return before - this.#entries.length;
  }

  stats(): { records: number; dropped: number; oldestAt: number | null; newestAt: number | null } {
    return {
      records: this.#entries.length,
      dropped: this.#dropped,
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

  /** 条数上限与保留窗口：先按时间淘汰，再按条数淘汰最旧的。 */
  #evict(): void {
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
