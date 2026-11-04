import { describe, expect, it } from "vitest";
import {
  DeviceClientMessageSchema, DeviceE2ePayloadSchema, LoopbackInboundSchema,
  RelayDeviceClientMessageSchema, RelayRuntimeClientMessageSchema,
} from "./index.js";

const host = { type: "runtime.authenticate", protocolVersion: 18, role: "host", credential: "test", runtime: { runtimeId: "h", name: "Host", cwd: "/", status: "idle" } };
const device = { type: "device.authenticate", protocolVersion: 18, credential: "test" };

describe("Relay compatibility is separate from business protocol support", () => {
  it.each([18, 19])("accepts released version %s on both routes", (protocolVersion) => {
    expect(RelayRuntimeClientMessageSchema.safeParse({ ...host, protocolVersion }).success).toBe(true);
    expect(RelayDeviceClientMessageSchema.safeParse({ ...device, protocolVersion }).success).toBe(true);
  });
  it.each([17, 20, 19.5, "18", null, {}, [], true])("rejects unsupported or malformed version %j", (protocolVersion) => {
    expect(RelayRuntimeClientMessageSchema.safeParse({ ...host, protocolVersion }).success).toBe(false);
    expect(RelayDeviceClientMessageSchema.safeParse({ ...device, protocolVersion }).success).toBe(false);
  });
  it("retains strict fields and required identity, credentials and roles", () => {
    expect(RelayRuntimeClientMessageSchema.safeParse({ ...host, capabilities: {} }).success).toBe(false);
    expect(RelayDeviceClientMessageSchema.safeParse({ ...device, credential: "" }).success).toBe(false);
    expect(RelayRuntimeClientMessageSchema.safeParse({ ...host, role: undefined }).success).toBe(false);
    expect(RelayRuntimeClientMessageSchema.safeParse({ ...host, runtime: { ...host.runtime, status: "unknown" } }).success).toBe(false);
  });
  it("does not claim E2E or loopback compatibility by relaxing transport schemas", () => {
    expect(LoopbackInboundSchema.safeParse(host).success).toBe(false);
    expect(DeviceClientMessageSchema.safeParse(device).success).toBe(false);
    expect(DeviceE2ePayloadSchema.safeParse({ type: "session.list", protocolVersion: 18, requestId: "r" }).success).toBe(false);
  });
});
