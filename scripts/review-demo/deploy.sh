#!/usr/bin/env bash
set -euo pipefail
task_dir=/opt/orbis-review
release_dir=${1:?release directory required}
image=${2:?image tag required}
commit=${3:?source commit required}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
base_image="orbis-review-base:$commit"
test -s "$task_dir/private/host.json"
test -s "$task_dir/private/deepseek.key"
docker build --build-arg "ORBIS_RELEASE_COMMIT=$commit" -t "$base_image" "$release_dir"
docker build --build-arg "BASE_IMAGE=$base_image" -f "$release_dir/scripts/review-demo/Dockerfile" -t "$image" "$release_dir"
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
site=$(readlink -f /etc/nginx/sites-enabled/orbis 2>/dev/null || true)
proxy_site=/etc/nginx/conf.d/orbis-hk149.conf
snippet=/etc/nginx/snippets/orbis-review-demo.conf
snippet_include=$snippet
proxy_include=/etc/nginx/snippets/orbis-proxy.conf
nginx_test() { nginx -t; }
nginx_reload() { systemctl reload nginx; }
# 1Panel owns the shared HTTP(S) listeners on the migrated Relay server.
if [[ -f /opt/1panel/www/conf.d/orbis.conf ]]; then
    site=/opt/1panel/www/conf.d/orbis.conf
    proxy_site=""
    snippet=/opt/1panel/apps/openresty/openresty/conf/ssl/orbis/review-locations.conf
    snippet_include=/usr/local/openresty/nginx/conf/ssl/orbis/review-locations.conf
    proxy_include=/usr/local/openresty/nginx/conf/ssl/orbis/proxy.conf
    nginx_container=$(docker ps --filter name=1Panel-openresty --format '{{.Names}}')
    [[ -n "$nginx_container" && "$nginx_container" != *$'\n'* ]]
    nginx_test() { docker exec "$nginx_container" /usr/local/openresty/nginx/sbin/nginx -t; }
    nginx_reload() { docker exec "$nginx_container" /usr/local/openresty/nginx/sbin/nginx -s reload; }
fi
test -f "$site"
snippet_existed=false
if [[ -f "$snippet" ]]; then
    cp -p "$snippet" "$task_dir/nginx-snippet-before-review.conf"
    snippet_existed=true
fi
sed "s|/etc/nginx/snippets/orbis-proxy.conf|$proxy_include|g" "$release_dir/scripts/review-demo/nginx.conf" > "$snippet"
chmod 644 "$snippet"
cp -p "$site" "$task_dir/nginx-before-review.conf"
sites=("$site")
if [[ -n "$proxy_site" && -f "$proxy_site" ]]; then
    cp -p "$proxy_site" "$task_dir/nginx-hk-before-review.conf"
    sites+=("$proxy_site")
fi
python3 - "$snippet_include" "${sites[@]}" <<'PY'
from pathlib import Path
import sys
include = 'include ' + sys.argv[1] + ';'
for name in sys.argv[2:]:
    p=Path(name); text=p.read_text()
    if include not in text:
        anchor='    location = /relay { return 308 /relay/; }'
        if anchor not in text: raise SystemExit('HTTPS location anchor missing: '+name)
        text=text.replace(anchor, '    '+include+'\n'+anchor)
        p.write_text(text)
PY
if ! nginx_test; then
    if [[ "$snippet_existed" == true ]]; then cp -p "$task_dir/nginx-snippet-before-review.conf" "$snippet"; else rm -f "$snippet"; fi
    cp -p "$task_dir/nginx-before-review.conf" "$site"
    if [[ "${#sites[@]}" -gt 1 ]]; then cp -p "$task_dir/nginx-hk-before-review.conf" "$proxy_site"; fi
    exit 1
fi
nginx_reload
printf '%s\n' "$image" > "$task_dir/deployed-image"
echo 'Dedicated review Host deployed; production Relay was not restarted.'
