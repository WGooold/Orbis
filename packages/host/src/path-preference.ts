/**
 * 设备可调的路径优先级（§6.2 的本机扩展）。
 *
 * 为什么不住在 `@pi-remote/protocol` 的 `DeviceE2ePayloadSchema` 里：这条消息只存在于
 * 手机 → Host 的 E2E 密文内，Relay 看不见、也永远不需要认识它。放进协议包会让每次
 * 调整这个纯本机偏好都触发一次 Relay 重新部署，收益为零。所以 Host 自己认、自己校验。
 */
import { PROTOCOL_VERSION } from "@pi-remote/protocol";
import type { PathKind } from "@pi-remote/protocol";

import { PATH_KINDS } from "./path.js";

export type PathPreferenceMessage = {
  type: "device.pathPreference";
  protocolVersion: number;
  /** 三档优先级：第 1 位最优先。必须是 lan/p2p/relay 的一个排列。 */
  preference: PathKind[];
};

/**
 * 认出设备发来的优先级偏好。不是这条消息、或顺序不是三档合法排列时返回 undefined，
 * 调用方据此把它当普通未知载荷处理（有日志可查），而不是拿一个残缺顺序去改选路——
 * 一个「看起来排好了、实际没生效」的设置比没有设置更难查。
 */
export function parsePathPreferenceMessage(value: unknown): PathPreferenceMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as { type?: unknown; preference?: unknown };
  if (message.type !== "device.pathPreference") return undefined;
  if (!Array.isArray(message.preference)) return undefined;
  const valid = message.preference.filter(
    (kind): kind is PathKind => typeof kind === "string" && (PATH_KINDS as readonly string[]).includes(kind),
  );
  if (valid.length !== PATH_KINDS.length || new Set(valid).size !== PATH_KINDS.length) return undefined;
  return { type: "device.pathPreference", protocolVersion: PROTOCOL_VERSION, preference: valid };
}
