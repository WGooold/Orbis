# ADR-0031: Host-owned permission management contract

Date: 2026-10-11

Status: accepted

2026-10-13: [ADR-0032](0032-host-owned-agent-state-model.md) incorporates this contract into the unified Host Agent state model. Opaque settings, backend confirmation, Session scope, and separate approval interactions remain required; model integration is pending.

## Context

The mobile permission page currently recognizes native slash command names and interprets Codex and DSH sandbox, approval, and preset values. Adding a backend therefore requires changes to the phone. Permission configuration is a runtime operational control, while its effective meaning and execution remain owned by the Agent backend. A single approval only authorizes its pending operation; it is separate from changing durable Session configuration.

## Decision

Host publishes a complete permission-management projection in Runtime metadata. The backend owns native interpretation and confirmation; clients render the projection and submit typed updates to the addressed Runtime.

`permissionManagement` contains summary, details, tone (`restricted`, `full`, `unknown`, `problem`) and select settings with opaque identities, current values, options and availability. Unknown native facts remain unknown.

Clients send `permissions.update { settingId, value }`. The backend validates current eligibility, applies the native operation and publishes confirmed metadata before reporting success. Approval interactions retain their own lifecycle. Unsupported backends publish a read-only unavailable state.

Codex uses native thread settings; DSH uses its advertised permission command and resulting Session projection. Changes apply to the addressed Session. DSH's `user-approval` context remains native model input, with human delivery represented separately.

Codex selection reconciliation follows [ADR-0061](0061-codex-selection-and-native-settings-reconciliation.md): permission patches preserve next-turn model / effort selections, and genuine native changes synchronize per field. The pre-input subscription evidence is in [ADR-0021](0021-codex-terminal-host-attachment.md#revision-2026-11-03-model-selection-before-the-first-input).

The permission page uses the typed contract. Raw metadata remains available for diagnostics, while native Slash commands retain their general menu role.

Localization follows [ADR-0063](0063-mobile-app-language.md), S27 / R62: clients translate known interface templates at presentation time and preserve opaque arguments, identities and execution semantics.

## Consequences and verification

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。
