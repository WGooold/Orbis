# ADR-0022: Attach Codex desktop sessions through the existing daemon

Date: 2026-10-04

Status: accepted; revised 2026-10-04 to separate terminal and desktop backends.

## Context

ADR-0021 lets the official terminal TUI attach to an app-server owned by Orbis Host. Codex desktop instead owns a persistent daemon and its own loaded threads. Starting a second Host app-server cannot observe those live desktop turns, approvals or settings. The desktop daemon's control socket is not a public Host endpoint; the installed Codex CLI exposes `codex app-server proxy` as a client bridge to it.

## Decision

Host starts two independent Codex backends. `codex` owns its app-server, remote TUI endpoint, terminal shim, and TUI process watchdog as in ADR-0021. `codexDesktop` connects through a Host-owned `codex app-server proxy` to the desktop daemon, completes `initialize`, and requires `thread/loaded/list`. Each backend has its own runtime ID (`codex:<thread>` and `codex-desktop:<thread>`) and the desktop backend exposes namespaced session IDs (`codex-desktop:<thread>`). Phone activation and archival select the backend explicitly. A failed desktop connection does not change terminal routing or switch the terminal backend to the desktop daemon. Host shutdown or proxy failure closes only the proxy connection; the daemon and desktop application keep their own lifecycle.

In desktop mode Host reconciles `thread/loaded/list` at startup and periodically, reads loaded thread metadata, and joins each eligible thread with `thread/resume` without overrides. The resume response seeds history, model and permissions; turn and item notifications received during resume are applied after the snapshot. Loaded idle threads remain visible once attached. Unloaded, closed and archived threads leave the online directory. An unsuccessful resume stays pending and is retried, including threads whose rollout has not yet materialized. The paired phone may send messages and respond to approvals on an attached Session through the same app-server protocol.

Phone `/quit` detaches only its desktop online view. It does not close a desktop window, archive a thread, stop a turn, or terminate the daemon. Automatic discovery remains suppressed until that desktop thread next begins work after an idle state; explicit phone activation can reopen it sooner. Provider switching is refused while Host uses the shared desktop backend, because native config writes or an owned-backend restart could disrupt the desktop application's route. The terminal shim always connects to the independent Host-owned app-server. When its foreground Codex TUI exits, the terminal watchdog removes that thread from the online directory and unsubscribes Host from the thread; desktop discovery never reclaims it as a terminal session. Desktop detachment likewise unsubscribes only the Host proxy connection, leaving desktop ownership untouched.

## Consequences

Desktop integration requires a compatible installed Codex CLI and a running, reachable desktop daemon. If the desktop connection fails, desktop sessions are unavailable while terminal sessions continue independently. If the proxy disconnects after startup, Host reports attached desktop Sessions offline; a new Host connection is needed to attach again. Host owns no desktop process and cannot repair or restart it. The polling interval adds small metadata traffic even while no desktop thread is active. Existing unqualified Codex session IDs remain terminal IDs for compatibility; desktop IDs are namespaced in the mobile protocol.

Codex stores terminal and desktop rollouts in the same native directory. Host persists IDs it has observed through the desktop backend and excludes them from terminal history and operations, including after a restart. Desktop history, including archived sessions, uses the namespaced ID. A desktop thread from before this separation that has never been observed by the new Host cannot be classified reliably from its rollout alone; it remains in the legacy terminal history until the desktop backend discovers it.
