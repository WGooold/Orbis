# Orbis deployment

Canonical repository: https://github.com/WGooold/Orbis. Public site: https://orbising.com. Console: https://orbising.com/admin/. Client Relay: `wss://orbising.com/relay`.

## Server preparation

Use a Linux server with Docker, Nginx and Certbot. Allow TCP 80/443, plus your restricted SSH access. The Relay container binds only `127.0.0.1:8787`.

Create `/opt/orbis/shared/data` owned by UID/GID 1000 with mode 700. Copy `deploy/relay.env.example` to `/opt/orbis/shared/relay.env`, replace its administrator placeholder with a strong random secret, and make the file mode 600. Keep credentials outside the repository. The console password is this `ORBIS_ADMIN_TOKEN`; there is no default password.

Install `deploy/nginx-proxy.conf` as `/etc/nginx/snippets/orbis-proxy.conf`, adapt `deploy/nginx-orbis.conf` to your domain, and obtain a valid TLS certificate with Certbot. Keep the ACME webroot `/var/www/orbis-acme` and Certbot's renewal timer enabled. Validate with `nginx -t` before reloading.

If Cloudflare proxies HTTPS, configure Nginx's trusted Cloudflare address ranges and `real_ip_header CF-Connecting-IP` before enabling `ORBIS_TRUST_PROXY=1`. Never trust arbitrary forwarded client addresses from the public internet. Source ranges: https://www.cloudflare.com/ips/.

Connections use LAN / Relay only, with a fixed LAN-first order (ADR-0050). The Relay requires TCP 443 through the reverse proxy; local discovery and direct connections follow the Host LAN configuration.

Protocol v16 requires matching Relay, Host, runtime / bridge and mobile builds. Prepare the artifacts before the cutover, update Relay first, and then update the endpoints. Mixed versions reject connections with an upgrade message. Preserve pairing keys and persistent state; roll back matching versions together if needed. Production cutover and service retirement require a separate deployment record.

## GitHub Actions

Create a `production` environment and configure its secrets:

| Secret | Value |
| --- | --- |
| `ORBIS_SSH_KEY` | Dedicated deployment private key |
| `ORBIS_SSH_KNOWN_HOSTS` | SSH host key verified through a trusted connection |
| `ORBIS_DEPLOY_TARGET` | `root@your-server` or a deployment account with required permissions |
| `ORBIS_SSH_PORT` | SSH port, usually `22` |
| `ORBIS_DEPLOY_DIR` | `/opt/orbis` |
| `ORBIS_HEALTH_URL` | `https://your-domain/relay/healthz` |

The workflow also accepts the former `PI_REMOTE_*` names for these secrets. Relay runtime configuration prefers `ORBIS_*` and accepts existing `PI_REMOTE_*` values, so a naming upgrade does not require rewriting deployed credentials. The deployment script uses `orbis-relay` for new containers and can replace an existing `pi-remote-relay` container while preserving its original name during rollback.

Push relevant changes to `main`. The check job runs on Windows; the deploy job archives `git archive HEAD`, uploads via pinned SSH, builds on the server and checks a candidate before switching traffic. Application deployments have no local shortcut.

Confirm the successful Actions run, public health `commit`, and `/opt/orbis/shared/deployed-commit` match. A failed rollout restores the previous container. State schema downgrades may require a matching state backup; container rollback cannot undo incompatible data migrations.

## Downloads

Release order for a tagged build on `main`:

1. Dispatch **Windows Host build**, **macOS Host build** and **Android build**, all on `main` from the release commit. Each run uploads its own artifacts (`OrbisHost-windows-x64`, `OrbisHost-macos-arm64`, `OrbisHost-macos-x64`, `Orbis-android`), and each artifact carries the `.sha256` files next to the binaries.
2. Create a draft release for the tag.
3. Dispatch **Publish client release** with `release_tag`, `windows_build_run_id`, `macos_build_run_id` and `android_build_run_id`. It refuses runs whose `head_sha` is not the tagged commit, re-checks every checksum, uploads the installer, portable ZIP, both dmgs and `orbis.apk` to the release, then undrafts it as latest.
4. Dispatch **Relay deploy** with the same `windows_build_run_id` and `macos_build_run_id` plus `android_release_tag` and the `android_apk_sha256` printed by the Android build. It re-verifies the runs, archives the four host files, and publishes them from a read-only mount; the server re-verifies every archived checksum before switching traffic.

Without those inputs a push-triggered **Relay deploy** still moves the Relay but publishes no downloads. The version in the client, packaging scripts, allowlist (`packages/relay/src/web.ts`) and release workflow must agree: the deploy fails if a file named after the version in `packages/windows-host/CMakeLists.txt` is missing from the artifacts.

**Android build** signs the APK with the release key from the `ORBIS_RELEASE_*` repository secrets and fails unless the signing certificate matches the pinned SHA-256 in the workflow; a different certificate would stop installed clients from upgrading. Local release builds read the same `ORBIS_RELEASE_*` properties from `~/.gradle/gradle.properties` and refuse to build without them. Never publish signing keys.

**iOS TestFlight** archives the app with automatic signing through an App Store Connect API key (`APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_P8_BASE64`) and uploads it to TestFlight; the build number is the workflow run number. It is independent of the GitHub release. Binary releases belong in GitHub Releases or the download directory, not source history.

To publish an existing local Android build, first verify its build-manifest SHA-256 and compare its signing certificate with the current website APK. Upload `orbis.apk` and `orbis.apk.sha256` to a GitHub Release, then dispatch **Relay deploy** with `android_release_tag` and the exact `android_apk_sha256`. The production job verifies the release asset, publishes both files, and downloads them again through the public website to verify their hashes. It preserves the previous APK and checksum outside the public directory and restores them if publication fails. The Android version may remain unchanged for a preview refresh; the pinned hash identifies the exact build.

## Registration and persistent state

QQ email verification defaults to required. In the console's Service page, the operator may disable it to allow direct Host-bound activation. Do not change this setting as a side effect of deployment. SMTP configuration stays in `shared/relay.env`; see [verification email setup](mail-server.md) for provider and self-hosted sending options. If verification is required and SMTP is absent, existing credentials continue working but new registrations are unavailable.

Back up `shared/relay.env`, all `shared/data/` files, and download checksums privately. The Relay device store, registration store and administrator policy/audit store must migrate together. Host pairing keys stay on each computer/phone, never in the server repository. Stop writes briefly for the final state copy when moving servers, then verify hashes and resume traffic.

For existing clients with the former Relay URL, keep that hostname as a reverse proxy to the new Relay until clients have migrated. Do not run two independently writable copies of Relay state after cutover.
