# Contributing to Orbis

Use https://github.com/WGooold/Orbis for issues, pull requests and releases.
Describe the observed behavior, expected behavior and a minimal reproduction.
Remove tokens, pairing QR codes, mailbox addresses and private conversation data from diagnostics.

## Development

Use Windows Node.js 22+ for the Host and test suite. Verify `node -p "process.execPath"` points to a Windows executable, then run:

```powershell
npm ci --ignore-scripts
npm run lint
npm run typecheck
npx vitest run --maxWorkers=1 --retry=1 --testTimeout=30000
npm run build
```

Implementation belongs in `packages/*/src`. Do not edit or commit generated `dist`, dependencies, build products or local state. Workspace imports use package names; read ADR-0004 before changing module resolution.

Windows GUI: see `packages/windows-host/README.md`. Android: see `android/README.md`; use the build wrapper to preserve the shared build lock and device provenance. Do not clear another developer's device data.

Read `CONTEXT.md` and the relevant `docs/adr/` before changing domain behavior. Add an ADR for a material architecture decision and focused tests for changed behavior. Keep local experiments in ignored `.scratch/`; public issues and docs must stand alone without that directory.

## Releases

Relay deploys exclusively through `.github/workflows/relay-deploy.yml` from `main` and the `production` environment. Never commit production secrets. See `docs/deployment.md`.

Contributions are provided under the repository's MIT license. Preserve third-party notices when incorporating upstream code or assets.
