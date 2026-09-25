# ADR-0018: DeepSeek Harness ACP backend

Date: 2026-09-24

Status: superseded by [ADR-0020](0020-deepseek-harness-shared-web-backend.md). The ACP adapter remains for legacy embedders and tests.

## Context

Orbis needs a third Agent backend without moving agent execution into the phone or widening the Host's process-control surface. DSH 0.1.7-rc.1 ships an automation-only ACP v1 profile with persistent multi-session lifecycle, model selection, cancellation and one-shot permission requests. Its ACP channel does not replay transcripts and does not expose raw provider token deltas or the full Web presentation model.

## Decision

The Host owns one `dsh --profile acp` child, launched directly through the Windows Node executable and the detected CLI entry. `DshRuntime` implements the existing Agent backend port with kind `dsh`; only Host-owned active sessions claim runtime routes. At most eight sessions are active. New work uses an existing absolute directory chosen through the shared directory browser; the phone never supplies executable arguments, environment, or arbitrary MCP process definitions.

Public Session IDs and Runtime IDs both use `dsh:<native session id>` as distinct protocol fields. The equal spelling is a DSH mapping choice, not a change to the semantic distinction between session identity and routing identity. Canonical Entry IDs use `dsh:<native session id>:<durable event seq>`. Entries retain the source message IDs, event timestamps and parent order across preview/history/catchup and restart. Injected context remains distinguishable from user messages. Session forks and archive operations are not exposed.

Canonical history is read through the persistence library resolved from the selected CLI installation, using read-only handles. This avoids hardcoding compressed log filenames or bypassing version validation. ACP owns execution and writes; Orbis never repairs, truncates or migrates DSH logs itself. The configured reader root must match the ACP persistence root. Successful prompt settlement waits for the durable turn end before reporting persisted message identities; a history failure still terminates the local live-turn state and reports a syncable error.

Committed ACP output feeds the existing live-message and tool events. It is not advertised as token streaming. Model and reasoning menus use the live ACP choices; JSON encoding preserves opaque option values, including the empty provider-default value. One-shot approvals stay bound to their session, display the tool arguments, expire, and cancel on stop or disconnect. The Host neither grants standing permissions nor emulates DSH-specific interactive cards.

Cancellation is admitted before asynchronous history loading so a stop cannot race into a later prompt. A timed-out mutation closes the owned ACP connection after sending cancellation, containing late activation and uncertain state. The operator can restart the Host and resume persisted sessions. Explicit session close remains independent and flushes persistence before disposal; full shutdown closes sessions before stdin EOF.

DSH is opt-in in the desktop settings or `host --dsh`. Android adds branding, discovery and filtering while retaining shared chat, tools, approvals and Session Tree ingestion. AgentKind gains `dsh`; no new transport, encrypted frame format or Relay business operation is introduced. Host and Android are updated together, and Protocol changes follow the existing CI deployment boundary.

## Verification

Unit tests cover routing, activation serialization, cancellation during admission, pending prompts, terminal error state, duplicate message IDs, opaque options, session-bound approvals, source timestamps and stable bounded sync. A real installed-CLI smoke test uses an isolated DSH home and loopback model server to exercise configuration, read/write tools, approval, cancellation, multiple sessions, shutdown/restart and history recovery. Native desktop and Android build/UI validation cover user entry points. Real paid provider inference remains separate from this deterministic test.

Official source references and user setup are in [DeepSeek Harness integration](../deepseek-harness.md).
