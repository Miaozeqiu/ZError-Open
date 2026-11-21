const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const catalog = require('./models.json');
const { createAppUpdateFeed, createReleaseListFeed } = require('./app-updates');
const { createReleaseMetadataSource } = require('./release-metadata-cache');
const { createReleaseAssetSource, streamInstaller, validRange } = require('./release-downloads');
const { createInstallerCache, serveCachedInstaller } = require('./installer-cache');
const { testModel } = require('./model-test');
const { sites, createWebsiteExperience } = require('./website-experience');
const fixtures = require('../test/fixtures.json');
const { splitQuestionImageParts } = require('../src');

const source = readFileSync(require.resolve('../src/algorithm.js'), 'utf8');
const imagePath = '/v1/question-images';
const maxBodyBytes = 32 * 1024;
const maxTextLength = 8192;

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJson(request, response) {
  const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return void sendJson(response, 415, { error: 'expected_application_json' });
  }
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    return void sendJson(response, 413, { error: 'body_too_large' });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      response.setHeader('Connection', 'close');
      request.resume();
      return void sendJson(response, 413, { error: 'body_too_large' });
    }
    chunks.push(chunk);
  }

  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    sendJson(response, 400, { error: 'invalid_json' });
  }
}

function parseQuestionImages(text) {
  const parts = splitQuestionImageParts(text);
  const urls = [...new Set(parts.filter(part => part.type === 'image').map(part => part.url))];
  return { parts, urls };
}

function fixtureWithStatus(fixture) {
  const { parts } = parseQuestionImages(fixture.input);
  const template = parts.map(part => part.type === 'image' ? '{{img}}' : part.text).join('');
  const urls = parts.filter(part => part.type === 'image').map(part => part.url);
  const passed = template === fixture.template
    && urls.length === fixture.urls.length
    && urls.every((url, index) => url === fixture.urls[index]);
  return { ...fixture, passed };
}

async function parse(request, response) {
  const input = await readJson(request, response);
  if (!input) return;
  const text = input.value?.text;
  if (typeof text !== 'string') return sendJson(response, 400, { error: 'text_must_be_a_string' });
  if (text.length > maxTextLength) return sendJson(response, 413, { error: 'text_too_long' });

  return sendJson(response, 200, parseQuestionImages(text));
}

const mime = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', ico: 'image/x-icon',
};
const publicFiles = {
  '/': 'index.html',
  '/models': 'index.html',
  '/question-images': 'question-images.html',
  '/website-experience': 'website-experience.html',
  '/workbench.css': 'workbench.css',
  '/workbench.js': 'workbench.js',
};
const modelTestOrigins = new Set(['https://open.zerrorai.com', 'https://open.zerror.cc']);
let runningTests = 0;

function servePublic(path, response) {
  const staticPath = Object.hasOwn(publicFiles, path) ? publicFiles[path] : undefined;
  const icon = /^\/(providers|models|websites)\/[a-zA-Z0-9_.-]+\.(svg|png|jpe?g|webp|gif|ico)$/.test(path);
  if (!staticPath && !icon) return false;
  try {
    const file = staticPath || path.slice(1);
    const body = readFileSync(join(__dirname, 'public', file));
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (icon) response.setHeader('Cache-Control', 'public, max-age=3600');
    response.writeHead(200, { 'Content-Type': mime[file.split('.').at(-1)] });
    response.end(body);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    sendJson(response, 500, { error: 'asset_unavailable' });
    return true;
  }
}

function makeServer({
  fetchUpstream = fetch,
  fetchWebsiteSource = fetch,
  fetchReleaseSource = fetch,
  fetchDownloadSource = fetch,
  installerCacheDirectory,
} = {}) {
  const releaseSource = createReleaseMetadataSource(fetchReleaseSource, installerCacheDirectory);
  const getAppRelease = createAppUpdateFeed(releaseSource);
  const getReleaseList = createReleaseListFeed(releaseSource);
  const readAsset = createReleaseAssetSource(fetchDownloadSource);
  const installerCache = installerCacheDirectory && createInstallerCache(installerCacheDirectory, readAsset);
  const getExperience = createWebsiteExperience(fetchWebsiteSource, undefined, installerCacheDirectory);
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    const path = request.url.split('?')[0];
    const method = request.method;
    if (path === '/health' && method === 'GET') return sendJson(response, 200, { status: 'ok' });
    if (method === 'GET' && path === '/website-repositories') {
      response.writeHead(308, { Location: '/website-experience' });
      return response.end();
    }
    if (method === 'GET' && servePublic(path, response)) return;
    if (method === 'GET' && path === '/v1/website-experience') {
      response.setHeader('Cache-Control', 'public, max-age=300');
      return sendJson(response, 200, { sites });
    }
    if ((method === 'GET' || method === 'OPTIONS') && path.startsWith('/v1/website-experience/')) {
      const site = sites.find(item => path === '/v1/website-experience/' + item.host);
      if (!site) return sendJson(response, 404, { error: 'unknown_website' });
      if (method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'If-None-Match, Cache-Control',
        });
        return response.end();
      }
      try {
        const snapshot = await getExperience(site);
        const etag = '"' + snapshot.revision + '"';
        response.setHeader('ETag', etag);
        if (request.headers['if-none-match'] === etag) {
          response.writeHead(304);
          return response.end();
        }
        const query = new URLSearchParams(request.url.split('?')[1]);
        if (query.get('revision') === snapshot.revision) {
          return sendJson(response, 200, { revision: snapshot.revision, unchanged: true });
        }
        return sendJson(response, 200, snapshot);
      } catch {
        response.setHeader('Retry-After', '60');
        return sendJson(response, 503, { error: 'experience_unavailable' });
      }
    }
    if (method === 'GET' && path === '/v1/app-updates/releases') {
      try {
        return sendJson(response, 200, await getReleaseList());
      } catch {
        response.setHeader('Retry-After', '60');
        return sendJson(response, 503, { error: 'release_list_unavailable' });
      }
    }
    const download = /^\/v1\/app-updates\/download\/(v?[0-9]+\.[0-9]+\.[0-9]+)\/(?:(\d+)\/)?([a-zA-Z0-9_.-]+)$/.exec(path);
    if (download && (method === 'GET' || method === 'HEAD')) {
      if (request.headers.range !== undefined && !validRange(request.headers.range)) {
        return sendJson(response, 400, { error: 'invalid_range' });
      }
      try {
        const { releases } = await getReleaseList();
        const [, tag, revision, name] = download;
        const release = releases.find(item => item.tag === tag);
        const installer = release?.installers.find(item => item.name === name);
        if (!installer || (revision && revision !== String(installer.assetId))) {
          return sendJson(response, 404, { error: 'unknown_installer' });
        }
        const cached = await installerCache?.find(installer);
        if (cached && revision && await serveCachedInstaller(request, response, cached, installer)) return;
        if (cached && !revision) {
          // Keep the website URL stable while giving every immutable GitHub
          // attachment its own CDN cache key.
          response.writeHead(302, { Location: '/v1/app-updates/download/' + tag + '/' + installer.assetId + '/' + name });
          return response.end();
        }
        return await streamInstaller(request, response, installer, readAsset);
      } catch {
        if (response.destroyed) return;
        if (response.headersSent) return response.destroy();
        return sendJson(response, 502, { error: 'download_unavailable' });
      }
    }
    const nativeUpdate = /^\/v1\/app-updates\/native\/(darwin|windows|linux)\/(aarch64|x86_64|i686|armv7)$/.exec(path);
    if (method === 'GET' && (path === '/v1/app-updates/latest' || nativeUpdate)) {
      try {
        const release = await getAppRelease();
        const platform = nativeUpdate && release?.platforms[nativeUpdate[1] + '-' + nativeUpdate[2]];
        if (!release || (nativeUpdate && !platform)) {
          response.writeHead(204);
          return response.end();
        }
        if (platform) {
          const { version, notes, pub_date } = release;
          return sendJson(response, 200, { version, notes, pub_date, ...platform });
        }
        return sendJson(response, 200, release);
      } catch {
        response.setHeader('Retry-After', '60');
        return sendJson(response, 503, { error: 'release_unavailable' });
      }
    }
    if (path === '/v1/config/models' && method === 'GET') {
      response.setHeader('Cache-Control', 'public, max-age=300');
      return sendJson(response, 200, catalog);
    }
    if (path === '/v1/config/models/test' && method === 'POST') {
      response.removeHeader('Access-Control-Allow-Origin');
      const origin = request.headers.origin;
      const local = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]+$/.test(origin || '') && origin === 'http://' + request.headers.host && (process.env.HOST || '127.0.0.1') === '127.0.0.1';
      if (origin && !modelTestOrigins.has(origin) && !local) {
        return sendJson(response, 403, { error: 'origin_not_allowed' });
      }
      if (runningTests >= 8) return sendJson(response, 429, { error: 'test_busy' });
      runningTests++;
      try {
        const input = await readJson(request, response);
        if (!input) return;
        const result = await testModel(catalog, input.value, fetchUpstream);
        return sendJson(response, result.status, result.body);
      } catch {
        if (!response.destroyed) return sendJson(response, 500, { error: 'test_failed' });
        return;
      } finally {
        runningTests--;
      }
    }
    if (path === imagePath + '/parse') {
      if (method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        return response.end();
      }
      if (method !== 'POST') {
        response.setHeader('Allow', 'POST, OPTIONS');
        return sendJson(response, 405, { error: 'method_not_allowed' });
      }
      try {
        return await parse(request, response);
      } catch {
        if (!response.destroyed) return sendJson(response, 500, { error: 'parse_failed' });
        return;
      }
    }
    if (path === imagePath + '/fixtures' && method === 'GET') {
      return sendJson(response, 200, fixtures.map(fixtureWithStatus));
    }
    if (path === imagePath + '/algorithm' && method === 'GET') {
      response.setHeader('Cache-Control', 'public, max-age=300');
      return sendJson(response, 200, { success: true, data: { source } });
    }
    return sendJson(response, 404, { error: 'not_found' });
  });
  if (installerCache) {
    const prefetch = () => getReleaseList().then(installerCache.warm).catch(error => {
      console.warn('Installer cache refresh: ' + error.message);
    });
    server.once('listening', () => {
      prefetch();
      const polling = setInterval(prefetch, 5 * 60_000);
      server.once('close', () => {
        clearInterval(polling);
        installerCache.close();
      });
    });
  }
  return server;
}

function start() {
  makeServer({ installerCacheDirectory: process.env.CACHE_DIRECTORY }).listen(Number(process.env.PORT || 3015), process.env.HOST || '127.0.0.1');
}

if (require.main === module) start();

module.exports = { makeServer, start };
