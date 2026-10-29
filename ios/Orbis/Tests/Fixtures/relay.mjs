// Isolated localhost interoperability fixture. Uses only Node built-ins and
// public test keys; it neither imports production Swift nor opens user data.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const version = 15;
const relayBasePath = process.argv[3] ?? '';
const relayPath = relayBasePath.replace(/\/+$/, '');
const enableLan = process.argv[4] === 'lan';
const enableP2P = process.argv[4] === 'p2p';
const rtc = enableP2P ? await import(process.argv[5]) : null;
let p2pPeer;
const peers = new Set();
const hostId = process.env.ORBIS_FIXTURE_HOST_ID ?? 'ios-fixture-host';
const deviceId = process.env.ORBIS_FIXTURE_DEVICE_ID ?? 'ios-fixture-device';
const host = crypto.generateKeyPairSync('x25519');
const rawPublic = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const publicKey = text => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(text, 'base64url')]), type: 'spki', format: 'der' });
const derive = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));
const mac = (key, ...parts) => crypto.createHmac('sha256', key).update(parts.join('')).digest('base64url');
const psk = Buffer.alloc(32, 0x11);
let root;
let generation = 0;
let connections = 0;
let pairingRequests = 0;

function wire(text, opcode = 1) {
  const data = Buffer.isBuffer(text) ? text : Buffer.from(text);
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([header, data]);
}
function aad(h) { return Buffer.from(`k=${h.k}\nroom=${h.room}\nfrom=${h.from}\nto=${h.to}\nch=${h.ch}\nn=${h.n}`); }
function nonce(h) { const b = Buffer.alloc(12); b.writeUInt32BE({ ctl: 1, msg: 2, bulk: 3 }[h.ch]); b.writeBigUInt64BE(BigInt(h.n), 4); return b; }
function decrypt(e, key) {
  const bytes = Buffer.from(e.ct, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce(e.hdr));
  decipher.setAAD(aad(e.hdr)); decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === `${relayPath}/v1/pairings`) {
    pairingRequests++;
    if (process.env.ORBIS_FIXTURE_PAIR_REQUEST_FILE) fs.writeFileSync(process.env.ORBIS_FIXTURE_PAIR_REQUEST_FILE, String(pairingRequests));
    req.resume();
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deviceId, credential: 'public-fixture-credential' }));
    };
    const delay = Number(process.env.ORBIS_FIXTURE_PAIR_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(reply, Math.min(delay, 1000)); else reply();
  } else res.writeHead(404).end();
});
server.on('upgrade', (req, socket) => {
  const isLan = enableLan && req.url === '/v1/lan';
  if (!isLan && req.url !== `${relayPath}/v1/device`) { socket.destroy(); return; }
  connections++;
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('error', () => {});
  const send = value => { if (!socket.destroyed) socket.write(wire(JSON.stringify(value))); };
  const plain = (kind, body) => send({ type: 'v2.frame', protocolVersion: version, envelope: { v: 2,
    hdr: { k: kind, room: hostId, from: hostId, to: deviceId, n: 0 }, ct: Buffer.from(JSON.stringify(body)).toString('base64url') } });
  let authenticated = isLan;
  const peer = { isLan, socket, json: null };
  peers.add(peer);
  socket.on('close', () => peers.delete(peer));
  let keys;
  let ePubH;
  let ePubD;
  let sequences = {};
  const partials = new Map();
  const encrypted = (kind, payload, channel = 'ctl') => {
    const h = { k: kind, room: hostId, from: hostId, to: deviceId, n: (sequences[channel] ?? 0) + 1, ch: channel };
    sequences[channel] = h.n;
    const cipher = crypto.createCipheriv('aes-256-gcm', keys.h2d, nonce(h));
    cipher.setAAD(aad(h));
    const ct = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    const mid = crypto.randomUUID();
    for (let offset = 0, idx = 0; offset < ct.length; offset += 8192, idx++) {
      const fragmented = ct.length > 8192;
      const hdr = fragmented ? { ...h, k: 'piece', ik: kind, mid, idx, last: offset + 8192 >= ct.length } : h;
      send({ type: 'v2.frame', protocolVersion: version, envelope: { v: 2, hdr, ct: ct.slice(offset, offset + 8192) } });
    }
  };
  const json = (value, channel = 'ctl') => encrypted('data', Buffer.from(JSON.stringify(value)), channel);
  peer.json = json;
  function receive(value) {
    if (value.type === 'device.authenticate') {
      if (value.credential !== 'public-fixture-credential' || value.protocolVersion !== version) throw Error('invalid authentication');
      authenticated = true;
      send({ type: 'device.ready', protocolVersion: version, deviceId, runtimes: [] });
      return;
    }
    if (!authenticated || value.type !== 'v2.frame') throw Error('authentication must precede frames');
    let e = value.envelope;
    if (e.hdr.k === 'piece') {
      const h = e.hdr;
      const parts = partials.get(h.mid) ?? [];
      parts[h.idx] = e.ct;
      partials.set(h.mid, parts);
      if (!h.last) return;
      if (parts.filter(Boolean).length !== h.idx + 1) throw Error('missing client piece');
      e = { v: 2, hdr: { k: h.ik, room: h.room, from: h.from, to: h.to, ch: h.ch, n: h.n }, ct: parts.join('') };
      partials.delete(h.mid);
    }
    const h = e.hdr;
    if (h.from !== deviceId || h.to !== hostId || h.room !== hostId) throw Error('routing mismatch');
    if (h.k === 'pair') {
      const body = JSON.parse(Buffer.from(e.ct, 'base64url'));
      const peer = publicKey(body.devicePub);
      root = derive(crypto.diffieHellman({ privateKey: host.privateKey, publicKey: peer }), Buffer.from('pi-remote/v2'), `root|${rawPublic(host.publicKey).toString('base64url')}${body.devicePub}`);
      const confirm = derive(psk, root, `pair-confirm|${rawPublic(host.publicKey).toString('base64url')}${body.devicePub}`);
      if (body.macD !== mac(confirm, 'device|', body.nonceD)) throw Error('invalid pair MAC');
      const nonceH = Buffer.alloc(32, 0x33).toString('base64url');
      plain('pair', { type: 'pair-accept', hostId, nonceH, macH: mac(confirm, 'host|', body.nonceD, nonceH) });
    } else if (h.k === 'hs') {
      const body = JSON.parse(Buffer.from(e.ct, 'base64url'));
      if (body.type === 'hs1') {
        const ephemeral = crypto.generateKeyPairSync('x25519');
        ePubH = rawPublic(ephemeral.publicKey).toString('base64url'); ePubD = body.ePubD;
        const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKey(ePubD) });
        keys = { h2d: derive(shared, root, `h2d|${ePubH}${ePubD}`), d2h: derive(shared, root, `d2h|${ePubH}${ePubD}`) };
        sequences = {}; generation++;
        plain('hs', { type: 'hs2', ePubH, macH: mac(keys.h2d, 'hs-h|', ePubH, ePubD) });
      } else if (body.type === 'hs3') {
        if (body.macD !== mac(keys.d2h, 'hs-d|', ePubH, ePubD)) throw Error('invalid HS3');
        peer.ready = true;
        if (isLan) json({ type: 'device.path', protocolVersion: version, path: 'lan', rttMs: 1 });
        json({ type: 'device.ready', protocolVersion: version, deviceId, runtimes: [], fixtureGeneration: generation, fixtureConnections: connections });
        json({ type: 'fixture.large', text: '分片兼容性'.repeat(4000) }, 'msg');
        encrypted('ping', Buffer.from([0x48, 0, 1, 2, 3, 4, 5, 6, 7]));
      }
    } else if (h.k === 'ping') {
      if (!decrypt(e, keys.d2h).equals(Buffer.from([0x48, 0, 1, 2, 3, 4, 5, 6, 7]))) throw Error('invalid ping echo');
      json({ type: 'fixture.ping.echoed' });
    } else if (h.k === 'data') {
      const body = JSON.parse(decrypt(e, keys.d2h));
      if (body.type === 'fixture.echo') json({ type: 'fixture.echoed', text: body.text, path: isLan ? 'lan' : 'relay' }, 'msg');
      else if (body.type === 'p2p.request' && enableP2P) { p2pPeer?.close(); p2pPeer = createP2PHost(json); }
      else if (body.type === 'p2p.answer' && enableP2P) { p2pPeer?.setRemoteDescription(body.sdp, 'answer'); }
      else if (body.type === 'host.lan.request' && enableLan) {
        json({ type: 'host.lan', protocolVersion: version, endpoints: [{ host: '127.0.0.1', port: server.address().port }] });
      } else if (body.type === 'fixture.close-relay') {
        for (const candidate of peers) if (!candidate.isLan && candidate.ready) candidate.socket.end(wire(Buffer.from([3, 232]), 8));
        json({ type: 'fixture.relay.closed' });
      } else if (body.type === 'fixture.close-lan') {
        for (const candidate of peers) if (!candidate.isLan && candidate.ready) candidate.json({ type: 'device.path', protocolVersion: version, path: 'relay', rttMs: 1 });
        socket.end(wire(Buffer.from([3, 232]), 8));
      }
      else if (body.type === 'fixture.restart') {
        send({ type: 'host.offline', hostId });
        setTimeout(() => send({ type: 'host.online', hostId }), 20);
      } else if (body.type === 'fixture.close') socket.end(wire(Buffer.from([3, 232]), 8));
    }
  }
  let buffer = Buffer.alloc(0);
  let fragments = [];
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 2) {
        const op = buffer[0] & 15, final = Boolean(buffer[0] & 128), masked = Boolean(buffer[1] & 128);
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (!masked || length > 8 * 1024 * 1024) throw Error('invalid client frame');
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + length);
        if (op === 8) { socket.end(wire(payload, 8)); return; }
        if (op === 9) { socket.write(wire(payload, 10)); continue; }
        if (op === 10) continue;
        fragments.push(payload);
        if (final) { receive(JSON.parse(Buffer.concat(fragments).toString())); fragments = []; }
      }
    } catch (error) { process.stderr.write(`${error.stack}\n`); socket.destroy(); }
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({ v: 2, relayUrl: `ws://127.0.0.1:${server.address().port}${relayBasePath}`, code: 'FIXTURE', hostId,
    hostName: 'Isolated iOS fixture', hostPub: rawPublic(host.publicKey).toString('base64url'), psk: psk.toString('base64url'), exp: Math.floor(Date.now() / 1000) + 120 }));
});


// Optional native loopback: actual libdatachannel Host, actual Apple WebRTC
// answerer. Signaling remains in the encrypted Relay session above.
function createP2PHost(signal) {
  const pc = new rtc.PeerConnection('ios-native-p2p-fixture', { iceServers: [] });
  let dc;
  let keys;
  let ePubH;
  let ePubD;
  let sequences = {};
  const partials = new Map();
  const send = envelope => dc.sendMessage(JSON.stringify({ type: 'v2.frame', protocolVersion: version, envelope }));
  const plain = body => send({ v: 2, hdr: { k: 'hs', room: hostId, from: hostId, to: deviceId, n: 0 }, ct: Buffer.from(JSON.stringify(body)).toString('base64url') });
  const encrypted = (kind, payload, channel = 'ctl') => {
    const h = { k: kind, room: hostId, from: hostId, to: deviceId, n: (sequences[channel] ?? 0) + 1, ch: channel };
    sequences[channel] = h.n;
    const cipher = crypto.createCipheriv('aes-256-gcm', keys.h2d, nonce(h));
    cipher.setAAD(aad(h));
    const ct = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    const mid = crypto.randomUUID();
    for (let offset = 0, idx = 0; offset < ct.length; offset += 8192, idx++) {
      const hdr = ct.length > 8192 ? { ...h, k: 'piece', ik: kind, mid, idx, last: offset + 8192 >= ct.length } : h;
      send({ v: 2, hdr, ct: ct.slice(offset, offset + 8192) });
    }
  };
  const json = (value, channel = 'ctl') => encrypted('data', Buffer.from(JSON.stringify(value)), channel);
  pc.onGatheringStateChange(state => {
    if (state === 'complete') signal({ type: 'p2p.offer', protocolVersion: version, sdp: pc.localDescription().sdp });
  });
  dc = pc.createDataChannel('orbis');
  dc.onError(error => process.stderr.write(`P2P fixture: ${error}\n`));
  dc.onClosed(() => {
    for (const peer of peers) if (!peer.isLan && peer.ready && !peer.socket.destroyed) {
      peer.json({ type: 'device.path', protocolVersion: version, path: 'relay', rttMs: 1 });
      peer.json({ type: 'fixture.p2p.closed' });
    }
  });
  dc.onMessage(text => {
    try {
      let e = JSON.parse(text).envelope;
      if (e.hdr.k === 'piece') {
        const h = e.hdr, partial = partials.get(h.mid) ?? { parts: [], total: null };
        partial.parts[h.idx] = e.ct;
        if (h.last) partial.total = h.idx + 1;
        partials.set(h.mid, partial);
        if (partial.total == null || partial.parts.filter(Boolean).length !== partial.total) return;
        e = { v: 2, hdr: { k: h.ik, room: h.room, from: h.from, to: h.to, ch: h.ch, n: h.n }, ct: partial.parts.join('') };
        partials.delete(h.mid);
      }
      const h = e.hdr;
      if (h.room !== hostId || h.from !== deviceId || h.to !== hostId) throw Error('P2P routing mismatch');
      if (h.k === 'hs') {
        const body = JSON.parse(Buffer.from(e.ct, 'base64url'));
        if (body.type === 'hs1') {
          const ephemeral = crypto.generateKeyPairSync('x25519');
          ePubH = rawPublic(ephemeral.publicKey).toString('base64url'); ePubD = body.ePubD;
          const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKey(ePubD) });
          keys = { h2d: derive(shared, root, `h2d|${ePubH}${ePubD}`), d2h: derive(shared, root, `d2h|${ePubH}${ePubD}`) };
          plain({ type: 'hs2', ePubH, macH: mac(keys.h2d, 'hs-h|', ePubH, ePubD) });
        } else if (body.type === 'hs3') {
          if (body.macD !== mac(keys.d2h, 'hs-d|', ePubH, ePubD)) throw Error('P2P HS3 mismatch');
          json({ type: 'device.path', protocolVersion: version, path: 'p2p', rttMs: 1 });
          json({ type: 'fixture.p2p.ready' });
          json({ type: 'fixture.p2p.large', text: 'Native WebRTC'.repeat(4000) }, 'msg');
        }
      } else if (h.k === 'data') {
        const body = JSON.parse(decrypt(e, keys.d2h));
        if (body.type === 'fixture.echo') json({ type: 'fixture.echoed', text: body.text, path: 'p2p' }, 'msg');
        else if (body.type === 'fixture.close-relay') {
          for (const peer of peers) if (!peer.isLan && peer.ready) peer.socket.end(wire(Buffer.from([3, 232]), 8));
          json({ type: 'fixture.relay.closed' });
        } else if (body.type === 'fixture.close-p2p') {
          dc.close(); pc.close();
        }
      } else if (h.k === 'bin') {
        const bytes = decrypt(e, keys.d2h);
        json({ type: 'fixture.p2p.binary', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      }
    } catch (error) { process.stderr.write(`${error.stack}\n`); dc.close(); pc.close(); }
  });
  return pc;
}
