const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readdirSync } = require('node:fs');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { join } = require('node:path');
const test = require('node:test');
const { makeServer } = require('./server');
const { createAppUpdateFeed } = require('./app-updates');

test('app updates still read the official GitHub release when its API is rate limited', async () => {
  const origin = 'https://github.com';
  const path = '/Miaozeqiu/ZError/releases/';
  const tag = 'v2.2.5';
  const releaseUrl = origin + path + 'tag/' + tag;
  const installer = path + 'download/' + tag + '/ZError_Setup_2.2.5.exe';
  const request = async (url, { redirect }) => {
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 403 });
    if (url === origin + path + 'latest') {
      assert.equal(redirect, 'manual');
      return Response.redirect(releaseUrl);
    }
    if (url === releaseUrl) {
      return new Response('<meta property="og:description" content="Fix &amp; improve"><relative-time datetime="2026-05-17T15:32:32Z">');
    }
    assert.equal(url, origin + path + 'expanded_assets/' + tag);
    return new Response(`<a href="${installer}">Installer</a><a href="/other/repo/releases/download/${tag}/ZError_Setup_2.2.5.exe">Other</a>`);
  };
  const release = await createAppUpdateFeed(request)();
  assert.equal(release.version, '2.2.5');
  assert.equal(release.releaseUrl, releaseUrl);
  assert.equal(release.changelog, 'Fix & improve');
  assert.deepEqual(release.installers, { 'windows-x86_64': origin + installer });
});

test('app updates cover signed packages and installer-only releases by target', async t => {
  const tag = 'v2.2.9';
  const url = name => `https://github.com/Miaozeqiu/ZError/releases/download/${tag}/${name}`;
  const exe = 'ZError_2.2.9_x64-setup.exe';
  const dmg = 'ZError_2.2.9_aarch64.dmg';
  const tar = 'ZError_2.2.9_aarch64.app.tar.gz';
  const signature = Buffer.from('untrusted comment: signature\nRWQ=\ntrusted comment: timestamp\nRWQ=\n').toString('base64');
  let releaseRequests = 0;
  let metadataSignal;
  const fetchReleaseSource = async (source, { signal }) => {
    if (source === url(exe + '.sig') || source === url(tar + '.sig')) {
      assert.notEqual(signal, metadataSignal);
      return new Response(source === url(exe + '.sig') ? signature + '\n' : 'invalid signature');
    }
    assert.equal(source, 'https://api.github.com/repos/Miaozeqiu/ZError/releases/latest');
    metadataSignal = signal;
    releaseRequests++;
    return Response.json({
      tag_name: tag,
      published_at: '2026-11-14T00:00:00Z',
      body: 'Update notes',
      assets: [
        ...[exe, exe + '.sig', dmg, tar, tar + '.sig'].map(name => ({ name, browser_download_url: url(name) })),
        { name: 'ZError_2.2.9_x86_64.dmg', browser_download_url: 'https://example.org/other-release.dmg' },
      ],
    });
  };
  const server = makeServer({ fetchReleaseSource }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const base = `http://127.0.0.1:${server.address().port}/v1/app-updates`;
  const [latest, native, unsigned, absent] = await Promise.all([
    fetch(base + '/latest'),
    fetch(base + '/native/windows/x86_64'),
    fetch(base + '/native/darwin/aarch64'),
    fetch(base + '/native/windows/aarch64'),
  ]);
  assert.equal(latest.status, 200);
  const { version, releaseUrl, installers, platforms } = await latest.json();
  assert.equal(version, '2.2.9');
  assert.equal(releaseUrl, 'https://github.com/Miaozeqiu/ZError/releases/tag/v2.2.9');
  assert.deepEqual(installers, { 'windows-x86_64': url(exe), 'darwin-aarch64': url(dmg) });
  assert.deepEqual(platforms, { 'windows-x86_64': { url: url(exe), signature } });
  assert.equal(native.status, 200);
  assert.deepEqual(await native.json(), {
    version, notes: 'Update notes', pub_date: '2026-11-14T00:00:00Z', url: url(exe), signature,
  });
  assert.equal(unsigned.status, 204);
  assert.equal(absent.status, 204);
  assert.equal(releaseRequests, 1);
});

test('public releases exclude drafts and previews and expose official installers for each platform', async t => {
  const tag = 'v2.2.5';
  const url = name => 'https://github.com/Miaozeqiu/ZError/releases/download/' + tag + '/' + name;
  const installers = [
    { name: 'ZError_Setup_2.2.5.exe', platform: 'windows', arch: 'x86_64', format: 'exe' },
    { name: 'ZError_2.2.5_aarch64.dmg', platform: 'macos', arch: 'aarch64', format: 'dmg' },
    { name: 'ZError_2.2.5_amd64.AppImage', platform: 'linux', arch: 'x86_64', format: 'appimage' },
    { name: 'ZError_2.2.5_amd64.deb', platform: 'linux', arch: 'x86_64', format: 'deb' },
  ].map((asset, index) => ({
    ...asset,
    assetId: index + 1,
    size: null,
    digest: null,
    url: url(asset.name),
    downloadUrl: 'https://open.zerrorai.com/v1/app-updates/download/' + tag + '/' + asset.name,
  }));
  let requests = 0;
  const fetchReleaseSource = async source => {
    requests++;
    if (source === 'https://api.github.com/repos/Miaozeqiu/ZError/releases/latest') {
      return Response.json({
        tag_name: tag, name: 'ZError', body: 'Fixes', published_at: '2026-05-17T15:32:32Z',
        assets: [
          ...installers.map(({ name, url, assetId }) => ({ id: assetId, name, browser_download_url: url, state: 'uploaded' })),
          { id: 5, name: 'ZError_Setup_2.2.5.exe.sig', browser_download_url: url('ZError_Setup_2.2.5.exe.sig') },
          { id: 6, name: 'ZError_2.2.5_x64.msi', browser_download_url: 'https://example.org/install.msi' },
          { id: 7, name: 'ZError_2.2.5_arm64.dmg', browser_download_url: url('ZError_2.2.5_arm64.dmg'), state: 'new' },
        ],
      });
    }
    assert.equal(source, 'https://api.github.com/repos/Miaozeqiu/ZError/releases?per_page=50');
    return Response.json([
      { tag_name: 'v2.2.9', draft: true },
      { tag_name: 'v2.2.8', prerelease: true },
      { tag_name: 'v2.3.0-beta.1' },
      { tag_name: 'v2.2.4', name: 'Earlier release' },
    ]);
  };
  const server = makeServer({ fetchReleaseSource }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/app-updates/releases';
  const responses = await Promise.all([fetch(endpoint), fetch(endpoint)]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), {
      releases: [{
        tag, version: '2.2.5', name: 'ZError', releaseDate: '2026-05-17T15:32:32Z',
        releaseUrl: 'https://github.com/Miaozeqiu/ZError/releases/tag/' + tag, notes: 'Fixes', installers,
      }, {
        tag: 'v2.2.4', version: '2.2.4', name: 'Earlier release', releaseDate: null,
        releaseUrl: 'https://github.com/Miaozeqiu/ZError/releases/tag/v2.2.4', notes: '', installers: [],
      }],
      partial: false,
    });
  }
  assert.equal(requests, 2);
});

test('installer downloads stream allowed release assets and preserve range responses', async t => {
  const tag = 'v2.2.9';
  const name = 'ZError_2.2.9_x64-setup.exe';
  const url = 'https://github.com/Miaozeqiu/ZError/releases/download/' + tag + '/' + name;
  const assetApi = 'https://api.github.com/repos/Miaozeqiu/ZError/releases/assets/10';
  const expires = encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString());
  const cdn = 'https://release-assets.githubusercontent.com/file?signature=mock&se=' + expires;
  const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  const release = { tag_name: tag, assets: [{ id: 10, name, browser_download_url: url }] };
  const fetchReleaseSource = async source => Response.json(source.endsWith('/latest') ? release : [release]);
  const calls = [];
  let redirect = cdn;
  const fetchDownloadSource = async (source, options) => {
    calls.push(source);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    assert.equal(options.headers.Accept, 'application/octet-stream');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    if (source === assetApi) return new Response(null, { status: 302, headers: { Location: redirect } });
    assert.equal(source, cdn);
    if (options.headers.Range === 'bytes=1-') return new Response(null, { status: 403 });
    const headers = { 'Accept-Ranges': 'bytes', ETag: '"mock"' };
    if (options.headers.Range === 'bytes=10-') {
      return new Response('outside the file', { status: 416, headers: { 'Content-Range': 'bytes */4' } });
    }
    if (options.headers.Range === 'bytes=0-1') {
      assert.equal(options.headers['If-Range'], '"mock"');
      return new Response(bytes.subarray(0, 2), {
        status: 206, headers: { ...headers, 'Content-Range': 'bytes 0-1/4', 'Content-Length': '2' },
      });
    }
    return new Response(options.method === 'HEAD' ? null : bytes, {
      headers: { ...headers, 'Content-Length': '4' },
    });
  };
  const server = makeServer({ fetchReleaseSource, fetchDownloadSource }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/app-updates/download/' + tag + '/' + name;

  const full = await fetch(endpoint, { redirect: 'manual' });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('location'), null);
  assert.equal(full.headers.get('content-disposition'), 'attachment; filename="' + name + '"');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

  const head = await fetch(endpoint, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '4');

  const part = await fetch(endpoint, {
    headers: { Range: 'bytes=0-1', 'If-Range': '"mock"', Cookie: 'private', Authorization: 'private' },
  });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-1/4');
  assert.equal(part.headers.get('accept-ranges'), 'bytes');
  assert.equal(part.headers.get('etag'), '"mock"');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(0, 2));

  const outside = await fetch(endpoint, { headers: { Range: 'bytes=10-' } });
  assert.equal(outside.status, 416);
  assert.equal(outside.headers.get('content-range'), 'bytes */4');
  assert.equal((await fetch(endpoint, { headers: { Range: 'bytes=0-1,2-3' } })).status, 400);
  assert.equal((await fetch(endpoint + '.sig')).status, 404);
  assert.deepEqual(calls, [assetApi, cdn, cdn, cdn, cdn]);

  assert.equal((await fetch(endpoint, { headers: { Range: 'bytes=1-' } })).status, 502);
  redirect = 'https://example.org/untrusted';
  assert.equal((await fetch(endpoint)).status, 502);
  assert.deepEqual(calls.slice(5), [cdn, assetApi]);
});

test('startup prefetch resumes an installer and subsequent downloads are served from disk', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zerror-installer-test-'));
  const tag = 'v2.2.9';
  const name = 'ZError_2.2.9_x64-setup.exe';
  const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const installer = {
    id: 10, name, size: bytes.length, digest: 'sha256:' + sha,
    browser_download_url: 'https://github.com/Miaozeqiu/ZError/releases/download/' + tag + '/' + name,
  };
  const release = { tag_name: tag, assets: [installer] };
  const cacheFile = join(directory, '10-' + sha + '.installer');
  await writeFile(cacheFile + '.part', bytes.subarray(0, 1));
  let downloads = 0;
  const server = makeServer({
    installerCacheDirectory: directory,
    fetchReleaseSource: async source => Response.json(source.endsWith('/latest') ? release : [release]),
    fetchDownloadSource: async (source, options) => {
      downloads++;
      assert.equal(source, 'https://api.github.com/repos/Miaozeqiu/ZError/releases/assets/10');
      assert.equal(options.headers.Range, 'bytes=1-');
      return new Response(bytes.subarray(1), {
        status: 206, headers: { 'Content-Length': '3', 'Content-Range': 'bytes 1-3/4' },
      });
    },
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  let prefetched;
  for (let retry = 0; retry < 100 && !prefetched; retry++) {
    prefetched = await readFile(cacheFile).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!prefetched) await delay(10);
  }
  assert.deepEqual(prefetched, bytes);
  assert.equal(downloads, 1);

  const root = 'http://127.0.0.1:' + server.address().port + '/v1/app-updates/download/' + tag;
  const stable = await fetch(root + '/' + name, { redirect: 'manual' });
  assert.equal(stable.status, 302);
  assert.equal(stable.headers.get('cache-control'), 'no-store');
  const url = new URL(stable.headers.get('location'), root);
  assert.equal(url.pathname, '/v1/app-updates/download/' + tag + '/10/' + name);

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('x-open-installer-cache'), 'HIT');
  assert.match(full.headers.get('cache-control'), /s-maxage=86400/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const etag = full.headers.get('etag');

  const resume = await fetch(url, { headers: { Range: 'bytes=-2', 'If-Range': etag } });
  assert.equal(resume.status, 206);
  assert.equal(resume.headers.get('content-range'), 'bytes 2-3/4');
  assert.deepEqual(Buffer.from(await resume.arrayBuffer()), bytes.subarray(2));
  const changed = await fetch(url, { headers: { Range: 'bytes=1-', 'If-Range': '"previous"' } });
  assert.equal(changed.status, 200);
  assert.deepEqual(Buffer.from(await changed.arrayBuffer()), bytes);
  assert.equal((await fetch(url, { headers: { 'If-None-Match': etag } })).status, 304);
  const invalid = await fetch(url, { headers: { Range: 'bytes=4-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */4');
  assert.equal((await fetch(root + '/9/' + name)).status, 404);
  assert.equal(downloads, 1);
});

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
  const tool = { type: 'function', function: { name: 'browser_login_chaoxing', description: 'Login', parameters: { type: 'object' } } };
  const adapter = 'const ZErrorSiteScript = { run: () => \"wait\" };';
  const source = Object.fromEntries(Object.entries(files).map(([path, value]) => [root + path, value]));
  source['site-tools/tools.json'] = JSON.stringify([tool]);
  source['site-tools/login.js'] = adapter;
  const tree = Object.entries(source).map(([path, value]) => ({
    path, type: 'blob', mode: '100644', size: Buffer.byteLength(value),
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
    const path = entry.path;
    const content = corrupt && path === root + 'SKILL.md' ? source[path].replace('Course', 'course') : source[path];
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
  assert.deepEqual(snapshot.tools, [tool]);
  const manifest = await fetch(base + '/chaoxing.com/script-manifest.json');
  assert.equal(manifest.status, 200);
  const { bundles, siteId } = await manifest.json();
  assert.equal(siteId, 'chaoxing');
  const bytes = await fetch(new URL(bundles.login.url, manifest.url));
  assert.equal(bytes.status, 200);
  assert.equal(await bytes.text(), adapter);
  assert.equal(bundles.login.sha256, createHash('sha256').update(adapter).digest('hex'));
  assert.equal((await fetch(base + '/chaoxing.com/scripts/login.' + '0'.repeat(64) + '.js')).status, 404);
  const etag = firstSnapshot.headers.get('etag');
  assert.equal((await fetch(base + '/chaoxing.com', { headers: { 'If-None-Match': etag } })).status, 304);
  const unchanged = await fetch(base + '/chaoxing.com?revision=' + revision);
  assert.deepEqual(await unchanged.json(), { revision, unchanged: true });
  assert.equal((await fetch(base + '/example.com')).status, 404);
  assert.equal(commitRequests, 2);
});
