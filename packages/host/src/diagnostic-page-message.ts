import { PROTOCOL_VERSION, type DiagnosticPage, type DiagnosticsRequest, type RelayToDeviceMessage } from "@pi-remote/protocol";

/**
 * 诊断记录分页应答（ADR-0032 模块 23）。
 *
 * 纯函数：只把已经读出来的一页包成线上消息，因此游标、缺口与协议版本都能单独断言，
 * 而不必为了验证一个字段形状去起一台设备。
 */
export function buildDiagnosticsPageMessage(
  request: DiagnosticsRequest,
  page: DiagnosticPage,
): Extract<RelayToDeviceMessage, { type: "diagnostics.page" }> {
  return { type: "diagnostics.page", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, page };
}
