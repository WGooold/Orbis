#!/usr/bin/env bash
# Atomically publish the caller-verified WeChat group QR into Nginx's public downloads directory.
set -Eeuo pipefail

expected="${1:?PNG SHA-256 is required}"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid PNG SHA-256' >&2; exit 2; }
incoming="/tmp/orbis-wechat-qr-$expected.png"
downloads=/var/www/orbis-downloads
destination="$downloads/wechat-group.png"
temporary="$downloads/.wechat-group.png.$expected.tmp"
trap 'rm -f "$temporary" "$incoming"' EXIT

[[ -f "$incoming" && ! -L "$incoming" ]] || { echo 'Uploaded PNG is missing or not a regular file' >&2; exit 1; }
test "$(sha256sum "$incoming" | cut -d' ' -f1)" = "$expected"
test "$(od -An -N8 -tx1 "$incoming" | tr -d ' \n')" = '89504e470d0a1a0a'

install -d -m 755 "$downloads"
install -m 644 "$incoming" "$temporary"
mv -f "$temporary" "$destination"
echo "Published WeChat group QR: $destination ($expected)"
