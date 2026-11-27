const assert = require('node:assert/strict');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createSignatureReader } = require('./release-signatures');
const signature = Buffer.from('untrusted comment: signature\nRWQ=\ntrusted comment: timestamp\nRWQ=\n').toString('base64');
const asset = { assetId: 100, url: 'https://github.com/Miaozeqiu/ZError/releases/download/v2.3.1/ZError_2.3.1_aarch64.app.tar.gz.sig' };

test('validated signatures survive restart and network failure, but never cross attachment IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zerror-signatures-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const reader = createSignatureReader(async () => { calls++; return new Response(signature); }, directory);
  assert.deepEqual(await Promise.all([reader(asset), reader(asset)]), [signature, signature]);
  assert.equal(calls, 1);
  const offline = createSignatureReader(async () => { throw new Error('offline'); }, directory);
  assert.equal(await offline(asset), signature);
  assert.equal(await offline({ ...asset, assetId: 101 }), null);
  assert.equal(await offline({ ...asset, url: asset.url.replace('v2.3.1', 'v2.3.2') }), null);
});

test('invalid and oversized signature responses are never persisted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zerror-signatures-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const value of ['invalid', 'A'.repeat(4097)]) {
    assert.equal(await createSignatureReader(async () => new Response(value), directory)(asset), null);
  }
  assert.deepEqual(await readdir(directory), []);
});
