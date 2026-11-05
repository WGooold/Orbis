// Isolated performance workload. Production Relay, E2E, fragmentation and Host
// outbound mux; synthetic bulk/window messages instead of filesystem/HostService.
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { setImmediate, clearImmediate, setInterval, clearInterval } from 'node:timers';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { HostRelayClient } from '../../../packages/host/dist/relay-client.js';
import { createRelayServer } from '../../../packages/relay/dist/index.js';
import { PROTOCOL_VERSION, fragmentEnvelope, EnvelopeReassembler, OutboundChannelMux } from '../../../packages/protocol/dist/index.js';
import { E2eChannel } from '../../../packages/e2e/dist/index.js';

const remote = process.env.ORBIS_PERF_REMOTE_CONFIG ? JSON.parse(await readFile(process.env.ORBIS_PERF_REMOTE_CONFIG, 'utf8')) : undefined;
const runtimeCredential = remote?.runtimeCredential ?? randomBytes(24).toString('hex');
const credential = remote?.credential ?? randomBytes(24).toString('hex');
const keys = { kHostToDevice: randomBytes(32), kDeviceToHost: randomBytes(32) };
const historyMode = ({ 'history-shared': 'shared', 'history-background': 'background' })[process.env.ORBIS_PERF_WORKLOAD];
const historyLane = historyMode === 'background' ? 'bulk' : 'msg';
const chunkBytes = Number(process.env.ORBIS_PERF_CHUNK_BYTES ?? 1048576);
const payload = historyMode ? Buffer.alloc(chunkBytes, 0x68) : randomBytes(chunkBytes);
const windowChunks = Math.max(1, Math.floor(4 * 1024 * 1024 / payload.length));
const relay = remote ? { url: remote.relayUrl, close: async () => {} } : await createRelayServer({ port: 0, host: '127.0.0.1', runtimeCredentials: [runtimeCredential],
  deviceCredentials: [{ deviceId: 'perf-device', credential, name: 'isolated', hostId: 'perf-host' }] });
let host, nativeHost;
if (remote) {
  host = new EventEmitter();
  nativeHost = new HostRelayClient({ relayUrl: relay.url, credential: runtimeCredential,
    runtime: { runtimeId: 'perf-host', name: 'isolated', cwd: '/', status: 'idle' },
    transportMode: process.env.ORBIS_PERF_HOST_TRANSPORT, reconnect: false,
    socketOptions: { helperPath: remote.helperPath, caFile: remote.caFile },
    onFrame: envelope => host.emit('message', Buffer.from(JSON.stringify({ type: 'v2.frame', envelope }))),
    onProtocolError: code => { throw Error(`relay: ${code}`); } });
  host.send = text => nativeHost.send(JSON.parse(text).envelope);
  Object.defineProperty(host, 'bufferedAmount', { get: () => nativeHost.bufferedAmount });
  await nativeHost.start();
} else {
  host = new WebSocket(`${relay.url}/v1/runtime`, { perMessageDeflate: false });
  await once(host, 'open');
  host.send(JSON.stringify({ type: 'runtime.authenticate', protocolVersion: PROTOCOL_VERSION, credential: runtimeCredential,
    role: 'host', runtime: { runtimeId: 'perf-host', name: 'isolated', cwd: '/', status: 'idle' } }));
  await once(host, 'message');
}
const cipher = new E2eChannel({ keys, role: 'host' });
const reassembler = new EnvelopeReassembler({ onRejected: reason => { throw Error(`piece rejected: ${reason}`); } });
const mux = new OutboundChannelMux({ write: text => host.send(text), backlog: () => host.bufferedAmount,
  channelBacklog: channel => nativeHost?.bufferedAmountFor(channel) ?? host.bufferedAmount,
  onWriteAbandoned: () => { throw Error('host write abandoned'); } });
let sent = 0, acked = 0, uploaded = 0, running = false, pendingPump;
let progressTimer;
if (process.env.ORBIS_PERF_PROGRESS) {
  const { appendFileSync } = await import('node:fs');
  const progressStarted = performance.now();
  progressTimer = setInterval(() => {
    appendFileSync(process.env.ORBIS_PERF_PROGRESS, JSON.stringify({ type: 'host.progress', pid: process.pid,
      elapsedMs: performance.now() - progressStarted, sent, acked, uploaded,
      muxBytes: mux.queuedBytes, bulkQueuedBytes: mux.bulkQueuedBytes, ctlQueuedBytes: mux.ctlQueuedBytes,
      msgQueuedBytes: mux.msgQueuedBytes, bufferedAmount: host.bufferedAmount }) + '\n');
  }, 1000);
  progressTimer.unref();
}
function send(ch, kind, bytes) {
  const envelope = cipher.seal({ k: kind, room: 'perf-host', from: 'perf-host', to: 'perf-device',
    ch, n: cipher.nextSequence(ch) }, bytes);
  for (const piece of fragmentEnvelope(envelope, { mid: `h-${ch}-${envelope.hdr.n}` })) {
    const text = JSON.stringify({ type: 'v2.frame', protocolVersion: PROTOCOL_VERSION, envelope: piece });
    mux.enqueue(ch, text, Buffer.byteLength(text));
  }
}
const control = value => send('ctl', 'ping', Buffer.from(JSON.stringify(value)));
function pump() {
  pendingPump = undefined;
  if (!running || sent - acked >= windowChunks) return;
  if (mux.hasRoom(historyMode ? historyLane : 'bulk', payload.length * (historyMode ? 2 : 1.4))) {
    const chunk = Buffer.from(payload);
    chunk.writeBigUInt64BE(BigInt(++sent));
    if (historyMode) send(historyLane, 'data', Buffer.from(JSON.stringify({ op: 'diagnostic.history', n: sent, text: chunk.subarray(8).toString('utf8') })));
    else send('bulk', 'bin', chunk);
  }
  pendingPump = setImmediate(pump);
}
function schedulePump() { if (running && pendingPump === undefined) pendingPump = setImmediate(pump); }
host.on('message', raw => {
  const value = JSON.parse(raw.toString());
  if (value.type === 'protocol.error') throw Error(`relay: ${value.code}`);
  if (value.type !== 'v2.frame') return;
  const envelope = reassembler.accept(value.envelope);
  if (envelope === undefined) return;
  const plain = cipher.open(envelope);
  if (plain === undefined) throw Error('duplicate encrypted sequence');
  if (envelope.hdr.ch === 'bulk') {
    if (plain.length !== payload.length || Number(plain.readBigUInt64BE()) !== uploaded + 1 || !plain.subarray(8).equals(payload.subarray(8))) {
      throw Error('upload content/sequence mismatch');
    }
    uploaded++;
    control({ op: 'upload-ack', n: uploaded });
    return;
  }
  const message = JSON.parse(plain.toString());
  if (message.op === 'ping') {
    if (historyMode) send('msg', 'ping', Buffer.from(JSON.stringify(message)));
    else control(message);
  }
  else if (message.op === 'start') { running = message.direction === 'download'; control({ op: 'started' }); schedulePump(); }
  else if (message.op === 'ack') {
    if (message.n !== acked + 1 || message.n > sent) throw Error('download window ack mismatch');
    acked = message.n; schedulePump();
  } else if (message.op === 'stop') {
    running = false;
    if (pendingPump !== undefined) clearImmediate(pendingPump);
    pendingPump = undefined;
    control({ op: 'stopped', sent, acked, uploaded });
  } else throw Error(`unknown operation: ${message.op}`);
});
// Only the parent receives these ephemeral credentials/keys; never copy them to reports.
process.stdout.write(JSON.stringify({ upstream: `${relay.url}/v1/device`, credential, version: PROTOCOL_VERSION,
  hostKey: keys.kHostToDevice.toString('base64'), deviceKey: keys.kDeviceToHost.toString('base64'),
  payload: payload.toString('base64'), windowChunks, remote: remote !== undefined, caFile: remote?.caFile, quicPort: remote?.quicPort, hostTransport: nativeHost?.transportKind ?? 'ws' }) + '\n');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true; running = false;
  if (progressTimer) clearInterval(progressTimer);
  if (pendingPump !== undefined) clearImmediate(pendingPump);
  mux.stop();
  if (nativeHost) await nativeHost.stop(); else host.terminate();
  await relay.close();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
