# Windows Host client and QQ mailbox registration

Status: accepted — requested on 2026-09-22.

The Relay operator controls whether new Hosts must verify a QQ mailbox. The persisted policy defaults to required; changing it requires the existing same-origin administrator session and CSRF token, and is audited. Public registration status reports the policy and SMTP availability.

The Windows client uses C++20, Qt 6.8 and QML. It owns its tray, settings, local activation storage and the lifecycle of a private Host child process. It does not reimplement the TypeScript Host's encryption, transport or agent semantics. Production runtime modules remain generated `dist` files; no source-first imports or browser management server are introduced.

When verification is required, an opaque, short-lived challenge and an emailed, single-use code bind an `@qq.com` mailbox to the specific Host ID before credential issuance. When optional, a new Host can activate with its Host ID alone. Direct activation issues a random credential, is rate limited by source, and cannot replace an existing identity. The server stores credential hashes. Windows stores the issued credential using user-scoped DPAPI. The client never receives the Relay administrator token or SMTP credentials.

A verified Host credential authenticates exactly one Host ID and can issue pairing codes scoped to that Host. Device transport credentials inherit that scope. Relay rejects cross-Host routing and limits Host online/offline notices to relevant devices. Relay still receives only opaque session ciphertext; registration adds mailbox and credential records, not agent or conversation semantics.

SMTP is a server-side dependency: required verification without SMTP makes new registration unavailable; optional verification permits direct activation. Existing credentials remain valid when the policy changes. Production has no development-code endpoint. Code expiry, retry limits and request throttling protect mailbox verification, separately from paired runtime command authority.

The client reads the selected Relay's registration policy; an older Relay without that policy retains the QQ flow. Administrator-managed CLI provisioning remains a separate path. Registration state version 2 records whether an email was verified and reads version 1; after direct registration, rollback requires a Relay build that understands the new state. Protocol rollout follows [ADR-0064](0064-protocol-compatibility.md).

The UI follows the existing Orbis neumorphic surface tokens. A native QQuickPaintedItem provides soft outer shadows and genuinely clipped inner shadows with software rendering, including Windows Remote Desktop and non-integer display scaling. Focus, errors and state labels retain explicit colors and text.

The application is packaged with Qt shared libraries, Windows Node/npm, Pi integration and the installed runtime dependency closure. It remains operable after relocation without repository checkout or developer PATH. Reproducible scripts perform compilation, native tests, dependency collection, a packaged smoke test, ZIP generation and optional per-user Inno Setup packaging. Public source publication, signing credentials and live SMTP provisioning are separate release operations.
