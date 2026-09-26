# ADR-0021: Terminal Codex attaches to the Host app-server

Date: 2026-09-26

Status: accepted.

## Context

A user who types `codex` in a Windows terminal should use the same Codex app-server that Orbis Host exposes to the phone. Replacing the npm-generated `codex.cmd` is fragile because package updates overwrite it and the selected Codex installation can change. A new app-server thread cannot be attached with `codex resume <id> --remote` before its first turn because Codex does not write the rollout until that turn.

## Decision

Orbis installs a managed `%LOCALAPPDATA%\\Orbis\\bin\\codex.cmd` shim ahead of other Codex entries in the user PATH. The shim intercepts only an argument-free interactive `codex` invocation. It reads the Host loopback descriptor, requests a short-lived local launch registration authenticated by that descriptor token, and runs the exact Codex CLI entry selected by Host with `--remote <Host endpoint>`. The official TUI creates the first thread and Host adopts the resulting `thread/started` notification for the pending terminal launch, matching it by working directory. Commands with arguments, including `login`, `exec`, `app-server`, `resume`, help, and provider-management commands, retain the normal Codex behavior; when Host is unavailable, the argument-free invocation falls back to the selected standalone Codex CLI.

The launch API is an HTTP route on the existing 127.0.0.1 loopback server. It is not exposed on LAN or Relay. The Host owns the selected Codex command and the shim metadata so PATH order, managed-version activation, and package updates do not require editing a third-party `codex.cmd`.

## Consequences

Terminal-first sessions become visible on the phone after the TUI creates its first thread. Multiple pending terminals in the same working directory are inherently ambiguous and are matched oldest-first; an explicit `codex resume <id>` remains an unmanaged official Codex invocation and is not retroactively claimed. Existing terminals need to be reopened after PATH installation. Host shutdown leaves the shim installed, but it transparently falls back to standalone Codex until Host is available again.
