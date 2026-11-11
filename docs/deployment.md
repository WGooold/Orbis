# Orbis deployment

Canonical repository: https://github.com/WGooold/Orbis. Public site: https://orbising.com. Console: https://orbising.com/admin/. Client Relay: `wss://orbising.com/relay`.

## Server preparation

Use a Linux server with Docker, Nginx and Certbot. Allow TCP 80/443, plus your restricted SSH access. The Relay container binds only `127.0.0.1:8787`.

Create `/opt/orbis/shared/data` owned by UID/GID 1000 with mode 700. Copy `deploy/relay.env.example` to `/opt/orbis/shared/relay.env`, replace its administrator placeholder with a strong random secret, and make the file mode 600. Keep credentials outside the repository. The console password is this `ORBIS_ADMIN_TOKEN`; there is no default password.

Install `deploy/nginx-proxy.conf` as `/etc/nginx/snippets/orbis-proxy.conf`, adapt `deploy/nginx-orbis.conf` to your domain, and obtain a valid TLS certificate with Certbot. Keep the ACME webroot `/var/www/orbis-acme` and Certbot's renewal timer enabled. Validate with `nginx -t` before reloading.

If Cloudflare proxies HTTPS, configure Nginx's trusted Cloudflare address ranges and `real_ip_header CF-Connecting-IP` before enabling `ORBIS_TRUST_PROXY=1`. Use forwarded addresses from the configured trusted proxy ranges. Source ranges: https://www.cloudflare.com/ips/.

Connections use LAN / Relay only, with a fixed LAN-first order (ADR-0050). The Relay requires TCP 443 through the reverse proxy; local discovery and direct connections follow the Host LAN configuration.

Per ADR-0064, the Relay transport accepts the released wire formats 18 and 19.
Each socket binds its version during authentication; ready messages and forwarded
outer frames use the recipient's version. The encrypted envelope is unchanged,
including its inner business version. Reject unsupported formats (including 17
and 20) and attempts to change version after authentication. This permits an
existing Host 18 to reconnect after a Relay update without reinstalling it.
It does not add protocol-18 E2E support to a strict Host/iOS 19 implementation;
Android 0.1.54 separately handles Host E2E formats 18 and 19. Preserve pairing
keys and persistent state. Production cutover requires a deployment record.

2026-11-05 decision (ADR-0064 §6): restore old-App interoperability through
Relay + Host updates, preserving installed App 18 / 19 builds. The Relay portion
is deployed in `8601e6508523`; Host 0.1.15 business-format adaptation is now merged into `main`,
including strict request parsing, per-path ready messages, response/state projection
and validated binary conversion. Internal schemas remain strict 19; supported
business formats are explicitly 18 / 19, independent of Relay routing support.
Relay waits for the first authenticated valid business request before Host ready;
LAN uses its socket version only after MAC confirmation. End-to-end encryption
and existing operation identities are retained. Local macOS arm64 validation has
passed; Windows / x64 packaging and full old-App device gates remain pending. Host 0.1.14 uses 18
and does not gain this business compatibility from a Relay-only deployment.
Acceptance uses the actual old App binaries and existing pairing, with delivery of the compatible Host recorded separately.

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

Push relevant changes to `main`. The full check job runs on Windows; a second job runs the Host path, shell, launcher and Git-hook compatibility tests on macOS; a third job checks the review Host integration on Linux. All three must pass before deployment. Host changes also trigger this workflow because its tests are part of the deployment gate. The deploy job archives `git archive HEAD`, uploads via pinned SSH, builds on the server and checks a candidate before switching traffic. Application deployments use this workflow.

2026-11-04 CI cleanup correction: the review portal and process-tree cleanup tests
also run on Windows, macOS and Linux. The Linux integration job is an additional
required dependency of deployment; existing Host tests and assertions remain.
All these jobs use Node 22.23.2, and upload JUnit results even after a test failure
(14-day retention). The review scripts themselves trigger Relay validation, so
editing the fixture cannot miss this gate. The compiled Pi extension is prepared
before running its real-process fixture on each platform.

Review fixtures terminate only their own recorded process trees: Windows uses
the system `taskkill.exe /PID <pid> /T /F`; POSIX uses the detached process group,
with bounded graceful shutdown and forced termination. Cleanup waits for the
owned roots and POSIX process groups to exit, including children whose parent
has already stopped. Resource state is drained before awaiting cleanup; every
closer is attempted and failures are aggregated. A live process prevents removal
of its temporary directory. The regression verifies a real parent/child tree,
directory release, preservation of an unrelated process, and failure isolation.
These checks reduce recurrence; a successful local macOS run does not establish
Windows or Linux success. Confirm all required CI jobs and the deployed health
commit before reporting an update as live.

Confirm the successful Actions run, public health `commit`, and `/opt/orbis/shared/deployed-commit` match. A failed rollout restores the previous container. State schema downgrades may require a matching state backup; container rollback cannot undo incompatible data migrations.

Relay compatibility is a deployment gate on all three operating systems. The
18/18, 18/19, 19/18 and 19/19 transport matrix checks exact released ready-message
shapes, real E2E handshakes and decryption, request/receipt identity, binary bytes,
and opaque piece forwarding. Credential and sender validation, unsupported
versions and changes to the authenticated version remain negative regressions.
Linux also runs the full protocol and Relay suites. Before reporting the rollout
as live, verify that public protocol-18 and protocol-19 authentication with
deliberately invalid test credentials reaches `unauthorized`, while protocol 17
and 20 return `protocol_version_mismatch`; no user credential is needed. The
deployment script runs this probe against the isolated candidate before stopping
the previous service, then through the public WebSocket path before committing
the release. Either failure stays inside the existing rollback boundary.

## Downloads

Release order for a tagged build on `main`:

1. Dispatch **Windows Host build**, plus **macOS Host build** and **Android build** when those platforms are in scope, all on `main` from the release commit. Each run uploads its own artifacts (`OrbisHost-windows-x64`, `OrbisHost-macos-arm64`, `OrbisHost-macos-x64`, `Orbis-android`), and each artifact carries the `.sha256` files next to the binaries.
2. Create a draft release for the tag.
3. Dispatch **Publish client release** with `release_tag`, `windows_build_run_id` and, for included platforms, `macos_build_run_id` / `android_build_run_id`. It refuses runs whose `head_sha` is not the tagged commit, re-checks every checksum, uploads the installer, portable ZIP and included platform assets to the release, then undrafts it as latest. A Windows-only release omits both optional inputs and assets.
4. Dispatch **Relay deploy** with the same selected Host build run IDs, plus `android_release_tag` and the `android_apk_sha256` printed by the Android build when publishing Android. Omit both Android inputs to retain its existing website download. Omitted Host platforms retain their previous website downloads. The server stages a fresh directory and verifies both incoming and retained checksums before switching traffic; a retry never modifies the serving directory. The staging regression is `scripts/prepare-host-downloads.test.mjs`.

Without those inputs a push-triggered **Relay deploy** still moves the Relay but publishes no downloads. The version in the client, packaging scripts, allowlist (`packages/relay/src/web.ts`) and release workflow must agree: the deploy fails if a file named after the version in `packages/windows-host/CMakeLists.txt` is missing from the artifacts.

**Android build** signs the APK with the release key from the `ORBIS_RELEASE_*` repository secrets and fails unless the signing certificate matches the pinned SHA-256 in the workflow; a different certificate would stop installed clients from upgrading. Local release builds read the same `ORBIS_RELEASE_*` properties from `~/.gradle/gradle.properties` and refuse to build without them. Keep signing keys in the private signing configuration.

**iOS TestFlight** archives the app with automatic signing through an App Store Connect API key (`APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_P8_BASE64`) and uploads it to TestFlight; the build number is the workflow run number. It is independent of the GitHub release. Store binary releases in GitHub Releases or the download directory.

To publish an existing local Android build, first verify its build-manifest SHA-256 and compare its signing certificate with the current website APK. Upload `orbis.apk` and `orbis.apk.sha256` to a GitHub Release, then dispatch **Relay deploy** with `android_release_tag` and the exact `android_apk_sha256`. The production job verifies the release asset, publishes both files, and downloads them again through the public website to verify their hashes. It preserves the previous APK and checksum outside the public directory and restores them if publication fails. The Android version may remain unchanged for a preview refresh; the pinned hash identifies the exact build.

## Registration and persistent state

QQ email verification defaults to required. In the console's Service page, the operator may disable it to allow direct Host-bound activation. Preserve this operator setting during deployment. SMTP configuration stays in `shared/relay.env`; see [verification email setup](mail-server.md) for provider and self-hosted sending options. If verification is required and SMTP is absent, existing credentials continue working but new registrations are unavailable.

Back up `shared/relay.env`, all `shared/data/` files, and download checksums privately. The Relay device store, registration store and administrator policy/audit store must migrate together. Host pairing keys remain private to each computer and phone. Stop writes briefly for the final state copy when moving servers, then verify hashes and resume traffic.

For existing clients with the former Relay URL, keep that hostname as a reverse proxy to the new Relay until clients have migrated. Maintain one authoritative writable Relay state after cutover.
