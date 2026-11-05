# Isolated Apple review Host

This service uses the released Orbis Host, real Pi runtime and a normal direct
DeepSeek API connection. A fixed review QR supports repeated scans, replacing the
previous paired review device each time. This adapter is
installed only in the disposable review service. Production pairing is unchanged.

The review service has its own container, Linux home, Host identity, paired-device
store, Relay state, Pi sessions and sample Git workspace. No personal directories,
production Relay state or Docker socket are mounted. The DeepSeek key belongs to
the separate review API account. There is no custom model gateway, request quota,
device quota or additional spending system; provider billing uses that account's
balance normally. Only the latest successful review pairing remains active.

## Provision and deploy

Provision these private files on the existing server, outside the repository:

- `/opt/orbis-review/private/host.json`, UID 1000, mode 600, with independent random
  `runtimeCredential`, `adminToken` and `publicRelayUrl` set to
  `wss://orbising.com/review-relay`.
- `/opt/orbis-review/private/deepseek.key`, UID 1000, mode 600.

Dispatch **Review Host deploy** on `main`. It builds against the published
`fd7a96335476` Relay image already on the server, runs the portal/E2E tests, deploys
only `orbis-review-host`, and adds a separate Nginx location to both existing TLS
listeners. Production `orbis-relay` is not restarted. Application deployments use
GitHub Actions. Persistent review data is in `/opt/orbis-review/data`.

The access link is `/beta-review/<random-review-code>/`; it requires no login.
Its `qr.png` and `pairing.json` paths are static and persist across service restarts.
Share this link and QR only with Apple review. It is a capability for this demo.
The root path does not expose the code. Public review Relay routes expose only
phone pairing and the device WebSocket, not runtime/admin interfaces. Each scan
redeems a fresh normal Relay credential internally, with a fresh device key pair
and normal encrypted session handshake. The app's manual input accepts the JSON.

## Verify and retire

[根部测试约束](../../AGENTS.md#测试)；[probe.mjs](probe.mjs)；[cleanup.mjs](cleanup.mjs)。
