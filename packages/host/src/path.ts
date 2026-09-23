/**
 * Path 抽象与选路（spec §6.1 / §6.2）。
 *
 * 这个文件刻意不认识任何具体的传输：它只知道「有哪些路径现在可用」「每条测出来多少毫秒」，
 * 以及「当前该走哪条」。把传输细节留在各自的实现里，是因为 §6.1 的整个意思就是
 * **三条路径跑同一个 Envelope，差别只是底层字节怎么送**。
 *
 * 选路规则刻意收敛成一条：**按优先级取当前可用的最高档**。
 * - 首次选路：最高档的可用路径直接当选。
 * - 更高档的路径随后可用（典型是 P2P 握手完成）：当拍顶替低档的既有路径。
 * - 当前路径消失：立刻取剩下可用的最高档（不等采样）。
 *
 * 优先级是用户在手机上显式排的，所以它压过 RTT 证据——「已生效路径不被后来者顶掉」
 * 那条旧规则会让手动排序形同虚设（中继永远第一个握手成功，P2P 就永远上不去）。
 * RTT 仍然持续测量，但只用于展示（`device.path` 的 `rttMs` 与状态页），不参与换路；
 * 因此也不再需要「连续 3 次快 30%」那套防抖计数。
 */
import type { PathKind } from "@pi-remote/protocol";

/** 默认优先级（用户没排过时）：同一时刻有几条可用就走哪条。 */
export const PATH_PREFERENCE: readonly PathKind[] = ["lan", "p2p", "relay"];

/** 三档优先级的成员，也是 `normalizePreference` 的补全依据。 */
export const PATH_KINDS: readonly PathKind[] = ["lan", "p2p", "relay"];

/** 生效路径的中文说法，给日志与界面用（§14 B4 显示的就是这三个词）。 */
export const PATH_LABELS: Record<PathKind, string> = {
  lan: "LAN 直连",
  p2p: "P2P 直连",
  relay: "中继",
};

export function describePath(kind: PathKind | undefined): string {
  return kind === undefined ? "无可用路径" : PATH_LABELS[kind];
}

/**
 * 把外部传入的顺序补成一个合法的三档排列：丢掉未知/重复项，缺的按默认顺序补在后面。
 * 设备发来的偏好可能不完整（旧版本、手滑），选路器不能因此少认一条路。
 */
export function normalizePreference(preference: readonly PathKind[] | undefined): PathKind[] {
  const seen = new Set<PathKind>();
  const ordered: PathKind[] = [];
  for (const kind of preference ?? PATH_PREFERENCE) {
    if (!PATH_KINDS.includes(kind) || seen.has(kind)) continue;
    seen.add(kind);
    ordered.push(kind);
  }
  for (const kind of PATH_PREFERENCE) {
    if (!seen.has(kind)) ordered.push(kind);
  }
  return ordered;
}

export type PathSelectorOptions = {
  /** 优先级顺序，第 1 位最优先。缺省用 [lan, p2p, relay]。 */
  preference?: readonly PathKind[];
};

/**
 * 选路结果。
 *
 * 用结构而不是 `PathKind | undefined`，是因为「没变」和「变成没有路径可用」是两件事：
 * 前者无需动作，后者意味着任何出站推送都得先攒着。把它俩都压成 `undefined` 会让
 * 调用方无法区分——而这个区分恰好是「全部路径断掉」时的正确行为所在。
 */
export type PathChange =
  | { changed: false }
  | { changed: true; from: PathKind | undefined; to: PathKind | undefined };

const UNCHANGED: PathChange = { changed: false };

export class PathSelector {
  #preference: readonly PathKind[];
  readonly #available = new Set<PathKind>();
  readonly #rtt = new Map<PathKind, number>();
  #active: PathKind | undefined;

  constructor(options: PathSelectorOptions = {}) {
    this.#preference = normalizePreference(options.preference);
  }

  get active(): PathKind | undefined {
    return this.#active;
  }

  get activeRttMs(): number | undefined {
    return this.#active === undefined ? undefined : this.#rtt.get(this.#active);
  }

  get available(): readonly PathKind[] {
    return this.#ordered();
  }

  rttOf(kind: PathKind): number | undefined {
    return this.#rtt.get(kind);
  }

  /**
   * 用户改了优先级顺序。按新顺序重取最高档可用路径——生效路径可能当场换掉。
   */
  setPreference(preference: readonly PathKind[]): PathChange {
    this.#preference = normalizePreference(preference);
    return this.#activate(this.#best());
  }

  /**
   * 一条路径变成可用。
   *
   * 它比当前生效路径档位更高就直接换过去（不比较 RTT）：这正是「P2P 一建立就用上」
   * 与手动排序生效的地方。档位不高于当前的则不动。
   */
  markAvailable(kind: PathKind): PathChange {
    this.#available.add(kind);
    const best = this.#best();
    if (best === this.#active) return UNCHANGED;
    return this.#activate(best);
  }

  /**
   * 一条路径消失（socket 关闭 / 对端不可达）。
   * 当前路径消失了就立刻换，不等采样——等三拍才回落中继正是要避免的行为。
   */
  markUnavailable(kind: PathKind): PathChange {
    this.#available.delete(kind);
    this.#rtt.delete(kind);
    if (this.#active !== kind) return UNCHANGED;
    return this.#activate(this.#best());
  }

  /**
   * 记一次 RTT 采样。只服务于展示（生效路径的 `rttMs`），不触发换路——
   * 换路由优先级决定，见类注释。
   */
  observeRtt(kind: PathKind, rttMs: number): PathChange {
    if (!this.#available.has(kind)) return UNCHANGED;
    this.#rtt.set(kind, rttMs);
    return UNCHANGED;
  }

  #ordered(): PathKind[] {
    return [...this.#preference].filter((kind) => this.#available.has(kind));
  }

  #best(): PathKind | undefined {
    // 目前每一级只有一条路径，所以优先级就是全部依据。
    // 将来同级出现多条（多条 P2P 候选）时，在这里按实测 RTT 排序即可。
    return this.#ordered()[0];
  }

  #activate(kind: PathKind | undefined): PathChange {
    const from = this.#active;
    this.#active = kind;
    return from === kind ? UNCHANGED : { changed: true, from, to: kind };
  }
}
