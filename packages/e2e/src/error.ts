/**
 * 端到端加密层的错误类型。
 *
 * 这里刻意把「失败原因」做成机器可判定的 code，因为配对与会话握手的失败必须能被
 * 上层的 UI 区分开：`expired` 要提示重新扫码，`already_used` 要提示可能是重放，
 * 而 `mac_mismatch` 意味着对面根本不是那台已配对设备。
 */
export type E2eErrorCode =
  | "malformed"
  | "invalid_key_length"
  | "degenerate_public_key"
  | "degenerate_shared_secret"
  | "aead_failed"
  | "sequence_out_of_order"
  | "unsupported_version"
  | "expired"
  | "window_closed"
  | "already_used"
  | "mac_mismatch"
  | "not_ready";

export class E2eError extends Error {
  readonly code: E2eErrorCode;

  constructor(code: E2eErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "E2eError";
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isE2eError(value: unknown): value is E2eError {
  return value instanceof E2eError;
}
