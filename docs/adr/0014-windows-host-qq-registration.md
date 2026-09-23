# Windows Host client and QQ mailbox registration

Status: accepted — requested on 2026-09-22.

Update: ADR-0016 supersedes the requirement that every new Windows Host verify QQ email. The default remains required, but the Relay operator may turn it off for new activations.

The Windows client uses C++20, Qt 6.8 and QML. It owns its tray, settings, local activation storage and the lifecycle of a private Host child process. It does not reimplement the TypeScript Host's encryption, transport or agent semantics. Production runtime modules remain generated `dist` files; no source-first imports or browser management server are introduced.

The desktop Host requires verification of an `@qq.com` mailbox before it obtains a runtime credential. An opaque, short-lived challenge and an emailed, single-use code bind verification to both the mailbox and the specific Host ID. The server stores credential hashes. Windows stores the issued credential using user-scoped DPAPI. The client never receives the Relay administrator token or SMTP credentials.

A verified Host credential authenticates exactly one Host ID and can issue pairing codes scoped to that Host. Device transport credentials inherit that scope. Relay rejects cross-Host routing and limits Host online/offline notices to relevant devices. Relay still receives only opaque session ciphertext; registration adds mailbox and credential records, not agent or conversation semantics.

SMTP is a server-side dependency. If absent, registration is explicitly unavailable; existing registered credentials remain valid. Tests inject a mail sender but production has no development-code or bypass endpoint. Code expiry, retry limits and request throttling protect the mailbox verification boundary; these are distinct from the paired runtime operational controls described in ADR-0002.

Existing administrator-managed CLI provisioning remains a separate operator path; the Qt client's normal path always requires QQ verification. The existing Envelope protocol version gate remains unchanged. ADR-0008's single-user premise no longer describes the proposed public registration service: future incompatible protocol changes require an explicit client rollout decision before release, rather than assuming all installations belong to the author.

The UI follows the existing Orbis neumorphic surface tokens. A native QQuickPaintedItem provides soft outer shadows and genuinely clipped inner shadows with software rendering, including Windows Remote Desktop and non-integer display scaling. Focus, errors and state labels retain explicit colors and text.

The application is packaged with Qt shared libraries, Windows Node/npm, Pi integration and the installed runtime dependency closure. It remains operable after relocation without repository checkout or developer PATH. Reproducible scripts perform compilation, native tests, dependency collection, a packaged smoke test, ZIP generation and optional per-user Inno Setup packaging. Public source publication, signing credentials and live SMTP provisioning are separate release operations.
