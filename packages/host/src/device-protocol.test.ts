import { describe, expect, it } from "vitest";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { DeviceHandshake, E2eChannel, buildHandshakeEnvelope, readHandshakeEnvelope } from "@orbis/e2e";
import { PROTOCOL_VERSION, DeviceE2ePayloadSchema, encodeArtifactChunkFrame, decodeArtifactChunkFrame } from "@orbis/protocol";
import { normalizeDeviceRequest, encodeDeviceResponse, convertDeviceBinary } from "./device-protocol.js";
import { HostDeviceSession } from "./device-session.js";

describe("released device business formats", () => {
  // S52: current-turn facts are optional additions inside existing metadata/model
  // domains. Released mobile readers ignore unknown fields; selection is unchanged.
  it.each([18, 19] as const)("preserves selected model and optional turn facts in format %s", version => {
    const currentTurn = { turnId: "turn", model: { provider: "p", id: "actual" }, thinkingLevel: "low" };
    const selected = { provider: "p", id: "next", thinkingLevel: "high" };
    const additions = { selection: { model: "opaque/next", thinking: "high" }, currentTurnSupported: true };
    const input = { type: "agent.state.snapshot", protocolVersion: 19, domains: [{ domain: "model", value: { ...selected, currentTurn, ...additions } }] };
    const result = JSON.parse(Buffer.from(encodeDeviceResponse(Buffer.from(JSON.stringify(input)), version)!).toString());
    expect(result).toMatchObject({ protocolVersion: version, domains: [{ value: { ...selected, currentTurn, ...additions } }] });
    const releasedMobileFields = z.object({ provider: z.string(), id: z.string(), thinkingLevel: z.string() });
    expect(releasedMobileFields.parse(result.domains[0].value)).toEqual(selected);
  });
  it.each([18, 19])("normalizes %s without relaxing known fields or changing operation identity", version => {
    const value = { type: "session.list", protocolVersion: version, requestId: "stable-request" };
    const normalized = normalizeDeviceRequest(Buffer.from(JSON.stringify(value)))!;
    expect(normalized.version).toBe(version);
    expect(DeviceE2ePayloadSchema.parse(JSON.parse(normalized.payload.toString()))).toEqual({ ...value, protocolVersion: PROTOCOL_VERSION });
    const invalid = normalizeDeviceRequest(Buffer.from(JSON.stringify({ ...value, unexpected: true })))!;
    expect(DeviceE2ePayloadSchema.safeParse(JSON.parse(invalid.payload.toString())).success).toBe(false);
  });
  it.each([17, 20, 19.5, "18", null, {}, [], true])("does not reinterpret unsupported version %j", protocolVersion => {
    expect(normalizeDeviceRequest(Buffer.from(JSON.stringify({ type: "session.list", protocolVersion, requestId: "r" })))).toBeUndefined();
  });
  it("projects only the released execution addition for 18, preserving user data and unknown-state truth", () => {
    const execution = { phase: "idle", waitingFor: [], retry: "unavailable", compaction: "unavailable", tasks: { availability: "unknown", items: [], truncated: false } };
    const input = { type: "agent.state.snapshot", protocolVersion: 19, domains: [
      { domain: "execution", availability: "ready", value: execution },
      { domain: "history", value: { execution: { tasks: "user text must remain unchanged" } } },
    ], requestId: "r", missing: [], truncated: false };
    const response = JSON.parse(Buffer.from(encodeDeviceResponse(Buffer.from(JSON.stringify(input)), 18)!).toString());
    const frozen18 = z.strictObject({ phase: z.literal("idle"), waitingFor: z.array(z.string()), retry: z.literal("unavailable"), compaction: z.literal("unavailable") });
    expect(frozen18.parse(response.domains[0].value)).toEqual({ phase: "idle", waitingFor: [], retry: "unavailable", compaction: "unavailable" });
    expect(response.domains[1]).toEqual(input.domains[1]);
    expect(response).toMatchObject({ protocolVersion: 18, requestId: "r", missing: [], truncated: false });
    expect(input.domains[0]!.value).toHaveProperty("tasks");
    const tasks = Buffer.from(JSON.stringify({ type: "runtime.event", protocolVersion: 19, event: { type: "execution.tasks", tasks: execution.tasks } }));
    expect(encodeDeviceResponse(tasks, 18)).toBeUndefined();
    expect(encodeDeviceResponse(tasks, 19)).toBe(tasks);
  });
  it("validates binary boundaries in both directions and preserves offsets and raw bytes", () => {
    const frame = { runtimeId: "runtime", transferId: "transfer", offset: 1_234, data: new Uint8Array([0, 18, 19, 128, 255]) };
    const modern = encodeArtifactChunkFrame(frame);
    const legacy = convertDeviceBinary(modern, 19, 18);
    expect(legacy[4]).toBe(18);
    expect(() => decodeArtifactChunkFrame(legacy)).toThrow();
    expect(decodeArtifactChunkFrame(legacy, 18)).toEqual(frame);
    expect(convertDeviceBinary(legacy, 18, 19)).toEqual(modern);
    expect(() => convertDeviceBinary(legacy.subarray(0, legacy.length - 1), 18, 19)).toThrow();
    expect(() => encodeArtifactChunkFrame(frame, 20)).toThrow();
    expect(() => decodeArtifactChunkFrame(legacy, 274)).toThrow();
  });
  it("pins the authenticated format, resets it on a fresh handshake and suppresses events before consuming a nonce", () => {
    const psk = randomBytes(32);
    const session = new HostDeviceSession({ hostId: "host", compatible: true, device: {
      deviceId: "phone", label: "legacy", devicePub: randomBytes(32).toString("base64url"), pskRoot: psk.toString("base64url"), createdAt: 1, revoked: false,
    } });
    const handshake = new DeviceHandshake(psk);
    const envelope = (body: Parameters<typeof buildHandshakeEnvelope>[0]["body"]) => buildHandshakeEnvelope({ room: "host", from: "phone", to: "host", body });
    const outcome = session.handle(envelope(handshake.start()));
    if (outcome.kind !== "handshake-reply") throw new Error("Expected handshake reply");
    const hs2 = readHandshakeEnvelope(outcome.envelope);
    if (hs2.type !== "hs2") throw new Error("Expected hs2");
    session.handle(envelope(handshake.accept(hs2)));
    expect(session.protocolVersion).toBeUndefined();
    expect(session.bindProtocolVersion(18)).toBe(true);
    expect(session.bindProtocolVersion(19)).toBe(false);
    const peer = new E2eChannel({ keys: handshake.keys, role: "device" });
    const payload = Buffer.from(JSON.stringify({ type: "device.path", protocolVersion: 19, path: "relay" }));
    const before = session.seal("data", payload, "ctl");
    const decoded = peer.open(before)!;
    expect(JSON.parse(decoded.toString())).toMatchObject({ protocolVersion: 18 });
    expect(() => session.seal("data", Buffer.from(JSON.stringify({ type: "runtime.event", protocolVersion: 19, event: { type: "execution.tasks" } })), "ctl")).toThrow();
    const after = session.seal("data", payload, "ctl");
    expect(after.hdr.n).toBe(before.hdr.n + 1);
    expect(peer.open(after)).toEqual(decoded);
    session.handle(envelope(new DeviceHandshake(psk).start()));
    expect(session.protocolVersion).toBeUndefined();
    expect(session.bindProtocolVersion(18)).toBe(false);
  });
});
