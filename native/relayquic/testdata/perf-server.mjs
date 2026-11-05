// Isolated public-link measurement Relay. No user credentials, state or accounts.
import process from 'node:process';
import { createInterface } from 'node:readline';
const { createRelayServer } = await import(process.env.ORBIS_PERF_RELAY_MODULE ?? '../../../packages/relay/dist/index.js');
const input = createInterface({ input: process.stdin });
const config = await new Promise((resolve, reject) => {
  input.once('line', line => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
  input.once('close', () => reject(Error('parent closed')));
});
const relay = await createRelayServer({ port: 0, host: '127.0.0.1',
  runtimeCredentials: [config.runtimeCredential],
  deviceCredentials: [{ deviceId: 'perf-device', credential: config.credential, name: 'isolated', hostId: 'perf-host' }],
  quicPort: config.port, quicHostEnabled: true });
process.stdout.write(JSON.stringify({ upstream: relay.url, nodeVersion: process.version }) + '\n');
const close = async () => { await relay.close(); process.exit(0); };
input.on('close', close); process.on('SIGTERM', close); process.on('SIGINT', close);
