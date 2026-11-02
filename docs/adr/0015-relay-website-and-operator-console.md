# Relay website and operator console

LAN / Relay routing follows [ADR-0050](0050-fixed-lan-relay-routing.md).

Status: accepted - requested on 2026-09-22.

The Relay serves the Orbis product website and an operator console from its existing HTTP listener. Production publishes them below the existing `/relay/` reverse-proxy prefix, so every browser URL and API call is relative to the served document. Static files use an explicit allowlist and a restrictive Content Security Policy. The public site reports live registration availability and only advertises download artifacts that have both an allowed filename and a valid SHA-256 sidecar.

The operator console is a Relay administration surface. It reports Relay health, registered and currently visible Hosts, device credentials, connection counts, and bounded audit events. It can disable a Host on Relay transport or revoke a device's Relay credential. These operations close matching Relay WebSockets and persist their result. They do not remove Host-side pairing trust or control LAN paths, and the Relay still cannot decrypt conversation or file payloads.

`ORBIS_ADMIN_TOKEN` remains the long-lived server secret and is never placed in browser storage. A successful same-origin login exchanges it for a random, HttpOnly, SameSite Strict cookie and a CSRF token; sessions expire after eight hours. Login attempts are rate limited, mutations require the session, matching origin, and CSRF token, and the operator state is stored separately from device credentials. The existing bearer-token CLI administration API remains available as an independent operator path.

This does not introduce the browser management server excluded by ADR-0014. That exclusion concerns a local server in the Windows Host. The console is hosted by the public Relay and manages only information and authority already owned by that Relay.

Windows downloads remain release artifacts rather than source-tree files. The authorized Relay deployment workflow may select a successful `main` run of the Windows Host build, verify its checksums, and mount the resulting release directory read-only. Source deployment, download publication, candidate health checks, rollback, and the deployed-commit marker stay in the same workflow.

## 2026-11-03: cinematic public homepage (r39, verification in progress)

The user requested replacing the previous marketing statements with the visual language and demonstrations from `../video/claude` (reference commit `0803434`). The public homepage now opens with “你想要的都在这”, an interactive 11-slot Agent ring, and “这可能是你用过最有交互感的 Agent 远控”. Seven chapters demonstrate chat, file review, downloads, session selection / closing, creating a session, quota coins and pairing. The original FAQ, long-form claims and feature slideshow are replaced. Host and App download cards retain their separate platform selectors and actual publication / registration APIs.

The ring identifies Claude Code, Codex, Pi, Codex Desktop and DeepSeek as integrated. The six other film marks are explicitly labelled “即将接入”; their cards show no fabricated working session. All phone conversations, file contents, quota readings and pairing states are labelled demonstration data and never send commands to a Host. The QR code opens the public website and says so in the demo. No availability claim is inferred from the film's ending: an absent iOS release remains unavailable until `/v1/site` supplies an installation URL.

The film's classic-light colors, original brand / Agent artwork, ring geometry, titanium phone mesh and ink / copper-coin motion are adapted to responsive web components. `cinema.css` and `cinema.js` own the public presentation; `styles.css` and `admin.js` retain the operator console's styles and behavior. Phone mesh styles are external CSS so the existing strict CSP remains unchanged. All new assets are individually allowlisted, with their source notices shipped alongside them.

The carousel supports dragging, buttons and keyboard navigation. Both stages expose pause / resume; manual interaction takes over the demo. A shared clock stops offscreen or when the document is hidden. Reduced motion starts paused, preserves controls and skips spatial movement; missing observer / JavaScript paths retain readable content and a release-page fallback. Motion classification is [ADR-0058 SC44](0058-shared-interaction-motion.md). Regression mapping is [UI regression R60](../testing/ui-regression.md); native-device acceptance is not implied by browser screenshots.
