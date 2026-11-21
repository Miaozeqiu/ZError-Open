const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');
const { createWebsiteExperience, sites } = require('./website-experience');
const { readGitRepository, withGitSource } = require('./website-git-source');

async function repository(t, corrupt = false) {
  const directory = await mkdtemp(join(tmpdir(), 'zerror-git-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const site = sites.find(site => site.id === 'chaoxing');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', '-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const bytes = Buffer.from('font-resource');
  const code = 'var ZErrorSitePackage={*create(){return {ok:true}}};';
  const digest = input => createHash('sha256').update(input).digest('hex');
  const runtime = { apiVersion: 2, bundle: { code, sha256: corrupt ? '0'.repeat(64) : digest(code) },
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    resources: [{ id: 'font', size: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') }] };
  await mkdir(join(directory, site.root, 'assets'), { recursive: true });
  for (const [path, data] of Object.entries({
    'website.json': JSON.stringify({ version: 1, id: site.id, host: site.host, name: 'Website', icon: 'assets/icon.png' }),
    'SKILL.md': 'Experience', 'site-graph.json': JSON.stringify({ id: site.id, host: site.host, nodes: [], edges: [] }),
    'assets/icon.png': 'image', 'runtime.json': JSON.stringify(runtime),
  })) await writeFile(join(directory, site.root, path), data);
  git('add', '.');
  git('commit', '-m', 'Fixture');
  return { site, directory, revision: git('rev-parse', 'HEAD'), runtime };
}

test('REST quota exhaustion uses verified native Git objects and caches the compiled snapshot', async t => {
  const fixture = await repository(t);
  let requests = 0, clones = 0;
  const get = createWebsiteExperience(async () => {
    requests++;
    return Response.json({ message: 'Rate limited' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  }, async (site, work) => { clones++; return work(await readGitRepository(fixture.directory, site)); });
  const [first, second] = await Promise.all([get(fixture.site), get(fixture.site)]);
  assert.deepEqual(first, second);
  assert.equal(first.revision, fixture.revision);
  assert.deepEqual(first.runtime, fixture.runtime);
  assert.equal(first.files['runtime.json'], undefined);
  assert.deepEqual(await get(fixture.site), first);
  assert.equal(requests, 1);
  assert.equal(clones, 1);
});

test('Git fallback does not permit corrupted compiled bytes or bypass non-quota failures', async t => {
  const fixture = await repository(t, true);
  const fallback = (site, work) => readGitRepository(fixture.directory, site).then(work);
  const get = createWebsiteExperience(async () => new Response('', { status: 429 }), fallback);
  await assert.rejects(get(fixture.site), /Invalid compiled/);
  const bad = createWebsiteExperience(async () => new Response('', { status: 500 }), () => {
    assert.fail('an ordinary source error must not fall back');
  });
  await assert.rejects(bad(fixture.site), /Invalid GitHub response/);
  await assert.rejects(withGitSource({ ...fixture.site, repository: 'different/repository' }, () => {}), /not an official/);
});

test('verified compiled snapshots survive a restart without contacting GitHub again', async t => {
  const fixture = await repository(t);
  const cache = await mkdtemp(join(tmpdir(), 'zerror-snapshot-cache-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const fetchSource = async () => new Response('', { status: 429 });
  const git = (site, work) => readGitRepository(fixture.directory, site).then(work);
  const first = await createWebsiteExperience(fetchSource, git, cache)(fixture.site);
  const forbidden = () => assert.fail('a fresh persisted snapshot must not fetch upstream');
  const restarted = createWebsiteExperience(forbidden, forbidden, cache);
  assert.deepEqual(await restarted(fixture.site), first);
  assert.deepEqual(await restarted(fixture.site), first);
});

test('persisted snapshots recheck compiled hashes and website identity before use', async t => {
  const fixture = await repository(t);
  const cache = await mkdtemp(join(tmpdir(), 'zerror-snapshot-invalid-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const fetchSource = async () => new Response('', { status: 429 });
  const git = (site, work) => readGitRepository(fixture.directory, site).then(work);
  const expected = await createWebsiteExperience(fetchSource, git, cache)(fixture.site);
  const file = join(cache, 'website-chaoxing.json');
  for (const tamper of [value => { value.snapshot.runtime.bundle.code += 'corrupt'; },
    value => { value.snapshot.website.host = 'outside.example'; }]) {
    const record = JSON.parse(await readFile(file, 'utf8'));
    tamper(record.value);
    record.sha256 = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    await writeFile(file, JSON.stringify(record));
    let refreshed = 0;
    const get = createWebsiteExperience(fetchSource, async (...args) => { refreshed++; return git(...args); }, cache);
    assert.deepEqual(await get(fixture.site), expected);
    assert.equal(refreshed, 1);
  }
});

test('temporary upstream failure keeps a verified persisted snapshot and backs off retries', async t => {
  const fixture = await repository(t);
  const cache = await mkdtemp(join(tmpdir(), 'zerror-snapshot-outage-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const expected = await createWebsiteExperience(async () => new Response('', { status: 429 }),
    (site, work) => readGitRepository(fixture.directory, site).then(work), cache)(fixture.site);
  const file = join(cache, 'website-chaoxing.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.savedAt = Date.now() - 11 * 60_000;
  await writeFile(file, JSON.stringify(record));
  let calls = 0;
  const get = createWebsiteExperience(async () => { calls++; throw new Error('offline'); }, undefined, cache);
  assert.deepEqual(await get(fixture.site), expected);
  assert.deepEqual(await get(fixture.site), expected);
  assert.equal(calls, 1);
});
