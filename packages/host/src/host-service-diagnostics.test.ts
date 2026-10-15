import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostService } from "./host-service.js";
import type { ProviderManager } from "./provider-manager.js";

/**
 * 诊断目录接线的端到端验证：真的 HostService + 真的状态目录（不启动网络端点）。
 *
 * 这里要证明的是两件事：记一条诊断就会刷新 HostState.diagnostics，而且重启后那一条还在。
 */

let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orbis-host-diagnostics-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const create = (providers?: ProviderManager) => HostService.create({
  relayUrl: "ws://127.0.0.1:9",
  credential: "test-credential",
  stateDir: dir,
  loopback: false,
  lan: false,
  ...(providers === undefined ? {} : { providers }),
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

  it("供应商摘要由读取路径独占写入：没人读时模型里没有这一格", async () => {
    const calls: string[] = [];
    const service = await create({
      list: async (kind: string) => {
        calls.push(kind);
        return kind === "codex"
          ? [{ id: "custom", kind: "codex", name: "Custom", enabled: true, mode: "exclusive" }]
          : [{ id: "deepseek", kind, name: "DeepSeek", enabled: false, mode: "exclusive" }];
      },
    } as unknown as ProviderManager);

    // 谁都没读过：模型里没有这一格，而不是「有一份全是 null 的摘要」。
    expect(service.readHostProviders()).toBeUndefined();

    await service.refreshProviderFacts();

    const state = service.readHostProviders();
    expect(state?.providers.map(entry => entry.agentKind)).toEqual(["pi", "codex", "dsh"]);
    expect(state?.providers.find(entry => entry.agentKind === "codex")).toMatchObject({
      current: "custom",
      profiles: [{ id: "custom", name: "Custom", enabled: true, globalDefault: false }],
      authenticated: null,
    });
    expect(calls).toEqual(["pi", "codex", "dsh"]);
  });

  it("某个后端读不到清单时如实记 null，并留下诊断", async () => {
    const service = await create({
      list: async (kind: string) => {
        if (kind === "codex") throw new Error("providers.json.lock 被占用");
        return [];
      },
    } as unknown as ProviderManager);

    await service.refreshProviderFacts();

    const codex = service.readHostProviders()?.providers.find(entry => entry.agentKind === "codex");
    expect(codex?.profiles).toBeNull();
    expect(codex?.current).toBeNull();
    expect(service.readDiagnostics({ category: "provider" }).records.map(record => record.message))
      .toEqual(["读取 codex 供应商清单失败"]);
  });

  it("切换失败会留下一条诊断记录，且不把配置内容写进去", async () => {
    const service = await create();

    await expect(service.changeProvider("dsh", async () => { throw new Error("provider boom: sk-秘密"); }))
      .rejects.toThrow("provider boom");

    const page = service.readDiagnostics({ category: "provider" });
    expect(page.records.map(record => record.message)).toEqual(["切换 dsh 供应商失败"]);
    // 只记原因摘要：写进来的东西将来会跟着诊断页被读出去。
    expect(page.records[0]?.detail?.reason).toContain("provider boom");
    expect(service.readHostDiagnostics()).toMatchObject({ records: 1, dropped: 0 });
  });
});
