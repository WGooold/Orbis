#!/usr/bin/env bash
set -euo pipefail
task_dir=/opt/orbis-review
release_dir=${1:?release directory required}
image=${2:?image tag required}
test -s "$task_dir/private/host.json"
test -s "$task_dir/private/deepseek.key"
docker build -f "$release_dir/scripts/review-demo/Dockerfile" -t "$image" "$release_dir"
mkdir -p "$task_dir/data/home" "$task_dir/data/workspace" "$task_dir/data/host"
chown -R 1000:1000 "$task_dir/data"
chmod 700 "$task_dir/data"
previous=$(docker inspect -f '{{.Config.Image}}' orbis-review-host 2>/dev/null || true)
start_host() {
    docker run -d --name orbis-review-host --hostname orbis-review-demo --init \
        --restart unless-stopped --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
        --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m \
        --publish 127.0.0.1:8788:8788 --publish 127.0.0.1:8789:8787 \
        --mount "type=bind,src=$task_dir/data,dst=/data" \
        --mount "type=bind,src=$task_dir/private/host.json,dst=/run/secrets/host.json,readonly" \
        --mount "type=bind,src=$task_dir/private/deepseek.key,dst=/run/secrets/deepseek.key,readonly" \
        --log-opt max-size=5m --log-opt max-file=2 "$1" >/dev/null
}
docker stop --time 20 orbis-review-host >/dev/null 2>&1 || true
docker rm orbis-review-host >/dev/null 2>&1 || true
start_host "$image"
healthy=false
for _ in $(seq 1 45); do
    if curl -fsS --max-time 3 http://127.0.0.1:8788/healthz >/dev/null 2>&1; then healthy=true; break; fi
    sleep 2
done
if [ "$healthy" != true ]; then
    docker logs --tail 40 orbis-review-host
    docker stop --time 20 orbis-review-host >/dev/null 2>&1 || true
    docker rm orbis-review-host >/dev/null 2>&1 || true
    if [ -n "$previous" ]; then start_host "$previous"; fi
    exit 1
fi
install -m 644 "$release_dir/scripts/review-demo/nginx.conf" /etc/nginx/snippets/orbis-review-demo.conf
# The existing site has both direct HTTPS and Hong Kong proxy-protocol listeners.
site=$(readlink -f /etc/nginx/sites-enabled/orbis)
proxy_site=/etc/nginx/conf.d/orbis-hk149.conf
cp -p "$site" "$task_dir/nginx-before-review.conf"
cp -p "$proxy_site" "$task_dir/nginx-hk-before-review.conf"
python3 - "$site" "$proxy_site" <<'PY'
from pathlib import Path
import sys
for name in sys.argv[1:]:
    p=Path(name); text=p.read_text()
    if 'include /etc/nginx/snippets/orbis-review-demo.conf;' not in text:
        anchor='    location = /relay { return 308 /relay/; }'
        if anchor not in text: raise SystemExit('HTTPS location anchor missing: '+name)
        text=text.replace(anchor, '    include /etc/nginx/snippets/orbis-review-demo.conf;\n'+anchor)
        p.write_text(text)
PY
if ! nginx -t; then
    cp -p "$task_dir/nginx-before-review.conf" "$site"
    cp -p "$task_dir/nginx-hk-before-review.conf" "$proxy_site"
    exit 1
fi
systemctl reload nginx
printf '%s\n' "$image" > "$task_dir/deployed-image"
echo 'Dedicated review Host deployed; production Relay was not restarted.'
