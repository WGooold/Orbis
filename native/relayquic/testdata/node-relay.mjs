// Actual Node Relay, ephemeral credentials and an isolated WS Host route.
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import WebSocket from 'ws';
import { createRelayServer } from '../../../packages/relay/dist/index.js';
import { PROTOCOL_VERSION } from '../../../packages/protocol/dist/index.js';

const runtimeCredential = randomBytes(24).toString('hex');
const credential = randomBytes(24).toString('hex');
const relay = await createRelayServer({ port: 0, runtimeCredentials: [runtimeCredential],
  deviceCredentials: [{ deviceId: 'quic-test-device', credential, name: 'isolated' }] });
const host = new WebSocket(`${relay.url}/v1/runtime`);
await once(host, 'open');
host.send(JSON.stringify({ type: 'runtime.authenticate', protocolVersion: PROTOCOL_VERSION, credential: runtimeCredential,
  role: 'host', runtime: { runtimeId: 'quic-test-host', name: 'isolated', cwd: '/', status: 'idle' } }));
await once(host, 'message');
const key = randomBytes(32);
const plaintext = Buffer.from('隔离 QUIC → Relay → Host encrypted round trip');
const hdr = { k: 'data', room: 'quic-test-host', from: 'quic-test-device', to: 'quic-test-host', n: 1, ch: 'ctl' };
const aad = Buffer.from(`k=${hdr.k}\nroom=${hdr.room}\nfrom=${hdr.from}\nto=${hdr.to}\nch=${hdr.ch}\nn=${hdr.n}`);
const nonce = Buffer.alloc(12); nonce.writeUInt32BE(1); nonce.writeBigUInt64BE(1n, 4);
const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
const bytes = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
const frame = { type: 'v2.frame', protocolVersion: PROTOCOL_VERSION, envelope: { v: 2, hdr, ct: bytes.toString('base64url') } };
host.on('message', raw => {
  const value = JSON.parse(raw.toString());
  if (value.type !== 'v2.frame') return;
  const ct = Buffer.from(value.envelope.ct, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad); decipher.setAuthTag(ct.subarray(-16));
  if (!Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]).equals(plaintext)) throw Error('payload changed');
  const envelope = { ...value.envelope, hdr: { ...hdr, from: hdr.to, to: hdr.from } };
  // Relay treats the ciphertext as opaque; the Host-side decrypt above verifies its preservation.
  host.send(JSON.stringify({ type: 'v2.frame', protocolVersion: PROTOCOL_VERSION, envelope }));
});
console.log(JSON.stringify({ upstream: `${relay.url}/v1/device`, credential, version: PROTOCOL_VERSION, frame }));
const stop = async () => { host.terminate(); await relay.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
