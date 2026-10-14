/**
 * 历史显示投影现在住在协议层（`@pi-remote/protocol`）：产出 display 批次的是适配层，
 * 其中 Pi 扩展与 Host 内的 Codex/DSH 用同一份实现。这里保留出口，Host 侧既有引用不必改。
 */
export {
  DISPLAY_PROJECTION_VERSION, buildDisplayPath, displayBatchFor, displayBatchFromProjection,
  projectDisplayEntries, toDisplayBatch,
  type DisplayBatch, type DisplayEntry, type DisplayProjection, type DisplayProjectionOptions,
  type DisplayUndisplayableReason,
} from "@pi-remote/protocol";
