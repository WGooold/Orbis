/** Runtime 的活动状态（内部短名；线上 `waiting` 写作 `waiting_local_interaction`）。 */
export type RuntimeActivity = "idle" | "running" | "waiting";

/**
 * 状态修复节拍的重报间隔。
 *
 * 手机端角标读的 `runtime.status` 是**纯增量事件**：链路上丢掉一帧（重连、换路径、重建握手
 * 都在丢），角标就停在旧值，而之后没有任何事件会去补发它——手机只能在重连时靠 metadata
 * 快照自愈。链路一直活着时，「compact 完一直显示运行中」就是这么来的。
 */
export const RUNTIME_STATUS_RECONCILE_MS = 15_000;

/**
 * 节拍该重报哪个状态；`undefined` 表示这一拍不报。
 *
 * `waiting`（等待电脑端本地交互）由 prompt 事件专管：它不是从 `isIdle()` 推得出来的，
 * 节拍若照推，手机上「等待电脑端交互」会每 15 秒闪回一次 idle/running。
 */
export function statusToReconcile(activity: RuntimeActivity, isIdle: boolean): "idle" | "running" | undefined {
  if (activity === "waiting") return undefined;
  return isIdle ? "idle" : "running";
}
