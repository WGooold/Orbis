# ADR-0019: Host-owned provider management

Date: 2026-09-24

Status: accepted

## Context

Previously Orbis only exposed each Agent's native configuration flow. The user requested Host-side installation and provider editing, with switching also available on the paired Android app, using CC Switch's native-file switching behavior as the reference.

This extends the remote authority described in ADR-0002: a paired device may now select a provider profile that the computer's Host has already saved. It does not receive a generic configuration, credential, package or process endpoint.

## Decision

The Windows Host owns the catalog, credentials and native configuration writes. Its Agent page supports installation or update from a fixed npm package per Agent, using a validated version and an isolated installation directory. The selected CLI entry changes only after installation and version validation succeed. The device has no installation operation.

Codex uses an exclusive profile: import the current native configuration, save the outgoing provider-owned settings before switching, then apply the selected `auth.json` and `config.toml`. Shared TOML preferences and MCP remain live resources. Official cards may bind to a Host-owned managed OAuth account; refresh-token rotation and same-identity CLI adoption happen before the native transaction, while live OAuth tokens are never stored in provider cards. Pi uses additive explicit providers: sync exact provider IDs from `models.json.providers`, enable or remove only that node, and leave `auth.json` and default-model settings alone. DeepSeek Harness uses an exclusive home-level `cordis.patch.yml` profile; its credentials remain in the local Host catalog and are synchronized through the native local Web credential API (ADR-0020), without baking managed keys into the persistent service environment. Native YAML with custom tags is retained verbatim by the advanced editor.

Edits use an atomic transaction journal with rollback on write or backend reload failure. A switch refuses active Codex/DSH work or approvals. Native Codex routing changes restart its owned backend and require sessions to be reopened. DSH awaits native Web configuration hot reload and updates native credentials without terminating the shared process; read-only environment overrides fail the switch and trigger rollback. Pi processes running independently must be reopened to load the changed provider list. The Host OAuth account store refreshes managed Codex accounts and preserves native CLI rotations by identity and timestamp.

The Android app sends only a saved provider ID, Agent kind and enable/disable choice over the paired E2E channel. It receives names, IDs, enabled state, and a non-secret global-default marker, never API keys, OAuth material, usage scripts, or raw native configuration. This is a deliberately bounded exception to the earlier no-credential-write rule in ADR-0002, requested for provider switching. Arbitrary config, npm package, CLI arguments and credentials from the phone remain excluded.

Codex additionally supports a Host-owned local routing mode modeled on CC Switch: Codex's native config temporarily points at an authenticated loopback Responses endpoint, which can pass through Responses or convert to Chat Completions/Anthropic Messages. The selected provider snapshot is immutable for each request; proxy-to-proxy switches affect later requests without restarting Codex. Optional failover uses only the explicit queue, with bounded timeouts, cancellation, circuit health, and no retry after streamed output begins. `/responses/compact` is passed to native Responses upstreams and converted requests use their normal endpoint. Official Codex OAuth accounts are not eligible for proxy failover. Disabling routing or shutting down restores the saved native configuration while preserving unrelated external preference/MCP edits, and routing conflicts are rejected for review. Provider routing credentials never flow to Android.
