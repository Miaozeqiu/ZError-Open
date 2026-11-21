const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createReleaseMetadataSource } = require('./release-metadata-cache');
const { createReleaseListFeed } = require('./app-updates');
const api = 'https://api.github.com/repos/Miaozeqiu/ZError/releases';
const release = { tag_name: 'v2.2.9', assets: [{ id: 42, name: 'ZError_2.2.9_x64-setup.exe',
  browser_download_url: 'https://github.com/Miaozeqiu/ZError/releases/download/v2.2.9/ZError_2.2.9_x64-setup.exe',
  size: 100, digest: 'sha256:' + 'a'.repeat(64) }] };

test('restart during GitHub throttling retains release asset IDs, hashes and download URLs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zerror-release-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fresh = createReleaseListFeed(createReleaseMetadataSource(async url => Response.json(url.endsWith('/latest') ? release : [release]), directory));
  const first = await fresh();
  const restarted = createReleaseListFeed(createReleaseMetadataSource(async () => new Response('', { status: 403 }), directory));
  assert.deepEqual(await restarted(), first);
  assert.equal(first.releases[0].installers[0].assetId, 42);
  const offline = createReleaseMetadataSource(async () => { throw new Error('offline'); }, directory);
  assert.deepEqual(await (await offline(api + '/latest')).json(), release);
});

test('explicit removal invalidates persisted latest release and corrupt metadata is ignored', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zerror-release-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fresh = createReleaseMetadataSource(async () => Response.json(release), directory);
  await (await fresh(api + '/latest')).arrayBuffer();
  const removed = createReleaseMetadataSource(async () => new Response(null, { status: 404 }), directory);
  assert.equal((await removed(api + '/latest')).status, 404);
  const throttled = createReleaseMetadataSource(async () => new Response('', { status: 429 }), directory);
  assert.equal((await throttled(api + '/latest')).status, 429);
  await writeFile(join(directory, 'release-latest.json'), '{broken');
  assert.equal((await throttled(api + '/latest')).status, 429);
  await assert.rejects(createReleaseMetadataSource(async () => Response.json({ tag_name: 'bad' }), directory)(api + '/latest'), /Invalid persisted/);
});
