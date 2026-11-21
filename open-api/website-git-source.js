// Public Git transport fallback for GitHub REST quota exhaustion. No credentials,
// checkout, repository hooks, or persistent clones are used.
const { spawn } = require('node:child_process');
const { mkdtemp, readdir, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function runGit(args, { signal, limit = 3 * 1024 * 1024, packDirectory } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('GitHub Git transport timed out'));
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
      '-c', 'init.templateDir=', '-c', 'http.version=HTTP/1.1', '-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=5', ...args], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_ALTERNATE_OBJECT_DIRECTORIES: '' },
    });
    let failure, length = 0, closed = false;
    const chunks = [];
    const stop = message => {
      if (closed) return;
      failure ||= new Error(message);
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop('GitHub Git transport timed out');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 20000);
    let checking = false;
    const monitor = packDirectory && setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const files = await readdir(packDirectory);
        const sizes = await Promise.all(files.map(name => stat(join(packDirectory, name)).then(row => row.size)));
        if (files.length > 32 || sizes.reduce((a, b) => a + b, 0) > 64 * 1024 * 1024)
          stop('GitHub repository exceeds its size limit');
      } catch (error) {
        if (error.code !== 'ENOENT') stop('GitHub repository size check failed');
      } finally { checking = false; }
    }, 250);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > limit) stop('GitHub Git result exceeds its size limit');
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => { failure ||= new Error('GitHub Git transport unavailable'); });
    child.on('close', code => {
      closed = true;
      clearTimeout(timer);
      if (monitor) clearInterval(monitor);
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(failure || new Error('GitHub Git transport failed'));
      else resolve(Buffer.concat(chunks, length));
    });
    if (signal?.aborted) abort();
  });
}

async function readGitRepository(directory, site, signal) {
  const git = (args, limit) => runGit(['-C', directory, ...args], { signal, limit });
  const revision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'], 128)).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid Git revision');
  const tree = await git(['ls-tree', '-r', '-z', '-l', revision, '--', site.root]);
  const entries = new Map();
  for (const row of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(row);
    if (!match || !match[5].startsWith(site.root + '/')) throw new Error('Invalid Git tree');
    entries.set(match[5].slice(site.root.length + 1),
      { mode: match[1], type: match[2], sha: match[3], size: Number(match[4]) });
  }
  return { revision, entries, blob: (sha, limit) => git(['cat-file', 'blob', sha], limit) };
}

async function withGitSource(site, work) {
  if (!/^Miaozeqiu\/ZError-(chaoxing|zjooc|zhihuishu)$/.test(site.repository)
    || site.branch !== 'main' || !/^skills\/(chaoxing|zjooc|zhihuishu)$/.test(site.root))
    throw new Error('Git source is not an official repository');
  const directory = await mkdtemp(join(tmpdir(), 'zerror-website-'));
  const repository = join(directory, 'repository');
  const signal = AbortSignal.timeout(20000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await runGit(['clone', '--bare', '--depth=1', '--single-branch', '--branch', site.branch,
          '--', 'https://github.com/' + site.repository + '.git', repository],
        { signal, limit: 4096, packDirectory: join(repository, 'objects', 'pack') });
        break;
      } catch (error) {
        // Retry only transient read transport errors within the original deadline.
        if (attempt || signal.aborted || error.message !== 'GitHub Git transport failed') throw error;
        await rm(repository, { recursive: true, force: true });
      }
    }
    return await work(await readGitRepository(repository, site, signal));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

module.exports = { withGitSource, readGitRepository };
