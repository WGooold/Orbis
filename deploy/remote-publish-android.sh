#!/usr/bin/env bash
# Invoked only by relay-deploy.yml after verifying a pinned GitHub release APK.
set -Eeuo pipefail

expected="${1:?APK SHA-256 is required}"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid APK SHA-256' >&2; exit 2; }
incoming="/tmp/orbis-android-$expected"
downloads=/var/www/orbis-downloads
backup="/var/www/.orbis-android-backups/$(date -u +%Y%m%dT%H%M%S)-$expected"
public=https://orbising.com/downloads

exec 9>/var/lock/orbis-android-publish.lock
flock -x 9

test -f "$incoming/orbis.apk"
test -f "$incoming/orbis.apk.sha256"
test "$(sha256sum "$incoming/orbis.apk" | cut -d' ' -f1)" = "$expected"
test "$(tr -d '\r\n' < "$incoming/orbis.apk.sha256")" = "$expected  orbis.apk"
(cd "$incoming" && tr -d '\r' < orbis.apk.sha256 | sha256sum -c -)

install -d -m 755 "$downloads"
install -d -m 700 "$backup"
for name in orbis.apk orbis.apk.sha256; do
  if [[ -e "$downloads/$name" ]]; then cp -p "$downloads/$name" "$backup/$name"; fi
done

rollback() {
  local status=$?
  trap - ERR
  set +e
  for name in orbis.apk orbis.apk.sha256; do
    if [[ -f "$backup/$name" ]]; then
      install -m 644 "$backup/$name" "$downloads/.$name.rollback-$expected" &&
        mv -f "$downloads/.$name.rollback-$expected" "$downloads/$name"
    else
      rm -f "$downloads/$name"
    fi
  done
  echo 'Android publication failed; restored previous downloads.' >&2
  exit "$status"
}
trap rollback ERR

for name in orbis.apk orbis.apk.sha256; do
  install -m 644 "$incoming/$name" "$downloads/.$name.$expected"
  mv -f "$downloads/.$name.$expected" "$downloads/$name"
done
(cd "$downloads" && sha256sum -c orbis.apk.sha256)

curl -fsSL --connect-timeout 15 --max-time 180 -H 'Cache-Control: no-cache' \
  "$public/orbis.apk?sha256=$expected" -o "$incoming/public.apk"
test "$(sha256sum "$incoming/public.apk" | cut -d' ' -f1)" = "$expected"
curl -fsSL --connect-timeout 15 --max-time 30 -H 'Cache-Control: no-cache' \
  "$public/orbis.apk.sha256?sha256=$expected" -o "$incoming/public.sha256"
test "$(tr -d '\r\n' < "$incoming/public.sha256")" = "$expected  orbis.apk"

trap - ERR
rm -f "$incoming/orbis.apk" "$incoming/orbis.apk.sha256" "$incoming/public.apk" "$incoming/public.sha256"
rmdir "$incoming"
echo "Verified Android website download SHA-256: $expected"
