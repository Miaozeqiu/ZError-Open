const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const assetApi = 'https://api.github.com/repos/Miaozeqiu/ZError/releases/assets/';
const maxCachedRedirects = 128;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const assetOrigins = new Set([
  'https://release-assets.githubusercontent.com',
  'https://objects.githubusercontent.com',
  'https://github-releases.githubusercontent.com',
]);
const copiedHeaders = ['Accept-Ranges', 'Content-Length', 'Content-Range', 'ETag', 'Last-Modified'];

function validRange(range) {
  return /^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range);
}

async function fetchAsset(assetId, options, fetchSource, redirectsByAsset) {
  const cached = redirectsByAsset.get(assetId);
  const metadataUrl = assetApi + assetId;
  let url = cached?.expiresAt > Date.now() ? cached.url : metadataUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const upstream = await fetchSource(url, { ...options, redirect: 'manual' });
    if (!redirectStatuses.has(upstream.status)) return upstream;

    const location = upstream.headers.get('Location');
    await upstream.body?.cancel();
    if (!location) break;
    const next = new URL(location, url);
    if (!assetOrigins.has(next.origin) || next.username || next.password) break;
    if (url === metadataUrl) {
      const expiresAt = Date.parse(next.searchParams.get('se')) - 60_000;
      if (expiresAt > Date.now()) {
        if (redirectsByAsset.size >= maxCachedRedirects) redirectsByAsset.delete(redirectsByAsset.keys().next().value);
        redirectsByAsset.set(assetId, { url: next.href, expiresAt });
      }
    }
    url = next.href;
  }
  throw new Error('Unexpected release asset redirect');
}

async function streamInstaller(request, response, installer, readAsset) {
  if (response.destroyed) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once('close', abort);
  const headerTimeout = setTimeout(abort, 15_000);
  try {
    const headers = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };
    if (request.headers.range) {
      headers.Range = request.headers.range;
      if (request.headers['if-range']) headers['If-Range'] = request.headers['if-range'];
    }
    const upstream = await readAsset(installer.assetId, {
      method: request.method, headers, signal: controller.signal,
    });
    clearTimeout(headerTimeout);

    if (upstream.status === 404 || upstream.status === 416) {
      await upstream.body?.cancel();
      const contentRange = upstream.headers.get('Content-Range');
      if (upstream.status === 416 && contentRange) response.setHeader('Content-Range', contentRange);
      response.writeHead(upstream.status);
      return response.end();
    }

    const encoding = upstream.headers.get('Content-Encoding');
    const type = upstream.headers.get('Content-Type');
    if (![200, 206].includes(upstream.status) || (encoding && encoding !== 'identity')
      || /^(?:text\/html|application\/(?:json|[^;]+\+json))/i.test(type || '')
      || (upstream.status === 206 && !upstream.headers.has('Content-Range'))
      || (request.method === 'GET' && !upstream.body)) {
      await upstream.body?.cancel();
      throw new Error('Invalid release asset response');
    }

    for (const name of copiedHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) response.setHeader(name, value);
    }
    response.writeHead(upstream.status, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + installer.name + '"',
      'X-Accel-Buffering': 'no',
      'X-Open-Installer-Cache': 'MISS',
    });
    if (request.method === 'HEAD') return response.end();
    await pipeline(Readable.fromWeb(upstream.body), response, { signal: controller.signal });
  } finally {
    clearTimeout(headerTimeout);
    response.off('close', abort);
    abort();
  }
}

function createReleaseAssetSource(fetchSource) {
  // The GitHub REST API rate-limits anonymous requests. Reuse its signed CDN
  // URLs by asset ID until shortly before they expire.
  const redirectsByAsset = new Map();
  return async (assetId, options) => {
    const result = await fetchAsset(assetId, options, fetchSource, redirectsByAsset);
    if (result.status === 401 || result.status === 403) redirectsByAsset.delete(assetId);
    return result;
  };
}

module.exports = { createReleaseAssetSource, streamInstaller, validRange };
