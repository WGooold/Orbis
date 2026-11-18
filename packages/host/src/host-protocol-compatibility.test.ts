import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DeviceHandshake, E2eChannel, buildHandshakeEnvelope, loadOrCreateHostIdentity, saveDeviceStore, readHandshakeEnvelope } from "@orbis/e2e";
import { EnvelopeReassembler, fragmentEnvelope, PROTOCOL_VERSION, LOOPBACK_PATH, RelayToDeviceMessageSchema, encodeArtifactChunkFrame, decodeArtifactChunkFrame, type EnvelopeV2 } from "@orbis/protocol";
import type { RelayServer } from "@orbis/relay";
import { createBusinessRelayServer as createRelayServer, relayBusinessDeviceURL, relayBusinessHostOptions, stopRelayBusinessTransports } from "./fixtures/relay-business-transport.js";
import { HostService as SourceHostService } from "./host-service.js";
import type { OpenClawConfig } from "./openclaw-gateway.js";

// Optional additional oracle from an unchanged installed release. Native require
// preserves its own dependency resolution, outside Vitest's current-source aliases.
const legacyRoot = process.env.ORBIS_LEGACY_RUNTIME;
const nativeRequire = createRequire(import.meta.url);
const compatibleRoot = process.env.ORBIS_COMPATIBLE_RUNTIME;
// Native import supports the runtime's top-level await and keeps packaged dependency
// resolution outside Vitest's aliases. The path is an explicit local test fixture.
const nativeImport = nativeRequire("../../../scripts/test-fixtures/import-native.cjs") as (specifier: string) => Promise<{ HostService: typeof SourceHostService }>;
// Optional source archives built from the published release tags, kept outside Vitest aliases.
const releaseProtocolPaths = (process.env.ORBIS_RELEASE_PROTOCOLS ?? "").split(",").filter(Boolean);
const releaseProtocols = await Promise.all(releaseProtocolPaths.map(path => import(/* @vite-ignore */ pathToFileURL(path).href) as Promise<typeof import("@orbis/protocol")>));
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
    await host?.stop(); await stopRelayBusinessTransports(); await relay?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    keys.clear();
  });
  const setup = async (openClaw: OpenClawConfig | false = false): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), "orbis-wire-compat-"));
    hostId = (await loadOrCreateHostIdentity({ dir: directory })).hostId;
    const devices = ["phone18", "phone19"].map(deviceId => {
      const psk = randomBytes(32); keys.set(deviceId, psk);
      return { deviceId, pskRoot: psk.toString("base64url"), devicePub: randomBytes(32).toString("base64url"), createdAt: 1, label: deviceId, revoked: false };
    });
    await saveDeviceStore(directory, { version: 1, devices });
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["isolated-runtime"], deviceCredentials: devices.map(device => ({ deviceId: device.deviceId, hostId, name: device.label, credential: device.deviceId })) });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "isolated-runtime", stateDir: directory, openClaw, sessionsRoot: join(directory, "sessions"), lanPort: 0, reconnect: false, probeIntervalMs: 0 });
    await host.start();
  };
  const connect = async (version: 18 | 19, path: "relay" | "lan", outerVersion: 18 | 19 = version, bootstrap = true): Promise<OldPhone> => {
    const deviceId = `phone${version}`;
    const socket = new WebSocket(path === "relay" ? await relayBusinessDeviceURL(relay.url + "/v1/device") : "ws://127.0.0.1:" + host.lan!.port + "/v1/lan");
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

  // OPENCLAW-02: exercise the SDK, Host and Relay together with a synthetic Gateway.
  // The same device ID can reconnect from an older App without inheriting its old capability.
  it("keeps OpenClaw private to the negotiated App view, including after rollback", async () => {
    const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(gateway, "listening");
    const address = gateway.address(); if (!address || typeof address === "string") throw new Error("No Gateway port");
    const methods = ["sessions.list", "sessions.create", "sessions.subscribe", "sessions.messages.subscribe", "sessions.messages.unsubscribe",
      "sessions.patch", "chat.history", "chat.send", "chat.abort"];
    const rows: Array<{ key: string; sessionId: string; spawnedCwd: string; archived: boolean }> = [];
    const requests: string[] = [];
    let loseCreateReceipt = true;
    gateway.on("connection", socket => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "isolated-fixture", ts: Date.now() } }));
      socket.on("message", raw => {
        const { id, method, params } = JSON.parse(raw.toString()); requests.push(method);
        let payload: unknown;
        if (method === "connect") payload = { type: "hello-ok", protocol: 4, server: { version: "fixture", connId: "fixture" },
          features: { methods, events: [] }, snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
          auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
          policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 10000 } };
        else if (method === "sessions.list") payload = { sessions: rows.filter(row => row.archived === (params.archived === true)), hasMore: false };
        else if (method === "sessions.subscribe") payload = { subscribed: true };
        else if (method === "sessions.messages.subscribe") payload = { subscribed: true, key: params.key };
        else if (method === "sessions.messages.unsubscribe") payload = { unsubscribed: true, key: params.key };
        else if (method === "sessions.create") {
          const entry = { key: `agent:main:${params.key}`, sessionId: `native-${rows.length}`, spawnedCwd: params.cwd, archived: false };
          rows.push(entry);
          if (loseCreateReceipt) {
            loseCreateReceipt = false;
            socket.close(1001);
            return;
          }
          payload = { ok: true, key: entry.key, sessionId: entry.sessionId, entry };
        } else if (method === "chat.history") {
          const row = rows.find(row => row.key === params.sessionKey)!;
          payload = { sessionKey: row.key, sessionId: row.sessionId, hasMore: false, messages: [{ role: "assistant", content: "fixture-history", __openclaw: { id: "occurrence-1" } }] };
        } else if (method === "chat.send") payload = { runId: params.idempotencyKey, status: "started" };
        else if (method === "chat.abort") payload = { aborted: true };
        else if (method === "sessions.patch") {
          const row = rows.find(row => row.key === params.key && row.sessionId === params.expectedSessionId)!;
          row.archived = params.archived;
          payload = { ok: true, key: row.key, entry: { sessionId: row.sessionId, ...(row.archived ? { archivedAt: 1 } : {}) } };
        }
        socket.send(JSON.stringify({ type: "res", id, ok: payload !== undefined, payload }));
      });
    });
    try {
      await setup({ url: `ws://127.0.0.1:${address.port}`, token: "fixture-only" });
      await vi.waitFor(() => expect(requests).toContain("sessions.list"));
      const released = await connect(18, "relay");
      const modern = await connect(19, "lan");
      released.request({ type: "device.features", features: ["agent.dshDesktop"] });
      const legacyReady = await released.take("device.ready");
      expect(legacyReady).not.toHaveProperty("deviceFeatures");
      for (const protocol of releaseProtocols) protocol.RelayToDeviceMessageSchema.parse({ ...legacyReady, protocolVersion: protocol.PROTOCOL_VERSION });
      modern.request({ type: "device.features", features: ["agent.openclaw"] });
      const negotiated = await modern.take("device.ready");
      expect(negotiated).toMatchObject({ deviceFeatures: ["agent.openclaw"], launchableAgents: expect.arrayContaining(["openclaw"]) });
      expect(negotiated).not.toHaveProperty("dshDesktop");

      modern.request({ type: "session.configuration.read", requestId: "options", agentKind: "openclaw", cwd: directory });
      const options = await modern.take("session.configuration.result", "options");
      expect(options).toMatchObject({ catalog: { models: [], permissions: [] } });
      const launch = { type: "session.launch", requestId: "start", launchId: "launch-1", agentKind: "openclaw", cwd: directory,
        binding: options.binding, revision: options.revision, values: {}, spawnMode: "headless" };
      modern.request(launch);
      expect(await modern.take("session.launch.result", "start")).toMatchObject({ phase: "preparing" });
      expect(await modern.take("session.launch.result", "start")).toMatchObject({ phase: "unknown" });
      await vi.waitFor(() => expect(requests.filter(method => method === "connect")).toHaveLength(2), { timeout: 5000 });
      await vi.waitFor(() => expect(host.readHostState(["backends"]).domains[0]?.value).toMatchObject({ agents: expect.arrayContaining(["openclaw"]) }));
      modern.request({ type: "session.launch.read", requestId: "recover", launchId: "launch-1" });
      const recovered = await modern.take("session.launch.result", "recover");
      expect(recovered).toMatchObject({ phase: "ready", spawnMode: "headless", sessionId: expect.stringMatching(/^openclaw:/) });
      expect(requests.filter(method => method === "sessions.create")).toHaveLength(1);
      expect(requests).not.toContain("chat.send");
      const sessionId = recovered.sessionId as string;
      const { runtime } = await modern.take("runtime.online");
      const runtimeId = (runtime as { runtimeId: string }).runtimeId;
      modern.request({ type: "runtime.command", runtimeId, commandId: "read-history",
        command: { type: "session.sync", sessionId, syncId: "preview", range: "preview" } });
      await vi.waitFor(() => expect(modern.messages).toContainEqual(expect.objectContaining({ type: "runtime.event", runtimeId,
        event: expect.objectContaining({ type: "session.snapshot", syncId: "preview", entries: [expect.objectContaining({
          data: { message: expect.objectContaining({ content: [{ type: "text", text: "fixture-history" }] }) },
        })] }) })));
      const noUpload = join(directory, "should-not-exist");
      modern.request({ type: "file.upload.init", requestId: "upload-disabled", runtimeId, directory: noUpload, fileName: "x", size: 1, sha256: "a".repeat(64) });
      expect(await modern.take("file.upload.failed", "upload-disabled")).toMatchObject({ code: "unsupported_command" });
      await expect(readFile(noUpload)).rejects.toMatchObject({ code: "ENOENT" });
      modern.request({ type: "runtime.command", runtimeId, commandId: "prompt", command: { type: "user_message", text: "fixture prompt", messageId: "prompt-1" } });
      await vi.waitFor(() => expect(modern.messages).toContainEqual(expect.objectContaining({ type: "runtime.event", runtimeId,
        event: expect.objectContaining({ type: "command.result", commandId: "prompt", status: "success" }) })));
      modern.request({ type: "runtime.command", runtimeId, commandId: "stop", command: { type: "stop" } });
      await vi.waitFor(() => expect(modern.messages).toContainEqual(expect.objectContaining({ type: "runtime.event", runtimeId,
        event: expect.objectContaining({ type: "command.result", commandId: "stop", status: "success" }) })));
      for (const phone of [released, modern]) {
        phone.request({ type: "agent.state.request", scope: "host", domains: ["backends", "catalog"], requestId: "catalog" });
        const snapshot = await phone.take("agent.state.snapshot", "catalog");
        expect(JSON.stringify(snapshot).includes(sessionId)).toBe(phone === modern);
        for (const protocol of releaseProtocols) {
          if (phone === modern) expect(protocol.RelayToDeviceMessageSchema.safeParse(negotiated).success).toBe(false);
          else {
            protocol.RelayToDeviceMessageSchema.parse({ ...snapshot, protocolVersion: protocol.PROTOCOL_VERSION });
            for (const domain of (snapshot.domains as Array<{ domain: string; value: unknown }>)) {
              if (domain.domain === "catalog") protocol.HostCatalogStateSchema.parse(domain.value);
              if (domain.domain === "backends") protocol.HostBackendsStateSchema.parse(domain.value);
            }
          }
        }
      }
      released.request({ type: "session.activate", requestId: "reject-legacy", target: { type: "resume", sessionId } });
      expect(await released.take("protocol.error", "reject-legacy")).toMatchObject({ code: "agent_unsupported" });
      expect(JSON.stringify(released.messages)).not.toContain(sessionId);
      expect(await readFile(join(directory, "openclaw-session-configuration.json"), "utf8")).toContain(sessionId);
      await expect(readFile(join(directory, "session-configuration.json"))).rejects.toMatchObject({ code: "ENOENT" });

      modern.request({ type: "session.archive", agentKind: "openclaw", sessionId, requestId: "archive", archived: true });
      expect(await modern.take("session.archive.changed", "archive")).toMatchObject({ archived: true });
      modern.request({ type: "session.archive", agentKind: "openclaw", sessionId, requestId: "restore", archived: false });
      expect(await modern.take("session.archive.changed", "restore")).toMatchObject({ archived: false });
      modern.request({ type: "session.activate", requestId: "resume", target: { type: "resume", sessionId } });
      expect(await modern.take("session.activated", "resume")).toMatchObject({ sessionId, agentKind: "openclaw" });
      const rolledBack = await connect(19, "lan");
      rolledBack.request({ type: "session.launch.read", launchId: "launch-1", requestId: "old-read" });
      expect(await rolledBack.take("session.launch.result", "old-read")).toMatchObject({ phase: "absent" });
      rolledBack.request({ type: "agent.state.request", scope: "device", domains: ["operations"], requestId: "old-operations" });
      expect(JSON.stringify(await rolledBack.take("agent.state.snapshot", "old-operations"))).not.toContain(runtimeId);
    } finally {
      for (const socket of gateway.clients) socket.terminate();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
  }, 20_000);

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
