# ADR-0020: Shared DeepSeek Harness Web backend

Date: 2026-09-26

Status: accepted; supersedes ADR-0018 for the default DSH backend.

## Context

The ACP backend could not share live execution with the DSH browser. Orbis now attaches both browser and mobile workflows to the same native Web service and Session.

## Decision

The Host authenticates to a loopback Web launch URL using its token. Without an explicit URL, it reuses a verified per-home descriptor or launches one persistent Web service under a cross-process lock. Host shutdown disconnects its transport, leaving that service and browser sessions running. A phone still requires an online Host.

The CLI installation supplies matching protocol validators and the assistant-stream decoder. Native session list/page/follow RPCs own discovery, canonical history, streaming, queue operations, model selection and approvals. Workspace follow supplies the archive set. Entry IDs include `:web:` to keep this event mapping separate from the earlier ACP mapping. The ACP implementation remains a legacy/test adapter, without an automatic fallback.

Provider management retains the complete native home patch. Native DSH HMR applies it; Orbis waits until the live provider route/default descriptors match before reporting success. Managed keys are excluded from the persistent child environment and synchronized through the native credential API, whose values are resolved per model request. Existing environment overrides are not silently replaced: native refusal causes the provider transaction to roll back. Active browser-only sessions are checked as well as Orbis sessions before switching. The shared process is never killed to apply a provider change.

## Verification

Unit tests cover transport validation, reconnect, streamed history, approval ownership, archive filtering, browser activity checks and provider reload failure. `scripts/test-dsh-web.mjs` launches an isolated official DSH installation against a loopback mock model and checks two clients, tools, queue cancellation, plus URL and API-key changes on the same running service. No user Host, browser service or paid model account is used.
