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

## 2026-11-03: source-faithful interaction revision (r41, verification in progress)

Following the user's review, feature explanations and side captions are removed. Each feature has its name, the usable UI, and Play / Reset. The current film source is `5672fd8`: S2 pairing, S3 Agent ring and S4 features now retain their original markup, geometry, timing and camera sequences. The 8500ms reconstructed demos and uniform ring stepping are superseded. The original continuous spin can be played; dragging and selecting remain available in a stable interactive view.

`film-markup.js`, `film-source.css` and `film-timeline.js` contain the transplanted source; `film.js` adds local interaction. Manual mode keeps the full phone visible. File downloads contain only chosen files, Back preserves its origin, selection closes only chosen sessions, all five new-session Agent choices retain identity, and quota query / both flip directions work. The third file now contains a reviewable example diff. The pairing QR is demonstration artwork; the earlier public-URL description no longer applies. No Host commands or real pairing are performed.

Inline styles and the data-URL mask are externalized, and GSAP 3.15.0 is served locally with its copyright/license notice. CSP and publication boundaries stay unchanged. R60 covers original-source frame comparisons, intermediate motion frames, interaction, 320–1920px layouts, keyboard/focus and reduced motion. Browser evidence does not complete shared-pool, native or real-device acceptance.

The manual swipe now uses the same 200ms phone shake as film playback when it first crosses the existing 150px close threshold. Each gesture produces at most one pulse; cancellation and action handoff restore the phone position. Trusted user input also attempts an optional 12ms device vibration. Missing or denied vibration does not affect closing, playback never requests hardware feedback, and reduced motion skips both. R60 covers these paths; physical haptic feel still requires a supported device.
