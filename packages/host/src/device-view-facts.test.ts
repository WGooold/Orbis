import { describe, expect, it } from "vitest";

import type { AgentOperationItem } from "@pi-remote/protocol";

import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { DeviceViewFacts } from "./device-view-facts.js";

const HOST = "host-1";
const scope = (deviceId: string): StateScope => ({ kind: "device", key: { hostId: HOST, deviceId } });

const setup = () => {
  const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
  let now = 1_000;
  const facts = new DeviceViewFacts({ registry, hostId: HOST, now: () => ++now });
  return { registry, facts };
};

const items = (registry: AgentStateRegistry, deviceId: string): Record<string, AgentOperationItem> =>
  registry.read<Record<string, AgentOperationItem>>(scope(deviceId), "operations")?.value ?? {};

describe("DeviceViewFacts 设备私有回执", () => {
  it("受理先记 accepted，结果到达后覆盖同一条", () => {
    const { registry, facts } = setup();
    facts.accepted("phone-1", { operationId: "c1", runtimeId: "codex:r1", requestId: "i1" });
    expect(items(registry, "phone-1").c1).toMatchObject({ state: "accepted", runtimeId: "codex:r1", requestId: "i1" });

    facts.settled("phone-1", { operationId: "c1", runtimeId: "codex:r1", state: "success" });
    const settled = items(registry, "phone-1").c1;
    expect(settled?.state).toBe("success");
    // requestId 从已受理的那条继承下来，调用方不必重复传。
    expect(settled?.requestId).toBe("i1");
    expect(Object.keys(items(registry, "phone-1"))).toEqual(["c1"]);
  });

  it("失败结果带原因，且能被客户端按操作身份读回", () => {
    const { registry, facts } = setup();
    facts.accepted("phone-1", { operationId: "c2", runtimeId: "pi:r1" });
    facts.settled("phone-1", { operationId: "c2", runtimeId: "pi:r1", state: "failure", detail: "runtime_offline" });
    expect(items(registry, "phone-1").c2).toMatchObject({ state: "failure", detail: "runtime_offline" });
    expect(facts.read("phone-1").map(item => item.operationId)).toEqual(["c2"]);
  });

  it("回执只对发起设备可见，设备之间互不影响", () => {
    const { registry, facts } = setup();
    facts.accepted("phone-1", { operationId: "c1", runtimeId: "codex:r1" });
    facts.accepted("phone-2", { operationId: "c9", runtimeId: "codex:r1" });
    expect(Object.keys(items(registry, "phone-1"))).toEqual(["c1"]);
    expect(Object.keys(items(registry, "phone-2"))).toEqual(["c9"]);
    facts.forget("phone-1");
    expect(registry.read(scope("phone-1"), "operations")).toBeUndefined();
    expect(Object.keys(items(registry, "phone-2"))).toEqual(["c9"]);
  });

  it("传输摘要只写进发起设备的作用域，撤销设备后一起清掉", () => {
    const { registry, facts } = setup();
    facts.transfers("phone-1", { uploads: [{ transferId: "part-1", runtimeId: "pi:r1", fileName: "a.bin",
      size: 10, durableBytes: 4, state: "interrupted", updatedAt: 7 }], receiving: 0, truncated: false });
    expect(registry.read(scope("phone-1"), "transfers")).toMatchObject({
      availability: "ready", completeness: "partial",
      value: { uploads: [expect.objectContaining({ transferId: "part-1", durableBytes: 4 })], receiving: 0 },
    });
    expect(registry.read(scope("phone-2"), "transfers")).toBeUndefined();
    facts.forget("phone-1");
    expect(registry.read(scope("phone-1"), "transfers")).toBeUndefined();
  });

  it("回执有界：超过上限按最旧淘汰，并用显式删除同步到模型", () => {
    const { registry, facts } = setup();
    for (let index = 0; index < 257; index += 1) {
      facts.accepted("phone-1", { operationId: "c" + index, runtimeId: "codex:r1" });
    }
    const stored = items(registry, "phone-1");
    expect(Object.keys(stored)).toHaveLength(256);
    expect(stored.c0).toBeUndefined();
    expect(stored.c256).toBeDefined();
    expect(facts.read("phone-1")).toHaveLength(256);
  });

  it("写入失败不影响调用方：非法操作身份被拒绝且不抛错", () => {
    const { registry, facts } = setup();
    facts.accepted("phone-1", { operationId: "   ", runtimeId: "codex:r1" });
    expect(items(registry, "phone-1")).toEqual({});
  });
});
