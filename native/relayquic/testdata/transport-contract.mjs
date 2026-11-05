// Same application transport contract for the existing WS path and the QUIC adapter.
// The fixture owns real HostRelayClient / DeviceLink / E2E code. Go supplies only
// the phone-to-Relay socket. No production credentials, backend or user data.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { createRelayServer } from '../../../packages/relay/dist/index.js';
import { DeviceLink } from '../../../packages/host/dist/device-link.js';
import { HostRelayClient } from '../../../packages/host/dist/relay-client.js';
import { channelForDeviceMessage } from '../../../packages/host/dist/host-service.js';
import { DeviceHandshake, E2eChannel, buildPlaintextEnvelope, readHandshakeEnvelope,
  generateX25519KeyPair, toBase64Url } from '../../../packages/e2e/dist/index.js';
import { PROTOCOL_VERSION, EnvelopeReassembler, fragmentEnvelope } from '../../../packages/protocol/dist/index.js';

const hostId = 'transport-contract-host';
const deviceId = 'transport-contract-device';
const credential = randomBytes(24).toString('hex');
const runtimeCredential = randomBytes(24).toString('hex');
const psk = randomBytes(32);
const stats = { confirmed: 0, delivered: 0, stale: 0, snapshotWrites: 0, errors: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const wire = envelope => ({ type: 'v2.frame', protocolVersion: PROTOCOL_VERSION, envelope });
const plain = body => buildPlaintextEnvelope({ kind: 'hs', room: hostId, from: deviceId, to: hostId, body });
const relay = await createRelayServer({ port: 0, host: '127.0.0.1', runtimeCredentials: [runtimeCredential],
  deviceCredentials: [{ deviceId, credential, name: 'isolated contract' }] });
const link = new DeviceLink({ hostId, device: { deviceId,
  devicePub: toBase64Url(generateX25519KeyPair().publicRaw), pskRoot: toBase64Url(psk),
  label: 'isolated contract', createdAt: 0, revoked: false }, probeIntervalMs: 0,
  onSessionReady: () => {
    stats.confirmed++;
    assert.equal(link.send(Buffer.from(JSON.stringify({ type: 'device.ready', encrypted: true })), 'ctl'), true);
  },
  onPayload: (payload, kind) => {
    stats.delivered++;
    if (kind === 'bin') assert.equal(link.sendBinary(payload), true);
    else publish(payload);
  },
  onStaleFrame: () => { stats.stale++; },
  onError: error => { stats.errors.push(String(error)); },
});
const host = new HostRelayClient({ relayUrl: relay.url, credential: runtimeCredential,
  runtime: { runtimeId: hostId, name: 'isolated contract', cwd: '/', status: 'idle' },
  reconnect: false, heartbeatIntervalMs: 0,
  onFrame: envelope => {
    try { assert.equal(link.handle('relay', envelope), true); }
    catch (error) { stats.errors.push(String(error)); }
  },
});
await host.start();
const sink = envelope => host.send(envelope);
sink.backlog = () => host.bufferedAmount;
link.attach('relay', sink);

let handshake;
let channel;
let reassembler = new EnvelopeReassembler();
function seal(kind, bytes, ch) {
  return channel.seal({ k: kind, room: hostId, from: deviceId, to: hostId,
    n: channel.nextSequence(ch), ch }, bytes);
}
function content(tag, size, kind = 'data', lane = 'ctl') {
  if (kind === 'bin') return Buffer.concat([Buffer.from(tag), Buffer.alloc(size, 0xa7)]);
  const type = lane === 'ctl' ? 'command.result' : 'runtime.event';
  const event = lane === 'bulk' ? 'session.tool.content.page' : 'session.snapshot';
  return Buffer.from(JSON.stringify({ type, event: { type: event }, tag, text: '汉🙂'.repeat(size) }));
}
function publish(payload) {
  const object = JSON.parse(payload.toString('utf8'));
  const lane = channelForDeviceMessage(object);
  if (lane === 'bulk') assert.equal(link.sendToolContent(payload), true);
  else if (lane === 'msg') assert.equal(link.sendSessionSnapshot(payload, () => { stats.snapshotWrites++; }), true);
  else assert.equal(link.send(payload, lane), true);
}

function command(request) {
  switch (request.op) {
    case 'hello':
      handshake = new DeviceHandshake(psk); channel = undefined;
      reassembler = new EnvelopeReassembler();
      return { frames: [wire(plain(handshake.start()))] };
    case 'accept': {
      const body = readHandshakeEnvelope(request.envelope);
      assert.equal(body.type, 'hs2');
      const confirm = handshake.accept(body);
      channel = new E2eChannel({ keys: handshake.keys, role: 'device' });
      return { frames: [wire(plain(confirm))] };
    }
    case 'send': {
      const bytes = request.kind === 'ping' ? Buffer.from('Dtransport-probe') : content(request.tag, request.size, request.kind, request.lane);
      const envelope = seal(request.kind, bytes, request.lane);
      return { frames: fragmentEnvelope(envelope).map(wire), expected: { digest: digest(bytes), lane: request.lane, kind: request.kind } };
    }
    case 'receive': {
      assert.equal(request.frame.type, 'v2.frame');
      const envelope = reassembler.accept(request.frame.envelope);
      if (!envelope) return { complete: false };
      const payload = channel.open(envelope);
      assert.notEqual(payload, undefined, 'same-channel data was reordered or duplicated');
      return { complete: true, digest: digest(payload), lane: envelope.hdr.ch, kind: envelope.hdr.k, sequence: envelope.hdr.n };
    }
    case 'burst': {
      const expected = [];
      // Existing Host entry points, including snapshot / tool-content admission,
      // create every ciphertext and piece. The adapter must preserve each lane.
      for (let index = 0; index < 3; index++) {
        for (const lane of ['bulk', 'msg', 'ctl']) {
          const bytes = content(`${lane}-${index}`, lane === 'ctl' ? 2 : 7000, 'data', lane);
          publish(bytes);
          expected.push({ lane, kind: 'data', digest: digest(bytes) });
        }
      }
      return { expected };
    }
    case 'stats': return { ...stats, activePath: link.activePath };
    default: throw Error(`unknown fixture operation: ${request.op}`);
  }
}

const output = value => process.stdout.write(JSON.stringify(value) + '\n');
output({ upstream: `${relay.url}/v1/device`, credential, version: PROTOCOL_VERSION });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  try { output({ result: command(JSON.parse(line)) }); }
  catch (error) { output({ error: String(error) }); }
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true; lines.close(); link.close();
  await host.stop(); await relay.close();
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
