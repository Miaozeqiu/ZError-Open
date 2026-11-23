const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createAgentSkills, loadSkill } = require('./agent-skills');
const { makeServer } = require('./server');
const hash = x => createHash('sha256').update(x).digest('hex');
async function serve(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('skill package and canonical revision cover every UTF-8 byte', () => {
  const skill = loadSkill();
  assert.equal(skill.name, 'zerror');
  assert.ok(skill.files.some(f => f.path === 'SKILL.md'));
  for (const f of skill.files) { assert.equal(f.bytes, Buffer.byteLength(f.content)); assert.equal(f.sha256, hash(f.content)); }
  const identity = `zerror-agent-skill:1\n${skill.name}\n${skill.version}\n${skill.cliProtocol}\n` + skill.files.map(f => `${f.path}\t${f.bytes}\t${f.sha256}\n`).join('');
  assert.equal(skill.revision, hash(identity));
});
test('publishing a new metadata version changes the package revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zerror-skill-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = version => `---\nname: zerror\nmetadata:\n  version: "${version}"\n---\n`;
  await writeFile(join(root, 'SKILL.md'), source('1.0.0'));
  const previous = loadSkill(root);
  await writeFile(join(root, 'SKILL.md'), source('1.0.1'));
  const next = loadSkill(root);
  assert.equal(next.version, '1.0.1'); assert.notEqual(next.revision, previous.revision);
});
test('catalog, package and raw files support versioned caching, HEAD and 304', async t => {
  const handler = createAgentSkills();
  const base = await serve(t, (req, res) => { if (!handler(req, res, req.url)) { res.writeHead(404); res.end(); } });
  const catalog = await (await fetch(base + '/v1/agent-skills')).json();
  const endpoint = base + catalog.skills[0].url;
  const response = await fetch(endpoint), skill = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-skill-version'), skill.version);
  const raw = await fetch(base + catalog.skills[0].skillUrl);
  assert.equal(await raw.text(), skill.files.find(f => f.path === 'SKILL.md').content);
  assert.match(raw.headers.get('content-type'), /text\/markdown/);
  const head = await fetch(endpoint, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('etag'), response.headers.get('etag'));
  const cached = await fetch(endpoint, { headers: { 'If-None-Match': head.headers.get('etag') } });
  assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
  assert.match(head.headers.get('cache-control'), /max-age=60/);
});
test('unknown files, method restrictions and prefix boundaries', async t => {
  const handler = createAgentSkills();
  const base = await serve(t, (req, res) => { if (!handler(req, res, req.url)) { res.writeHead(418); res.end(); } });
  assert.equal((await fetch(base + '/v1/agent-skills/zerror/private.json')).status, 404);
  assert.equal((await fetch(base + '/v1/agent-skills-oops')).status, 418);
  assert.equal((await fetch(base + '/v1/agent-skills/zerror', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/v1/agent-skills', { method: 'OPTIONS' })).status, 204);
  const head = await fetch(base + '/v1/agent-skills/missing', { method: 'HEAD' });
  assert.equal(head.status, 404); assert.equal(await head.text(), '');
});
test('production router exposes skills without changing health', async t => {
  const server = makeServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/v1/agent-skills/zerror')).status, 200);
});
