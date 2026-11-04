# Isolated Apple review Host

This service uses the released Orbis Host, real Pi runtime and a normal direct
DeepSeek API connection. It adds a password-protected page for generating standard
120-second, single-use QR codes. Production pairing behavior is unchanged.

The review service has its own container, Linux home, Host identity, paired-device
store, Relay state, Pi sessions and sample Git workspace. No personal directories,
production Relay state or Docker socket are mounted. The DeepSeek key belongs to
the separate review API account. There is no custom model gateway, request quota,
device quota or additional spending system; provider billing uses that account's
balance normally.

## Provision and deploy

Provision these private files on the existing server, outside the repository:

- `/opt/orbis-review/private/host.json`, UID 1000, mode 600, with independent random
  `runtimeCredential`, `adminToken` and `publicRelayUrl` set to
  `wss://orbising.com/review-relay`.
- `/opt/orbis-review/private/deepseek.key`, UID 1000, mode 600.
- `/etc/nginx/orbis-review.htpasswd`, root:www-data, mode 640. These credentials
  are review-page credentials, never the model API key.

Dispatch **Review Host deploy** on `main`. It builds against the published
`fd7a96335476` Relay image already on the server, runs the portal/E2E tests, deploys
only `orbis-review-host`, and adds a separate Nginx location to both existing TLS
listeners. Production `orbis-relay` is not restarted. Application deployments use
GitHub Actions. Persistent review data is in `/opt/orbis-review/data`.

The protected page is `/beta-review/`. Public review Relay routes expose only the
standard phone pairing-code redemption and device WebSocket, not runtime/admin
interfaces. The app's manual pairing input accepts the JSON shown below the QR.

## Verify and retire

Run `docker exec orbis-review-host node /app/scripts/review-demo/probe.mjs --live`
once for the real model test. This consumes a normal small API request and creates
a paired test device and a real Pi conversation in the demonstration environment.
Do not claim real iOS UI testing from this protocol probe alone.

After review, remove the Nginx review includes, validate/reload Nginx, then stop and
remove `orbis-review-host` and revoke its dedicated API key. Preserve or deliberately
delete its private state separately. Never delete production Relay files.
