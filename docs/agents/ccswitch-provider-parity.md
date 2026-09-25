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
- DSH preserves the complete patch text, existing provider model rows, unknown YAML fields, and the provider's existing environment-variable name while keeping credentials in Host state.
- The Android protocol carries only saved Agent/provider IDs and status. It never carries provider credentials, raw native configuration, scripts, or OAuth tokens.
- Host supports Agent installation/update from pinned package names and isolated managed directories.

## Deliberate limits

The native provider switching path is complete for the in-scope Agent contracts. CC Switch's local proxy takeover data plane, request conversion for non-Responses Codex presets, proxy hot-switching, circuit health, and failover queue are not part of the current Orbis Host architecture and are not silently presented as available. Codex presets that require those paths remain rejected with an explicit message. DSH is an adaptation and is not described as exact CC Switch parity.

## Evidence

- `npm run typecheck` passes.
- `npx vitest run --maxWorkers=2` passes all tests, including native round trips, sparse Pi overrides, Codex token routing and rotation, model catalog transactions, OAuth account lifecycle, usage sandbox/cache, network checks, rollback, and encrypted Android transport.
- `scripts/windows/windows-host-build.ps1` builds Qt Host and its CTest target successfully.
- Host provider smoke test exits 0 and produces provider editor/list/Pi editor screenshots with an empty QML error log.
- Android debug build and unit tests pass through `scripts/windows/android-build.ps1`.

## Release gate still required

Before merging or publishing, run the current Android build/install workflow against an explicitly owned device, verify a real Pi and Codex CLI round trip, and review the remaining proxy/failover scope with the product owner. The current branch has not been merged, pushed, published, or installed on a physical phone.
