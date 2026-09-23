# Orbis deployment

Canonical repository: https://github.com/WGooold/Orbis. Public site: https://orbising.com. Console: https://orbising.com/admin/. Client Relay: `wss://orbising.com/relay`.

## Server preparation

Use a Linux server with Docker, Nginx, Certbot and coturn. Allow TCP 80/443 and UDP 3478, plus your restricted SSH access. The Relay container binds only `127.0.0.1:8787`.

Create `/opt/orbis/shared/data` owned by UID/GID 1000 with mode 700. Copy `deploy/relay.env.example` to `/opt/orbis/shared/relay.env`, replace its administrator placeholder with a strong random secret, and make the file mode 600. Keep credentials outside the repository. The console password is this `PI_REMOTE_ADMIN_TOKEN`; there is no default password.

Install `deploy/nginx-proxy.conf` as `/etc/nginx/snippets/orbis-proxy.conf`, adapt `deploy/nginx-orbis.conf` to your domain, and obtain a valid TLS certificate with Certbot. Keep the ACME webroot `/var/www/orbis-acme` and Certbot's renewal timer enabled. Validate with `nginx -t` before reloading.

If Cloudflare proxies HTTPS, configure Nginx's trusted Cloudflare address ranges and `real_ip_header CF-Connecting-IP` before enabling `ORBIS_TRUST_PROXY=1`. Never trust arbitrary forwarded client addresses from the public internet. Source ranges: https://www.cloudflare.com/ips/.

Install `deploy/turnserver.conf` as `/etc/turnserver.conf` and enable/restart coturn. It is **STUN only**, with no anonymous TURN relay. The official `orbising.com` clients use the UDP origin `74.81.55.191:3478` because the web hostname is proxied. Self-hosted clients default to their Relay hostname; that hostname must resolve directly to a STUN server for P2P. CLI Host configurations may override `stunServers`. Verify from outside the server using `node scripts/stun-probe.mjs YOUR_STUN_HOST`. Failed P2P still falls back to Relay.

## GitHub Actions

Create a `production` environment and configure its secrets:

| Secret | Value |
| --- | --- |
| `PI_REMOTE_SSH_KEY` | Dedicated deployment private key |
| `PI_REMOTE_SSH_KNOWN_HOSTS` | SSH host key verified through a trusted connection |
| `PI_REMOTE_DEPLOY_TARGET` | `root@your-server` or a deployment account with required permissions |
| `PI_REMOTE_SSH_PORT` | SSH port, usually `22` |
| `PI_REMOTE_DEPLOY_DIR` | `/opt/orbis` |
| `PI_REMOTE_HEALTH_URL` | `https://your-domain/relay/healthz` |

Push relevant changes to `main`. The check job runs on Windows; the deploy job archives `git archive HEAD`, uploads via pinned SSH, builds on the server and checks a candidate before switching traffic. Application deployments have no local shortcut.

Confirm the successful Actions run, public health `commit`, and `/opt/orbis/shared/deployed-commit` match. A failed rollout restores the previous container. State schema downgrades may require a matching state backup; container rollback cannot undo incompatible data migrations.

## Downloads

Run **Windows Host build** on `main`. After it succeeds, dispatch **Relay deploy** with that run's `windows_build_run_id`. It checks artifact hashes and publishes the installer, portable ZIP and checksums from a read-only mount. The version in the client, packaging scripts, allowlist and release workflow must agree.

Build Android with the Windows wrapper, publish the verified APK as `/var/www/orbis-downloads/orbis.apk` and its checksum as `orbis.apk.sha256`. Preserve the signing identity for upgrades. Never publish signing keys. Binary releases belong in GitHub Releases or the download directory, not source history.

## Registration and persistent state

QQ email verification defaults to required. In the console's Service page, the operator may disable it to allow direct Host-bound activation. Do not change this setting as a side effect of deployment. SMTP configuration stays in `shared/relay.env`; see the Windows Host README. If verification is required and SMTP is absent, existing credentials continue working but new registrations are unavailable.

Back up `shared/relay.env`, all `shared/data/` files, and download checksums privately. The Relay device store, registration store and administrator policy/audit store must migrate together. Host pairing keys stay on each computer/phone, never in the server repository. Stop writes briefly for the final state copy when moving servers, then verify hashes and resume traffic.

For existing clients with the former Relay URL, keep that hostname as a reverse proxy to the new Relay until clients have migrated. Do not run two independently writable copies of Relay state after cutover.
