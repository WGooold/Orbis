# ADR-0021: Terminal Codex attaches to the Host app-server

Date: 2026-09-26

Status: accepted.

## Context

A user who types `codex` in a Windows terminal should use the same Codex app-server that Orbis Host exposes to the phone. Replacing the npm-generated `codex.cmd` is fragile because package updates overwrite it and the selected Codex installation can change. A new app-server thread cannot be attached with `codex resume <id> --remote` before its first turn because Codex does not write the rollout until that turn.

## Decision

Orbis installs a managed `%LOCALAPPDATA%\\Orbis\\bin\\codex.cmd` shim ahead of other Codex entries in the user PATH. The shim intercepts only an argument-free interactive `codex` invocation. It reads the Host loopback descriptor, requests a short-lived local launch registration authenticated by that descriptor token, and runs the exact Codex CLI entry selected by Host with `-C <terminal directory> --remote <Host endpoint>`. `-C` is load-bearing: without it the official TUI creates its first thread in the app-server's own working directory, so the terminal session would run in the wrong directory and the cwd-keyed adoption could never match its registration. The official TUI creates the first thread and Host adopts the resulting `thread/started` notification for the pending terminal launch, matching it by working directory; the registration therefore outlives the official trust prompt that an untrusted directory triggers before any thread exists. Commands with arguments, including `login`, `exec`, `app-server`, `resume`, help, and provider-management commands, retain the normal Codex behavior; when Host is unavailable, the argument-free invocation falls back to the selected standalone Codex CLI.

The launch API is an HTTP route on the existing 127.0.0.1 loopback server. It is not exposed on LAN or Relay. Host and offline/parameterized shim launches share the Codex entry selected by Host, persisted under the Orbis agent-install root in `codex-selection.json`. Managed installation, version activation and maintenance selection update this record; ordinary users never pick a version, a source or a CLI path, and the Agent page deliberately shows no terminal-integration state for terminal-first attachment to be a concept they have to manage. The runtime updates a detected npm installation in place and uses a verified managed installation for other entries, preferring the recorded entry, then the active managed version, then auto-detection, and skipping any record whose file has disappeared. The shim is enabled automatically once the Host runs and a compatible Codex is installed; a failure only logs, because terminal `codex` keeps working through the standalone fallback. Compatibility checks require both CLI `--remote` and app-server `--listen` before the shim is installed. Windows resolves the machine PATH before the user PATH, so a `codex` that another tool installed machine-wide keeps winning however the user PATH is ordered. That single case cannot be repaired without elevation, so Settings shows a repair action only while such a conflict exists; uninstall removes the entry it added. The per-user installer never writes the machine PATH on its own, and it never replaces an npm-generated `codex.cmd`.

## Consequences

### Revision 2026-11-02: App terminal activation on macOS

The reproduced root cause is an inherited
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop` in the Host and its owned
app-server. Isolated `thread/start` requests to the same native CLI with the same
`orbis-host` initialization return `originator=Codex Desktop` when that variable
is present and `originator=orbis-host` when it is absent; neither case invokes a
model. The owned terminal app-server and terminal child launchers remove only
this private source override from their child environment. The parent Host,
Desktop wrapper / GUI, native home, provider config and authentication are
unchanged. Existing histories are not relabelled or migrated.

App selection of `codex` activates the independent terminal backend. Historical rollout metadata describes creation context; current selection and observed attachment determine routing and ownership. The Desktop namespace and observed ownership guard remain in effect. Independent app-servers cannot write the same loaded thread concurrently, and that conflict can legitimately produce the Desktop warning.

For macOS, terminal activation opens a private executable `.command` through
Terminal, using the exact CLI selected for that app-server and `resume --remote`
to its existing endpoint. It does not invoke `wt.exe` or PowerShell. OS acceptance
of `open` is followed by a private startup receipt written only from a real TTY;
until then Host does not log that a window opened. Failure returns `spawn_failed`
and releases only a newly attached idle subscription. Existing or running work
is preserved. Existing watchdog lifecycle rules remain unchanged.

The macOS watchdog recognizes both its own rollout-waiting shell and native
remote TUI. It checks terminal, endpoint, executable and session identity; close
rechecks PID / start time before signalling and waits for native exit. The
app-server and Desktop processes are never treated as terminal windows.
Verification and remaining device / manual gates are recorded under R56 in
[UI regression](../../AGENTS.md#测试). This revision is under validation;
it does not claim the running user Host has been upgraded.

Adoption subscribes to the existing thread through `thread/resume`, retaining its native configuration. `thread/started` and `thread/status/changed` are global broadcasts, but merely reading `thread/turns/list` does not subscribe the Host connection to items, turns or effective permission changes. The resume response supplies the initial history, model and permissions; subsequent notifications keep them current. Codex 0.160.0 rejects resume before the first message materializes the rollout, so Host retains the empty session and retries on status broadcasts and its existing TUI window watcher. An absent rollout at that stage is not a permanent history error. Notifications received during resume are applied after the history snapshot to preserve newer state. TUI `/new` and `/resume` switches use the same subscription path.

Terminal-first sessions become visible on the phone after the TUI creates its first thread. Each registered launch now has its own loopback endpoint, including concurrent launches in the same working directory; the 2026-11-10 revision below replaces cwd matching and broadcast-based switch inference. An explicit `codex resume <id>` remains an unmanaged official Codex invocation and is not retroactively claimed. Existing terminals need to be reopened after PATH installation. A machine-wide `codex` installed by another tool needs that single elevation before a bare `codex` reaches Orbis; until then the shim stays installed but unused, and the only user-visible trace is the Settings repair row. Host shutdown leaves the shim installed, but it transparently falls back to standalone Codex until Host is available again.

### Revision 2026-11-10: Exact terminal ownership (SC74)

The terminal backend previously interpreted an unmanaged `thread/started` or
`thread/status/changed` broadcast as a TUI switch and transferred the most recently
active window to that thread. A closed historical thread could replace a live
card while the card count stayed constant. Its `/quit` then targeted the replaced
window's process. Repeated broadcasts could move cards out of and back into the
active directory.

Each managed terminal now uses a private loopback WebSocket connection to the
same native app-server. Only a successful, correlated `thread/start`,
`thread/resume` or `thread/fork` response on that connection determines its current
interactive thread. Global broadcasts, ephemeral threads and child threads do
not transfer terminal ownership. Monitoring and close use the complete private
endpoint. Close checks the current selection and prevents a concurrent switch
while the OS verifies the process. Process snapshots remain batched across
windows, and disconnect cleanup releases the private listeners. Mobile protocol
18 / 19 and Android / iOS wire contracts are unchanged.

Implementation: `codex-terminal-connection.ts`, `codex-runtime.ts` and
`codex-terminal-macos.ts`. Regression coverage in their tests includes repeated
old-session broadcasts with two live windows, identical project directories,
exact close targets, delayed history responses, selection races and native
app-server routing with an isolated home and no model calls. Evidence:
`.artifacts/codex-terminal-ownership-20261110/`. The native macOS PTY probe ran
two Codex 0.167.0 TUIs in one directory, ignored an unrelated native thread,
transferred only the `/new` window, confirmed that window's process exit on
`/quit`, and verified the other TUI survived. No model was called. Windows native
process termination and mobile device acceptance remain unverified. Source and automated validation
are separate from deployment: the installed Host has not been replaced or
restarted. After installing the updated Host, reopen its terminal sessions;
Android installation is not required for this Host-side change. Device and user
acceptance remain pending（待用户验证）.

### Revision 2026-11-03: Model selection before the first input

The complete reconciliation decision and its tradeoffs are maintained in [ADR-0061](0061-codex-selection-and-native-settings-reconciliation.md).

An isolated real PTY test of Codex 0.166.0 confirms that the TUI broadcasts an empty loaded thread before input, but `thread/resume` still returns `no rollout found` and `thread/turns/list` reports that the thread is not materialized. An observer's `thread/settings/update` returns success at that point without delivering `thread/settings/updated` to that observer. RPC success therefore cannot replace subscription or effective-state confirmation. Both terminal-first and phone-first input were tested against a local Responses stub with an isolated native home; no real model or user session was used.

Host retains the existing next-turn `/model` and `/thinking` overrides without a settings RPC. It tracks the last native model and effort separately: unchanged values repeated by a permission update or the first successful subscription preserve those overrides. A changed native value or native confirmation of the selected value takes ownership of that field again; model and effort reconcile independently, including an explicit native null effort. Ordinary resume uses the same rule. This restores the existing selection semantics without forcing materialization or submitting a synthetic user message.

Regression tests are `codex-permission-settings.test.ts` and `codex-terminal-sync.test.ts`; UI mapping and validation limits are recorded under R27 / R56 in [UI regression](../../AGENTS.md#测试). Evidence is in `.artifacts/ui-regression/20261103-codex-permission-model/`. Complete device/manual acceptance and deployment are separate from these native and adapter results.
