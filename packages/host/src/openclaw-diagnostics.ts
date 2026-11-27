import { GatewayClientRequestError, GatewayClientRequestTimeoutError } from "@openclaw/gateway-client";
import { ConnectErrorDetailCodes as Connect, readConnectErrorDetailCode } from "@openclaw/gateway-protocol/connect-error-details";
import { ErrorCodes, readMissingScopeErrorDetails } from "@openclaw/gateway-protocol/gateway-error-details";

// OPENCLAW-RECOVERY-01: only fixed Orbis text crosses to the UI. In particular,
// upstream messages, close reasons, URLs, paths and recovery hints can contain secrets.
export const openClawAdvice = {
  configuration_missing: "尚未配置 OpenClaw Gateway。请在电脑的 Orbis Host → OpenClaw 保存本机端口或远程地址。",
  configuration_invalid: "OpenClaw Host 配置无效。请在电脑的 Orbis Host → OpenClaw 核对地址；如由环境变量管理，请检查 Host 的启动配置。",
  host_state_unavailable: "Orbis Host 无法读取或保存 OpenClaw 设备身份。请检查电脑上 Host 状态目录的权限，再重新连接 Host。",
  work_directory_unavailable: "OpenClaw 工作目录不可用。请在 App 重新选择电脑上存在且可访问的工作目录。",
  local_port_closed: "本机 OpenClaw Gateway 端口未监听。请在电脑启动 Gateway，并核对 Orbis Host 中的端口。",
  local_cli_unavailable: "本机 Gateway 端口未监听，且 Host 找不到兼容的 OpenClaw CLI。请在电脑手动启动 Gateway，或安装 OpenClaw 2026.11.5 或更新版本后重试。",
  local_cli_incompatible: "Host 无法用当前 OpenClaw CLI 启动 Gateway。请在电脑手动启动 Gateway，或确认已安装 OpenClaw 2026.11.5 或更新版本。",
  local_start_failed: "本机 OpenClaw Gateway 启动失败。请在电脑启动 Gateway，检查 OpenClaw 给出的错误后重试。",
  local_start_unconfirmed: "Host 未能确认本机 OpenClaw Gateway 已启动。请在电脑检查 Gateway 状态和端口后重试。",
  local_port_unknown: "Host 无法确认本机 OpenClaw Gateway 端口状态。请在电脑检查 Gateway 是否已启动及端口是否正确。",
  attach_only: "此 OpenClaw 地址只能接入已运行的 Gateway。请在 Gateway 所在电脑启动服务，再重新连接 Host。",
  starting: "OpenClaw Gateway 正在初始化。请等 Gateway 就绪后重试。",
  token_missing: "缺少 OpenClaw Gateway 令牌。请在电脑的 Orbis Host → OpenClaw 填入 Gateway 令牌并应用。",
  token_mismatch: "OpenClaw Gateway 令牌不匹配。请在电脑的 Orbis Host → OpenClaw 核对令牌并重新应用。",
  environment_token_missing: "缺少 OpenClaw Gateway 令牌。此连接由环境变量管理，请在电脑为 Orbis Host 设置 ORBIS_OPENCLAW_TOKEN，再重启 Host。",
  environment_token_mismatch: "OpenClaw Gateway 令牌不匹配。此连接由环境变量管理，请在电脑更新 ORBIS_OPENCLAW_TOKEN，再重启 Host。",
  gateway_token_unconfigured: "OpenClaw Gateway 未配置所需的令牌。请先在 Gateway 所在电脑修正认证配置，再在 Orbis Host 设置匹配的令牌。",
  device_token_rejected: "OpenClaw Gateway 拒绝了 Orbis Host 的设备令牌。请在电脑核对 Gateway 令牌，再重新连接 Host。",
  pairing_required: "OpenClaw 等待设备批准。请在 OpenClaw 的设备列表批准 Orbis Host，再重新连接 Host。",
  pairing_rejected: "OpenClaw 的设备申请已被拒绝或过期。请重新连接 Host，再在 OpenClaw 的设备列表处理新申请。",
  auth_rejected: "OpenClaw Gateway 拒绝了当前认证方式。请在电脑核对 Gateway 是否支持令牌认证，或联系 Gateway 管理员。",
  rate_limited: "OpenClaw Gateway 暂时限制了认证请求。请稍等一会儿再重试。",
  version_incompatible: "OpenClaw Gateway 与 Orbis Host 的版本不兼容。请在电脑检查两者版本，使用支持的版本后重新连接 Host。",
  session_methods_unavailable: "OpenClaw Gateway 未提供所需的会话接口。请核对 Gateway 版本或联系管理员，再重新连接 Host。",
  session_access_denied: "OpenClaw Gateway 未授予所需的会话权限。请检查 Orbis Host 在 Gateway 上的授权，或联系 Gateway 管理员。",
  session_check_timeout: "OpenClaw Gateway 未及时回复会话检查。请等待 Gateway 就绪后重试；若仍失败，请查看 Gateway 诊断。",
  session_check_unconfirmed: "OpenClaw Gateway 未确认会话可访问。请在电脑查看 Gateway 诊断，再重新连接 Host。",
  tls_failed: "OpenClaw Gateway 的 TLS 校验失败。请在电脑核对远程地址和证书，修正后重新连接 Host。",
  connect_unconfirmed: "Host 未能确认 OpenClaw Gateway 已接入。请在电脑核对 Gateway 地址、运行状态，再重新连接 Host。",
  launch_unconfirmed: "OpenClaw Gateway 未确认这次启动。请先核对原启动和会话列表，不要直接再次创建。",
  configuration_unconfirmed: "电脑端未能确认 OpenClaw 配置。请在电脑检查 Orbis Host 的状态和诊断，再重试。",
  resume_unconfirmed: "OpenClaw Gateway 未能恢复此会话。请先刷新会话列表；若仍失败，请检查电脑端 Gateway 的状态和授权。",
  no_session: "此 OpenClaw 会话在当前 Gateway 上不可用。请刷新会话列表，或先在 OpenClaw 恢复已归档的会话。",
} as const;
export type OpenClawIssue = keyof typeof openClawAdvice;

export class OpenClawSetupError extends Error {
  constructor(readonly issue: OpenClawIssue) { super(openClawAdvice[issue]); }
}

/** Correlated Gateway rejection only. Never classify the response's free-form text. */
export function openClawConnectIssue(error: unknown, environment: boolean): OpenClawIssue | undefined {
  if (!(error instanceof GatewayClientRequestError)) {
    const transport = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
    switch (transport?.code) {
      case "ERR_TLS_CERT_ALTNAME_INVALID": case "CERT_HAS_EXPIRED": case "DEPTH_ZERO_SELF_SIGNED_CERT":
      case "SELF_SIGNED_CERT_IN_CHAIN": case "UNABLE_TO_VERIFY_LEAF_SIGNATURE": case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      case "ERR_SSL_WRONG_VERSION_NUMBER": return "tls_failed";
      default: return undefined;
    }
  }
  switch (readConnectErrorDetailCode(error.details)) {
    case Connect.AUTH_TOKEN_MISSING: return environment ? "environment_token_missing" : "token_missing";
    case Connect.AUTH_TOKEN_MISMATCH: return environment ? "environment_token_mismatch" : "token_mismatch";
    case Connect.AUTH_TOKEN_NOT_CONFIGURED: return "gateway_token_unconfigured";
    case Connect.AUTH_DEVICE_TOKEN_MISMATCH: return "device_token_rejected";
    case Connect.PAIRING_REQUIRED: return "pairing_required";
    case Connect.PAIRING_REJECTED: case Connect.PAIRING_EXPIRED: return "pairing_rejected";
    case Connect.AUTH_RATE_LIMITED: return "rate_limited";
    case Connect.AUTH_SCOPE_MISMATCH: case Connect.AUTH_VERIFIED_USER_REQUIRED: case Connect.OPERATOR_ACCESS_DENIED:
    case Connect.AUTHENTICATED_PROFILE_UNAVAILABLE: return "session_access_denied";
    case Connect.PROTOCOL_MISMATCH: case Connect.CLIENT_VERSION_MISMATCH: return "version_incompatible";
    case Connect.AUTH_REQUIRED: case Connect.AUTH_UNAUTHORIZED:
    case Connect.AUTH_PASSWORD_MISSING: case Connect.AUTH_PASSWORD_MISMATCH: case Connect.AUTH_PASSWORD_NOT_CONFIGURED:
    case Connect.AUTH_IDENTITY_HEADER_REQUIRED: case Connect.DEVICE_IDENTITY_REQUIRED:
    case Connect.AUTH_TAILSCALE_IDENTITY_MISSING: case Connect.AUTH_TAILSCALE_PROXY_MISSING:
    case Connect.AUTH_TAILSCALE_WHOIS_FAILED: case Connect.AUTH_TAILSCALE_IDENTITY_MISMATCH:
      return "auth_rejected";
    default: return undefined;
  }
}

export function openClawSessionCheckIssue(error: unknown): OpenClawIssue {
  if (error instanceof GatewayClientRequestError &&
      (error.gatewayCode === ErrorCodes.FORBIDDEN || readMissingScopeErrorDetails(error.details))) return "session_access_denied";
  if (error instanceof GatewayClientRequestTimeoutError) return "session_check_timeout";
  return "session_check_unconfirmed";
}
