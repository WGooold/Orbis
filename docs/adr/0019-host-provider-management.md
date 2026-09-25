# ADR-0019: Host-owned provider management

Date: 2026-09-24

Status: accepted

## Context

Previously Orbis only exposed each Agent's native configuration flow. The user requested Host-side installation and provider editing, with switching also available on the paired Android app, using CC Switch's native-file switching behavior as the reference.

This extends the remote authority described in ADR-0002: a paired device may now select a provider profile that the computer's Host has already saved. It does not receive a generic configuration, credential, package or process endpoint.

## Decision

The Windows Host owns the catalog, credentials and native configuration writes. Its Agent page supports installation or update from a fixed npm package per Agent, using a validated version and an isolated installation directory. The selected CLI entry changes only after installation and version validation succeed. The device has no installation operation.

Codex uses an exclusive profile: import the current native configuration, save the outgoing provider-owned settings before switching, then apply the selected `auth.json` and `config.toml`. Shared TOML preferences and MCP remain live resources. Official cards may bind to a Host-owned managed OAuth account; refresh-token rotation and same-identity CLI adoption happen before the native transaction, while live OAuth tokens are never stored in provider cards. Pi uses additive explicit providers: sync exact provider IDs from `models.json.providers`, enable or remove only that node, and leave `auth.json` and default-model settings alone. DeepSeek Harness uses an exclusive home-level `cordis.patch.yml` profile; its credentials remain in the local Host catalog and are passed to the owned ACP process as environment variables. Native YAML with custom tags is retained verbatim by the advanced editor.

Edits use an atomic transaction journal with rollback on write or backend reload failure. A switch refuses active Codex/DSH work or approvals. The Host restarts the corresponding owned backend after a successful switch, and sessions must be reopened. Pi processes running independently must be reopened to load the changed provider list. The Host OAuth account store refreshes managed Codex accounts and preserves native CLI rotations by identity and timestamp.

The Android app sends only a saved provider ID, Agent kind and enable/disable choice over the paired E2E channel. It receives names, IDs, enabled state, and a non-secret global-default marker, never API keys, OAuth material, usage scripts, or raw native configuration. This is a deliberately bounded exception to the earlier no-credential-write rule in ADR-0002, requested for provider switching. Arbitrary config, npm package, CLI arguments and credentials from the phone remain excluded.

The current Host architecture provides native-file provider switching for Pi, Codex, and DSH. CC Switch's separate local proxy takeover data plane, protocol conversion, proxy hot-switching, and failover queue are not enabled by this ADR; presets requiring those paths are rejected until a dedicated proxy architecture is approved.
