import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { DeviceHandshake, E2eChannel, buildHandshakeEnvelope, loadOrCreateHostIdentity, saveDeviceStore, readHandshakeEnvelope } from "@orbis/e2e";
import { EnvelopeReassembler, fragmentEnvelope, PROTOCOL_VERSION, LOOPBACK_PATH, RelayToDeviceMessageSchema, encodeArtifactChunkFrame, decodeArtifactChunkFrame, type EnvelopeV2 } from "@orbis/protocol";
import { createRelayServer, type RelayServer } from "@orbis/relay";
import { HostService as SourceHostService } from "./host-service.js";

// Optional additional oracle from an unchanged installed release. Native require
// preserves its own dependency resolution, outside Vitest's current-source aliases.
const legacyRoot = process.env.ORBIS_LEGACY_RUNTIME;
const nativeRequire = createRequire(import.meta.url);
const compatibleRoot = process.env.ORBIS_COMPATIBLE_RUNTIME;
// Native import supports the runtime's top-level await and keeps packaged dependency
// resolution outside Vitest's aliases. The path is an explicit local test fixture.
const nativeImport = nativeRequire("../../../scripts/test-fixtures/import-native.cjs") as (specifier: string) => Promise<{ HostService: typeof SourceHostService }>;
const HostService = compatibleRoot ? (await nativeImport(pathToFileURL(join(compatibleRoot, "packages/host/dist/host-service.js")).href)).HostService : SourceHostService;
const legacyProtocol = legacyRoot ? nativeRequire(join(legacyRoot, "node_modules/@orbis/protocol/dist/index.js")) as typeof import("@orbis/protocol") : undefined;
const legacyE2e = legacyRoot ? nativeRequire(join(legacyRoot, "node_modules/@orbis/e2e/dist/index.js")) as typeof import("@orbis/e2e") : undefined;
if (legacyProtocol && Number(legacyProtocol.PROTOCOL_VERSION) !== 18) throw new Error("Expected an unchanged protocol18 release fixture");

class OldPhone {
  readonly messages: Record<string, unknown>[] = [];
  readonly binaries: Buffer[] = [];
  readonly errors: unknown[] = [];
  readonly envelopes: EnvelopeV2[] = [];
  readonly pieces = new EnvelopeReassembler();
  sentPieces = 0;
  receivedPieces = 0;
  channel: E2eChannel | undefined;
  constructor(readonly socket: WebSocket, readonly version: 18 | 19, readonly outerVersion: 18 | 19, readonly hostId: string, readonly deviceId: string) {
    socket.on("message", raw => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "v2.frame") return;
        expect(frame.protocolVersion).toBe(outerVersion);
        if (frame.envelope.hdr.k === "piece") this.receivedPieces += 1;
        const envelope = this.pieces.accept(frame.envelope);
        if (!envelope) return;
        if (envelope.hdr.k === "hs") { this.envelopes.push(envelope); return; }
        const payload = this.channel!.open(envelope);
        if (!payload) return;
        if (envelope.hdr.k === "bin") {
          decodeArtifactChunkFrame(payload, version);
          if (version === 18) legacyProtocol?.decodeArtifactChunkFrame(payload);
          this.binaries.push(payload); return;
        }
        const message = JSON.parse(payload.toString()) as Record<string, unknown>;
        if ("protocolVersion" in message) expect(message.protocolVersion).toBe(version);
        // Strict old version gate, plus current known-field validation. Local verification
        // additionally loads the unchanged installed full protocol18 schema.
        if (message.type === "host.lan") {
          expect(Object.keys(message).sort()).toEqual(["endpoints", "protocolVersion", "type"]);
          expect(Array.isArray(message.endpoints)).toBe(true);
        } else {
          RelayToDeviceMessageSchema.parse("protocolVersion" in message ? { ...message, protocolVersion: PROTOCOL_VERSION } : message);
          if (version === 18) legacyProtocol?.RelayToDeviceMessageSchema.parse(message);
        }
        this.messages.push(message);
      } catch (error) { this.errors.push(error); }
    });
  }
  frame(envelope: EnvelopeV2): void {
    const fragment = this.version === 18 && legacyProtocol ? legacyProtocol.fragmentEnvelope : fragmentEnvelope;
    for (const piece of fragment(envelope)) {
      if (piece.hdr.k === "piece") this.sentPieces += 1;
      this.socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: this.outerVersion, envelope: piece }));
    }
  }
  request(message: Record<string, unknown>): void {
    this.frame(this.channel!.seal({ k: "data", room: this.hostId, from: this.deviceId, to: this.hostId, ch: "ctl", n: this.channel!.nextSequence("ctl") }, Buffer.from(JSON.stringify({ protocolVersion: this.version, ...message }))));
  }
  async handshake(psk: Buffer): Promise<void> {
    const wireCrypto = this.version === 18 && legacyE2e ? legacyE2e : { DeviceHandshake, E2eChannel };
    const handshake = new wireCrypto.DeviceHandshake(psk);
    const hs = (body: Parameters<typeof buildHandshakeEnvelope>[0]["body"]): EnvelopeV2 => buildHandshakeEnvelope({ room: this.hostId, from: this.deviceId, to: this.hostId, body });
    this.frame(hs(handshake.start()));
    await vi.waitFor(() => expect(this.envelopes).toHaveLength(1));
    const accept = readHandshakeEnvelope(this.envelopes.shift()!);
    if (accept.type !== "hs2") throw new Error("expected hs2");
    const confirm = handshake.accept(accept);
    this.channel = new wireCrypto.E2eChannel({ keys: handshake.keys, role: "device" });
    this.frame(hs(confirm));
  }
  async take(type: string, requestId?: string): Promise<Record<string, unknown>> {
    await vi.waitFor(() => {
      expect(this.errors).toEqual([]);
      expect(this.messages.some(m => m.type === type && (!requestId || m.requestId === requestId))).toBe(true);
    }, { timeout: 5_000 });
    return this.messages.splice(this.messages.findIndex(m => m.type === type && (!requestId || m.requestId === requestId)), 1)[0]!;
  }
}

describe("unchanged legacy device behavior against a compatible Host", () => {
  let directory: string;
  let relay: RelayServer;
  let host: SourceHostService;
  let hostId: string;
  const phones: OldPhone[] = [];
  const runtimes: WebSocket[] = [];
  const keys = new Map<string, Buffer>();
  afterEach(async () => {
    for (const phone of phones.splice(0)) phone.socket.close();
    for (const runtime of runtimes.splice(0)) runtime.close();
    await host?.stop(); await relay?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    keys.clear();
  });
  const setup = async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), "orbis-wire-compat-"));
    hostId = (await loadOrCreateHostIdentity({ dir: directory })).hostId;
    const devices = ["phone18", "phone19"].map(deviceId => {
      const psk = randomBytes(32); keys.set(deviceId, psk);
      return { deviceId, pskRoot: psk.toString("base64url"), devicePub: randomBytes(32).toString("base64url"), createdAt: 1, label: deviceId, revoked: false };
    });
    await saveDeviceStore(directory, { version: 1, devices });
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["isolated-runtime"], deviceCredentials: devices.map(device => ({ deviceId: device.deviceId, hostId, name: device.label, credential: device.deviceId })) });
    host = await HostService.create({ relayUrl: relay.url, credential: "isolated-runtime", stateDir: directory, sessionsRoot: join(directory, "sessions"), lanPort: 0, reconnect: false, probeIntervalMs: 0 });
    await host.start();
  };
  const connect = async (version: 18 | 19, path: "relay" | "lan", outerVersion: 18 | 19 = version, bootstrap = true): Promise<OldPhone> => {
    const deviceId = `phone${version}`;
    const socket = new WebSocket(path === "relay" ? `${relay.url}/v1/device` : `ws://127.0.0.1:${host.lan!.port}/v1/lan`);
    await once(socket, "open");
    if (path === "relay") {
      const ready = once(socket, "message");
      socket.send(JSON.stringify({ type: "device.authenticate", protocolVersion: outerVersion, credential: deviceId }));
      const [raw] = await ready;
      expect(JSON.parse(raw.toString())).toMatchObject({ type: "device.ready", protocolVersion: outerVersion });
    }
    const phone = new OldPhone(socket, version, outerVersion, hostId, deviceId); phones.push(phone);
    await phone.handshake(keys.get(deviceId)!);
    if (path === "relay" && bootstrap) {
      // Exactly the already-released Android/iOS HS3 follow-up; no new negotiation fields.
      phone.request({ type: "host.lan.request" });
    }
    if (bootstrap) await phone.take("device.ready");
    return phone;
  };

  it.each([[18, "relay"], [19, "relay"], [18, "lan"], [19, "lan"]] as const)("protocol %s on %s reads, receives correlated errors and transfers original bytes", async (version, path) => {
    await setup();
    const phone = await connect(version, path);
    phone.request({ type: "session.list", requestId: "same-id" });
    expect(await phone.take("session.list.result", "same-id")).toMatchObject({ requestId: "same-id", sessions: [] });
    const invalid = { type: "session.list", requestId: "bad-fields", extra: true };
    phone.request(invalid);
    expect(await phone.take("protocol.error", "bad-fields")).toMatchObject({ code: "invalid_request" });
    const bytes = randomBytes(96 * 1024);
    phone.request({ type: "file.upload.init", requestId: "upload", runtimeId: hostId, directory: join(directory, "uploads"), fileName: "bytes.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    const ready = await phone.take("file.upload.ready", "upload");
    const read = await phone.take("file.upload.read");
    const uploadId = ready.uploadId as string;
    expect(read).toMatchObject({ uploadId, offset: 0 });
    const chunk = encodeArtifactChunkFrame({ runtimeId: hostId, transferId: uploadId, offset: 0, data: bytes }, version);
    phone.frame(phone.channel!.seal({ k: "bin", room: hostId, from: phone.deviceId, to: hostId, ch: "bulk", n: phone.channel!.nextSequence("bulk") }, chunk));
    const finished = await phone.take("file.upload.finished");
    expect(await readFile(finished.path as string)).toEqual(bytes);
    phone.request({ type: "runtime.command", runtimeId: hostId, commandId: "download-once", command: { type: "file.download", path: finished.path } });
    await vi.waitFor(() => expect(phone.messages.some(m => m.type === "runtime.event" && (m.event as { type?: string })?.type === "artifact.started")).toBe(true));
    const started = phone.messages.splice(phone.messages.findIndex(m => (m.event as { type?: string })?.type === "artifact.started"), 1)[0]!;
    const event = started.event as { commandId: string; transferId: string };
    expect(event.commandId).toBe("download-once");
    phone.request({ type: "artifact.read", transferId: event.transferId, requestId: "read-once", offset: 0, length: bytes.length });
    await vi.waitFor(() => expect(phone.binaries).toHaveLength(1));
    expect(Buffer.from(decodeArtifactChunkFrame(phone.binaries[0]!, version).data)).toEqual(bytes);
    expect(phone.sentPieces).toBeGreaterThan(1);
    expect(phone.receivedPieces).toBeGreaterThan(1);
    phone.request({ type: "artifact.done", transferId: event.transferId });
    phone.request({ type: "artifact.read", transferId: event.transferId, requestId: "read-after-done", offset: 0, length: bytes.length });
    expect(await phone.take("artifact.read.failed", "read-after-done")).toMatchObject({ reason: "unknown_transfer" });
    expect(phone.errors).toEqual([]);
    expect(host.devices).toHaveLength(2);
  });

  it("does not publish ready or select an unbound Relay path after invalid first requests", async () => {
    await setup();
    const phone = await connect(18, "relay", 18, false);
    phone.request({ type: "session.list", requestId: "unsupported-first", protocolVersion: 20 });
    expect(await phone.take("protocol.error", "unsupported-first")).toMatchObject({ code: "protocol_version_mismatch" });
    phone.request({ type: "session.list", requestId: "malformed-first", extra: true });
    expect(await phone.take("protocol.error", "malformed-first")).toMatchObject({ code: "invalid_request" });
    expect(host.activePathOf(phone.deviceId)).toBeUndefined();
    expect(phone.messages.some(message => message.type === "device.ready")).toBe(false);
    phone.request({ type: "session.list", requestId: "valid-first" });
    await phone.take("device.ready");
    await phone.take("session.list.result", "valid-first");
    expect(host.activePathOf(phone.deviceId)).toBe("relay");
    expect(phone.errors).toEqual([]);
  });

  it("separates simultaneous 18/19 peers, Relay outer versions, path switching and fresh sessions", async () => {
    await setup();
    const legacy = await connect(18, "relay", 19);
    const modern = await connect(19, "relay", 18);
    legacy.request({ type: "host.lan.request", protocolVersion: 19, requestId: "changed" });
    // Strict known-field validation rejects the extra requestId before it can select a version.
    expect(await legacy.take("protocol.error", "changed")).toMatchObject({ code: "invalid_request" });
    legacy.request({ type: "session.list", protocolVersion: 19, requestId: "mid-session" });
    expect(await legacy.take("protocol.error", "mid-session")).toMatchObject({ code: "protocol_version_mismatch" });
    legacy.request({ type: "session.list", requestId: "old" });
    legacy.request({ type: "session.list", protocolVersion: 20, requestId: "future-version" });
    expect(await legacy.take("protocol.error", "future-version")).toMatchObject({ code: "protocol_version_mismatch" });
    modern.request({ type: "session.list", requestId: "new" });
    await legacy.take("session.list.result", "old"); await modern.take("session.list.result", "new");
    const lan = await connect(18, "lan");
    expect(host.activePathOf(legacy.deviceId)).toBe("lan");
    lan.socket.close();
    await vi.waitFor(() => expect(host.activePathOf(legacy.deviceId)).toBe("relay"));
    legacy.request({ type: "session.list", requestId: "fallback" });
    await legacy.take("session.list.result", "fallback");
    // A new MAC-confirmed session may choose a different supported business version.
    await legacy.handshake(keys.get(legacy.deviceId)!);
    expect(host.activePathOf(legacy.deviceId)).toBeUndefined();
    legacy.request({ type: "host.lan.request" });
    await legacy.take("device.ready");
    legacy.request({ type: "session.list", requestId: "reconnected" });
    await legacy.take("session.list.result", "reconnected");
    expect(legacy.errors).toEqual([]); expect(modern.errors).toEqual([]);
  });

  it("projects live execution, notifications, command receipts and history for simultaneous strict peers", async () => {
    await setup();
    const legacy = await connect(18, "relay");
    const modern = await connect(19, "relay");
    const descriptor = host.loopback!.descriptor!;
    const socket = new WebSocket(`${descriptor.url}${LOOPBACK_PATH}`);
    runtimes.push(socket);
    await once(socket, "open");
    const incoming: Record<string, unknown>[] = [];
    socket.on("message", raw => incoming.push(JSON.parse(raw.toString())));
    const send = (message: object): void => socket.send(JSON.stringify({ protocolVersion: 19, runtimeId: "pi-compat", ...message }));
    socket.send(JSON.stringify({ type: "runtime.authenticate", protocolVersion: 19, role: "host", credential: descriptor.token,
      runtime: { runtimeId: "pi-compat", name: "compat", cwd: directory, status: "idle", sessionId: "session" } }));
    await legacy.take("runtime.online"); await modern.take("runtime.online");
    let sequence = 0;
    const publish = (event: object): void => send({ type: "runtime.event", sequence: ++sequence, event });
    for (const phone of [legacy, modern]) {
      phone.request({ type: "agent.state.request", requestId: "execution", scope: "agent", runtimeId: "pi-compat",
        sessionId: "session", agentKind: "pi", subscribe: true, domains: ["execution"] });
      await phone.take("agent.state.snapshot", "execution");
    }
    publish({ type: "execution.tasks", tasks: { availability: "ready", items: [
      { id: "background", title: "existing task", kind: "test", status: "running" },
    ], truncated: false } });
    await vi.waitFor(() => expect(modern.messages.some(message => (message.event as { type?: string })?.type === "execution.tasks")).toBe(true));
    publish({ type: "runtime.status", status: "running" });
    for (const phone of [legacy, modern]) {
      await vi.waitFor(() => expect(phone.messages.some(message => (message.event as { type?: string; status?: string })?.type === "runtime.status" &&
        (message.event as { status?: string }).status === "running")).toBe(true));
      phone.request({ type: "agent.state.request", requestId: "latest", scope: "agent", runtimeId: "pi-compat",
        sessionId: "session", agentKind: "pi", domains: ["execution"] });
      const state = await phone.take("agent.state.snapshot", "latest");
      const execution = (state.domains as { value: Record<string, unknown> }[])[0]!.value;
      expect(execution.phase).toBe("running");
      if (phone.version === 18) expect(execution).not.toHaveProperty("tasks");
      else expect(execution.tasks).toMatchObject({ items: [{ id: "background", status: "running" }] });
    }
    expect(legacy.messages.some(message => (message.event as { type?: string })?.type === "execution.tasks")).toBe(false);
    publish({ type: "notification.source", producerEpoch: "source", sessionId: "session", revision: 1, complete: true,
      notifications: [{ code: "retry", occurrenceId: "one", scope: { turnId: "turn" }, lifecycle: "condition", severity: "warning", message: "retry" }] });
    for (const phone of [legacy, modern]) await vi.waitFor(() => expect(phone.messages.some(message => message.type === "notification.snapshot" &&
      (message.notifications as unknown[]).length === 1)).toBe(true));
    legacy.request({ type: "runtime.command", runtimeId: "pi-compat", commandId: "sync-once",
      command: { type: "session.sync", sessionId: "session", syncId: "original-sync", range: "preview", maxEntries: 100 } });
    await vi.waitFor(() => expect(incoming.filter(message => message.type === "runtime.command")).toHaveLength(1));
    const forwarded = incoming.find(message => message.type === "runtime.command")!;
    publish({ type: "command.result", commandId: forwarded.commandId, ok: true });
    publish({ type: "session.snapshot", sessionId: "session", syncId: (forwarded.command as { syncId: string }).syncId,
      range: "preview", cursor: { leafId: null }, mode: "replace", entries: [], complete: true,
      source: { epoch: "source", seq: 0, ready: true }, checkpoint: { checkpointId: "checkpoint", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } });
    await vi.waitFor(() => {
      expect(legacy.errors).toEqual([]);
      expect(legacy.messages.some(message => (message.event as { commandId?: string })?.commandId === "sync-once")).toBe(true);
      expect(legacy.messages.some(message => (message.event as { syncId?: string })?.syncId === "original-sync")).toBe(true);
    });
    expect(modern.messages.some(message => (message.event as { syncId?: string })?.syncId === "original-sync")).toBe(false);
    expect(incoming.filter(message => message.type === "runtime.command")).toHaveLength(1);
    expect(modern.errors).toEqual([]);
  });
});
