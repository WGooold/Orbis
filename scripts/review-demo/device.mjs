// Protocol probe, not an alternate runtime: this behaves like the mobile client.
import { once } from "node:events";
import WebSocket from "ws";
import { DeviceHandshake, E2eChannel, buildPairEnvelope, buildPlaintextEnvelope,
  createDevicePairingSession, decodePairingQrText, fromBase64Url, generateX25519KeyPair,
  readHandshakeEnvelope, readPairEnvelope, verifyPairAccept } from "@orbis/e2e";
import { EnvelopeReassembler, PROTOCOL_VERSION } from "@orbis/protocol";

export async function connectDevice(text, options = {}) {
  const qr = decodePairingQrText(text);
  const base = options.httpBase ?? qr.relayUrl.replace(/^ws/u, "http").replace(/\/$/u, "");
  const response = await fetch(`${base}/v1/pairings`, { method: "POST", headers: { "content-type": "application/json", "User-Agent": "OrbisReviewProbe/1.0" },
    body: JSON.stringify({ code: qr.code, deviceName: "Orbis review connectivity check" }) });
  if (!response.ok) throw new Error(`Pairing code exchange failed: HTTP ${response.status}`);
  const paired = await response.json();
  const socket = new WebSocket(`${(options.relayUrl ?? qr.relayUrl).replace(/\/$/u, "")}/v1/device`, { headers: { "User-Agent": "OrbisReviewProbe/1.0" } });
  let channel; let waiter;
  const queue = []; const reassembler = new EnvelopeReassembler();
  const deliver = item => { if (waiter) { const current = waiter; waiter = undefined; current(item); } else queue.push(item); };
  const send = envelope => socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
  const seal = (kind, bytes) => channel.seal({ k: kind, room: qr.hostId, from: paired.deviceId, to: qr.hostId,
    ch: "ctl", n: channel.nextSequence("ctl") }, bytes);
  socket.on("message", raw => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "protocol.error") throw new Error(frame.message);
      if (frame.type !== "v2.frame") return;
      if (!channel) return deliver({ envelope: frame.envelope });
      const envelope = reassembler.accept(frame.envelope);
      if (!envelope) return;
      const bytes = channel.open(envelope);
      if (!bytes) return;
      if (envelope.hdr.k === "ping") return send(seal("ping", bytes));
      if (envelope.hdr.k === "data") deliver({ message: JSON.parse(bytes.toString("utf8")) });
    } catch (error) { deliver({ error }); }
  });
  socket.on("error", error => deliver({ error }));
  async function next(timeout = 20_000) {
    const item = queue.shift() ?? await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiter = undefined; reject(new Error("Review protocol probe timed out")); }, timeout);
      waiter = value => { clearTimeout(timer); resolve(value); };
    });
    if (item.error) throw item.error;
    return item;
  }
  async function matching(predicate, timeout = 20_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const item = await next(Math.max(1, end - Date.now()));
      if (item.message && predicate(item.message)) return item.message;
    }
    throw new Error("Expected review message was not received");
  }
  async function close() {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, "close"); socket.close();
    const timer = setTimeout(() => socket.terminate(), 2000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: paired.credential }));
    const pairing = createDevicePairingSession({ hostPublicRaw: fromBase64Url(qr.hostPub, "hostPub"),
      psk: fromBase64Url(qr.psk, "psk"), deviceId: paired.deviceId, deviceKeyPair: generateX25519KeyPair() });
    send(buildPairEnvelope({ room: qr.hostId, from: paired.deviceId, to: qr.hostId, body: pairing.request }));
    const accepted = readPairEnvelope((await next()).envelope);
    verifyPairAccept(pairing, accepted);
    const handshake = new DeviceHandshake(pairing.pskRoot);
    send(buildPlaintextEnvelope({ kind: "hs", room: qr.hostId, from: paired.deviceId, to: qr.hostId, body: handshake.start() }));
    const hs2 = readHandshakeEnvelope((await next()).envelope);
    const confirmation = handshake.accept(hs2);
    channel = new E2eChannel({ keys: handshake.keys, role: "device" });
    send(buildPlaintextEnvelope({ kind: "hs", room: qr.hostId, from: paired.deviceId, to: qr.hostId, body: confirmation }));
    // Released Android/iOS refresh LAN endpoints immediately after HS3. This also
    // gives Host the authenticated business version before its first ready/state.
    send(seal("data", Buffer.from(JSON.stringify({ type: "host.lan.request", protocolVersion: PROTOCOL_VERSION }))));
    const ready = await matching(message => message.type === "device.ready");
    return { qr, ready, matching, close,
      send: message => send(seal("data", Buffer.from(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message })))) };
  } catch (error) { await close(); throw error; }
}
