// Exercise the real remote deployment transaction in a temporary filesystem.
// Only system services, HTTP and the runtime executable are replaced by fixtures.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, readFile, access, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const runtime = `#!/usr/bin/env bash
set -e
if [ "\${1:-}" = --test ]; then exit 0; fi
cat >/dev/null
if [ "$#" = 2 ] && [ "\${FAIL_SOURCE:-0}" = 1 ]; then exit 1; fi
if [ "$#" = 1 ] && [ "\${FAIL_SMOKE:-0}" = 1 ]; then exit 1; fi
`;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const exists = path => access(path).then(() => true, () => false);

async function fixture(t, { fresh = false, corruptChecksum = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zerror-open-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app'), stage = join(root, 'stage'), bin = join(root, 'bin');
  const config = join(root, 'nginx/zerror-open-api.conf'), unit = join(root, 'units/zerror-open-api.service');
  const put = async (path, data, mode = 0o644) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, data, { mode });
  };
  await mkdir(bin);
  await mkdir(join(root, 'nginx'));
  await mkdir(join(root, 'units'));
  if (!fresh) {
    for (const [path, data] of Object.entries({
      'runtime/bin/node': runtime, 'src/old.js': 'old-source', 'open-api/server.js': 'old-api',
      'test/fixtures.json': 'old-fixtures', 'server.js': 'retired-entry',
      'node_modules/question-image-algorithm/index.js': 'retired-module',
      'package.json': 'old-package', 'package-lock.json': 'old-lock',
    })) await put(join(app, path), data, path.endsWith('/node') ? 0o755 : 0o644);
    await put(config, 'old-nginx');
    await put(unit, 'old-unit');
  }
  for (const [path, data] of Object.entries({
    'src/index.js': 'new-source', 'open-api/server.js': 'new-api',
    'open-api/nginx.conf': 'new-nginx', 'open-api/zerror-open-api.service': 'new-unit',
    'open-api/api.test.js': '', 'test/fixtures.json': 'new-fixtures', 'test/algorithm.test.js': '',
    'package.json': '{"name":"zerror-open"}', 'README.md': 'unified-application', 'LICENSE': 'license',
  })) await put(join(stage, path), data);
  await put(join(bin, 'systemctl'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MOCK_LOG"\n', 0o755);
  await put(join(bin, 'nginx'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  await put(join(bin, 'uname'), '#!/usr/bin/env bash\necho x86_64\n', 0o755);
  await put(join(bin, 'curl'), `#!/usr/bin/env bash
output=''
for ((i=1;i<=$#;i++)); do
  value="\${!i}"
  if [ "$value" = -o ]; then ((i++)); output="\${!i}"; fi
  case "$value" in
    https://nodejs.org/*/SHASUMS256.txt) source="$MOCK_SUMS" ;;
    https://nodejs.org/*.tar.xz) source="$MOCK_ARCHIVE" ;;
  esac
done
if [ -n "$output" ]; then cp "$source" "$output"; fi
`, 0o755);
  // macOS names the same checksum operation shasum; production requires sha256sum.
  if (spawnSync('sha256sum', ['--version']).error)
    await put(join(bin, 'sha256sum'), '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n', 0o755);
  const archive = join(root, 'node-v24.18.0-linux-x64.tar.xz');
  const payload = join(root, 'payload');
  await put(join(payload, 'node-v24.18.0-linux-x64/bin/node'), runtime, 0o755);
  execFileSync('tar', ['-cJf', archive, '-C', payload, 'node-v24.18.0-linux-x64']);
  const digest = corruptChecksum ? '0'.repeat(64) : createHash('sha256').update(await readFile(archive)).digest('hex');
  const sums = join(root, 'SHASUMS256.txt');
  await put(sums, digest + '  node-v24.18.0-linux-x64.tar.xz\n');
  const source = await readFile(join(__dirname, '../open-api/deploy.sh'), 'utf8');
  const remote = source.split("<<'REMOTE'\n")[1].split('\nREMOTE')[0]
    .replace('app=/opt/zerror-open-api', 'app=' + quote(app))
    .replace('config=/etc/nginx/conf.d/zerror-open-api.conf', 'config=' + quote(config))
    .replace('unit_file=/etc/systemd/system/$unit', 'unit_file=' + quote(unit))
    .replaceAll('/etc/zerror-open-api-network.env', join(root, 'missing-network.env'));
  const program = join(root, 'deploy-remote.sh');
  await put(program, remote);
  const run = env => spawnSync('bash', [program, stage], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, MOCK_LOG: join(root, 'services.log'),
      MOCK_SUMS: sums, MOCK_ARCHIVE: archive, ...env },
  });
  return { root, app, stage, config, unit, run };
}

test('one deployment upgrades the complete application and retires the old API entry and dependency', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.app, 'open-api/server.js'), 'utf8'), 'new-api');
  assert.equal(await readFile(join(f.app, 'package.json'), 'utf8'), '{"name":"zerror-open"}');
  assert.equal(await readFile(f.unit, 'utf8'), 'new-unit');
  for (const path of ['server.js', 'node_modules', 'package-lock.json']) assert.equal(await exists(join(f.app, path)), false);
  assert.equal(await exists(f.stage), false);
});

test('a failed live check restores source, metadata, retired files and service configuration', async t => {
  const f = await fixture(t);
  assert.notEqual(f.run({ FAIL_SMOKE: '1' }).status, 0);
  assert.equal(await readFile(join(f.app, 'open-api/server.js'), 'utf8'), 'old-api');
  assert.equal(await readFile(join(f.app, 'server.js'), 'utf8'), 'retired-entry');
  assert.equal(await readFile(join(f.app, 'node_modules/question-image-algorithm/index.js'), 'utf8'), 'retired-module');
  assert.equal(await readFile(join(f.app, 'test/fixtures.json'), 'utf8'), 'old-fixtures');
  assert.equal(await readFile(join(f.app, 'package.json'), 'utf8'), 'old-package');
  assert.equal(await readFile(f.config, 'utf8'), 'old-nginx');
  assert.equal(await readFile(f.unit, 'utf8'), 'old-unit');
  assert.equal(await exists(f.stage), false);
});

test('source preflight failure leaves the existing application untouched', async t => {
  const f = await fixture(t);
  assert.notEqual(f.run({ FAIL_SOURCE: '1' }).status, 0);
  assert.equal(await readFile(join(f.app, 'server.js'), 'utf8'), 'retired-entry');
  assert.equal(await readFile(f.unit, 'utf8'), 'old-unit');
  assert.equal(await exists(join(f.root, 'services.log')), false);
});

test('first installation uses the verified runtime and the same application deployment', async t => {
  const f = await fixture(t, { fresh: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.app, 'runtime/bin/node'), 'utf8'), runtime);
  assert.equal(await readFile(f.unit, 'utf8'), 'new-unit');
  assert.match(await readFile(join(f.root, 'services.log'), 'utf8'), /enable zerror-open-api.service/);
});

test('runtime checksum failure cannot install or enable a new application', async t => {
  const f = await fixture(t, { fresh: true, corruptChecksum: true });
  assert.notEqual(f.run().status, 0);
  assert.equal(await exists(f.app), false);
  assert.equal(await exists(f.unit), false);
});
