const { readFileSync, readdirSync, lstatSync } = require('node:fs');
const { join, relative } = require('node:path');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const NAME = 'zerror', PROTOCOL = 1;
function loadSkill(root = join(__dirname, 'agent-skills', NAME)) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Skill source cannot contain symbolic links');
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        files.push({ path: relative(root, path).split('\\').join('/'), bytes: bytes.length, sha256: hash(bytes), content: bytes.toString('utf8') });
      } else throw new Error('Unsupported skill source file');
    }
  }
  visit(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entry = files.find(f => f.path === 'SKILL.md');
  const version = entry?.content.match(/^  version: "(\d{1,8}\.\d{1,8}\.\d{1,8})"$/m)?.[1];
  if (!version) throw new Error('SKILL.md must declare metadata.version');
  const identity = `zerror-agent-skill:1\n${NAME}\n${version}\n${PROTOCOL}\n` + files.map(f => `${f.path}\t${f.bytes}\t${f.sha256}\n`).join('');
  return { schemaVersion: 1, name: NAME, version, cliProtocol: PROTOCOL, revision: hash(identity), files };
}
function createAgentSkills(root) {
  const skill = loadSkill(root);
  const etag = `"${skill.revision}"`;
  return function serve(request, response, path) {
    if (path !== '/v1/agent-skills' && !path.startsWith('/v1/agent-skills/')) return false;
    const method = request.method;
    if (method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'If-None-Match, Cache-Control' }); response.end(); return true;
    }
    if (!['GET', 'HEAD'].includes(method)) { response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }); response.end(); return true; }
    const summary = { name: skill.name, version: skill.version, cliProtocol: skill.cliProtocol, revision: skill.revision, url: `/v1/agent-skills/${NAME}`, skillUrl: `/v1/agent-skills/${NAME}/SKILL.md` };
    let body, type = 'application/json; charset=utf-8';
    if (path === '/v1/agent-skills') body = JSON.stringify({ skills: [summary] });
    else if (path === `/v1/agent-skills/${NAME}`) body = JSON.stringify(skill);
    else {
      const file = skill.files.find(f => path === `/v1/agent-skills/${NAME}/${f.path}`);
      if (!file) { response.writeHead(404, { 'Content-Type': type }); response.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'unknown_agent_skill' })); return true; }
      body = file.content; type = file.path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
    }
    response.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    response.setHeader('ETag', etag);
    response.setHeader('X-Skill-Version', skill.version);
    if (request.headers['if-none-match'] === etag) { response.writeHead(304); response.end(); return true; }
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    response.end(method === 'HEAD' ? undefined : body); return true;
  };
}
module.exports = { createAgentSkills, loadSkill };
