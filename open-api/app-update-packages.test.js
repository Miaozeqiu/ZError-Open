const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createAppUpdateFeed } = require('./app-updates');
const { makeServer } = require('./server');
const tag = 'v2.3.1';
const names = ['ZError_2.3.1_aarch64.app.tar.gz', 'ZError_2.3.1_x64-setup.exe', 'ZError_2.3.1_amd64.AppImage'];
const signature = Buffer.from('untrusted comment: signature\nRWQ=\ntrusted comment: timestamp\nRWQ=\n').toString('base64');
const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0]);
const sha = createHash('sha256').update(bytes).digest('hex');
const assets = names.flatMap((name, index) => [name, name + '.sig'].map((name, offset) => ({
  id: index * 2 + offset + 1, name, size: bytes.length, digest: 'sha256:' + sha,
  browser_download_url: `https://github.com/Miaozeqiu/ZError/releases/download/${tag}/${name}`,
})));
const release = { tag_name: tag, assets };
const fetchReleaseSource = async url => url.endsWith('.sig') ? new Response(signature)
  : Response.json(url.endsWith('/latest') ? release : [release]);

test('all three signed update targets use Open downloads', async () => {
  const feed = await createAppUpdateFeed(fetchReleaseSource)();
  for (const [target, index] of [['darwin-aarch64', 0], ['windows-x86_64', 1], ['linux-x86_64', 2]]) {
    assert.deepEqual(feed.platforms[target], {
      url: `https://open.zerrorai.com/v1/app-updates/download/${tag}/${index * 2 + 1}/${names[index]}`, signature,
    });
  }
});

test('updater tarballs are prefetched and resumed from verified disk cache, but excluded from manual installers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zerror-update-packages-'));
  let downloads = 0;
  const server = makeServer({
    installerCacheDirectory: directory, fetchReleaseSource,
    fetchDownloadSource: async () => {
      downloads++;
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections(); await closed;
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/v1/app-updates`;
  const listing = await (await fetch(base + '/releases')).json();
  assert.equal(listing.releases[0].installers.some(asset => asset.format === 'app.tar.gz'), false);
  assert.equal(listing.releases[0].updaters[0].name, names[0]);
  const cachedFile = join(directory, '1-' + sha + '.installer');
  let cached;
  for (let i = 0; i < 100 && !cached; i++) {
    cached = await readFile(cachedFile).catch(() => null);
    if (!cached) await delay(10);
  }
  assert.deepEqual(cached, bytes);
  const response = await fetch(base + `/download/${tag}/1/${names[0]}`, { headers: { Range: 'bytes=1-' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('x-open-installer-cache'), 'HIT');
  assert.equal(response.headers.get('content-range'), 'bytes 1-3/4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(1));
  assert.equal(downloads, 3);
});
