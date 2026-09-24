# Orbis Host for Windows

Windows x64 desktop client, implemented in C++20, Qt 6.8 and QML. The interface follows Orbis's soft, light neumorphic surfaces. The Qt application manages a private stdin/stdout Host subprocess; the existing TypeScript Host continues to own agent integration, pairing, encryption and transport.

## Using the portable build

Extract the entire ZIP, then double-click `OrbisHost.exe`. Keep the DLLs, `qml`, `plugins` and `runtime` directories alongside it. Node, npm, the Pi extension and the required JavaScript/native dependencies are included; source code, Qt and a global Node installation are not required on the destination computer.

1. Activate this computer according to the selected Relay's policy. By default, verify an `@qq.com` mailbox; when the operator disables that requirement, activate directly without an email. Numeric and QQ alias addresses are accepted when verification is required; other domains, including `foxmail.com`, are excluded.
2. Review Pi/Codex/DeepSeek Harness on the Agent page. Install or update from npm while Host is paused; the new version is selected without replacing the previous installation. Manage providers under each Agent: basic forms configure a compatible API, while advanced JSON preserves native options. Existing native configuration is imported on refresh.
3. Start Host and choose Add phone. Scan the short-lived QR code in Orbis Android.

The Overview page provides **Open Pi**, **Open Codex** and **Open DeepSeek Harness** shortcuts. Pi and Codex open their interactive terminal interfaces in your Windows user directory; Pi loads the Orbis integration automatically. DeepSeek opens its official Web workspace. These local shortcuts do not require Relay activation. If an agent is missing, use the Agent page to detect or install it. The Agent page's separate Codex login action remains available for account setup. When DeepSeek is installed but its phone backend is disabled, Overview links to Settings to enable it; opening the Web workspace alone does not enable phone access.

Email activation requires server-side SMTP. Without SMTP and with verification required, the server returns `registration_unavailable`. Direct activation is available only while the Relay operator explicitly disables verification; it still issues a Host-bound credential. Self-hosted servers are selectable in Settings and publish their own activation policy.

DeepSeek Harness is opt-in under Settings. Enable it and restart the Host, then choose DeepSeek when creating a session on Android. The Agent page opens `dsh web` for local use; Orbis runs its own background `acp` profile. Configuration and supported capabilities are documented in [DeepSeek Harness integration](../../docs/deepseek-harness.md).

Provider switching follows CC Switch's native-file model: Codex saves the outgoing `auth.json`/`config.toml` snapshot and applies the selected snapshot; Pi adds or removes explicit nodes in `models.json.providers` while retaining `/login`, `auth.json`, and default-model settings; DSH switches the home-level `cordis.patch.yml` and restarts its ACP connection. Orbis keeps its provider catalog in the local Host state directory. API keys and Codex auth snapshots stay on the computer; the Android app receives names, IDs and enabled state only. Codex and DSH refuse switching while a task or approval is in progress. Reopen existing sessions and standalone terminals after switching; reopen Pi to load changed explicit providers, then choose a model with `/model`. The Android Settings page can enable or switch providers already configured on the Host. Codex OAuth tokens may require signing in again after an older snapshot is restored; Orbis does not refresh them.

Closing the window leaves the application in the tray. Use Exit from the tray menu to quit. Pausing stops this Host and its Codex/DSH backends; running work in Host-owned headless sessions may be interrupted. Independent terminal sessions are not forcibly terminated. Updating or uninstalling retains activation and pairing data.

Desktop settings and DPAPI-encrypted activation are stored in the current Windows user's local Orbis application-data directory. Pairing identity stays in `~/.pi-remote/` for compatibility with existing Pi loopback discovery. An already-running CLI Host is detected; stop it in its original window before starting the desktop Host. Credentials cannot be copied to another Windows account.

## Development

Use the Windows toolchain. Node >=22.19, CMake and Ninja must be on PATH. Install the matching Qt/MinGW kit once:

```powershell
scripts/windows/windows-host-setup.ps1
npm ci --ignore-scripts --no-audit --no-fund
scripts/windows/windows-host-build.ps1 -Package
```

The build script uses only two C++ compiler workers and checks the native credential store. Packaging collects the installed runtime dependency closure, preserving exact versions and licenses, then tests the executable with development tooling removed from PATH. Products are under `.artifacts/windows-host/<timestamp>/`.

To build an installer using an independently installed Inno Setup 6 compiler, add `-InnoCompiler 'path\to\ISCC.exe'`. The installer is per-user and does not require administrator privileges. Distributed preview binaries are unsigned until a code-signing certificate is configured.

For development, run the built executable with `--runtime-root <repository>`. `--data-dir <directory> --host-state-dir <directory>` isolate desktop/Host data. `--smoke-test --screenshot <png>` renders the actual QML window, checks the bundled Host and exits. Smoke tests automatically isolate Host identity if no state directory was supplied; they do not send emails or start agent sessions.

## Registration service

The Relay provides these endpoints under its existing URL prefix:

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/registration/status` | Whether registration is available, whether QQ verification is required, and whether SMTP is configured |
| `POST /v1/registration/code` | Accepts `email`, `hostId`; emails a six-digit code and returns an opaque `challengeId` |
| `POST /v1/registration/activate` | With verification required: accepts those fields plus `challengeId`, `code`; with verification optional: accepts only `hostId`. Returns one Host-bound credential. |

Codes expire after 10 minutes, can be used once, allow five verification attempts, and have resend/address/source limits. Only credential hashes are persisted by Relay. Verified Host credentials can create pairing codes for their own devices and cannot access administrator routes or another Host's routing identity. Re-verification rotates that Host's credential.

The Relay console's Service page defaults to requiring QQ verification. Turning it off allows new Hosts to activate without mail, while preserving one-Host credential scope and source rate limits. Turning it back on affects only new activations; existing Host credentials remain valid. Windows 0.1.1 reads the current policy before showing the activation controls.

Configure server-side SMTP through environment variables, never through the Windows client:

```dotenv
ORBIS_SMTP_HOST=smtp.example.com
ORBIS_SMTP_PORT=465
ORBIS_SMTP_FROM=Orbis <noreply@example.com>
ORBIS_SMTP_USER=noreply@example.com
ORBIS_SMTP_PASSWORD=<SMTP authorization secret>
ORBIS_REGISTRATION_STATE_FILE=/data/registrations.json
# Only behind a trusted proxy that overwrites X-Real-IP:
ORBIS_TRUST_PROXY=1
```

Port 465 uses TLS; other ports require STARTTLS. Any suitable SMTP provider may send to QQ mailboxes. Keep registration state durable across deployments. Existing authenticated Hosts continue to work if SMTP is temporarily disabled. Official Relay deployment remains exclusively `.github/workflows/relay-deploy.yml`; adding SMTP configuration does not require embedding or distributing an administrator token.

## Validation

`npm run lint`, `npm run typecheck`, `npx vitest run --maxWorkers=2`, native CTest, and the packaged executable smoke test. Mail tests use an in-memory sender. Real SMTP delivery and a clean-machine Windows install remain separate acceptance steps when the provider and distribution environment are available.
