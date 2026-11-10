# Relay website and operator console

LAN / Relay routing follows [ADR-0050](0050-fixed-lan-relay-routing.md).

Status: accepted (2026-09-22).

The Relay serves the Orbis product website and an operator console from its existing HTTP listener. Production publishes them below the existing `/relay/` reverse-proxy prefix, so every browser URL and API call is relative to the served document. Static files use an explicit allowlist and a restrictive Content Security Policy. The public site reports live registration availability and only advertises download artifacts that have both an allowed filename and a valid SHA-256 sidecar.

The operator console is a Relay administration surface. It reports Relay health, registered and currently visible Hosts, device credentials, connection counts, and bounded audit events. It can disable a Host on Relay transport or revoke a device's Relay credential. These operations close matching Relay WebSockets and persist their result. Host pairing owns trust across transports; conversation and file payloads use E2E.

`ORBIS_ADMIN_TOKEN` remains a server-side secret. A successful same-origin login exchanges it for a random, HttpOnly, SameSite Strict cookie and a CSRF token; sessions expire after eight hours. Login attempts are rate limited, mutations require the session, matching origin, and CSRF token, and the operator state is stored separately from device credentials. The existing bearer-token CLI administration API remains available as an independent operator path.

The public Relay hosts the console, whose authority is limited to Relay-owned state.

## 2026-11-10: iOS TestFlight invitation (SITE-IOS-01)

The public `/v1/site` publishes the iOS invitation at `https://testflight.apple.com/join/9zGP1NZX`. The existing App download card labels it “TestFlight 测试版” / “加入 iOS 测试” and explains installation and pairing. iPhone and iPad visitors initially select iOS; manual platform changes remain available. Unpublished links and API failures retain the existing unavailable state. This extends X07 / X08 / X10 using the existing download controls.

Implementation and API regression: [web.ts](../../packages/relay/src/web.ts), [site.js](../../packages/relay/src/web/site.js), [admin.test.ts](../../packages/relay/src/admin.test.ts). Local browser checks, screenshots, deployment and public verification are recorded separately in [.artifacts/website-testflight-20261110](../../.artifacts/website-testflight-20261110/verification.json). TestFlight installation and pairing remain pending user verification.

## 2026-11-08: unified public design and demonstrations

The public `cinema-site` entry uses the shared appearance tokens and components from [ADR-0070](0070-unified-design-and-interaction.md). Its local demonstrations follow the current draft-first session flow, directory tree, provider dial and settings. The cinematic marketing layout remains; the demonstrations use synthetic data. The earlier r39 / r41 visual revisions below are historical. Browser, visual comparison and release evidence are recorded separately from deployment and user acceptance in [.artifacts/design-alignment-20261108/site](../../.artifacts/design-alignment-20261108/site/).

## 2026-11-05: per-device bandwidth (X11)

The console's bandwidth page groups authenticated Relay message bytes by device ID, with upload/download totals and one-second active-window mean, P95 and peak rates. UTC daily records are retained for 30 days; seven- and thirty-day percentiles merge the sample histograms. P95 uses a bounded histogram with an upper-bound error below 4.5%. Idle seconds and the unfinished current second are excluded from rates. Totals include authentication and control messages. LAN traffic, transport headers and retransmission are outside this measurement; QUIC downlink measures the Node-to-adapter handoff rather than confirmed device reception.

The collector stores IDs and numeric aggregates separately in `ORBIS_BANDWIDTH_STATE_FILE` (default: `ORBIS_STATE_FILE` plus `.bandwidth.json`), saving every minute and on graceful shutdown. Reads use the existing administrator session. Implementation: [bandwidth.ts](../../packages/relay/src/bandwidth.ts) and [admin.js](../../packages/relay/src/web/admin.js). Scenarios RELAY-BW-01/02/03 cover sample accounting, authenticated forwarding and console rendering logic in the corresponding `bandwidth*.test.ts` files. Evidence: [.artifacts/relay-bandwidth/20261105](../../.artifacts/relay-bandwidth/20261105/). Deployment and user acceptance remain pending; browser inspection was blocked by the local browser connection.

Windows downloads remain release artifacts rather than source-tree files. The authorized Relay deployment workflow may select a successful `main` run of the Windows Host build, verify its checksums, and mount the resulting release directory read-only. Source deployment, download publication, candidate health checks, rollback, and the deployed-commit marker stay in the same workflow.

## 2026-11-03: cinematic public homepage (r39, verification in progress)

The public homepage uses the visual language and demonstrations from `../video/claude` (reference commit `0803434`).

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。

## 2026-11-03: source-faithful interaction revision (r41, verification in progress)

The public homepage presents feature names and demonstrations directly.

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。
