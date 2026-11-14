const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { makeServer } = require('./server');

test('public image algorithm API', async t => {
  const server = makeServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = base + '/v1/question-images/parse';
  const send = body => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  const preflight = await fetch(path, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');

  const formula = 'https://mooc1.chaoxing.com/ananas/latex/p/123';
  const result = await send(JSON.stringify({ text: `(${formula}) https://example.com` }));
  assert.equal(result.status, 200);
  const { parts, urls } = await result.json();
  assert.deepEqual(urls, [formula]);
  assert.equal(parts.map(part => part.type === 'image' ? part.url : part.text).join(''), `(${formula}) https://example.com`);

  assert.equal((await send('{')).status, 400);
  assert.equal((await send(JSON.stringify({ text: '字'.repeat(8193) }))).status, 413);
  assert.equal((await send(' '.repeat(32769))).status, 413);
  const source = await fetch(base + '/v1/question-images/algorithm');
  assert.equal(source.status, 200);
  assert.match((await source.json()).data.source, /^function createQuestionImageAlgorithm\(runtime\)/);

  const fixtures = await fetch(base + '/v1/question-images/fixtures');
  assert.equal(fixtures.status, 200);
  assert.deepEqual(
    await fixtures.json(),
    require('../test/fixtures.json').map(fixture => ({ ...fixture, passed: true })),
  );
});

test('public workbench uses one catalog and tests only its configured endpoints', async t => {
  const calls = [];
  const fetchUpstream = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  const server = makeServer({ fetchUpstream }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const path of ['/', '/models']) {
    const page = await fetch(base + path);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    const html = await page.text();
    assert.match(html, /href="\/models" aria-current="page"/);
    assert.match(html, /href="\/question-images"/);
    assert.match(html, /id="model-form"/);
    assert.doesNotMatch(html, /id="image-form"/);
  }
  const imagePage = await fetch(base + '/question-images');
  assert.equal(imagePage.status, 200);
  assert.match(imagePage.headers.get('content-security-policy'), /connect-src 'self'/);
  const imageHtml = await imagePage.text();
  assert.match(imageHtml, /href="\/question-images" aria-current="page"/);
  assert.match(imageHtml, /href="\/models"/);
  assert.match(imageHtml, /id="image-form"/);
  assert.match(imageHtml, /id="fixture-list"/);
  assert.doesNotMatch(imageHtml, /id="model-form"/);
  assert.equal((await fetch(base + '/workbench.js')).status, 200);

  const catalog = await (await fetch(base + '/v1/config/models')).json();
  assert.ok(!catalog.question_image_algorithm);
  const providerFiles = readdirSync(join(__dirname, 'public', 'providers'))
    .filter(filename => !filename.startsWith('.'));
  assert.deepEqual([...catalog.providers_list].sort(), providerFiles.sort());
  for (const platform of catalog.platforms) {
    assert.ok(!platform.apiKey);
    assert.ok(catalog.providers_list.includes(platform.icon));
    const icon = await fetch(base + '/providers/' + platform.icon);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /^image\//);
    await icon.arrayBuffer();
  }
  for (const filename of Object.keys(catalog.model_icon_mappings)) {
    const icon = await fetch(base + '/models/' + filename);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /^image\//);
    await icon.arrayBuffer();
  }
  const platform = catalog.platforms.find(item => item.apiProtocol === 'openai-chat');
  const model = platform.models[0];
  const testConfig = (values, origin = base) => fetch(base + '/v1/config/models/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ platformId: platform.id, modelId: model.id, apiKey: 'test-key', ...values }),
  });
  assert.equal((await testConfig({ modelId: 'not-in-catalog' })).status, 400);
  assert.equal((await testConfig({}, 'https://different.test')).status, 403);
  assert.equal(calls.length, 0);
  const result = await testConfig({ baseUrl: 'https://different.test' });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).success, true);
  assert.equal(calls[0].url, platform.baseUrl + '/chat/completions');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(calls[0].init.body).model, model.modelId || model.id);
});

test('official experience serves one complete revision and rejects altered files', async t => {
  const { createHash } = require('node:crypto');
  const revision = 'a'.repeat(40);
  const root = 'skills/chaoxing/';
  const website = { version: 1, id: 'chaoxing', host: 'chaoxing.com', name: '学习通', icon: 'assets/icon.png' };
  const files = {
    'website.json': JSON.stringify(website),
    'SKILL.md': '---\nname: chaoxing\ndescription: Course navigation\n---\n',
    'site-graph.json': JSON.stringify({ id: website.id, host: website.host, nodes: [], edges: [] }),
    [website.icon]: 'image',
  };
  const tree = Object.entries(files).map(([path, value]) => ({
    path: root + path, type: 'blob', mode: '100644', size: Buffer.byteLength(value),
    sha: createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex'),
  }));
  let corrupt = true;
  let commitRequests = 0;
  const fetchWebsiteSource = async input => {
    if (input.endsWith('/commits/main')) {
      commitRequests++;
      return Response.json({ sha: revision, commit: { tree: { sha: 'b'.repeat(40) } } });
    }
    if (input.includes('/git/trees/')) return Response.json({ tree });
    const entry = tree.find(item => input.endsWith('/git/blobs/' + item.sha));
    const path = entry.path.slice(root.length);
    const content = corrupt && path === 'SKILL.md' ? files[path].replace('Course', 'course') : files[path];
    return Response.json({ encoding: 'base64', sha: entry.sha, size: entry.size, content: Buffer.from(content).toString('base64') });
  };
  const startServer = async () => {
    const server = makeServer({ fetchWebsiteSource }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return 'http://127.0.0.1:' + server.address().port + '/v1/website-experience';
  };

  const first = await startServer();
  assert.equal((await fetch(first + '/chaoxing.com')).status, 503);
  assert.equal((await fetch(first + '/chaoxing.com')).status, 503);
  assert.equal(commitRequests, 1);

  corrupt = false;
  const base = await startServer();
  const catalog = await (await fetch(base)).json();
  assert.ok(catalog.sites.some(site => site.host === 'zhihuishu.com'));
  const [firstSnapshot, secondSnapshot] = await Promise.all([fetch(base + '/chaoxing.com'), fetch(base + '/chaoxing.com')]);
  assert.equal(firstSnapshot.status, 200);
  const snapshot = await firstSnapshot.json();
  assert.deepEqual(await secondSnapshot.json(), snapshot);
  assert.equal(snapshot.files['SKILL.md'], files['SKILL.md']);
  const etag = firstSnapshot.headers.get('etag');
  assert.equal((await fetch(base + '/chaoxing.com', { headers: { 'If-None-Match': etag } })).status, 304);
  const unchanged = await fetch(base + '/chaoxing.com?revision=' + revision);
  assert.deepEqual(await unchanged.json(), { revision, unchanged: true });
  assert.equal((await fetch(base + '/example.com')).status, 404);
  assert.equal(commitRequests, 2);
});
