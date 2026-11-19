const releasePath = 'https://github.com/Miaozeqiu/ZError/releases/';
const releasesApi = 'https://api.github.com/repos/Miaozeqiu/ZError/releases';
const releaseApi = releasesApi + '/latest';
const releaseHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'ZError-Open' };
const archPattern = /(?:^|[-_.])(x86_64|amd64|x64|aarch64|arm64|i686|x86|armv7|universal)(?=[-_.]|$)/;
const architectures = { amd64: 'x86_64', x64: 'x86_64', arm64: 'aarch64', x86: 'i686' };
const cacheDuration = 5 * 60_000;
const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseAsset(asset, tag) {
  const name = asset?.name;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) return null;
  const url = releasePath + 'download/' + encodeURIComponent(tag) + '/' + encodeURIComponent(name);
  return asset.browser_download_url === url ? { name, url } : null;
}

async function readSignature(asset, request, signal) {
  try {
    const response = await request(asset.url, { signal });
    if (!response.ok) return null;
    const reader = response.body.getReader();
    let text = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > 4096) return null;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const signature = (text + decoder.decode()).trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return null;
    // Tauri signs with minisign and wraps the signature file in base64.
    const decoded = Buffer.from(signature, 'base64').toString('utf8');
    return /^untrusted comment:.*\r?\n[A-Za-z0-9+/=]+\r?\ntrusted comment:/.test(decoded) ? signature : null;
  } catch {
    return null;
  }
}

async function fetchReleasePage(request, signal) {
  const latest = await request(releasePath + 'latest', { signal, redirect: 'manual' });
  if (latest.status === 404) return null;
  const location = latest.headers.get('location');
  const tagPrefix = releasePath + 'tag/';
  if (!location?.startsWith(tagPrefix)) throw new Error('Invalid latest release redirect');
  const tag = location.slice(tagPrefix.length);
  if (!stableTag.test(tag)) throw new Error('Invalid stable release');
  const [page, listing] = await Promise.all([
    request(location, { signal, redirect: 'error' }),
    request(releasePath + 'expanded_assets/' + tag, { signal, redirect: 'error' }),
  ]);
  if (!page.ok || !listing.ok) throw new Error('GitHub release page unavailable');
  const [html, attachments] = await Promise.all([page.text(), listing.text()]);
  const prefix = '/Miaozeqiu/ZError/releases/download/' + tag + '/';
  const assets = [];
  for (const [, path] of attachments.matchAll(/\bhref="([^"]+)"/g)) {
    if (!path.startsWith(prefix)) continue;
    assets.push({ name: path.slice(prefix.length), browser_download_url: 'https://github.com' + path });
  }
  const description = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] || '';
  const escapes = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  return {
    tag_name: tag,
    published_at: html.match(/<relative-time\b[^>]*\bdatetime="([^"]+)"/)?.[1],
    body: description.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => escapes[entity]),
    assets,
  };
}

async function fetchReleaseMetadata(request, signal) {
  const response = await request(releaseApi, { signal, redirect: 'error', headers: releaseHeaders });
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) return fetchReleasePage(request, signal);
  if (!response.ok) throw new Error('GitHub release request failed');
  return response.json();
}

async function fetchRelease(request) {
  const signal = AbortSignal.timeout(8000);
  const release = await fetchReleaseMetadata(request, signal);
  if (!release) return null;
  const tag = release.tag_name;
  if (release.draft || release.prerelease || typeof tag !== 'string' || !stableTag.test(tag)) {
    throw new Error('Invalid stable release');
  }
  const assets = new Map((release.assets || []).map(asset => releaseAsset(asset, tag)).filter(Boolean).map(asset => [asset.name, asset]));
  const installers = {};
  const platforms = {};
  const packages = new Map();
  for (const asset of assets.values()) {
    if (!/^zerror(?:[_.-]|$)/i.test(asset.name)) continue;
    const name = asset.name.toLowerCase();
    const windows = /\.(exe|msi)$/.test(name);
    const mac = /\.(dmg|app\.tar\.gz)$/.test(name);
    if (!windows && !mac) continue;
    const token = name.match(archPattern)?.[1];
    const legacyWindows = /^zerror_setup_\d+\.\d+\.\d+\.exe$/.test(name);
    const arch = architectures[token] || token || (legacyWindows ? 'x86_64' : '');
    if (!arch || (arch === 'universal' && !mac)) continue;
    const targets = arch === 'universal' ? ['darwin-aarch64', 'darwin-x86_64'] : [(windows ? 'windows-' : 'darwin-') + arch];
    for (const target of targets) {
      if (windows || name.endsWith('.dmg')) {
        if (!installers[target] || name.endsWith('.exe')) installers[target] = asset.url;
      }
      const signatureAsset = assets.get(asset.name + '.sig');
      if (signatureAsset && (windows || name.endsWith('.app.tar.gz'))) {
        if (!packages.has(target) || name.endsWith('.exe')) packages.set(target, { asset, signatureAsset });
      }
    }
  }
  const signatures = new Map();
  await Promise.all([...packages].map(async ([target, { asset, signatureAsset }]) => {
    if (!signatures.has(signatureAsset.url)) signatures.set(signatureAsset.url, readSignature(signatureAsset, request, signal));
    const signature = await signatures.get(signatureAsset.url);
    if (signature) platforms[target] = { url: asset.url, signature };
  }));
  const notes = typeof release.body === 'string' ? release.body : '';
  const { published_at: published } = release;
  return {
    version: tag.replace(/^v/, ''),
    notes,
    changelog: notes,
    ...(Number.isFinite(Date.parse(published)) ? { pub_date: published, releaseDate: published } : {}),
    releaseUrl: releasePath + 'tag/' + encodeURIComponent(tag),
    installers,
    platforms,
  };
}

function publicInstaller(asset, tag) {
  if (asset?.state && asset.state !== 'uploaded') return null;
  const entry = releaseAsset(asset, tag);
  if (!entry || !/^zerror(?:[_.-]|$)/i.test(entry.name)) return null;
  const name = entry.name.toLowerCase();
  const format = name.match(/\.(exe|msi|dmg|appimage|deb)$/)?.[1];
  if (!format) return null;
  const platform = format === 'exe' || format === 'msi' ? 'windows' : format === 'dmg' ? 'macos' : 'linux';
  const token = name.match(archPattern)?.[1];
  const legacyWindows = /^zerror_setup_\d+\.\d+\.\d+\.exe$/.test(name);
  const arch = architectures[token] || token || (legacyWindows ? 'x86_64' : '');
  return arch && (arch !== 'universal' || platform === 'macos') ? { ...entry, platform, arch, format } : null;
}

function publicRelease(release) {
  const tag = release?.tag_name;
  if (release?.draft || release?.prerelease || typeof tag !== 'string' || !stableTag.test(tag)) return null;
  const version = tag.replace(/^v/, '');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return {
    tag,
    version,
    name: typeof release.name === 'string' && release.name.trim() ? release.name.slice(0, 160) : 'ZError v' + version,
    releaseDate: Number.isFinite(Date.parse(release.published_at)) ? release.published_at : null,
    releaseUrl: releasePath + 'tag/' + encodeURIComponent(tag),
    notes: typeof release.body === 'string' ? release.body.slice(0, 20_000) : '',
    installers: assets.map(asset => publicInstaller(asset, tag)).filter(Boolean),
  };
}

async function fetchReleaseList(request) {
  const signal = AbortSignal.timeout(8000);
  const [history, latest] = await Promise.allSettled([
    request(releasesApi + '?per_page=50', { signal, redirect: 'error', headers: releaseHeaders }),
    fetchReleaseMetadata(request, signal).then(publicRelease),
  ]);
  const newest = latest.status === 'fulfilled' ? latest.value : null;
  if (history.status === 'rejected' || !history.value.ok) {
    if (latest.status === 'fulfilled') return { releases: newest ? [newest] : [], partial: true };
    throw new Error('GitHub release list request failed');
  }
  const data = await history.value.json();
  if (!Array.isArray(data)) throw new Error('Invalid GitHub release list');
  const releases = data.map(publicRelease).filter(Boolean);
  // GitHub's public history can temporarily omit a republished draft even
  // when the canonical latest endpoint already serves the new release.
  return {
    releases: newest ? [newest, ...releases.filter(release => release.tag !== newest.tag)] : releases,
    partial: /rel="next"/.test(history.value.headers.get('link') || ''),
  };
}

function createCachedFeed(load) {
  let current;
  let expiresAt = 0;
  let pending;
  let failure;
  return function getRelease() {
    if (Date.now() < expiresAt) return failure ? Promise.reject(failure) : Promise.resolve(current);
    pending ||= load().then(release => {
      current = release;
      failure = undefined;
      expiresAt = Date.now() + cacheDuration;
      return release;
    }).catch(error => {
      expiresAt = Date.now() + 60_000;
      if (current === undefined) {
        failure = error;
        throw error;
      }
      return current;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

const createAppUpdateFeed = (request = fetch) => createCachedFeed(() => fetchRelease(request));
const createReleaseListFeed = (request = fetch) => createCachedFeed(() => fetchReleaseList(request));

module.exports = { createAppUpdateFeed, createReleaseListFeed };
