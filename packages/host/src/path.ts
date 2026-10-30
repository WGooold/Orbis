/** 固定选路：已握手的 LAN 优先，Relay 兜底；RTT 仅供展示（ADR-0050）。 */
import type { PathKind } from "@orbis/protocol";

/** 生效路径的中文说法，给日志与界面用（§14 B4 显示的就是这两个词）。 */
export const PATH_LABELS: Record<PathKind, string> = {
  lan: "LAN 直连",
  relay: "中继",
};

export function describePath(kind: PathKind | undefined): string {
  return kind === undefined ? "无可用路径" : PATH_LABELS[kind];
}

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
  readonly #available = new Set<PathKind>();
  readonly #rtt = new Map<PathKind, number>();
  #active: PathKind | undefined;

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
    return (["lan", "relay"] as const).filter((kind) => this.#available.has(kind));
  }

  #best(): PathKind | undefined {
    // 目前每一级只有一条路径，所以优先级就是全部依据。
    return this.#ordered()[0];
  }

  #activate(kind: PathKind | undefined): PathChange {
    const from = this.#active;
    this.#active = kind;
    return from === kind ? UNCHANGED : { changed: true, from, to: kind };
  }
}
