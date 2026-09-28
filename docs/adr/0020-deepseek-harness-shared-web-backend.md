# ADR-0020: Shared DeepSeek Harness Web backend

Date: 2026-09-26

Status: accepted; supersedes ADR-0018 for the default DSH backend.

Update (2026-09-27): attaching every live Agent at startup scaled badly (dozens of Sessions meant dozens of follows and metadata broadcasts). Only working Agents now occupy an online card.

## Context

The ACP backend could not share live execution with the DSH browser. Orbis now attaches both browser and mobile workflows to the same native Web service and Session.

## Decision

The Host authenticates to a loopback Web launch URL using its token. Without an explicit URL, it reuses a verified per-home descriptor or launches one persistent Web service under a cross-process lock. Host shutdown disconnects its transport, leaving that service and browser sessions running. A phone still requires an online Host.

The desktop Agent update flow is an explicit exception: after installing and verifying DSH, it restarts a running Orbis-owned Web service with the new CLI, keeping its home and port and publishing fresh authentication metadata. The update dialog explains the interruption before confirmation. Restart and service acquisition share the same cross-process lock; the authenticated descriptor PID must also own the listening socket before termination. External endpoints are left to their launcher, and unused services are not started by an installation. Failed or cancelled downloads do not restart the service. A failed restart or provider synchronization retains the verified installation and reports a separate warning. Ordinary Host shutdown and provider changes retain their existing non-terminating behavior.

The CLI installation supplies matching protocol validators and the assistant-stream decoder. Native session list/page/follow RPCs own discovery, canonical history, streaming, queue operations, model selection and approvals. Before creating or resuming a Session from the app, Orbis resolves its absolute `cwd` through `workspace/create` and passes the resulting `workspaceId` to `session/create`; this keeps browser Workspace grouping aligned with the app's directory tree. Workspace follow supplies the archive set. Entry IDs include `:web:` to keep this event mapping separate from the earlier ACP mapping. The ACP implementation remains a legacy/test adapter, without an automatic fallback.

The slash `/quit` operation only detaches the phone's active runtime and preserves the Session. Archiving is a separate sidebar operation that calls the native Workspace archive RPC; a successful archive also detaches any local runtime for that Session.

The Host discovers native Agents at startup and follows the ones already working (`running`). An idle Agent stays a catalog row: it occupies no online card and costs no per-Session follow, skills or model RPC until the browser starts new work in it or the app opens it. A Session that is already attached stays online after its turn finishes. Reconnection reconciles native membership before reopening Session follows, because following a cold ordinary Session can activate its Agent. Explicit `/quit` suppresses automatic attachment until new browser work starts in that instance (idle→running), the app reopens it, or its native instance is removed. Follow openings and app history synchronization replay the current assistant prefix so joining a browser turn midway preserves already-generated text.

Provider management retains the complete native home patch. Native DSH HMR applies it; Orbis waits until the live provider route/default descriptors match before reporting success. Managed keys are excluded from the persistent child environment and synchronized through the native credential API, whose values are resolved per model request. Existing environment overrides are not silently replaced: native refusal causes the provider transaction to roll back. Active browser-only sessions are checked as well as Orbis sessions before switching. The shared process is never killed to apply a provider change.

## Verification

Unit tests cover transport validation, reconnect, streamed history, approval ownership, archive filtering, browser activity checks and provider reload failure. Discovery tests cover startup, late notifications, stale list responses, detach, archive changes and joining a streaming turn; an encrypted Host test verifies automatic announcement and bidirectional routing without app activation. `scripts/test-dsh-web.mjs` launches an isolated official DSH installation against a loopback mock model and checks native discovery (including browser restoration of a cold Session), cold-safe history reads, shared messages, archive changes, tools, queue cancellation, plus URL and API-key changes on the same running service. No user Host, browser service or paid model account is used.
