import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostService } from "./host-service.js";

/**
 * 诊断目录接线的端到端验证：真的 HostService + 真的状态目录（不启动网络端点）。
 *
 * 这里要证明的是两件事：记一条诊断就会刷新 HostState.diagnostics，而且重启后那一条还在。
 */

let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orbis-host-diagnostics-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const create = () => HostService.create({
  relayUrl: "ws://127.0.0.1:9",
  credential: "test-credential",
  stateDir: dir,
  loopback: false,
  lan: false,
});

const record = {
  scope: "host" as const,
  agentKind: null,
  sessionId: null,
  category: "transport",
  severity: "warning" as const,
  message: "relay unreachable",
};

describe("HostService 的诊断目录", () => {
  it("记一条诊断就刷新 HostState.diagnostics，游标读也读得到", async () => {
    const service = await create();
    // 启动时就把目录对齐：空 journal 是「现在没有记录」，不是「不知道」。
    expect(service.readHostDiagnostics()).toMatchObject({ records: 0, dropped: 0, persistFailures: 0 });

    service.recordDiagnostic(record);

    expect(service.readHostDiagnostics()).toMatchObject({ records: 1, dropped: 0, persistFailures: 0 });
    expect(service.readDiagnostics().records.map(item => item.message)).toEqual(["relay unreachable"]);
  });

  it("重启后目录仍报得出上一轮的记录数", async () => {
    const first = await create();
    first.recordDiagnostic(record);
    first.recordDiagnostic({ ...record, category: "provider", message: "provider read failed" });

    const second = await create();

    expect(second.readHostDiagnostics()).toMatchObject({ records: 2, persistFailures: 0 });
    expect(second.readDiagnostics().records.map(item => item.category)).toEqual(["transport", "provider"]);
  });
});
