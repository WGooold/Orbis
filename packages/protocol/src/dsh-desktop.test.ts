// ADR-0076 DSH-DESKTOP-06: the Desktop kind, its attach tier and per-device feature negotiation are additive.
import { describe, expect, it } from "vitest";
import {
  AgentKindSchema, DEVICE_FEATURE_DSH_DESKTOP, DeviceE2ePayloadSchema, DshDesktopAttachSchema, HOST_FEATURE_DEVICE_FEATURES,
  HostBackendsStateSchema, PROTOCOL_VERSION, RelayToDeviceMessageSchema,
} from "./index.js";

describe("DeepSeek Harness Desktop protocol additions", () => {
  it("accepts the Desktop kind, tier and negotiation messages", () => {
    expect(AgentKindSchema.parse("dshDesktop")).toBe("dshDesktop");
    expect(DeviceE2ePayloadSchema.parse({ type: "device.features", protocolVersion: PROTOCOL_VERSION, features: [DEVICE_FEATURE_DSH_DESKTOP] }))
      .toMatchObject({ features: ["agent.dshDesktop"] });
    expect(() => DeviceE2ePayloadSchema.parse({ type: "device.features", protocolVersion: PROTOCOL_VERSION, features: ["Bad Feature"] })).toThrow();
    const status = DshDesktopAttachSchema.parse({ state: "running", reason: "已在运行", version: "0.2.2-rc.2" });
    RelayToDeviceMessageSchema.parse({ type: "device.ready", protocolVersion: PROTOCOL_VERSION, deviceId: "d", notificationEpoch: null, runtimes: [],
      agents: ["dshDesktop"], launchableAgents: ["dshDesktop"], dshDesktop: status, hostFeatures: [HOST_FEATURE_DEVICE_FEATURES] });
    HostBackendsStateSchema.parse({ backends: [{ kind: "dshDesktop", ready: false, launchable: true, runtimeCount: 0, reason: null }], dshDesktop: status });
    expect(() => DshDesktopAttachSchema.parse({ state: "launching", reason: "x" })).toThrow();
  });
});
