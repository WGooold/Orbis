# Contributing to Orbis

Use https://github.com/WGooold/Orbis for issues, pull requests and releases.
Describe the observed behavior, expected behavior and a minimal reproduction.
Share sanitized diagnostics.

## Development

Use Windows Node.js 22+ for the Host and test suite. Verify `node -p "process.execPath"` points to a Windows executable, then run:

```powershell
npm ci --ignore-scripts
npm run lint
npm run typecheck
npx vitest run --maxWorkers=1 --retry=1 --testTimeout=30000
npm run build
```

Implementation belongs in `packages/*/src`. Workspace imports use package names, and the Pi manifest points to the built `dist/index.js`. Rebuild and activate a fresh Pi process to load extension changes.

Windows GUI: see `packages/windows-host/README.md`. Android: see `android/README.md`; use the shared build and device wrappers.

Read `CONTEXT.md` and the relevant `docs/adr/` before changing domain behavior. Record material architecture decisions and verify changed behavior with focused tests. Keep experiments in ignored `.scratch/` and public documentation self-contained.

## Releases

Relay deploys through `.github/workflows/relay-deploy.yml` from `main` and the `production` environment. See `docs/deployment.md`.

Contributions are provided under the repository's MIT license. Preserve third-party notices when incorporating upstream code or assets.
