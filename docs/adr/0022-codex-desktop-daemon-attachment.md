# ADR-0022: Attach Codex desktop sessions through an Orbis-owned wrapper

Date: 2026-10-04

Status: accepted; revised 2026-10-28 to support macOS; revised 2026-10-04 to separate terminal and desktop backends; revised 2026-10-05 to record automatic re-attachment and the attach state published to the two clients; **replaced 2026-10-05**: the proxy/daemon route cannot work on Windows, so the desktop backend attaches through an Orbis wrapper instead (see the withdrawal note at the end).

2026-11-01: The Codex Desktop lifecycle is independent of the optional Codex terminal backend. App session requests reuse an attached Desktop runtime; when none is ready, Host opens the GUI through the Orbis wrapper, waits for its app-server endpoint and handshake, then creates or resumes the requested session. `orbis host --codex` only prestarts the terminal backend.

## Context

ADR-0021 lets the official terminal TUI attach to an app-server owned by Orbis Host. Codex desktop instead owns a persistent daemon and its own loaded threads. Starting a second Host app-server cannot observe those live desktop turns, approvals or settings. The desktop daemon's control socket is not a public Host endpoint; the installed Codex CLI exposes `codex app-server proxy` as a client bridge to it.

## Decision

Host manages two independent Codex backends. `codex` owns its app-server, remote TUI endpoint, terminal shim, and TUI process watchdog as in ADR-0021; the CLI's `--codex` flag controls whether it starts eagerly. `codexDesktop` is available independently when the desktop application is installed. It connects through a Host-owned wrapper endpoint, completes `initialize`, and requires `thread/loaded/list`. Each backend has its own runtime ID (`codex:<thread>` and `codex-desktop:<thread>`) and the desktop backend exposes namespaced session IDs (`codex-desktop:<thread>`). Phone activation and archival select the backend explicitly. A failed desktop connection does not change terminal routing or switch the terminal backend to the desktop daemon. Host shutdown or proxy failure closes only the proxy connection; the daemon and desktop application keep their own lifecycle.

When an App new-session or resume request targets Codex Desktop, Host first reuses the existing ready runtime. Otherwise it opens the registered application through the Orbis wrapper and waits for the published app-server endpoint and native handshake before issuing `thread/start` or `thread/resume`. A running and already attached application is controlled directly; Host does not open a second instance. If startup or attachment does not complete, the request fails and the App does not present a connected Session.

In desktop mode Host reconciles `thread/loaded/list` at startup and periodically, reads loaded thread metadata, and joins each eligible thread with `thread/resume` without overrides. The resume response seeds history, model and permissions; turn and item notifications received during resume are applied after the snapshot. Loaded idle threads remain visible once attached. Unloaded, closed and archived threads leave the online directory. An unsuccessful resume stays pending and is retried, including threads whose rollout has not yet materialized. The paired phone may send messages and respond to approvals on an attached Session through the same app-server protocol.

Phone `/quit` detaches only its desktop online view. It does not close a desktop window, archive a thread, stop a turn, or terminate the daemon. Automatic discovery remains suppressed until that desktop thread next begins work after an idle state; explicit phone activation can reopen it sooner. Provider switching is refused while Host uses the shared desktop backend, because native config writes or an owned-backend restart could disrupt the desktop application's route. The terminal shim always connects to the independent Host-owned app-server. When its foreground Codex TUI exits, the terminal watchdog removes that thread from the online directory and unsubscribes Host from the thread; desktop discovery never reclaims it as a terminal session. Desktop detachment likewise unsubscribes only the Host proxy connection, leaving desktop ownership untouched.

## Consequences

2026-11-02 source-environment repair: a terminal app-server inherited
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop` from Host and incorrectly
labelled App-created terminal threads as Desktop. The terminal spawn boundary
clears this override; the Desktop wrapper and GUI keep their own environment.
The isolated native reproduction is recorded with R56.

2026-11-02 ownership clarification: historical rollout metadata describes creation context. App selection, observed native attachment and the current writer determine present ownership. A thread loaded in the terminal app-server can legitimately produce the Desktop warning that it is open in another application. Missing terminal windows are handled by the launcher / lifecycle repair in [ADR-0021](0021-codex-terminal-host-attachment.md); existing running work retains its ownership.

2026-11-10 SC75: clearing the Desktop originator did not correct SQLite
`threads.source`. The ordinary `codex app-server` entry fixed new thread sources
to `vscode`, even on the independent terminal backend. Terminal startup now uses
the version-matched official standalone server with `--session-source cli`, and
releases an idle writer after its last subscriber leaves. The history of the
incomplete repair, native persistence path, package validation and regression
evidence are recorded in [ADR-0021, SC75](0021-codex-terminal-host-attachment.md#revision-2026-11-10-native-terminal-source-and-writer-release-sc75).
Existing history metadata remains unchanged. Desktop attachment does not adopt
terminal lifecycle settings; a currently active terminal writer still excludes
a second independent writer. Deployment and Desktop acceptance remain pending.

Desktop integration requires a compatible installed Codex CLI and a running, reachable desktop daemon. If the desktop connection fails, desktop sessions are unavailable while terminal sessions continue independently. If the connection drops after startup, Host reports attached desktop Sessions offline and re-attaches on its next poll once the desktop side answers again; no Host restart is needed. Host owns no desktop process and cannot repair or restart it. The polling interval adds small metadata traffic even while no desktop thread is active. The same watch publishes one attach state — `unsupported`, `notInstalled`, `closed`, `attached` or `error` — with a user-facing reason on `device.ready`, so the Windows Host diagnostics page and the phone connection status page can say why desktop sessions are or are not available instead of only showing them missing. A failed attach is a reported state, not a silent one.

## Decision (replaced 2026-10-05): attach through the Orbis wrapper

`codex app-server proxy` cannot reach the desktop application's app-server on Windows: the GUI's only WebSocket/daemon branch is gated behind `process.platform !== "win32"`, so it always spawns its own app-server as a private stdio child, and the managed daemon that the proxy does reach is a different, SSH-oriented server. The attach point has to be created on the desktop side instead.

Orbis therefore ships a wrapper and makes the desktop application run its app-server through it. `CODEX_CLI_PATH` (read by the desktop application as a CLI override) points at `codex-launcher.exe`, a small Windows PE binary; it hands the arguments and the inherited stdio to `node codex-desktop-wrapper.js`. The wrapper starts the real CLI as `app-server … --listen ws://127.0.0.1:<free port>`, bridges the GUI's stdio to that endpoint, and publishes the endpoint as `codex-desktop-endpoint.json` in the Host state directory. Every non-`app-server` invocation is passed through. A transport setup failure before GUI input can fall back to the same CLI after stopping its failed child. The earlier claim that this could never break native startup was incorrect: if no selected executable can start, Desktop receives no startup-policy JSON. The recovery and retry boundary below supersedes that claim.

Host reads that descriptor (loopback websocket plus a live bridge process only), attaches as an ordinary second WebSocket client with `initialize` and `thread/loaded/list`, and keeps the rest of the desktop behaviour described above — namespaced `codex-desktop:<thread>` IDs, `thread/resume` without overrides, offline/online transitions and one published attach bracket. Nothing about the GUI's own transport changes, and the app-server serves both clients natively, which is the same multi-client shape the terminal backend already relies on.

The entry is the user-level environment variable `CODEX_CLI_PATH`, which the desktop application reads at startup as a CLI override. Host writes it (idempotently, pointing at the staged wrapper) as soon as the wrapper is ready, and removes it on uninstall. It never overwrites a value that is not its own: a foreign value is reported instead, the same way a machine-PATH conflict for the terminal shim is reported. Because the override is an environment variable rather than something Orbis does at launch time, a desktop application started from the Start menu is wrapped too, and whether Host or the desktop application starts first does not matter — the desktop side publishes its endpoint whenever it starts and Host attaches whenever it sees it. Host opens the registered Windows application as described in the 2026-10-08 revision below.

Rejected alternative: replacing the CLI the desktop application provisions into `%LOCALAPPDATA%\OpenAI\Codex\bin\<key>\codex.exe`. Those keyed directories are cache keys rather than content hashes (the directory name is not the hash of the file inside), so such a replacement is not integrity-checked — but the application provisions a fresh keyed copy when its own version or paths change, so a replaced binary silently stops being used and the attach breaks again after every desktop update. It would also require keeping the displaced real CLI aside, since the wrapper's own lookup must not find itself.

Orbis stages `codex-launcher.exe` and the pinned `node.exe` outside its own install directory (`%LOCALAPPDATA%\Orbis\wrapper`) and points the desktop application at that copy. Both stay resident for the whole desktop session, so living inside the runtime would lock files that a Host update has to replace. The wrapper's JavaScript stays in the install directory: it is read once at startup and never held open, so it can be replaced at any time. A generated stub at the staged script location forwards to that implementation, which keeps the launcher's self-relative lookup working for a launch Orbis did not perform. Staging is idempotent and the stub points to the implementation in the install directory: a self-referential stub kills the wrapper process, and a desktop application that cannot reach its own app-server falls back to an in-memory one and reports that it cannot load organization settings safely — a failure that looks like a network or policy problem rather than a wrapper problem.

### Revision 2026-10-08: launch the registered desktop application

Overview and on-demand desktop launches use `IApplicationActivationManager.ActivateApplication` with the installed package family and the GUI application ID read from its manifest. They no longer start the versioned `WindowsApps/.../ChatGPT.exe` directly. Direct EXE launch can give the taskbar the embedded EXE icon and a shortcut to a package version that disappears after an update; registered activation uses the application's Windows identity and its official icon assets. Activation errors propagate to Host rather than reporting success immediately after an asynchronous spawn.

Host waits for its user-level wrapper entry before activation. The staged forwarding script also records the Host endpoint as a default, preserving custom state directories when Shell activation does not inherit Host's temporary environment. An explicit endpoint in the wrapper environment still takes precedence. Existing running desktop processes retain their lifecycle; launch does not close or restart them. Previously pinned EXE shortcuts need to be unpinned and recreated from the registered application.

### Revision 2026-10-10: mobile answers to desktop async questions

The desktop `request_user_input_async` tool produces an `agentMessage` with a `questions` array of titles and optional string options. It does not send the blocking `item/tool/requestUserInput` server request. Host projects each native question into the existing portable questionnaire interaction, preserving options and allowing free text. Question IDs follow the desktop projection (`["request_user_input_async", itemId, questionIndex]`); replies use its `send_user_message_question_reply` text envelope. Host sends answers with `turn/steer` and the question's own active turn precondition. It does not interrupt work to answer an async question.

Native turn status, history and live items determine which questions remain actionable, so attachment, reconnect, desktop answers and revert all reconcile the same pending interactions. Verified against desktop `26.1002.7124.0`: its answer action and submission path require the question's owning turn to be `inProgress`. Completed, interrupted or failed turns leave readable question history but disable answering even without a reply. Host sends `interaction.cancelled` when that turn ends, excludes those questions from snapshots, and rejects late answers instead of starting another turn. A later ordinary user message or another question does not itself expire an unanswered question in a still-running turn.

The desktop also initializes a 30-second composer-panel deadline and clears it on user interaction. That timer only minimizes the panel; the transcript can reopen an unanswered question while its turn continues. It is local presentation state, not a shared expiration or an approval timeout. Host therefore keeps `expiresAt` unbounded and derives answerability from native turn status. Cancelling the mobile form dismisses it locally without sending an answer or stopping the turn. Conversation Entries retain readable question/option text and render reply envelopes as readable answers. The mobile client keeps its existing questionnaire UI and generic interaction protocol.

### Revision 2026-10-28: macOS uses the same wrapper

The macOS desktop application (`com.openai.codex`, installed as `ChatGPT.app` — the same bundle name as the plain ChatGPT app `com.openai.chat`, so Host identifies it by bundle id only) also spawns its app-server as a private stdio child by default. Its WebSocket/daemon branch is taken only when `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` and no `CODEX_CLI_PATH` is set, and it honours an absolute `CODEX_CLI_PATH` as a CLI override (verified against `26.1023.50603` with `codex-cli 0.165.0-alpha.1.2`). macOS therefore attaches through the same wrapper and endpoint descriptor; only the platform pieces differ:

- No launcher binary ships. Staging generates `~/Library/Application Support/Orbis/wrapper/bin/codex-launcher`, a POSIX `sh` script that runs the Host's own `node` on the staged stub. Node is not copied, because macOS can replace files that running processes hold open. When node or the script is missing, the launcher executes `ORBIS_CODEX_REAL` or the CLI bundled with its parent `.app`, so the desktop application still starts.
- The wrapper resolves the real CLI from its parent process, which is the GUI main process: `<app>/Contents/Resources/codex-cli/bin/codex`. That CLI and `codex-code-mode-host` update in place with the application, so the Windows install-race wait does not apply.
- The entry is the launchd user-session environment (`launchctl setenv CODEX_CLI_PATH …`), which apps opened from the Dock, Launchpad, Finder or Spotlight inherit. A LaunchAgent (`~/Library/LaunchAgents/dev.orbis.codex-desktop-entry.plist`) sets it again at every login. The ownership rules match Windows: a foreign value is reported and left alone. An application that is already running keeps its old environment and has to be reopened.
- Presence means the bundle's main executable is in `ps`. Electron helpers live under `Contents/Frameworks` and do not match. Launch and thread links use `open -b com.openai.codex`, passing the wrapper variables with `--env`.

### Revision 2026-11-14: reuse version-matched official CLI files and recover native startup

The reported Windows failure used Desktop `26.1103.7773.0`: the wrapper selected
the package CLI, its spawn failed with `EPERM`, and the one-shot policy query
returned no JSON. An existing official local copy with the same SHA-256 worked.
This does not establish that all WindowsApps executables require package
identity: on the development machine the installed `26.1106.6628.0` CLI runs
from ordinary Node. A temporary deny-execute ACL reproduces the failure shape;
the reported machine's exact security-policy cause remains unconfirmed.

Windows selection is now tied first to the GUI ancestor's actual package. If
ancestry cannot be established, only the current user's AppX registration is
considered, with the startup client version when supplied. Ambiguous installs
are not resolved by highest version, modification time, or another user's
machine-level registration.

The wrapper uses existing executables in this order: a matching explicit
`ORBIS_CODEX_REAL`, a matching official `%LOCALAPPDATA%/OpenAI/Codex/bin` copy,
then the launching GUI's package CLI. Matching compares SHA-256 for the CLI
and every known runtime companion shipped by that package (code-mode host,
command runner and sandbox setup). Stale pins and incomplete copies are
skipped, including after an update. An explicit manual override is still
allowed when installation discovery is unavailable, subject to startup
protocol validation. Orbis neither downloads nor copies Codex executables,
and does not create or update the official cache. Its optional local metadata
cache contains only file identities and hashes, invalidated on file changes.

`--print-startup-config` without `--startup-sign-out` is the read-only
compatibility probe. The wrapper buffers its response and forwards the chosen
candidate's original stdout, stderr and exit code; native policy/auth/config
error objects remain errors and are never replaced by fabricated success JSON.
Both synchronous and asynchronous OS spawn failures can select another
candidate. Ordinary commands and sign-out are never replayed after successful
spawn, including nonzero exit. The long-running server is probed first; a
failed bridge child must close before stdio fallback, and no GUI requests may
have been sent before that fallback.

If all matching candidates fail, the wrapper removes only the Orbis-owned
user `CODEX_CLI_PATH`, verifies removal, and writes a recovery diagnostic beside
the endpoint file. A foreign value or failed registry read/write is preserved
and reported. Host shows the specific recovery reason instead of repeatedly
recommending the same failing entry. The user must fully close and reopen
Desktop to regain its native component-selection/provisioning behavior;
Orbis cannot change the environment of an already-running GUI. This may cost
one failed launch and user-controlled reopen. No application is automatically
terminated, and Host need not restart.

On a later Orbis launch request, recovery remains active until a read-only
preflight succeeds against existing files. Otherwise Host activates the
registered GUI with the Orbis override removed. Successful preflight permits
re-enabling the wrapper, but retains guidance for a GUI already running in
native mode. The recovery marker is cleared only when a bridge becomes ready;
a live endpoint takes precedence over a stale marker.

### Withdrawn: proxy through the desktop daemon

The 2026-10-04 decision above is withdrawn as impossible on Windows, not merely unimplemented. Verified against Codex desktop `26.930.3930.0` with `codex-cli 0.160.0`: the GUI spawns its own app-server as a private stdio child (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe app-server …`, no `--listen`) that no other process can attach to, while `codex app-server proxy` addresses only the managed daemon that `codex app-server daemon bootstrap` describes as "durable local app-server management for SSH-driven use"; on that build the proxy's `initialize` receives no answer and the daemon closes the control socket. The proxy transport remains in the code only as the non-Windows fallback.

Existing unqualified Codex session IDs remain terminal IDs for compatibility; desktop IDs are namespaced in the mobile protocol.

Codex stores terminal and desktop rollouts in the same native directory. Host persists IDs it has observed through the desktop backend and excludes them from terminal history and operations, including after a restart. Desktop history, including archived sessions, uses the namespaced ID. A desktop thread from before this separation that has never been observed by the new Host cannot be classified reliably from its rollout alone; it remains in the legacy terminal history until the desktop backend discovers it.
