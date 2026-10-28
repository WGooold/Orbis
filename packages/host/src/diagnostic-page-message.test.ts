import { PROTOCOL_VERSION, RelayToDeviceMessageSchema } from "@orbis/protocol";
import { describe, expect, it } from "vitest";

import { buildDiagnosticsPageMessage } from "./diagnostic-page-message.js";

/**
 * 构造出来的消息必须能过协议联合体本身——只断言字段名会让「发了但收不下」这种错漏过去。
 */

const request = { type: "diagnostics.request" as const, requestId: "req-1" };
const page = {
  records: [{
    recordId: "rec-1", scope: "host" as const, agentKind: null, sessionId: null,
    category: "catalog", severity: "error" as const, message: "catalog read failed", at: 1_700_000_000_000,
  }],
  nextCursor: "r1:1",
  truncated: false,
};

describe("buildDiagnosticsPageMessage", () => {
  it("带上协议版本与 requestId，页内容原样透传", () => {
    const message = buildDiagnosticsPageMessage(request, page);

    expect(message).toEqual({
      type: "diagnostics.page", protocolVersion: PROTOCOL_VERSION, requestId: "req-1", page,
    });
    expect(RelayToDeviceMessageSchema.safeParse(message).success).toBe(true);
  });

  it("空页与缺口标记照原样回带：没有记录也不许编一条占位记录", () => {
    const message = buildDiagnosticsPageMessage(request, { records: [], nextCursor: null, truncated: true });

    expect(message.page).toEqual({ records: [], nextCursor: null, truncated: true });
    expect(RelayToDeviceMessageSchema.safeParse(message).success).toBe(true);
  });
});
