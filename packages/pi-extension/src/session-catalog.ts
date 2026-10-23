/**
 * 会话目录（catalog）的进程内缓存（ADR-0035 §11）。
 *
 * `SessionManager.listAll()` 会把 `~/.pi/agent/sessions` 下**每一个**会话文件逐行解析一遍，
 * 只为拿到标题 / 消息数 / 首条消息。这台机器上是 179 个文件 / 517MB，实测一次 **2.0s、
 * 峰值 heap 205MB**。而它被挂在每一次 transport 连上（`RuntimeBridge` 的 connected 回调）
 * 和每次 `session_info_changed` / `session_tree` 上——连接抖动一次就白扫一遍整个会话库。
 *
 * 这里做一个**有上界**的进程内缓存：
 * - TTL 内复用同一份结果；并发的调用共用同一个 in-flight Promise（不叠加扫描）。
 * - 失效是显式的：重命名 / 切树 / 新会话由扩展自己 invalidate，不靠"再扫一遍看看变没变"。
 * - 缓存只针对"整个会话库的列表"，不改变任何权威来源：原生文件仍是唯一事实。
 */

export type SessionCatalogCacheOptions<T> = {
  load: () => Promise<T[]>;
  /** 缓存有效期；缺省 60s。 */
  ttlMs?: number;
  now?: () => number;
};

export type SessionCatalogCache<T> = {
  /** TTL 内直接返回缓存；并发调用合并成一次 load。 */
  get(): Promise<T[]>;
  /** 下一次 get 必定重新加载（rename / tree / 新会话时调用）。 */
  invalidate(): void;
};

export function createSessionCatalogCache<T>(
  options: SessionCatalogCacheOptions<T>,
): SessionCatalogCache<T> {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; items: T[] } | undefined;
  let inFlight: Promise<T[]> | undefined;
  let generation = 0;

  return {
    async get() {
      if (cached !== undefined && now() - cached.at < ttlMs) return cached.items;
      if (inFlight !== undefined) return inFlight;
      const startedAt = now();
      const requested = generation;
      inFlight = (async () => {
        try {
          const items = [...await options.load()];
          // 扫描期间被 invalidate：这份结果已经不可信，丢弃缓存但不重试（下一次 get 会重扫）。
          if (requested === generation) cached = { at: startedAt, items };
          return items;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
    invalidate() {
      generation += 1;
      cached = undefined;
    },
  };
}
