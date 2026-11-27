const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { open, readdir, rename, stat, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const releaseLimit = 2;
const releaseByteLimit = 2 * 1024 ** 3;
const parallelDownloads = 4;
const cacheable = 'public, max-age=0, s-maxage=86400';
const cacheFilePattern = /^\d+-[a-f0-9]{64}\.installer(?:\.part)?$/;

function cacheName(installer) {
  return installer.size && installer.digest ? installer.assetId + '-' + installer.digest.slice(7) + '.installer' : null;
}

async function statFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function discard(path) {
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function validDigest(path, digest) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return 'sha256:' + hash.digest('hex') === digest;
}

async function fillInstaller(path, installer, readAsset, signal) {
  const partial = path + '.part';
  let received = (await statFile(partial))?.size ?? 0;
  if (received > installer.size) {
    await discard(partial);
    received = 0;
  }
  if (received < installer.size) {
    const headers = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };
    if (received) headers.Range = 'bytes=' + received + '-';
    const upstream = await readAsset(installer.assetId, {
      headers, signal: AbortSignal.any([signal, AbortSignal.timeout(12 * 60 * 60_000)]),
    });
    const encoding = upstream.headers.get('Content-Encoding');
    const contentRange = upstream.headers.get('Content-Range');
    const expectedRange = 'bytes ' + received + '-' + (installer.size - 1) + '/' + installer.size;
    if (upstream.status === 200) received = 0;
    if (!upstream.body || (encoding && encoding !== 'identity')
      || (upstream.status !== 200 && (upstream.status !== 206 || !received || contentRange !== expectedRange))
      || Number(upstream.headers.get('Content-Length')) !== installer.size - received) {
      await upstream.body?.cancel();
      throw new Error('Unexpected installer response (' + upstream.status + ')');
    }
    // Keep valid partial downloads after transient network errors. Bound writes by
    // the published size, even if an upstream sends more than it declared.
    const measure = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > installer.size) return done(new Error('Installer exceeded published size'));
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(upstream.body), measure, createWriteStream(partial, {
      flags: received ? 'a' : 'w', mode: 0o600,
    }), { signal });
  }
  const size = (await statFile(partial))?.size;
  if (size !== installer.size) throw new Error('Incomplete installer');
  if (!(await validDigest(partial, installer.digest))) {
    await discard(partial);
    throw new Error('Installer SHA-256 mismatch');
  }
  await rename(partial, path);
}

function createInstallerCache(directory, readAsset, report = console.warn) {
  const controller = new AbortController();
  const active = new Set();
  const queue = new Map();

  async function prepare(name, installer) {
    const path = join(directory, name);
    if ((await statFile(path))?.size === installer.size) return;
    await fillInstaller(path, installer, readAsset, controller.signal);
  }

  function run() {
    for (const [name, installer] of queue) {
      if (controller.signal.aborted || active.size >= parallelDownloads) break;
      queue.delete(name);
      if (active.has(name)) continue;
      active.add(name);
      prepare(name, installer)
        .catch(error => {
          if (!controller.signal.aborted) report('Installer cache ' + installer.assetId + ': ' + error.message);
        })
        .finally(() => {
          active.delete(name);
          run();
        });
    }
  }

  async function warm({ releases, partial }) {
    queue.clear();
    const retained = new Set();
    for (const release of releases.slice(0, releaseLimit)) {
      let size = 0;
      for (const installer of [...release.installers, ...(release.updaters || [])]) {
        const name = cacheName(installer);
        if (!name || size + installer.size > releaseByteLimit) continue;
        size += installer.size;
        retained.add(name);
        if (!active.has(name)) queue.set(name, installer);
      }
    }
    run();

    if (partial) return;
    for (const file of await readdir(directory)) {
      if (!cacheFilePattern.test(file)) continue;
      const name = file.replace(/\.part$/, '');
      if (!retained.has(name) && !active.has(name)) await discard(join(directory, file));
    }
  }

  async function find(installer) {
    const name = cacheName(installer);
    if (!name) return null;
    const path = join(directory, name);
    return (await statFile(path))?.size === installer.size ? path : null;
  }

  return { warm, find, close: () => controller.abort() };
}

function byteRange(range, size) {
  const [first, last] = range.slice('bytes='.length).split('-');
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1;
  return start <= end ? { start, end } : null;
}

async function serveCachedInstaller(request, response, path, installer) {
  const file = await open(path, 'r').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!file) return false;
  try {
    const { size } = installer;
    const etag = '"' + installer.digest + '"';
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheable,
      ETag: etag,
      'X-Open-Installer-Cache': 'HIT',
    };
    const noneMatch = request.headers['if-none-match']?.split(/,\s*/);
    if (noneMatch?.some(value => value === '*' || value.replace(/^W\//, '') === etag)) {
      response.writeHead(304, headers);
      response.end();
      return true;
    }
    let selection = { start: 0, end: size - 1 };
    let status = 200;
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      selection = byteRange(request.headers.range, size);
      if (!selection) {
        response.writeHead(416, { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes */' + size });
        response.end();
        return true;
      }
      status = 206;
      headers['Content-Range'] = 'bytes ' + selection.start + '-' + selection.end + '/' + size;
    }
    response.writeHead(status, {
      ...headers,
      'Content-Length': selection.end - selection.start + 1,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + installer.name + '"',
    });
    if (request.method === 'HEAD') response.end();
    else await pipeline(file.createReadStream({ ...selection, autoClose: false }), response);
    return true;
  } finally {
    await file.close();
  }
}

module.exports = { createInstallerCache, serveCachedInstaller };
