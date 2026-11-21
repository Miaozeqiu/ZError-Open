#!/usr/bin/env bash
set -euo pipefail

project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote="${1:?Usage: bash open-api/deploy.sh user@host}"
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8)
stage="$(ssh "${ssh_options[@]}" "$remote" 'mktemp -d /opt/zerror-open-api-stage.XXXXXX')"
[[ "$stage" =~ ^/opt/zerror-open-api-stage\.[[:alnum:]]+$ ]]

COPYFILE_DISABLE=1 tar --no-xattrs --exclude='._*' --exclude='.DS_Store' -czf - -C "$project" package.json README.md LICENSE src open-api test \
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
for tool in git nginx systemctl curl sha256sum tar; do command -v "$tool" >/dev/null; done
fresh=0
if [ ! -e "$app" ]; then
    if [ -e "$unit_file" ] || [ -e "$config" ]; then
        echo 'Existing service configuration has no application directory' >&2
        exit 1
    fi
    fresh=1
else
    test -x "$app/runtime/bin/node"
    test -f "$unit_file"
    test -f "$config"
fi
for file in "$unit_file" "$config"; do
    if [ -f "$file" ]; then cp -p "$file" "$backup/"; fi
done
items=(src open-api test package.json README.md LICENSE server.js node_modules package-lock.json ._server.js ._node_modules)
mutating=0

finish() {
    status=$?
    if [ "$status" -ne 0 ] && [ "$mutating" = 1 ]; then
        systemctl stop "$unit" || true
        if [ "$fresh" = 1 ]; then
            rm -rf "$app"
        else
            for item in "${items[@]}"; do
                if [ -e "$backup/$item" ] || [ -L "$backup/$item" ]; then
                    rm -rf "$app/$item"
                    mv "$backup/$item" "$app/$item"
                elif [ -f "$backup/new-$item" ]; then
                    rm -rf "$app/$item"
                fi
            done
        fi
        if [ -f "$backup/$unit" ]; then cp -p "$backup/$unit" "$unit_file"; else rm -f "$unit_file"; fi
        if [ -f "$backup/zerror-open-api.conf" ]; then cp -p "$backup/zerror-open-api.conf" "$config"; else rm -f "$config"; fi
        systemctl daemon-reload
        if [ "$fresh" = 0 ]; then systemctl start "$unit"; fi
        nginx -t && systemctl reload nginx
    fi
    rm -rf "$stage"
}
trap finish EXIT

if [ "$fresh" = 1 ]; then
    version=v24.18.0
    case "$(uname -m)" in
        x86_64) architecture=x64 ;;
        aarch64|arm64) architecture=arm64 ;;
        *) echo 'Unsupported Node.js runtime architecture' >&2; exit 1 ;;
    esac
    archive="node-$version-linux-$architecture.tar.xz"
    base="https://nodejs.org/dist/$version"
    curl -fsS --connect-timeout 10 --max-time 30 "$base/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
    curl -fsS --connect-timeout 10 --max-time 300 "$base/$archive" -o "$stage/$archive"
    (cd "$stage" && awk -v archive="$archive" '$2 == archive { print }' SHASUMS256.txt | sha256sum -c -)
    mkdir "$stage/runtime"
    tar -xJf "$stage/$archive" --strip-components=1 -C "$stage/runtime"
    node="$stage/runtime/bin/node"
else
    node="$app/runtime/bin/node"
fi

"$node" --test "$stage/open-api/"*.test.js "$stage/test/"*.test.js
# Confirm official compiled packages are available before replacing the service.
"$node" - "$stage" <<'NODE'
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
if [ "$fresh" = 1 ]; then
    mkdir -p "$app"
    mv "$stage/runtime" "$app/runtime"
fi
for item in "${items[@]}"; do
    if [ -e "$app/$item" ] || [ -L "$app/$item" ]; then
        mv "$app/$item" "$backup/$item"
    else
        touch "$backup/new-$item"
    fi
    if [ -e "$stage/$item" ]; then mv "$stage/$item" "$app/$item"; fi
done
install -m 0644 "$app/open-api/$unit" "$unit_file"
install -m 0644 "$app/open-api/nginx.conf" "$config"
nginx -t
systemctl daemon-reload
systemctl restart "$unit"

for _ in $(seq 1 10); do
    if curl -fsS --max-time 2 http://127.0.0.1:3015/health >/dev/null 2>&1; then break; fi
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
if [ "$fresh" = 1 ]; then systemctl enable "$unit"; fi
REMOTE
