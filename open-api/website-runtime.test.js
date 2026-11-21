const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const { makeServer } = require('./server');

const revision = 'a'.repeat(40);
const code = "var ZErrorSitePackage = { *create() { const page = yield {op:'browser.observe',args:{}}; return {title:page.title}; } };";
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const runtime = () => ({ apiVersion: 2, bundle: { code, sha256: createHash('sha256').update(code).digest('hex') },
  tools: [{ name: 'read_catalog', description: 'Read this website', parameters: schema({}), result: schema({ title: { type: 'string' } }), commands: ['browser.observe'] }] });

async function sourceServer(t, compiled) {
  const website = { version: 1, id: 'chaoxing', host: 'chaoxing.com', name: 'Site', icon: 'assets/icon.png' };
  const files = { 'website.json': JSON.stringify(website), 'assets/icon.png': 'image',
    'SKILL.md': '---\nname: chaoxing\ndescription: Website\n---\n',
    'site-graph.json': JSON.stringify({ id: website.id, host: website.host, nodes: [], edges: [] }),
    ...(compiled ? { 'runtime.json': JSON.stringify(compiled) } : {}) };
  const tree = Object.entries(files).map(([path, bytes]) => ({ path: 'skills/chaoxing/' + path, type: 'blob', mode: '100644', size: Buffer.byteLength(bytes),
    sha: createHash('sha1').update('blob ' + Buffer.byteLength(bytes) + '\0').update(bytes).digest('hex') }));
  let requests = 0;
  const fetchWebsiteSource = async url => {
    requests++;
    if (url.endsWith('/commits/main')) return Response.json({ sha: revision, commit: { tree: { sha: 'b'.repeat(40) } } });
    if (url.includes('/git/trees/')) return Response.json({ tree });
    const entry = tree.find(entry => url.endsWith('/git/blobs/' + entry.sha));
    assert.ok(entry, 'only verified blobs are downloaded');
    return Response.json({ encoding: 'base64', sha: entry.sha, size: entry.size,
      content: Buffer.from(files[entry.path.slice('skills/chaoxing/'.length)]).toString('base64') });
  };
  const server = makeServer({ fetchWebsiteSource }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: 'http://127.0.0.1:' + server.address().port + '/v1/website-experience/chaoxing.com', requests: () => requests };
}

test('the existing endpoint serves one compiled package with normal ETag and revision caching', async t => {
  const compiled = runtime();
  compiled.tools[0].commands = ['document.query'];
  compiled.automations = [{ event: 'page', tool: 'read_catalog' }];
  const { url, requests } = await sourceServer(t, compiled);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.deepEqual(snapshot.runtime, compiled);
  assert.equal(snapshot.files['runtime.json'], undefined);
  assert.ok(snapshot.files['SKILL.md']);
  assert.equal(response.headers.get('etag'), '"' + revision + '"');
  assert.equal((await fetch(url, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
  assert.deepEqual(await (await fetch(url + '?revision=' + revision)).json(), { revision, unchanged: true });
  assert.equal(requests(), 7);
});

test('corrupt compiled bytes are not promoted even when the Git blob is valid', async t => {
  const compiled = runtime();
  compiled.bundle.code += 'changed';
  const { url, requests } = await sourceServer(t, compiled);
  assert.equal((await fetch(url)).status, 503);
  const count = requests();
  assert.equal((await fetch(url)).status, 503);
  assert.equal(requests(), count, 'failed source is rate limited');
});

test('verified binary resources larger than the former file limit travel in the same compiled snapshot', async t => {
  const compiled = runtime(), bytes = Buffer.alloc(758936, 42);
  compiled.resources = [{ id: 'font-reference', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }];
  const { url } = await sourceServer(t, compiled);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.deepEqual(snapshot.runtime.resources, compiled.resources);
  assert.equal(snapshot.files['font-reference'], undefined);
});

test('a valid Git blob cannot promote corrupted or oversized runtime resources', async t => {
  for (const bad of [{ id: 'asset', size: 3, sha256: '0'.repeat(64), data: 'YWJj' }, { id: 'asset', size: 1048577, sha256: '0'.repeat(64), data: 'AA==' }]) {
    const compiled = { ...runtime(), resources: [bad] };
    const { url } = await sourceServer(t, compiled);
    assert.equal((await fetch(url)).status, 503);
  }
});
