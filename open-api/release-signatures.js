const { randomUUID, createHash } = require('node:crypto');
const { readFile, writeFile, rename, unlink, stat, readdir } = require('node:fs/promises');
const { join } = require('node:path');

function validSignature(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return /^untrusted comment:.*\r?\n[A-Za-z0-9+/=]+\r?\ntrusted comment:/.test(decoded);
}

function createSignatureReader(request, directory) {
  const pending = new Map();
  return function readSignature(asset) {
    // 签名按 GitHub 附件 ID 和地址缓存，重新上传同名文件不会沿用旧签名。
    const key = createHash('sha256').update(String(asset.assetId) + ':' + asset.url).digest('hex');
    if (pending.has(key)) return pending.get(key);
    const path = directory && Number.isSafeInteger(asset.assetId) && asset.assetId > 0
      ? join(directory, 'release-signature-' + key + '.json') : null;
    const operation = (async () => {
      if (path) {
        try {
          if ((await stat(path)).size <= 8192) {
            const saved = JSON.parse(await readFile(path, 'utf8'));
            if (saved.url === asset.url && saved.assetId === asset.assetId && validSignature(saved.signature)) return saved.signature;
          }
        } catch { /* 缓存损坏或不存在时重新获取，不影响更新检查。 */ }
      }
      try {
        // 每个附件独立计时，避免一个慢请求耗尽其他平台签名的时间。
        const response = await request(asset.url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) return null;
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        const signature = Buffer.concat(chunks).toString('utf8').trim();
        if (!validSignature(signature)) return null;
        if (path) {
          const temporary = path + '.' + randomUUID() + '.tmp';
          try {
            await writeFile(temporary, JSON.stringify({ url: asset.url, assetId: asset.assetId, signature }), { mode: 0o600 });
            await rename(temporary, path);
            // 只保留最近 128 个签名文件，限制长期运行时的磁盘占用。
            const entries = await readdir(directory);
            const files = await Promise.all(entries.filter(name => /^release-signature-[a-f0-9]{64}\.json$/.test(name))
              .map(async name => ({ name, time: (await stat(join(directory, name)).catch(() => null))?.mtimeMs || 0 })));
            await Promise.all(files.sort((a, b) => b.time - a.time).slice(128).map(file => unlink(join(directory, file.name)).catch(() => {})));
          } catch { /* 缓存写入失败仍可返回本次已验证的签名。 */ }
          finally { await unlink(temporary).catch(() => {}); }
        }
        return signature;
      } catch { return null; }
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
}

module.exports = { createSignatureReader };
