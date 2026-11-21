// Preserve public release metadata across service restarts and REST rate limits.
// Package bytes remain in the existing verified installer cache.
const { randomUUID } = require('node:crypto');
const { readFile, writeFile, rename, stat, unlink } = require('node:fs/promises');
const { join } = require('node:path');

const endpoints = new Map([
  ['https://api.github.com/repos/Miaozeqiu/ZError/releases/latest', 'release-latest.json'],
  ['https://api.github.com/repos/Miaozeqiu/ZError/releases?per_page=50', 'release-history.json'],
]);
const maxBytes = 4 * 1024 * 1024;

function valid(bytes, name) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (name === 'release-history.json' ? !Array.isArray(value) || value.length > 100
    : !value || typeof value.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(value.tag_name))
    throw new Error('Invalid persisted release metadata');
  return bytes;
}

async function readCached(path, name) {
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size > maxBytes) return null;
    return valid(await readFile(path), name);
  } catch { return null; }
}

function createReleaseMetadataSource(request, directory, report = console.warn) {
  if (!directory) return request;
  return async (url, options) => {
    const name = endpoints.get(String(url));
    if (!name) return request(url, options);
    const path = join(directory, name);
    let response;
    try { response = await request(url, options); }
    catch (error) {
      const cached = await readCached(path, name);
      if (!cached) throw error;
      return new Response(cached, { headers: { 'Content-Type': 'application/json' } });
    }
    if (response.status === 404) {
      // An explicit withdrawal remains authoritative over persisted metadata.
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') report('Release cache removal failed'); });
      return response;
    }
    if ([403, 429].includes(response.status) || response.status >= 500) {
      const cached = await readCached(path, name);
      if (cached) {
        await response.body?.cancel();
        return new Response(cached, { headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    }
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('Release metadata exceeds its size limit');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = valid(Buffer.concat(chunks, size), name);
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch { report('Release metadata could not be persisted'); }
    finally { await unlink(temporary).catch(() => {}); }
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
}

module.exports = { createReleaseMetadataSource };
