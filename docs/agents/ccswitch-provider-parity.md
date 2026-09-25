# CC Switch provider parity

Reference repository: `D:/cc-switch`, commit `f8788719`. The reference is MIT licensed; the notice and license are in `packages/windows-host/`.

## Scope

The requested scope is the three Agent types already exposed by Orbis: Pi, Codex, and DeepSeek Harness (DSH). Claude, Gemini, OpenCode, and the other CC Switch applications are outside this change. DSH has no CC Switch implementation, so its native `cordis.patch.yml` and ACP contract define the adaptation.

## Implemented behavior

- Provider catalog migration keeps the existing `providers.json` version and native credentials.
- Pi cards mirror explicit `models.json.providers` nodes. Add, edit, copy, enable, remove, delete, import, metadata, five API formats, headers, compat, multiple models, capability fields, unknown fields, atomic writes, revision checks, rollback, and global-default warnings are implemented.
- Pi edits preserve partial built-in overrides. Editing an existing node with only `apiKey` or other sparse fields does not inject default API, URL, or model fields. New cards still require a complete transport and model.
- Codex stores provider-owned routing separately from shared TOML settings, preserving comments and unrelated tables where the TOML editor can do so. MCP, common preferences, model catalogs, official login preservation, third-party bearer routing, stale reserved IDs, auth conflicts, and rollback are covered.
- Codex managed OAuth has a Host-owned account file, device-code flow, account binding, refresh-token rotation, identity checks, native-login import, CLI rotation adoption, and a UI for adding, reauthenticating, selecting, and removing accounts.
- Provider presets, endpoint checks, authenticated model discovery, bounded QuickJS usage scripts, New API/general/official-balance templates, per-provider usage cache, automatic refresh intervals, and last-good snapshots are implemented.
- Codex local routing now follows CC Switch's loopback takeover model: authenticated `127.0.0.1` Responses endpoint, Chat Completions and Anthropic conversion, native Responses passthrough including `/responses/compact`, explicit failover queue, circuit breaker, bounded timeouts, cancellation, prompt-cache routing, vendor reasoning mapping, request overrides, and proxy hot-switching without restarting Codex.
- The Windows Agent page exposes provider cards plus routing controls, and Android switches saved provider IDs through the existing encrypted provider protocol. Routing credentials and the local bearer token stay on the Host.
- DSH preserves the complete patch text, existing provider model rows, unknown YAML fields, and the provider's existing environment-variable name while keeping credentials in Host state.
- The Android protocol carries only saved Agent/provider IDs and status. It never carries provider credentials, raw native configuration, scripts, or OAuth tokens.
- Host supports Agent installation/update from pinned package names and isolated managed directories.

## Deliberate limits

The parity claim is limited to the three Orbis Agent kinds. CC Switch's Claude, Gemini, OpenCode, xAI OAuth account flow, and other application-specific integrations remain outside this branch. DSH is an adaptation because CC Switch has no DSH backend; its native ACP contract is preserved. Official Codex OAuth accounts are deliberately excluded from the proxy failover queue and continue using native routing. Advanced provider fields remain available in the native JSON/TOML editor; the common form covers routing, cache, reasoning, Chat options, and request overrides.

## Evidence

- `npm run typecheck` and `npm run lint` pass.
- Focused proxy, conversion, and provider-manager tests pass (39 tests in the final focused run); the full Vitest suite passed earlier at 519 tests before the final focused additions.
- `scripts/test-provider-routing.mjs` passes against installed Codex and Pi CLIs with isolated homes and a local mock upstream, including Chat/Anthropic conversion and tool round trips.
- `scripts/windows/windows-host-build.ps1` builds Qt Host and its CTest target successfully.
- Host provider smoke test exits 0 and produces provider editor/list/Pi editor screenshots with an empty QML error log.
- Android debug build and unit tests pass through `scripts/windows/android-build.ps1`.

## Release gate still required

Before merging or publishing, run the current Android build/install workflow against an explicitly owned device. The local Android debug build and unit tests already pass; no physical phone was connected during this run. The current branch has not been merged, pushed, published, or installed on a physical phone.
