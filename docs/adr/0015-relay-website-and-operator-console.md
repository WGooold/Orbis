# Relay website and operator console

Status: accepted - requested on 2026-09-22.

The Relay serves the Orbis product website and an operator console from its existing HTTP listener. Production publishes them below the existing `/relay/` reverse-proxy prefix, so every browser URL and API call is relative to the served document. Static files use an explicit allowlist and a restrictive Content Security Policy. The public site reports live registration availability and only advertises download artifacts that have both an allowed filename and a valid SHA-256 sidecar.

The operator console is a Relay administration surface. It reports Relay health, registered and currently visible Hosts, device credentials, connection counts, and bounded audit events. It can disable a Host on Relay transport or revoke a device's Relay credential. These operations close matching Relay WebSockets and persist their result. They do not remove Host-side pairing trust or control LAN and P2P paths, and the Relay still cannot decrypt conversation or file payloads.

`PI_REMOTE_ADMIN_TOKEN` remains the long-lived server secret and is never placed in browser storage. A successful same-origin login exchanges it for a random, HttpOnly, SameSite Strict cookie and a CSRF token; sessions expire after eight hours. Login attempts are rate limited, mutations require the session, matching origin, and CSRF token, and the operator state is stored separately from device credentials. The existing bearer-token CLI administration API remains available as an independent operator path.

This does not introduce the browser management server excluded by ADR-0014. That exclusion concerns a local server in the Windows Host. The console is hosted by the public Relay and manages only information and authority already owned by that Relay.

Windows downloads remain release artifacts rather than source-tree files. The authorized Relay deployment workflow may select a successful `main` run of the Windows Host build, verify its checksums, and mount the resulting release directory read-only. Source deployment, download publication, candidate health checks, rollback, and the deployed-commit marker stay in the same workflow.
