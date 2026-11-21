const { createHash } = require('node:crypto');
const { withGitSource } = require('./website-git-source');
const { createSnapshotCache } = require('./website-snapshot-cache');

const sites = Object.freeze([
  { id: 'chaoxing', name: '学习通', host: 'chaoxing.com', repository: 'Miaozeqiu/ZError-chaoxing' },
  { id: 'zjooc', name: '在浙学', host: 'zjooc.cn', repository: 'Miaozeqiu/ZError-zjooc' },
  { id: 'zhihuishu', name: '智慧树', host: 'zhihuishu.com', repository: 'Miaozeqiu/ZError-zhihuishu' },
].map(site => ({ ...site, branch: 'main', root: 'skills/' + site.id, url: 'https://github.com/' + site.repository })));

const shaPattern = /^[a-f0-9]{40}$/;
const documentPath = /^(?:SKILL\.md|site-graph\.json|references\/[a-z0-9][a-z0-9-]*\.md)$/;
const iconPath = /^assets\/[a-zA-Z0-9_-]+\.(png|ico|jpe?g|webp|gif)$/;
const mime = { png: 'image/png', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const maxDocument = 512 * 1024;
const maxPackage = 2 * 1024 * 1024;
const refreshInterval = 10 * 60_000;

// The client remains the authority for command/schema validation. Open verifies
// the compiled bytes before promoting an atomic package into its source cache.
function runtimePackage(value) {
  if (value?.apiVersion !== 2 || typeof value.bundle?.code !== 'string'
    || !value.bundle.code.trim() || Buffer.byteLength(value.bundle.code) > 256 * 1024
    || !/^[a-f0-9]{64}$/.test(value.bundle.sha256 || '')
    || createHash('sha256').update(value.bundle.code).digest('hex') !== value.bundle.sha256
    || !Array.isArray(value.tools) || !value.tools.length || value.tools.length > 32
    || Buffer.byteLength(JSON.stringify(value.tools)) > 64 * 1024) throw new Error('Invalid compiled website runtime');
  const names = value.tools.map(tool => tool?.name);
  if (names.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(name))
    || new Set(names).size !== names.length) throw new Error('Invalid website tool names');
  let total = 0;
  const ids = new Set();
  if (value.resources !== undefined) {
    if (!Array.isArray(value.resources) || value.resources.length > 4) throw new Error('Invalid runtime resources');
    for (const asset of value.resources) {
      if (!asset || !/^[a-z][a-z0-9_-]{0,63}$/.test(asset.id || '') || ids.has(asset.id)
        || !Number.isSafeInteger(asset.size) || asset.size < 1 || (total += asset.size) > 1024 * 1024
        || typeof asset.data !== 'string' || asset.data.length !== Math.ceil(asset.size / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.data)) throw new Error('Invalid runtime resource');
      ids.add(asset.id);
      const bytes = Buffer.from(asset.data, 'base64');
      if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Invalid runtime resource digest');
    }
  }
  return value;
}

async function readBytes(response, limit) {
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    await response.body?.cancel();
    throw new GitHubRateLimitError();
  }
  if (!response.ok || !response.body) throw new Error('Invalid GitHub response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new Error('GitHub response exceeds its size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

class GitHubRateLimitError extends Error {}

function parseJson(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function refreshSite(site, previous, fetchSource) {
  const api = 'https://api.github.com/repos/' + site.repository;
  const signal = AbortSignal.timeout(12000);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ZError-Open' };
  const headHeaders = previous?.upstreamEtag ? { ...headers, 'If-None-Match': previous.upstreamEtag } : headers;
  const head = await fetchSource(api + '/commits/' + site.branch, { headers: headHeaders, signal, redirect: 'error' });
  if (head.status === 304 && previous) return previous;
  const commit = parseJson(await readBytes(head, 512 * 1024));
  const revision = commit.sha;
  const treeSha = commit.commit?.tree?.sha;
  if (!shaPattern.test(revision || '') || !shaPattern.test(treeSha || '')) throw new Error('Invalid experience revision');
  const upstreamEtag = head.headers.get('etag');
  if (previous?.snapshot.revision === revision) return { ...previous, upstreamEtag };

  const treeResponse = await fetchSource(api + '/git/trees/' + treeSha + '?recursive=1', { headers, signal, redirect: 'error' });
  const tree = parseJson(await readBytes(treeResponse, 3 * 1024 * 1024));
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete experience tree');
  const prefix = site.root + '/';
  const entries = new Map(tree.tree
    .filter(entry => typeof entry.path === 'string' && entry.path.startsWith(prefix) && entry.type !== 'tree')
    .map(entry => [entry.path.slice(prefix.length), entry]));

  async function download(path, limit) {
    const entry = entries.get(path);
    if (entry?.type !== 'blob' || entry.mode !== '100644' || !shaPattern.test(entry.sha || '')
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limit) throw new Error('Invalid experience file');
    const response = await fetchSource(api + '/git/blobs/' + entry.sha, { headers, signal, redirect: 'error' });
    const blob = parseJson(await readBytes(response, Math.ceil(entry.size / 3) * 5 + 8192));
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.sha !== entry.sha || blob.size !== entry.size) {
      throw new Error('Invalid GitHub file response');
    }
    const bytes = Buffer.from(blob.content, 'base64');
    return verifyBlob(bytes, entry);
  }

  return packageSnapshot(site, revision, upstreamEtag, entries, download);
}

function verifyBlob(bytes, entry) {
  const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  if (bytes.length !== entry.size || hash !== entry.sha) throw new Error('Experience file does not match the commit');
  return bytes;
}

async function packageSnapshot(site, revision, upstreamEtag, entries, download) {
  const website = parseJson(await download('website.json', 16 * 1024));
  const iconMatch = iconPath.exec(website?.icon);
  if (website?.version !== 1 || website.id !== site.id || website.host !== site.host
    || typeof website.name !== 'string' || !website.name.trim() || website.name.length > 80 || !iconMatch) {
    throw new Error('Invalid experience manifest');
  }
  const runtime = entries.has('runtime.json') ? runtimePackage(parseJson(await download('runtime.json', 2 * 1024 * 1024))) : undefined;
  const paths = [...entries.keys()].filter(path => path !== 'website.json' && path !== 'runtime.json' && path !== website.icon);
  if (!paths.includes('SKILL.md') || !paths.includes('site-graph.json') || paths.length > 32
    || paths.some(path => !documentPath.test(path))
    || paths.reduce((total, path) => total + entries.get(path).size, 0) > maxPackage) {
    throw new Error('Invalid experience package');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const [iconBytes, documents] = await Promise.all([
    download(website.icon, 256 * 1024),
    Promise.all(paths.map(async path => [path, decoder.decode(await download(path, maxDocument))])),
  ]);
  const files = Object.fromEntries(documents);
  const graph = JSON.parse(files['site-graph.json']);
  if (graph?.id !== site.id || graph.host !== site.host || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error('Invalid experience graph');
  }
  const icon = { path: website.icon, dataUrl: 'data:' + mime[iconMatch[1]] + ';base64,' + iconBytes.toString('base64') };
  return { upstreamEtag, snapshot: { revision, files, website, icon, ...(runtime ? { runtime } : {}) } };
}

async function validateCachedSnapshot(site, value) {
  const snapshot = value?.snapshot;
  if (!shaPattern.test(snapshot?.revision || '') || !snapshot.files || Array.isArray(snapshot.files)
    || !snapshot.icon || !iconPath.test(snapshot.icon.path || '') || snapshot.icon.path !== snapshot.website?.icon
    || typeof snapshot.icon.dataUrl !== 'string' || snapshot.icon.dataUrl.length > 360 * 1024
    || !/^data:image\/[a-z-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(snapshot.icon.dataUrl)) throw new Error('Invalid cached website');
  const files = new Map();
  for (const [path, text] of Object.entries(snapshot.files)) {
    if (typeof text !== 'string') throw new Error('Invalid cached document');
    files.set(path, Buffer.from(text));
  }
  files.set('website.json', Buffer.from(JSON.stringify(snapshot.website)));
  files.set(snapshot.icon.path, Buffer.from(snapshot.icon.dataUrl.split(',')[1], 'base64'));
  if (snapshot.runtime !== undefined) files.set('runtime.json', Buffer.from(JSON.stringify(snapshot.runtime)));
  const entries = new Map([...files].map(([path, bytes]) => [path, { size: bytes.length }]));
  return packageSnapshot(site, snapshot.revision, value.upstreamEtag, entries, async (path, limit) => {
    const bytes = files.get(path);
    if (!bytes || bytes.length > limit) throw new Error('Invalid cached file size');
    return bytes;
  });
}

function createWebsiteExperience(fetchSource = fetch, gitSource = withGitSource, directory) {
  const cache = new Map();
  const persisted = createSnapshotCache(directory);

  return async function getExperience(site) {
    if (!cache.has(site.id)) cache.set(site.id, {});
    const state = cache.get(site.id);
    state.restored ||= persisted.read(site, value => validateCachedSnapshot(site, value)).then(saved => {
      if (saved) { state.value = saved.value; state.freshUntil = saved.savedAt + refreshInterval; }
    });
    await state.restored;
    const now = Date.now();
    if (state.value && now < state.freshUntil) return state.value.snapshot;
    if (now < state.retryAt) {
      if (state.value) return state.value.snapshot;
      throw new Error('Experience source temporarily unavailable');
    }
    state.pending ||= refreshSite(site, state.value, fetchSource).catch(error => {
      if (!(error instanceof GitHubRateLimitError)) throw error;
      return gitSource(site, async ({ revision, entries, blob }) => {
        if (state.value?.snapshot.revision === revision) return { ...state.value, upstreamEtag: undefined };
        const download = async (path, limit) => {
          const entry = entries.get(path);
          if (entry?.type !== 'blob' || entry.mode !== '100644' || !shaPattern.test(entry.sha || '')
            || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limit) throw new Error('Invalid experience file');
          return verifyBlob(await blob(entry.sha, limit), entry);
        };
        return packageSnapshot(site, revision, undefined, entries, download);
      });
    })
      .then(async value => {
        state.value = value;
        const checkedAt = Date.now();
        state.freshUntil = checkedAt + refreshInterval;
        state.retryAt = 0;
        await persisted.write(site, value, checkedAt).catch(() => console.warn('Verified website snapshot could not be persisted'));
        return value.snapshot;
      })
      .catch(error => {
        state.retryAt = Date.now() + 60_000;
        if (state.value) return state.value.snapshot;
        throw error;
      })
      .finally(() => { state.pending = undefined; });
    return state.pending;
  };
}

module.exports = { sites, createWebsiteExperience };
