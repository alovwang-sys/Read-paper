import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAIHandler } from './ai.mjs';
import { startDesktopAI } from '../desktop/local-ai.mjs';

const identity = { workspaceId: 'desktop-workspace', researchId: 'research-a' };
async function writableDirectories(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writableDirectories(join(directory, entry.name));
}
async function fixture(t, { run } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'read-paper-desktop-project-test-')));
  const project = join(root, 'research'); const stateDir = join(root, 'agents'); await mkdir(project);
  let handler; const calls = []; const token = 'synthetic-private-desktop-token';
  const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; const base = `http://127.0.0.1:${port}`;
  const agentRuntimes = Object.fromEntries(['codex', 'opencode', 'claude'].map(agentId => [agentId, {
    async probe() { calls.push({ method: 'probe', agentId }); return { state: 'ready', version: 'test' }; },
    async capabilities() { return { skills: [], models: [], plan: false }; },
    async listSessions({ cwd }) { calls.push({ method: 'list', agentId, cwd }); return { sessions: agentId === 'codex' ? [{ id: 'native-desktop-session', title: 'Desktop research', updatedAt: '2026-10-17T00:00:00Z', state: 'unknown', canResume: true }] : [] }; },
    async readSession({ cwd, sessionId }) { calls.push({ method: 'read', agentId, cwd, sessionId }); return { id: sessionId, title: 'Desktop research', updatedAt: '2026-10-17T00:00:00Z', state: 'unknown', canResume: true, messages: [{ id: 'u1', role: 'user', text: 'Native question' }, { id: 'a1', role: 'assistant', text: 'Native answer' }] }; },
    async run(input) { calls.push({ method: 'run', agentId, cwd: input.cwd }); return run ? run(input) : { nativeSessionId: input.nativeSessionId || 'native-created-session', body: 'Desktop answer' }; },
  }]));
  const setup = () => createAIHandler({ env: { AI_PORT: String(port), AI_AGENT_STATE_DIR: stateDir }, localToken: token, agentRuntimes });
  handler = setup();
  t.after(async () => { await handler.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await writableDirectories(root); await rm(root, { recursive: true, force: true }); });
  const call = (path, { method = path.startsWith('/api/ai/agents/projects/') ? 'POST' : 'GET', body, authorization = token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method, agent: false, headers: { ...(authorization === null ? {} : { 'X-Papertrail-Token': authorization }), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('error', reject);
      res.on('end', () => resolve(new Response(text, { status: res.statusCode, headers: { 'Content-Type': res.headers['content-type'] || 'application/json' } })));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { root, project, stateDir, token, calls, call, get handler() { return handler; }, async restart() { await handler.stop(); handler = setup(); } };
}
const frames = async response => (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);

test('the shared desktop handler protects agent and project routes with its private token before dispatch', async (t) => {
  const f = await fixture(t);
  for (const authorization of [null, 'wrong-token']) {
    for (const [path, body] of [['/api/ai/agents', undefined], ['/api/ai/agents/codex/capabilities', undefined], ['/api/ai/agents/projects/bind', { ...identity, path: f.project }]]) {
      const response = await f.call(path, { authorization, body });
      assert.equal(response.status, 403); assert.equal((await frames(response))[0].code, 'forbidden_token');
    }
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.project), []);
  for (const headers of [{ Origin: 'null' }, { Origin: 'papertrail://app' }, { Origin: 'https://attacker.example' }, { Host: 'attacker.example:8787' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.call('/api/ai/agents/projects/bind', { body: { ...identity, path: f.project }, headers })).status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(await readdir(f.project), []);
});

test('desktop agent discovery and project endpoints work without a direct-model API key and persist in the configured directory', async (t) => {
  const f = await fixture(t);
  assert.equal((await (await f.call('/api/ai/config')).json()).configured, false);
  assert.equal((await (await f.call('/api/ai/agents')).json()).agents.length, 3);
  assert.deepEqual(await (await f.call('/api/ai/agents/codex/capabilities')).json(), { skills: [], models: [], plan: false });
  const preview = await f.call('/api/ai/agents/projects/preview', { body: { ...identity, path: f.project } }); assert.equal(preview.status, 200);
  const binding = await (await f.call('/api/ai/agents/projects/bind', { body: { ...identity, path: f.project, title: 'Desktop research' } })).json();
  assert.equal(binding.path, f.project);
  const result = await (await f.call('/api/ai/agents/projects/list', { body: identity })).json();
  assert.equal(result.sessions.length, 1); assert.notEqual(result.sessions[0].id, 'native-desktop-session');
  const ref = result.sessions[0].id;
  assert.equal((await (await f.call('/api/ai/agents/projects/read', { body: { ...identity, sessionRef: ref } })).json()).messages[1].text, 'Native answer');
  assert.ok(f.calls.filter(call => call.method === 'list' || call.method === 'read').every(call => call.cwd === f.project));
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'projects.json'), 'utf8')).version, 1);
  await f.restart();
  assert.deepEqual(await (await f.call('/api/ai/agents/projects/status', { body: identity })).json(), binding);
  assert.equal((await (await f.call('/api/ai/agents/projects/list', { body: identity })).json()).sessions[0].id, ref);
});

test('shared handler shutdown stops its active native project run before resolving', async (t) => {
  let started; const running = new Promise(resolve => { started = resolve; }); let aborted = false;
  const f = await fixture(t, { run: async input => {
    input.onEvent({ type: 'progress', kind: 'status', text: 'Synthetic native request running' }); started();
    await new Promise((_, reject) => input.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('Stopped'), { code: 'stopped' })); }, { once: true }));
  } });
  const binding = await (await f.call('/api/ai/agents/projects/bind', { body: { ...identity, path: f.project } })).json();
  const response = f.call('/api/ai/agents/run', { method: 'POST', body: { ...identity, bindingId: binding.id, requestId: 'desktop-running', conversationId: 'desktop-conversation', connectionId: 'codex', purpose: 'chat', prompt: 'A synthetic question', context: [], history: [] } });
  await running; await f.handler.stop();
  assert.equal(aborted, true); assert.equal((await frames(await response)).at(-1).code, 'stopped');
  assert.equal(f.calls.find(call => call.method === 'run').cwd, f.project);
});

test('the actual desktop bootstrap serves project binding with the process token and stable app state', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'read-paper-desktop-bootstrap-test-')));
  const project = join(root, 'research'); await mkdir(project);
  const service = await startDesktopAI({ env: { AI_AGENT_STATE_DIR: join(root, 'app-state') } });
  t.after(async () => { await service.stop(); await writableDirectories(root); await rm(root, { recursive: true, force: true }); });
  const bind = token => fetch(`${service.baseURL}/api/ai/agents/projects/bind`, { method: 'POST', headers: { 'X-Papertrail-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, path: project, title: 'Bootstrapped project' }) });
  assert.equal((await bind('wrong-token')).status, 403); assert.deepEqual(await readdir(project), []);
  const response = await bind(service.token); assert.equal(response.status, 200);
  assert.equal((await response.json()).path, project);
  assert.equal(JSON.parse(await readFile(join(root, 'app-state', 'projects.json'), 'utf8')).version, 1);
});
