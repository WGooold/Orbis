/**
 * HOST-LANE-01：桌面桥命令的调度（ADR-0081 §5-2）。
 *
 * 以前所有命令排成一条全局串行队列：一次 `detect`（每个 Agent 的 `--version` 加 npm 查询，
 * 约 25 s）就能把紧随其后的 `start` 挡住，用户点“开始连接 / 暂停连接 / 添加手机”都要等它。
 * 串行本身是刻意的——配置、身份、安装不能并发改写——所以这里只把两类命令移出主队列：
 *
 * - `lifecycle`（start / pair / cancelPair）：彼此有序，不等只读的后台命令。
 * - `background`（detect / state.* / provider.check / provider.models）：只读或自带互斥，彼此有序，不等连接。
 * - `preempt`（stop / shutdown）：用户要立刻停下，不等在途的 start；在途 start 由运行时自己作废并收尾。
 *   shutdown 仍等后台命令写完它们的文件（例如终端 pi 命令、Codex shim）再退出进程。
 * - 其余全部是 `exclusive`：等此前所有命令结束，之后的命令也都等它。暂停—改动—恢复
 *   （HOST-LIVE-01）因此仍按 stop → 改动 → start 的顺序执行。
 */
export type DesktopCommandLane = "exclusive" | "lifecycle" | "background" | "preempt";

const LIFECYCLE = new Set(["start", "pair", "cancelPair"]);
const BACKGROUND = new Set(["detect", "state.read", "state.range", "provider.check", "provider.models"]);
const PREEMPT = new Set(["stop", "shutdown"]);

export function desktopCommandLane(method: string): DesktopCommandLane {
  if (LIFECYCLE.has(method)) return "lifecycle";
  if (BACKGROUND.has(method)) return "background";
  if (PREEMPT.has(method)) return "preempt";
  return "exclusive";
}

export class DesktopCommandLanes {
  /** 最近一条独占命令：任何命令都不能越过它。 */
  #exclusive: Promise<void> = Promise.resolve();
  #lifecycle: Promise<void> = Promise.resolve();
  #background: Promise<void> = Promise.resolve();

  /** 排入一条命令。`task` 自己处理并上报错误；这里只决定它何时开始。 */
  enqueue(method: string, task: () => Promise<void>): Promise<void> {
    const run = (): Promise<void> => task().catch(() => undefined);
    switch (desktopCommandLane(method)) {
      case "lifecycle": {
        const done = this.#lifecycle.then(run);
        this.#lifecycle = done;
        return done;
      }
      case "background": {
        const done = this.#background.then(run);
        this.#background = done;
        return done;
      }
      case "preempt": {
        // 只等独占命令（配置、安装、身份）落定，不等在途连接；退出还要等后台命令写完它们的文件。
        // 之后的 start 要等这次暂停结束，后面的独占命令也一样。
        const before = method === "shutdown" ? Promise.all([this.#exclusive, this.#background]) : this.#exclusive;
        const done = before.then(run);
        this.#lifecycle = Promise.all([this.#lifecycle, done]).then(() => undefined);
        return done;
      }
      default: {
        const done = Promise.all([this.#lifecycle, this.#background]).then(run);
        this.#exclusive = this.#lifecycle = this.#background = done;
        return done;
      }
    }
  }

  /** 等到此刻已排入的所有命令都结束（含后台与连接两条通道）。 */
  async drain(): Promise<void> {
    await Promise.all([this.#exclusive, this.#lifecycle, this.#background]);
  }
}
