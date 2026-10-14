import { DISPLAY_PROJECTION_VERSION, type DisplayEntry, type DisplayProjection } from "./display-entries.js";

/**
 * Host 侧的有界显示页缓存与范围索引（ADR-0032 §5，issue #7）。
 *
 * 它只缓存**已经归一好的显示页**，不自己去查原生历史——adapter 查询与归一仍由上层负责，
 * 这样缓存策略可以单独验证，协议接入（issue #10）再决定什么时候真的去问 adapter。
 *
 * 有效性的判据是 `sourceEpoch`，**不是** sourceRevision：
 * canonical 历史在同一代次里是追加式的，新内容推进 revision 不会改写更旧的范围；真正
 * 「历史被改写」的信号是换代次（ADR-0025 的 revert/rebuild）。要求 revision 完全相等
 * 会让忙碌会话的历史页永远用不上，等于没有缓存。
 */

export type DisplayPageRequest = {
  readonly scopeId: string;
  /** 这一段历史属于哪个 head；head 变了就是另一条分支。 */
  readonly leafId: string | null;
  /** 该页之前的条目 id；null 表示从叶子往前数的第一页。 */
  readonly beforeEntryId: string | null;
  readonly maxEntries: number;
};

export type DisplayPageSource = {
  readonly sourceEpoch: string;
  readonly sourceRevision: number;
};

export type DisplayPage = {
  readonly request: DisplayPageRequest;
  readonly sourceEpoch: string;
  readonly sourceRevision: number;
  readonly projectionVersion: number;
  readonly entries: DisplayEntry[];
  /** 显示窗口起点：比它更旧的路径条目已经被历史改写覆盖。null = 整条路径都是窗口。 */
  readonly windowStart: string | null;
  /** 这一页之外还有更旧的内容。false 表示已经到分支起点。 */
  readonly hasOlder: boolean;
  readonly status: DisplayProjection["status"];
  readonly createdAt: number;
  readonly bytes: number;
  /** 因为每页上限被截断：这一页之后还有内容没放进来。 */
  readonly truncated: boolean;
};

/** 一个会话已经缓存到哪：回答「这段历史我有没有」而不必再问 adapter。 */
export type DisplayCoverage = {
  readonly leafId: string | null;
  /** 已经缓存到的最旧条目；比它更旧的还没有。 */
  readonly oldestEntryId: string | null;
  /** 已经确认到达分支起点。 */
  readonly reachedStart: boolean;
  readonly entries: number;
  readonly pages: number;
};

export type DisplayPageCacheOptions = {
  readonly maxPages?: number;
  readonly maxEntriesPerPage?: number;
  readonly maxBytes?: number;
  readonly projectionVersion?: number;
  readonly now?: () => number;
};

const DEFAULT_MAX_PAGES = 64;
const DEFAULT_MAX_ENTRIES_PER_PAGE = 200;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class DisplayPageCache {
  readonly #pages = new Map<string, DisplayPage>();
  readonly #coverage = new Map<string, DisplayCoverage>();
  readonly #maxPages: number;
  readonly #maxEntriesPerPage: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  #projectionVersion: number;
  #bytes = 0;

  constructor(options: DisplayPageCacheOptions = {}) {
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.#maxEntriesPerPage = options.maxEntriesPerPage ?? DEFAULT_MAX_ENTRIES_PER_PAGE;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#projectionVersion = options.projectionVersion ?? DISPLAY_PROJECTION_VERSION;
    this.#now = options.now ?? Date.now;
  }

  get projectionVersion(): number { return this.#projectionVersion; }

  /**
   * 读取一页。命中要求同一个来源代次与同一套投影语义；否则这一页会被丢掉并返回 undefined，
   * 调用方据此去问 adapter。
   */
  get(request: DisplayPageRequest, source: Pick<DisplayPageSource, "sourceEpoch">): DisplayPage | undefined {
    const key = pageKey(request);
    const page = this.#pages.get(key);
    if (page === undefined) return undefined;
    if (page.sourceEpoch !== source.sourceEpoch) {
      this.#drop(key);
      return undefined;
    }
    // 命中即视为最近使用。
    this.#pages.delete(key);
    this.#pages.set(key, page);
    return page;
  }

  /**
   * 存入一页。返回 undefined 表示这一页**没有**被缓存（单页就超过总预算）；
   * 调用方仍然可以把返回的投影直接发给客户端，只是下次还要重新归一。
   */
  put(
    request: DisplayPageRequest,
    input: { readonly source: DisplayPageSource; readonly projection: DisplayProjection; readonly hasOlder: boolean },
  ): DisplayPage | undefined {
    const all = input.projection.entries;
    const entries = all.slice(0, this.#maxEntriesPerPage);
    const page: DisplayPage = {
      request,
      sourceEpoch: input.source.sourceEpoch,
      sourceRevision: input.source.sourceRevision,
      projectionVersion: this.#projectionVersion,
      entries,
      windowStart: input.projection.windowStart,
      hasOlder: input.hasOlder,
      status: input.projection.status,
      createdAt: this.#now(),
      bytes: byteLength(entries),
      truncated: all.length > entries.length,
    };
    if (page.bytes > this.#maxBytes) return undefined;

    // head 换过就是另一条分支：旧的页与覆盖范围都不能再算数。
    const known = this.#coverage.get(request.scopeId);
    if (known !== undefined && known.leafId !== request.leafId) this.invalidateScope(request.scopeId);

    this.#drop(pageKey(request));
    this.#pages.set(pageKey(request), page);
    this.#bytes += page.bytes;
    this.#updateCoverage(request, page);
    this.#evict();
    return page;
  }

  /**
   * 覆盖范围：只有带 `beforeEntryId` 的页才会把最旧边界往更早推——从叶子起的第一页
   * 是「最新的一段」，它不证明更旧的内容已经拿到。
   */
  #updateCoverage(request: DisplayPageRequest, page: DisplayPage): void {
    const existing = this.#coverage.get(request.scopeId);
    const oldest = page.entries[0]?.entryId ?? null;
    this.#coverage.set(request.scopeId, {
      leafId: request.leafId,
      oldestEntryId: request.beforeEntryId === null || existing === undefined ? oldest : oldest ?? existing.oldestEntryId,
      reachedStart: existing?.reachedStart === true || page.hasOlder === false,
      entries: (existing?.entries ?? 0) + page.entries.length,
      pages: (existing?.pages ?? 0) + 1,
    });
  }

  coverage(scopeId: string): DisplayCoverage | undefined {
    return this.#coverage.get(scopeId);
  }

  /** 会话结束、换代次或修正历史时按作用域作废。 */
  invalidateScope(scopeId: string): number {
    let removed = 0;
    for (const [key, page] of [...this.#pages]) {
      if (page.request.scopeId !== scopeId) continue;
      this.#drop(key);
      removed += 1;
    }
    this.#coverage.delete(scopeId);
    return removed;
  }

  /**
   * 整份作废。投影语义在运行期变化（例如换了一套 displayEntries 规则）时必须调用它：
   * 缓存是内存对象，部署新算法本身就会清空，所以这个方法服务的是「同一个进程里换语义」。
   */
  invalidateAll(): void {
    this.#pages.clear();
    this.#coverage.clear();
    this.#bytes = 0;
  }

  stats(): { pages: number; bytes: number; scopes: number; projectionVersion: number } {
    return { pages: this.#pages.size, bytes: this.#bytes, scopes: this.#coverage.size, projectionVersion: this.#projectionVersion };
  }

  #drop(key: string): void {
    const page = this.#pages.get(key);
    if (page === undefined) return;
    this.#pages.delete(key);
    this.#bytes -= page.bytes;
  }

  /** 超出页数或字节预算时按最久未使用淘汰。 */
  #evict(): void {
    while (this.#pages.size > this.#maxPages || this.#bytes > this.#maxBytes) {
      const oldest = this.#pages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#drop(oldest);
    }
  }
}

const pageKey = (request: DisplayPageRequest): string =>
  JSON.stringify([request.scopeId, request.leafId, request.beforeEntryId, request.maxEntries]);

/** 预算按条目的序列化大小算：显示页会原样发给客户端，字节数就是它的成本。 */
const byteLength = (entries: readonly DisplayEntry[]): number =>
  new TextEncoder().encode(JSON.stringify(entries)).length;
