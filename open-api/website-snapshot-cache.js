const { createHash, randomUUID } = require('node:crypto');
const { readFile, writeFile, rename, stat, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const limit = 13 * 1024 * 1024;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createSnapshotCache(directory) {
  const path = site => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(site.id)) throw new Error('Invalid cached website ID');
    return join(directory, 'website-' + site.id + '.json');
  };
  return {
    async read(site, validate) {
      if (!directory) return;
      try {
        const file = path(site), info = await stat(file);
        if (!info.isFile() || info.size > limit) return;
        const record = JSON.parse(await readFile(file, 'utf8'));
        if (record.version !== 1 || !Number.isSafeInteger(record.savedAt) || record.savedAt > Date.now()
          || record.sha256 !== digest(record.value)) return;
        return { value: await validate(record.value), savedAt: record.savedAt };
      } catch { return; }
    },
    async write(site, value, savedAt) {
      if (!directory) return;
      const file = path(site), temporary = file + '.' + randomUUID() + '.tmp';
      const text = JSON.stringify({ version: 1, savedAt, value, sha256: digest(value) });
      if (Buffer.byteLength(text) > limit) throw new Error('Website cache exceeds its size limit');
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => {}); }
    },
  };
}

module.exports = { createSnapshotCache };
