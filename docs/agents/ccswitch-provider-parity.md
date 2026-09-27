# CC Switch provider parity

Reference repository: `D:/cc-switch`, commit `f8788719`. The reference is MIT licensed; the notice and license are in `packages/windows-host/`.

## Scope

The requested scope is the three Agent types already exposed by Orbis: Pi, Codex, and DeepSeek Harness (DSH). Claude, Gemini, OpenCode, and the other CC Switch applications are outside this change. DSH has no CC Switch implementation, so its native `cordis.patch.yml` and Web RPC contract define the adaptation (ADR-0020).

## Implemented behavior

- Provider catalog migration keeps the existing `providers.json` version and native credentials.
- Pi cards mirror explicit `models.json.providers` nodes. Add, edit, copy, enable, remove, delete, import, metadata, five API formats, headers, compat, multiple models, capability fields, unknown fields, atomic writes, revision checks, rollback, and global-default warnings are implemented.
- Pi edits preserve partial built-in overrides. Editing an existing node with only `apiKey` or other sparse fields does not inject default API, URL, or model fields. New cards still require a complete transport and model.
- Codex stores provider-owned routing separately from shared TOML settings, preserving comments and unrelated tables where the TOML editor can do so. MCP, common preferences, model catalogs, official login preservation, third-party bearer routing, stale reserved IDs, auth conflicts, and rollback are covered.
- Codex managed OAuth has a Host-owned account file, device-code flow, account binding, refresh-token rotation, identity checks, native-login import, CLI rotation adoption, and a UI for adding, reauthenticating, selecting, and removing accounts.
- Provider presets, endpoint checks, authenticated model discovery, bounded QuickJS usage scripts, New API/general/official-balance templates, per-provider usage cache, automatic refresh intervals, and last-good snapshots are implemented. Usage querying remains a backend capability; the Windows usage settings, query actions, and result display are deliberately removed.
- The Windows provider editor uses a single preset/custom entry point, searchable presets, structured fields with native-config round trips, and explicit confirmation before discarding edits or replacing a dirty draft. Incomplete drafts can switch editor modes without weakening save validation. Official Codex profiles expose login-source selection without requiring an API key or custom endpoint; ordinary form edits preserve native authentication.
- Provider lists support search, persisted drag/arrow ordering, and copies immediately after their source. Connectivity checks have per-card progress and do not block unrelated editing.
- Codex's default-model field fills missing values with `gpt-5.6-sol`; missing reasoning effort defaults to `high`, matching CC Switch's Codex templates. Its adjacent discovery button opens a single-selection picker that replaces the default model. The separate Codex catalog editor is removed; existing catalog data remains in native configuration and is not overwritten by ordinary form saves.
- Pi and DSH model sections offer bulk discovery beside Add Model and a per-row picker beside the model ID. Pi follows CC Switch's new-row defaults: text input, reasoning disabled, and blank context/output fields with `128000` / `16384` placeholders. DSH has no CC Switch equivalent, so its adapted new-row defaults remain 262144 context / 32768 output, text-only, and no declared reasoning. Selection deduplicates IDs and preserves existing capability fields. DSH persists the whole native model list and requires its selected default to name a listed model when that list is explicitly edited; native credentials, other providers, and unknown fields are retained.
- Codex local routing now follows CC Switch's loopback takeover model: authenticated `127.0.0.1` Responses endpoint, Chat Completions and Anthropic conversion, native Responses passthrough including `/responses/compact`, explicit failover queue, circuit breaker, bounded timeouts, cancellation, prompt-cache routing, vendor reasoning mapping, request overrides, and proxy hot-switching without restarting Codex.
- The Windows Agent page exposes provider cards but no global routing/failover dialog, route-health display, or circuit-reset action. Existing routing configuration and backend conversion/failover remain intact. Android switches saved provider IDs through the existing encrypted provider protocol. Routing credentials and the local bearer token stay on the Host.
- DSH preserves the complete patch text, existing provider model rows, unknown YAML fields, and the provider's existing environment-variable name while keeping credentials in Host state and syncing them to the native local Web credential store. Browser-only running sessions also block a provider switch.
- The Android protocol carries only saved Agent/provider IDs and status. It never carries provider credentials, raw native configuration, scripts, or OAuth tokens.
- Host supports Agent installation/update from pinned package names and isolated managed directories, npm dist-tag checks, exact global npm-prefix updates, validated activation, cancellation, batch operations, installation history, and rollback. DSH requires the published ACP-compatible 0.1.7-rc.1 package when the registry's latest tag is older.

## Deliberate limits

The parity claim is limited to the three Orbis Agent kinds. CC Switch's Claude, Gemini, OpenCode, xAI OAuth account flow, and other application-specific integrations remain outside this branch. DSH is an adaptation because CC Switch has no DSH backend; its native Web service owns shared sessions; native HMR and credential writes apply provider changes without restarting the service. Official Codex OAuth accounts are deliberately excluded from the proxy failover queue and continue using native routing. Advanced provider fields remain available in the native JSON/TOML editor; the common form covers routing, cache, reasoning, Chat options, and request overrides.

## Model selection verification (2026-09-27)

- Extended the existing model-merge and native round-trip tests to cover row selection, deduplication, capability preservation, DSH model-list validation, and preservation of hidden Codex catalog data.
- Windows provider smoke tests use an isolated authenticated loopback model-list endpoint, not real provider credentials. Actual mouse clicks cover Codex single selection, Pi/DSH bulk selection, DSH per-row selection, and save/reopen persistence.
- Normal and minimum-window runs both exit 0 with empty QML logs: `.artifacts/provider-model-picker/smoke-normal-20260927-173939/` and `.artifacts/provider-model-picker/smoke-compact-20260927-174018/`.
- Long smoke-step timers use precise scheduling: coarse timers previously allowed the DSH save verification to run before the preceding selection/save step.

## Provider flow verification (2026-09-27)

Worktree: `D:/orbis-worktrees/provider-flow-parity`, branch `feat/provider-flow-parity`.

- Windows Node toolchain: `npm run lint` and `npm run check` pass (67 test files, 624 tests). Logs: `.artifacts/provider-flow/check.log`.
- `scripts/windows/windows-host-build.ps1` builds the Host and passes both native tests. Log: `.artifacts/provider-flow/build.log`.
- Normal and minimum-window provider smoke tests both exit 0 with empty QML logs. They exercise real mouse drag ordering, Pi create/copy/enable/remove, official Codex form saving, incomplete draft mode round trips, multi-model saving/reopening, and Codex activation.
- Screenshots and isolated smoke data: `.artifacts/provider-flow/final-normal-20260927-160610/` and `.artifacts/provider-flow/final-compact-20260927-160636/`.
- The drag test caught a card-sizing defect caused by the added drop layer; setting the card's content height from its layout restored both card geometry and drop hit testing.
- No running user Host was stopped, restarted, or overwritten. No push, release, or deployment was performed.

## Earlier evidence

- `npm run typecheck` and `npm run lint` pass.
- The full Vitest suite passes with 561 tests. The final installation-detection adjustment passes 41 focused tests, and release website validation passes 9 tests.
- `scripts/test-provider-routing.mjs` passes against installed Codex and Pi CLIs with isolated homes and a local mock upstream, including Chat/Anthropic conversion and tool round trips.
- `scripts/windows/windows-host-build.ps1` builds Qt Host and its CTest target successfully.
- Host provider smoke test exits 0 and produces provider editor/list/Pi editor screenshots with an empty QML error log.
- Android 0.1.46 (versionCode 47) builds through `scripts/windows/android-build.ps1`; all 294 unit tests pass. Its signing certificate matches the previous official APK.

## Release verification

On 2026-09-26, the release APK was installed through `scripts/windows/android-install.ps1` on the explicitly owned `emulator-5554`. Both provider-filter instrumentation tests pass, including current-provider selection and missing-configuration handling. Screenshots and logs are retained under `.artifacts/release-v0.1.5/android-smoke/`. The emulator was closed and its leases released. No physical phone or user Host installation was changed during release preparation.
