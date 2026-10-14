import type { RemoteSessionEntry } from "@pi-remote/protocol";

import { projectDisplayEntries, type DisplayEntry, type DisplayProjection } from "./display-entries.js";
import type { DisplayCoverage, DisplayPageCache, DisplayPageRequest } from "./display-page-cache.js";

/**
 * 统一的显示范围入口（ADR-0032 §5，issue #7）。
 *
 * 它把三件事串成一条路径：**缓存 → provider 查原生历史 → 归一 → 校验 → 入缓存 → 返回**。
 * provider 是留给协议层（issue #10）的缝：真实实现应当是「Host 向该会话的 adapter 要一段
 * 原生条目」，与我们今天已经有的事件复制走同一条来源；本模块先在接口上把它固定下来，
 * 这样编排、缓存与失败语义可以独立验证。
 *
 * 它不直接写模型、不发消息：模型里的 head 来自来源复制，客户端读到的仍是既有事件。
 */

export type DisplayRangeRequest = DisplayPageRequest;

/** adapter 侧唯一需要提供的能力：给我一段原生条目，以及它属于哪个来源版本。 */
export type DisplayRangeProvider = (request: DisplayRangeRequest) => Promise<{
  readonly sourceEpoch: string;
  readonly sourceRevision: number;
  readonly entries: readonly RemoteSessionEntry[];
  /** 这一窗之外还有更旧的内容；false 表示已经到分支起点。 */
  readonly hasOlder: boolean;
}>;

export type DisplayRangeResult = {
  readonly entries: DisplayEntry[];
  /** 投影状态；provider 失败时是 `unavailable`，不能当成「这里没有历史」。 */
  readonly status: DisplayProjection["status"] | "unavailable";
  readonly hasOlder: boolean;
  readonly source: { readonly sourceEpoch: string; readonly sourceRevision: number } | null;
  readonly cached: boolean;
  /** 页或请求上限造成的截断：后面还有内容没进来。 */
  readonly truncated: boolean;
  readonly coverage: DisplayCoverage | undefined;
};

export type DisplayRangeServiceOptions = {
  readonly provider: DisplayRangeProvider;
  readonly cache: DisplayPageCache;
  /** 单次请求允许的最大条目数，防止一次把整段历史拉进来。 */
  readonly maxEntriesPerRequest?: number;
  readonly log?: (line: string) => void;
};

const DEFAULT_MAX_ENTRIES_PER_REQUEST = 200;

export class DisplayRangeService {
  readonly #provider: DisplayRangeProvider;
  readonly #cache: DisplayPageCache;
  readonly #maxEntriesPerRequest: number;
  readonly #log: ((line: string) => void) | undefined;
  /** Host 从来源复制里看到的最新版本；缓存据此判断有效，而不必先问 adapter。 */
  readonly #sources = new Map<string, { sourceEpoch: string; sourceRevision: number }>();
  /** 同一个窗口的并发请求合并成一次 provider 调用，避免翻页把 adapter 打爆。 */
  readonly #inflight = new Map<string, Promise<DisplayRangeResult>>();

  constructor(options: DisplayRangeServiceOptions) {
    this.#provider = options.provider;
    this.#cache = options.cache;
    this.#maxEntriesPerRequest = options.maxEntriesPerRequest ?? DEFAULT_MAX_ENTRIES_PER_REQUEST;
    this.#log = options.log;
  }

  /**
   * 告诉服务这个会话当前的来源版本（Host 在处理 session 同步事件时调用）。
   * 代次变了就必须作废该会话的显示页——那是「历史被改写」的唯一信号。
   */
  observeSource(scopeId: string, source: { readonly sourceEpoch: string; readonly sourceRevision: number }): void {
    const known = this.#sources.get(scopeId);
    if (known?.sourceEpoch === source.sourceEpoch) {
      this.#sources.set(scopeId, { sourceEpoch: source.sourceEpoch, sourceRevision: source.sourceRevision });
      return;
    }
    if (known !== undefined) {
      const dropped = this.#cache.invalidateScope(scopeId);
      this.#log?.(`显示范围：${scopeId} 来源代次变化，作废 ${dropped} 页`);
    }
    this.#sources.set(scopeId, { sourceEpoch: source.sourceEpoch, sourceRevision: source.sourceRevision });
  }

  /**
   * 读一段显示范围。命中缓存就直接返回；否则问 provider，校验后归一、入缓存再返回。
   * provider 失败返回 `unavailable`（空结果 + 明确状态），不会污染缓存。
   */
  async read(request: DisplayRangeRequest): Promise<DisplayRangeResult> {
    const bounded: DisplayRangeRequest = { ...request, maxEntries: clamp(request.maxEntries, this.#maxEntriesPerRequest) };
    const known = this.#sources.get(bounded.scopeId);
    if (known !== undefined) {
      const hit = this.#cache.get(bounded, { sourceEpoch: known.sourceEpoch });
      if (hit !== undefined) {
        return {
          entries: hit.entries, status: hit.status, hasOlder: hit.hasOlder,
          source: { sourceEpoch: hit.sourceEpoch, sourceRevision: hit.sourceRevision },
          cached: true, truncated: hit.truncated, coverage: this.#cache.coverage(bounded.scopeId),
        };
      }
    }
    const key = JSON.stringify([bounded.scopeId, bounded.leafId, bounded.beforeEntryId, bounded.maxEntries]);
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    const task = this.#load(bounded).finally(() => { if (this.#inflight.get(key) === task) this.#inflight.delete(key); });
    this.#inflight.set(key, task);
    return task;
  }

  async #load(request: DisplayRangeRequest): Promise<DisplayRangeResult> {
    let fetched: Awaited<ReturnType<DisplayRangeProvider>>;
    try {
      fetched = await this.#provider(request);
    } catch (error) {
      this.#log?.(`显示范围：${request.scopeId} 查询失败：${error instanceof Error ? error.message : String(error)}`);
      const known = this.#sources.get(request.scopeId);
      return {
        entries: [], status: "unavailable", hasOlder: false,
        source: known === undefined ? null : { ...known }, cached: false, truncated: false,
        coverage: this.#cache.coverage(request.scopeId),
      };
    }
    // 校验：来源必须能自报代次，否则这一页进不了缓存（也就不能被复用）。
    if (typeof fetched.sourceEpoch !== "string" || fetched.sourceEpoch.trim() === "") {
      this.#log?.(`显示范围：${request.scopeId} 的来源没有给代次，本次不缓存`);
      const projection = projectDisplayEntries(fetched.entries, request.leafId);
      return {
        entries: projection.entries, status: projection.status, hasOlder: fetched.hasOlder,
        source: null, cached: false, truncated: fetched.entries.length > request.maxEntries,
        coverage: this.#cache.coverage(request.scopeId),
      };
    }
    const known = this.#sources.get(request.scopeId);
    if (known !== undefined && known.sourceEpoch !== fetched.sourceEpoch) {
      this.#cache.invalidateScope(request.scopeId);
      this.#log?.(`显示范围：${request.scopeId} 的来源换代次，旧显示页已作废`);
    }
    this.#sources.set(request.scopeId, { sourceEpoch: fetched.sourceEpoch, sourceRevision: fetched.sourceRevision });
    const projection = projectDisplayEntries(fetched.entries, request.leafId);
    const stored = this.#cache.put(request, {
      source: { sourceEpoch: fetched.sourceEpoch, sourceRevision: fetched.sourceRevision },
      projection,
      hasOlder: fetched.hasOlder,
    });
    return {
      entries: stored?.entries ?? projection.entries,
      status: projection.status,
      hasOlder: fetched.hasOlder,
      source: { sourceEpoch: fetched.sourceEpoch, sourceRevision: fetched.sourceRevision },
      cached: false,
      truncated: (stored?.truncated ?? false) || fetched.entries.length > request.maxEntries,
      coverage: this.#cache.coverage(request.scopeId),
    };
  }

  /** 会话结束或接入变化时清掉它的页与已知来源。 */
  forget(scopeId: string): number {
    this.#sources.delete(scopeId);
    return this.#cache.invalidateScope(scopeId);
  }

  stats(): { sources: number; inflight: number; cache: ReturnType<DisplayPageCache["stats"]> } {
    return { sources: this.#sources.size, inflight: this.#inflight.size, cache: this.#cache.stats() };
  }
}

const clamp = (value: number, max: number): number => {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(1, Math.trunc(value)), max);
};
