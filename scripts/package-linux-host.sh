#!/usr/bin/env bash
# Build on the matching Linux architecture with the pinned release toolchain, after npm run build.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ $(uname -s) == Linux ]] || { echo 'Use a native Linux build environment' >&2; exit 2; }
case "$(uname -m):$(node -p 'process.arch')" in
  x86_64:x64) arch=x64 ;;
  aarch64:arm64) arch=arm64 ;;
  *) echo 'Mismatched or unsupported build architecture' >&2; exit 2 ;;
esac
version=$(sed -nE 's/^project\(OrbisHost VERSION ([0-9]+\.[0-9]+\.[0-9]+) .*$/\1/p' packages/windows-host/CMakeLists.txt)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
name="OrbisHost-$version-linux-$arch-cli"
output=.artifacts/linux-host
mkdir -p "$output"
stage=$(mktemp -d "$output/.stage.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
bundle="$stage/$name"
# Match the bundled Node; do not inherit unrelated cross-compilation settings.
env -u GOOS -u GOARCH node scripts/package-host-runtime.mjs "$bundle/runtime"
printf '%s\n' "$version" > "$bundle/VERSION"
cat > "$bundle/orbis" <<'LAUNCHER'
#!/bin/sh
set -eu
here=$(dirname -- "$(readlink -f -- "$0")")
if [ "${1-}" = "--version" ] && [ "$#" -eq 1 ]; then
  cat "$here/VERSION"
  exit 0
fi
export PATH="$here/runtime/node:$PATH"
exec "$here/runtime/node/node" --enable-source-maps "$here/runtime/packages/host/dist/cli.js" "$@"
LAUNCHER
chmod 755 "$bundle/orbis"
tar -C "$stage" -czf "$stage/$name.tar.gz" "$name"
(cd "$stage" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
mv -- "$stage/$name.tar.gz" "$stage/$name.tar.gz.sha256" "$output/"
