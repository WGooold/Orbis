#!/usr/bin/env bash
# Run on the server during initial setup; Relay application deploys use GitHub Actions.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -m 644 "$root/deploy/turnserver.conf" /etc/turnserver.conf
systemctl enable coturn
systemctl restart coturn
systemctl is-active coturn
