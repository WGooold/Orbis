# ADR-0031: Host-owned permission management contract

Date: 2026-10-11

Status: accepted

2026-10-13: [ADR-0032](0032-host-owned-agent-state-model.md) incorporates this contract into the unified Host Agent state model. Opaque settings, backend confirmation, Session scope, and separate approval interactions remain required; model integration is pending.

## Context

The mobile permission page currently recognizes native slash command names and interprets Codex and DSH sandbox, approval, and preset values. Adding a backend therefore requires changes to the phone. Permission configuration is a runtime operational control, while its effective meaning and execution remain owned by the Agent backend. A single approval only authorizes its pending operation; it is separate from changing durable Session configuration.

## Decision

The Host exposes one permission-management contract in Runtime metadata. `permissionManagement` contains a user-facing summary, details, a generic tone (`restricted`, `full`, `unknown`, `problem`), and a collection of select settings. Each setting has an opaque ID, label, current value when known, selectable options with labels and descriptions, and an optional disabled reason. Backends construct this complete projection from native facts. Unknown native facts stay unknown; a preset name alone does not prove its sandbox or network bundle. The mobile client renders these fields without consulting agentKind, native permission values, or the slash menu.

Clients submit `permissions.update { settingId, value }` as an authenticated Runtime command addressed to a Runtime ID. The Host routes it through the existing backend ownership boundary. The backend validates the setting and option against its current supported configuration, rejects unavailable, busy, or concurrent writes, invokes its native API, and publishes refreshed metadata before a successful command result. A native refusal, timeout, or unconfirmed state produces a failure; clients do not optimistically claim effective permissions. The existing command ownership and result path continues to isolate paired devices.

Codex maps select settings to its native thread-settings update and confirmation lifecycle. DSH maps its advertised preset selection to the native permission command and verifies the resulting Session projection. The native handler may inject a `user-approval` context message for the next model step; it stays in DSH's native inbox but is excluded from the App's human delivery queue and transcript. Changing permissions does not call `session/prompt` or start a model request. Legacy or unsupported backends omit `permissionManagement`, yielding a read-only unavailable state in clients. No Host-global default silently changes existing Sessions. This first interface controls the addressed Session only; future-session defaults require a separate explicit scope in a future decision.

Approval requests continue through structured interactions and are not automatically answered by this interface. Permission updates are unavailable while the Session is working or has pending approval interactions. The backend remains responsible for enforcing this condition at execution time; client disabling is only feedback.

2026-11-03 Codex selection preservation ([ADR-0061](0061-codex-selection-and-native-settings-reconciliation.md)): a permission notification can contain the full native model/effort snapshot even when those fields did not change. Host must not overwrite an existing next-turn model or effort choice with an unchanged native value. Initial TUI subscription and ordinary resume apply the same reconciliation; actual native changes continue to synchronize independently per field. The pre-input subscription boundary and real 0.166.0 PTY verification are documented in [ADR-0021](0021-codex-terminal-host-attachment.md#revision-2026-11-03-model-selection-before-the-first-input). The permission command remains a permission-only patch with the existing RPC plus notification confirmation, and never starts a turn.

The existing raw `permissions` metadata remains available for diagnostics and existing backend tests. It is not the presentation or edit contract. Native slash commands may remain for the general command menu, but the permission page never discovers or applies settings through `slash.execute`. This qualifies ADR-0003: permission management is a dedicated typed runtime operational control rather than a second catalog for invoking arbitrary slash commands.

2026-11-04 localization ([ADR-0063](0063-mobile-app-language.md), S27 / R62): clients may render known Host-owned UI wording in the selected app language using a finite shared text catalog. Known full templates keep dynamic arguments opaque, and unknown backend text is retained. This is presentation only: clients still do not interpret native permission values or derive semantics from setting IDs, and setting / option identities, disabled reasons, confirmation and command routing remain unchanged. English device coverage checks that translated permission controls submit the original opaque identities.

## Consequences and verification

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。
