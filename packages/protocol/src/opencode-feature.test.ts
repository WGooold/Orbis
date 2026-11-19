import { describe, expect, it } from "vitest";
import { AgentKindSchema, DEVICE_FEATURE_OPENCODE, DeviceE2ePayloadSchema, PROTOCOL_VERSION } from "./index.js";

describe("OpenCode protocol capability", () => {
  it("round-trips the new Agent kind and feature declaration", () => {
    expect(AgentKindSchema.parse("opencode")).toBe("opencode");
    expect(DeviceE2ePayloadSchema.parse({
      type: "device.features", protocolVersion: PROTOCOL_VERSION, features: [DEVICE_FEATURE_OPENCODE],
    })).toMatchObject({ features: ["agent.opencode"] });
  });
});
