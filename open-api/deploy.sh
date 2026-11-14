#!/usr/bin/env bash
set -euo pipefail

project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote="${1:?Usage: bash open-api/deploy.sh user@host}"
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8)
stage="$(ssh "${ssh_options[@]}" "$remote" 'mktemp -d /opt/zerror-open-api-stage.XXXXXX')"
[[ "$stage" =~ ^/opt/zerror-open-api-stage\.[[:alnum:]]+$ ]]

COPYFILE_DISABLE=1 tar --no-xattrs --exclude='._*' --exclude='.DS_Store' -czf - -C "$project" src open-api test/fixtures.json \
  | ssh "${ssh_options[@]}" "$remote" "tar -xzf - -C '$stage'"

ssh "${ssh_options[@]}" "$remote" bash -s -- "$stage" <<'REMOTE'
set -euo pipefail

stage="$1"
app=/opt/zerror-open-api
config=/etc/nginx/conf.d/zerror-open-api.conf
unit=zerror-open-api.service
unit_file=/etc/systemd/system/$unit
backup="$stage/backup"
mkdir "$backup"
test -x "$app/runtime/bin/node"
test -f "$unit_file"
test -f "$config"
cp -p "$unit_file" "$config" "$backup/"
fixture_file="$app/test/fixtures.json"
if [ -f "$fixture_file" ]; then
    cp -p "$fixture_file" "$backup/fixtures.json"
fi
mutating=0

finish() {
    status=$?
    if [ "$status" -ne 0 ] && [ "$mutating" = 1 ]; then
        systemctl stop "$unit" || true
        for dir in src open-api; do
            if [ -e "$backup/$dir" ]; then
                rm -rf "$app/$dir"
                mv "$backup/$dir" "$app/$dir"
            elif [ -f "$backup/new-$dir" ]; then
                rm -rf "$app/$dir"
            fi
        done
        if [ -f "$backup/fixtures.json" ]; then
            cp -p "$backup/fixtures.json" "$fixture_file"
        else
            rm -f "$fixture_file"
        fi
        cp -p "$backup/$unit" "$unit_file"
        cp -p "$backup/zerror-open-api.conf" "$config"
        systemctl daemon-reload
        systemctl start "$unit"
        nginx -t && systemctl reload nginx
    fi
    rm -rf "$stage"
}
trap finish EXIT

"$app/runtime/bin/node" --test "$stage/open-api/server.test.js"
mutating=1
for dir in src open-api; do
    if [ -e "$app/$dir" ]; then
        mv "$app/$dir" "$backup/$dir"
    else
        touch "$backup/new-$dir"
    fi
    mv "$stage/$dir" "$app/$dir"
done
mkdir -p "$app/test"
install -m 0644 "$stage/test/fixtures.json" "$fixture_file"
install -m 0644 "$app/open-api/$unit" "$unit_file"
install -m 0644 "$app/open-api/nginx.conf" "$config"
nginx -t
systemctl daemon-reload
systemctl restart "$unit"

for _ in $(seq 1 10); do
    if curl -fsS --max-time 2 http://127.0.0.1:3015/health >/dev/null; then break; fi
    sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:3015/v1/config/models >/dev/null
curl -fsS --max-time 3 http://127.0.0.1:3015/v1/question-images/algorithm >/dev/null
nginx -t
systemctl reload nginx
for path in / /models /question-images /website-experience /v1/website-experience /v1/config/models /v1/question-images/algorithm /v1/question-images/fixtures; do
    curl --max-time 3 -fsS -H 'Host: open.zerrorai.com' "http://127.0.0.1$path" >/dev/null
done
REMOTE
