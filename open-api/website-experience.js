const { createHash } = require('node:crypto');

const sites = Object.freeze([
  { id: 'chaoxing', name: '学习通', host: 'chaoxing.com', repository: 'Miaozeqiu/ZError-chaoxing' },
  { id: 'zjooc', name: '在浙学', host: 'zjooc.cn', repository: 'Miaozeqiu/ZError-zjooc' },
  { id: 'zhihuishu', name: '智慧树', host: 'zhihuishu.com', repository: 'Miaozeqiu/ZError-zhihuishu' },
].map(site => ({ ...site, branch: 'main', root: 'skills/' + site.id, url: 'https://github.com/' + site.repository })));

const shaPattern = /^[a-f0-9]{40}$/;
const documentPath = /^(?:SKILL\.md|site-graph\.json|references\/[a-z0-9][a-z0-9-]*\.md)$/;
const siteScriptPath = /^site-tools\/([a-z][a-z0-9-]{0,40})\.js$/;
const toolLimit = 32 * 1024;
const scriptLimit = 256 * 1024;
const iconPath = /^assets\/[a-zA-Z0-9_-]+\.(png|ico|jpe?g|webp|gif)$/;
const mime = { png: 'image/png', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const maxDocument = 512 * 1024;
const maxPackage = 2 * 1024 * 1024;
const refreshInterval = 10 * 60_000;

async function readBytes(response, limit) {
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
    .filter(entry => typeof entry.path === 'string' && entry.type !== 'tree'
      && (entry.path.startsWith(prefix) || (site.id !== 'zhihuishu' && (entry.path === 'site-tools/tools.json' || siteScriptPath.test(entry.path)))))
    .map(entry => [entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path, entry]));

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
    const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    if (bytes.length !== entry.size || hash !== entry.sha) throw new Error('Experience file does not match the commit');
    return bytes;
  }

  const website = parseJson(await download('website.json', 16 * 1024));
  const iconMatch = iconPath.exec(website?.icon);
  if (website?.version !== 1 || website.id !== site.id || website.host !== site.host
    || typeof website.name !== 'string' || !website.name.trim() || website.name.length > 80 || !iconMatch) {
    throw new Error('Invalid experience manifest');
  }
  const paths = [...entries.keys()].filter(path => path !== 'website.json' && path !== website.icon && !path.startsWith('site-tools/'));
  if (!paths.includes('SKILL.md') || !paths.includes('site-graph.json') || paths.length > 32
    || paths.some(path => !documentPath.test(path))
    || paths.reduce((total, path) => total + entries.get(path).size, 0) > maxPackage) {
    throw new Error('Invalid experience package');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const toolsFile = 'site-tools/tools.json';
  const scriptPaths = [...entries.keys()].filter(path => siteScriptPath.test(path));
  if (scriptPaths.length > 12 || (scriptPaths.length && !entries.has(toolsFile))) throw new Error('Invalid website scripts');
  const [iconBytes, documents, toolBytes, scripts] = await Promise.all([
    download(website.icon, 256 * 1024),
    Promise.all(paths.map(async path => [path, decoder.decode(await download(path, maxDocument))])),
    entries.has(toolsFile) ? download(toolsFile, toolLimit) : undefined,
    Promise.all(scriptPaths.map(async path => {
      const code = await download(path, scriptLimit);
      return { name: siteScriptPath.exec(path)[1], code, sha256: createHash('sha256').update(code).digest('hex') };
    })),
  ]);
  const files = Object.fromEntries(documents);
  const graph = JSON.parse(files['site-graph.json']);
  if (graph?.id !== site.id || graph.host !== site.host || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error('Invalid experience graph');
  }
  const icon = { path: website.icon, dataUrl: 'data:' + mime[iconMatch[1]] + ';base64,' + iconBytes.toString('base64') };
  const tools = toolBytes ? parseJson(toolBytes) : [];
  if (!Array.isArray(tools) || tools.length > 32 || tools.some(row => row?.type !== 'function'
    || !/^browser_[a-z][a-z0-9_]{0,58}$/.test(row.function?.name ?? '')
    || typeof row.function?.description !== 'string' || row.function?.parameters?.type !== 'object')
    || new Set(tools.map(row => row.function.name)).size !== tools.length) throw new Error('Invalid website tools');
  const artifacts = new Map(scripts.map(({ name, code, sha256 }) => [name + '.' + sha256 + '.js', code]));
  const hasScripts = scripts.length > 0;
  const manifest = hasScripts ? {
    apiVersion: 1, siteId: site.id, revision,
    bundles: Object.fromEntries(scripts.map(({ name, sha256 }) => [name, { url: './scripts/' + name + '.' + sha256 + '.js', sha256 }])),
  } : undefined;
  return { upstreamEtag, snapshot: { revision, files, website, icon, tools,
    ...(hasScripts ? { scriptManifest: '/v1/website-experience/' + site.host + '/script-manifest.json' } : {}) }, manifest, artifacts };
}

function createWebsiteExperience(fetchSource = fetch) {
  const cache = new Map();

  return async function getExperience(site) {
    if (!cache.has(site.id)) cache.set(site.id, {});
    const state = cache.get(site.id);
    const now = Date.now();
    if (state.value && now < state.freshUntil) return state.value;
    if (now < state.retryAt) {
      if (state.value) return state.value;
      throw new Error('Experience source temporarily unavailable');
    }
    state.pending ||= refreshSite(site, state.value, fetchSource)
      .then(value => {
        state.value = value;
        state.freshUntil = Date.now() + refreshInterval;
        state.retryAt = 0;
        return value;
      })
      .catch(error => {
        state.retryAt = Date.now() + 60_000;
        if (state.value) return state.value;
        throw error;
      })
      .finally(() => { state.pending = undefined; });
    return state.pending;
  };
}

module.exports = { sites, createWebsiteExperience };
