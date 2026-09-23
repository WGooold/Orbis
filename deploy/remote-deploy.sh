#!/usr/bin/env bash
# Runs on the Relay host. It expects the source archive and shared relay.env to
# already exist on that host. Secrets are preserved across releases.
# Invoked over SSH by .github/workflows/relay-deploy.yml — the only deployment
# entry point. This script never runs on a developer machine.
set -Eeuo pipefail

release="${1:?release id is required}"
archive="${2:?source archive path is required}"
app="${3:-/opt/orbis}"
public_health_url="${4:-https://relay.example.com/healthz}"
downloads_archive="${5:-}"

if [[ ! "$release" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Invalid release id: $release" >&2
  exit 2
fi
if [[ ! -f "$archive" ]]; then
  echo "Source archive does not exist: $archive" >&2
  exit 2
fi

shared="$app/shared"
env_file="$shared/relay.env"
data_dir="$shared/data"
release_dir="$app/releases/$release"
image="pi-remote-relay:$release"
candidate="pi-remote-relay-candidate-$release"
previous="pi-remote-relay-previous-$(date +%s)"
old_moved=0
new_started=0

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Run the one-time server setup before deploying." >&2
  exit 2
fi

rollback() {
  local status=$?
  set +e
  docker rm -f "$candidate" >/dev/null 2>&1 || true
  if [[ "$new_started" -eq 1 ]]; then
    docker rm -f pi-remote-relay >/dev/null 2>&1 || true
  fi
  if [[ "$old_moved" -eq 1 ]]; then
    docker rename "$previous" pi-remote-relay >/dev/null 2>&1 || true
    docker start pi-remote-relay >/dev/null 2>&1 || true
  fi
  echo "Relay deployment failed; the previous container was restored when available." >&2
  exit "$status"
}
trap rollback ERR

install -d -m 755 "$app/releases" "$shared" "$data_dir"
# The official Node image runs as uid/gid 1000.
chown 1000:1000 "$data_dir"
chmod 700 "$data_dir"

# Release downloads are separate from source and secrets. Only the CI-selected,
# checksummed Windows artifact is published, and the container gets a read-only mount.
install -d -m 755 "$shared/download-releases/empty"
downloads_dir="$(readlink -f "$shared/downloads-current" 2>/dev/null || true)"
if [[ ! -d "$downloads_dir" ]]; then downloads_dir="$shared/download-releases/empty"; fi
if [[ -n "$downloads_archive" ]]; then
  downloads_dir="$shared/download-releases/$release"
  install -d -m 755 "$downloads_dir"
  tar -xzf "$downloads_archive" --no-same-owner -C "$downloads_dir"
  (cd "$downloads_dir" && sha256sum -c OrbisHost-0.1.2-windows-x64-setup.exe.sha256 && sha256sum -c OrbisHost-0.1.2-windows-x64.zip.sha256)
  chmod 644 "$downloads_dir"/*
fi

rm -rf "$release_dir"
install -d -m 755 "$release_dir"
tar -xzf "$archive" -C "$release_dir"

cd "$release_dir"
# Build the archived source, never a developer machine dist directory.
docker build --build-arg "ORBIS_RELEASE_COMMIT=$release" -t "$image" -f Dockerfile .

# Start an isolated candidate first. It has no host port and receives no public
# traffic, but proves that the built image can load the persisted state and pass
# its health endpoint before the active container is touched.
docker rm -f "$candidate" >/dev/null 2>&1 || true
docker run -d \
  --name "$candidate" \
  --env-file "$env_file" \
  -v "$data_dir:/data" \
  -v "$downloads_dir:/downloads:ro" -e ORBIS_DOWNLOADS_DIR=/downloads \
  "$image" >/dev/null

candidate_healthy=0
for _ in $(seq 1 40); do
  if docker exec "$candidate" node -e \
    "fetch('http://127.0.0.1:8787/healthz').then(r => { if (!r.ok) process.exit(1) })" \
    >/dev/null 2>&1; then
    candidate_healthy=1
    break
  fi
  sleep 1
done
if [[ "$candidate_healthy" -ne 1 ]]; then
  docker logs --tail 80 "$candidate" >&2 || true
  false
fi
docker rm -f "$candidate" >/dev/null

# Keep the former container intact until both local and public health checks pass.
if docker inspect pi-remote-relay >/dev/null 2>&1; then
  docker rm -f "$previous" >/dev/null 2>&1 || true
  docker rename pi-remote-relay "$previous"
  docker stop "$previous" >/dev/null || true
  old_moved=1
fi

docker run -d \
  --name pi-remote-relay \
  --restart unless-stopped \
  --env-file "$env_file" \
  -v "$data_dir:/data" \
  -v "$downloads_dir:/downloads:ro" -e ORBIS_DOWNLOADS_DIR=/downloads \
  -p 127.0.0.1:8787:8787 \
  "$image" >/dev/null
new_started=1

local_healthy=0
for _ in $(seq 1 40); do
  if local_health_body="$(curl -fsS --max-time 3 http://127.0.0.1:8787/healthz 2>/dev/null)" &&
    grep -q '"status":"ok"' <<<"$local_health_body"; then
    local_healthy=1
    break
  fi
  sleep 1
done
if [[ "$local_healthy" -ne 1 ]]; then
  docker logs --tail 80 pi-remote-relay >&2 || true
  false
fi

if ! public_health_body="$(curl -fsS --max-time 15 "$public_health_url")"; then
  echo "Public health check failed: $public_health_url" >&2
  false
fi
if ! grep -q '"status":"ok"' <<<"$public_health_body"; then
  echo "Public health check returned an unexpected response: $public_health_body" >&2
  false
fi
if ! grep -q "\"commit\":\"$release\"" <<<"$public_health_body"; then
  echo "Public health check is not serving the expected commit $release" >&2
  false
fi

# Pages and authentication must pass before marking the release healthy, so
# missing web assets still use the same container rollback as Relay failures.
site_url="${public_health_url%/healthz}/"
site_body="$(curl -fsS --max-time 20 "$site_url")"
admin_body="$(curl -fsS --max-time 20 "${site_url}admin/")"
grep -q 'Easy Agents Everywhere' <<<"$site_body"
grep -q 'Relay 控制台' <<<"$admin_body"
admin_status="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "${site_url}v1/admin/overview")"
test "$admin_status" = 401

ln -sfn "$release_dir" "$app/current"
ln -sfn "$downloads_dir" "$shared/downloads-current"
# This marker lets the CI entry point compare the next HEAD with the version
# actually running on this host, instead of guessing from the latest commit.
printf '%s\n' "$release" > "$shared/deployed-commit"
chmod 600 "$shared/deployed-commit"
if [[ "$old_moved" -eq 1 ]]; then
  docker rm "$previous" >/dev/null 2>&1 || true
fi
old_moved=0
new_started=0
rm -f "$archive"
if [[ -n "$downloads_archive" ]]; then rm -f "$downloads_archive"; fi

# Keep the three newest source releases and discard dangling build layers.
mapfile -t old_releases < <(
  find "$app/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -nr |
    tail -n +4 |
    cut -d' ' -f2-
)
if [[ "${#old_releases[@]}" -gt 0 ]]; then
  rm -rf -- "${old_releases[@]}"
fi
docker image prune -f >/dev/null

trap - ERR
echo "Relay release $release is healthy at $public_health_url"
