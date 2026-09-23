# Operator-controlled QQ verification

Status: accepted - requested on 2026-09-23.

The Relay operator console controls whether new Windows Hosts must verify a QQ mailbox. The policy defaults to required and is stored with Relay administrator state. A browser change requires the existing administrator session, matching origin, and CSRF token; each change is audited. The public registration status reports both the policy and whether SMTP is configured.

When verification is required, activation still needs a single-use emailed code. Without SMTP, new registrations remain unavailable. When verification is optional, a new Host can activate with only its Host ID. The Relay issues a random credential bound to that ID, stores only its hash, and rate limits direct issuance by source. The first registration claims the Host ID; direct registration cannot replace an existing identity. Turning verification back on blocks new direct activations but does not revoke existing credentials or disconnect Hosts.

The Windows 0.1.1 client reads the policy from the selected Relay and presents the matching activation flow. A request to an older Relay keeps the QQ verification flow. No administrator token or SMTP secret is sent to the client. This policy change supersedes ADR-0014's unconditional QQ verification requirement. Registration state version 2 records whether a Host verified an email; it reads version 1 data, but an older Relay build cannot read the new state after a direct registration. Rollbacks across this schema change require a compatible Relay build.
