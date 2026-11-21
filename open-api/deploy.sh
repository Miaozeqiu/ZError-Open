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
if [ -r /etc/zerror-open-api-network.env ]; then
    export ZERROR_GITHUB_GIT_ADDRESS="$(sed -n 's/^ZERROR_GITHUB_GIT_ADDRESS=//p' /etc/zerror-open-api-network.env)"
fi
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

"$app/runtime/bin/node" --test "$stage/open-api/"*.test.js
# Confirm official compiled packages are available before replacing the service.
"$app/runtime/bin/node" - "$stage" <<'NODE'
const assert = require('node:assert/strict');
const { sites, createWebsiteExperience } = require(process.argv[2] + '/open-api/website-experience');
(async () => {
    const getExperience = createWebsiteExperience();
    for (const host of ['chaoxing.com', 'zjooc.cn']) {
        const snapshot = await getExperience(sites.find(site => site.host === host));
        assert.equal(snapshot.runtime?.apiVersion, 2, host + ' has no compiled runtime');
        assert.ok(snapshot.runtime.tools.length);
        console.log(JSON.stringify({ host, revision: snapshot.revision, tools: snapshot.runtime.tools.length,
            resources: snapshot.runtime.resources?.length || 0 }));
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
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
"$app/runtime/bin/node" - <<'NODE'
const assert = require('node:assert/strict');
(async () => {
    for (const host of ['chaoxing.com', 'zjooc.cn']) {
        const response = await fetch('http://127.0.0.1:3015/v1/website-experience/' + host, { signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200, host + ' experience unavailable');
        const snapshot = await response.json();
        assert.equal(snapshot.runtime?.apiVersion, 2, host + ' compiled runtime missing');
        assert.ok(snapshot.runtime.tools.length);
    }
    const releases = await fetch('http://127.0.0.1:3015/v1/app-updates/releases', { signal: AbortSignal.timeout(15000) });
    assert.equal(releases.status, 200, 'release list unavailable after deployment');
    const feed = await releases.json();
    assert.ok(feed.releases.some(release => release.installers?.length), 'installer metadata missing after deployment');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
nginx -t
systemctl reload nginx
for path in / /models /question-images /website-experience /v1/website-experience /v1/config/models /v1/question-images/algorithm /v1/question-images/fixtures; do
    curl --max-time 3 -fsS -H 'Host: open.zerrorai.com' "http://127.0.0.1$path" >/dev/null
done
REMOTE
