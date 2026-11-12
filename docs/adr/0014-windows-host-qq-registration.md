# Windows Host client and QQ mailbox registration

Status: accepted (2026-09-22).

The Relay operator controls whether new Hosts must verify a QQ mailbox. The persisted policy defaults to required; changing it requires the existing same-origin administrator session and CSRF token, and is audited. Public registration status reports the policy and SMTP availability.

The Windows client uses C++20, Qt 6.8 and QML. It owns its tray, settings, local activation storage and the lifecycle of a private Host child process. The TypeScript Host owns encryption, transport and Agent semantics; production runtime modules use generated `dist` files.

When verification is required, an opaque, short-lived challenge and an emailed, single-use code bind an `@qq.com` mailbox to the specific Host ID before credential issuance. When optional, a new Host can activate with its Host ID alone. Direct activation issues a random credential, is rate limited by source, and cannot replace an existing identity. The server stores credential hashes. Windows stores the issued credential using user-scoped DPAPI. Relay administrator and SMTP credentials remain server-side.

A verified Host credential authenticates exactly one Host ID and can issue pairing codes scoped to that Host. Device transport credentials inherit that scope. Relay rejects cross-Host routing and limits Host online/offline notices to relevant devices. Relay still receives only opaque session ciphertext; registration adds mailbox and credential records, not agent or conversation semantics.

SMTP is a server-side dependency: required verification without SMTP makes new registration unavailable; optional verification permits direct activation. Existing credentials remain valid when the policy changes. Production has no development-code endpoint. Code expiry, retry limits and request throttling protect mailbox verification, separately from paired runtime command authority.

The client reads the selected Relay's registration policy; an older Relay without that policy retains the QQ flow. Administrator-managed CLI provisioning remains a separate path. Registration state version 2 records whether an email was verified and reads version 1; after direct registration, rollback requires a Relay build that understands the new state. Protocol rollout follows [ADR-0064](0064-protocol-compatibility.md).

The UI follows the existing Orbis neumorphic surface tokens. A native QQuickPaintedItem provides soft outer shadows and genuinely clipped inner shadows with software rendering, including Windows Remote Desktop and non-integer display scaling. Focus, errors and state labels retain explicit colors and text.

## 2026-11-12: recoverable Host activation (HOST-ACT-01–07)

An explicit runtime `unauthorized` during startup or reconnect returns the desktop to registration. The rejected credential is removed from native secure storage off the UI thread; recovery retains the Relay endpoint, known mailbox, Host identity, keys and phone pairings. Network failures, protocol-version errors and administrator disablement preserve activation. Reinstalled and portable clients use the existing shared per-user credential store.

An existing verified registration recovers through its original mailbox, including when new computers may activate without email. Registration conflicts return an optional recovery hint without revealing the mailbox; an older Relay's generic conflict retains the mailbox recovery entry. A direct registration whose credential is lost requires an authenticated administrator reset. The existing console confirmation, same-origin session, CSRF and audit protect that reset. The registration remains visible with `activationResetAt`, its previous credential becomes unusable, and the next activation follows the current verification policy. Reset state stays within registration format 2; older loaders accept the additional field and continue rejecting the revoked credential.

Implementation: [desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts), [HostController.cpp](../../packages/windows-host/src/HostController.cpp), [registration.ts](../../packages/relay/src/registration.ts) and [index.ts](../../packages/relay/src/index.ts). Scenarios and assertions are in [desktop-runtime.test.ts](../../packages/host/src/desktop-runtime.test.ts), [HostActivationTest.cpp](../../packages/windows-host/src/tests/HostActivationTest.cpp), [registration.test.ts](../../packages/relay/src/registration.test.ts) and [admin.test.ts](../../packages/relay/src/admin.test.ts). Actual automated results, compatibility checks and their boundaries are recorded in [.artifacts/relay-runtime-credential-20261112](../../.artifacts/relay-runtime-credential-20261112/). Source implementation and local automated verification are separate from publication and user acceptance; release, Windows installation and user verification remain pending.

The application is packaged with Qt shared libraries, Windows Node/npm, Pi integration and the installed runtime dependency closure. It remains operable after relocation without repository checkout or developer PATH. Reproducible scripts perform compilation, native tests, dependency collection, a packaged smoke test, ZIP generation and optional per-user Inno Setup packaging. Public source publication, signing credentials and live SMTP provisioning are separate release operations.
