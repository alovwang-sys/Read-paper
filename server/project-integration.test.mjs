import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, readdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentHandler } from './agents.mjs';

const identity = researchId => ({ workspaceId: 'integration-workspace', researchId });
const evidence = (id, quote) => ({ evidenceId: id, documentId: `doc-${id}`, documentHash: `hash-${id}`, title: `Paper ${id}`, pageIndex: 0, quote });
const body = (researchId, bindingId, extra = {}) => ({ ...identity(researchId), bindingId, requestId: 'request-1', conversationId: 'conversation-1', connectionId: 'codex', purpose: 'chat', prompt: 'Explain the selected source', context: [], history: [], ...extra });
const native = id => ({ id, title: `Native ${id}`, updatedAt: '2026-10-17T00:00:00.000Z', state: 'unknown', canResume: true });
const parseEvents = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const finish = async response => parseEvents(await response.text());

async function removeFixture(path) {
  await chmod(path, 0o700).catch(() => {});
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await removeFixture(join(path, entry.name));
}
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'read-paper-project-http-test-')));
  const paths = { a: join(root, 'project-a'), b: join(root, 'project-b') };
  await mkdir(paths.a); await mkdir(paths.b);
  const stateDir = join(root, 'state');
  const calls = [];
  const runtimes = Object.fromEntries(['codex', 'opencode', 'claude'].map(agentId => [agentId, {
    async listSessions() { return { sessions: [] }; },
    async readSession({ sessionId }) { return { ...native(sessionId), messages: [] }; },
    async run(input) { calls.push(input); const id = input.nativeSessionId || `native-${calls.length}`; input.onEvent({ type: 'session', nativeSessionId: id }); return { body: 'Answer', nativeSessionId: id, model: 'local/original' }; },
    ...overrides[agentId],
  }]));
  let handler;
  const server = createServer((req, res) => { handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const setup = () => createAgentHandler({ stateDir, runtimes, ports: [port], timeoutMs: 5000 });
  handler = setup();
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await removeFixture(root); await rm(root, { recursive: true, force: true }); });
  const post = (action, value) => fetch(`http://127.0.0.1:${port}/api/ai/agents/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { root, paths, calls, post,
    bind: async researchId => (await post('projects/bind', { ...identity(researchId), path: paths[researchId], title: `Research ${researchId}` })).json(),
    restart() { handler.close(); handler = setup(); },
  };
}
async function runningStream(response) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error('native session identity was not announced');
    text += decoder.decode(next.value, { stream: true });
    const lines = text.slice(0, text.lastIndexOf('\n') + 1);
    const event = parseEvents(lines).find(item => item.nativeSessionRef);
    if (event) return { sessionRef: event.nativeSessionRef, async finish() { while (true) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); } return parseEvents(text); } };
  }
}

test('bound HTTP chat uses real project cwd and an immutable per-request material path', async t => {
  const f = await fixture(t); const project = await f.bind('a');
  const a = evidence('a', 'First immutable quote'); const b = evidence('b', 'Second quote');
  const first = await finish(await f.post('run', body('a', project.id, { context: [a] })));
  assert.equal(first.at(-1).type, 'done');
  const firstRun = f.calls[0]; assert.equal(firstRun.cwd, f.paths.a); assert.notEqual(firstRun.materialCwd, firstRun.cwd);
  const firstMaterials = await readFile(join(firstRun.materialCwd, 'materials.md'), 'utf8');
  assert.match(firstRun.prompt, new RegExp(firstRun.materialCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const history = [{ requestId: 'request-1', prompt: 'Earlier question', body: 'Answer', evidenceIds: ['a'], context: [a] }];
  const second = await finish(await f.post('run', body('a', project.id, { requestId: 'request-2', context: [a, b], history })));
  assert.equal(second.at(-1).type, 'done');
  assert.equal(f.calls[1].cwd, f.paths.a); assert.notEqual(f.calls[1].materialCwd, firstRun.materialCwd);
  assert.equal(f.calls[1].nativeSessionId, firstRun.nativeSessionId || 'native-1');
  assert.equal(await readFile(join(firstRun.materialCwd, 'materials.md'), 'utf8'), firstMaterials);
  assert.match(await readFile(join(f.calls[1].materialCwd, 'materials.md'), 'utf8'), /Second quote/);
});

test('opaque project session refs resume their native identity and cannot be used from another research', async t => {
  const calls = [];
  const f = await fixture(t, { codex: {
    async listSessions({ cwd }) { return { sessions: [native(cwd.endsWith('project-a') ? 'external-a' : 'external-b')] }; },
    async readSession({ cwd, sessionId }) { calls.push({ method: 'read', cwd, sessionId }); return { ...native(sessionId), messages: [{ id: 'native-message', role: 'user', text: 'Original native question' }] }; },
    async run(input) { calls.push({ method: 'run', ...input }); return { body: 'Continued', nativeSessionId: input.nativeSessionId }; },
  } });
  const a = await f.bind('a'); const b = await f.bind('b');
  const listed = await (await f.post('projects/list', identity('a'))).json();
  const selected = listed.sessions.find(session => session.agentId === 'codex');
  assert.ok(selected.id); assert.notEqual(selected.id, 'external-a');
  const read = await (await f.post('projects/read', { ...identity('a'), sessionRef: selected.id })).json();
  assert.equal(read.messages[0].id, 'native-message');
  const continued = await finish(await f.post('run', body('a', a.id, { sessionRef: selected.id })));
  assert.equal(continued.at(-1).type, 'done');
  assert.equal(calls.find(call => call.method === 'run').nativeSessionId, 'external-a');
  assert.equal(calls.find(call => call.method === 'run').cwd, f.paths.a);
  const before = calls.filter(call => call.method === 'run').length;
  const rejected = await finish(await f.post('run', body('b', b.id, { requestId: 'wrong-research', sessionRef: selected.id })));
  assert.equal(rejected.at(-1).code, 'session_not_found');
  assert.equal(calls.filter(call => call.method === 'run').length, before);
});

test('two local conversation IDs cannot run the same native project session concurrently', async t => {
  let release, started = 0;
  const f = await fixture(t, { codex: {
    async listSessions() { return { sessions: [native('shared-native')] }; },
    async run(input) {
      started++; input.onEvent({ type: 'session', nativeSessionId: input.nativeSessionId });
      if (started === 1) await new Promise((resolve, reject) => { release = resolve; input.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'stopped' })), { once: true }); });
      return { body: 'Finished', nativeSessionId: input.nativeSessionId };
    },
  } });
  const project = await f.bind('a'); const listed = await (await f.post('projects/list', identity('a'))).json(); const ref = listed.sessions[0].id;
  const first = await runningStream(await f.post('run', body('a', project.id, { sessionRef: ref })));
  const second = await finish(await f.post('run', body('a', project.id, { requestId: 'concurrent', conversationId: 'second-local-conversation', sessionRef: ref })));
  assert.equal(second.at(-1).code, 'session_busy'); assert.equal(started, 1);
  release(); assert.equal((await first.finish()).at(-1).type, 'done');
  const after = await finish(await f.post('run', body('a', project.id, { requestId: 'after-completion', conversationId: 'second-local-conversation', sessionRef: ref })));
  assert.equal(after.at(-1).type, 'done'); assert.equal(started, 2);
});

test('fork recovery protects the new native writer, releases the original and persists the new ref across restart', async t => {
  let release;
  const starts = [];
  const f = await fixture(t, { codex: {
    async listSessions() { return { sessions: [native('original-native')] }; },
    async run(input) {
      starts.push(input.nativeSessionId);
      const id = starts.length === 1 ? 'fork-native' : input.nativeSessionId;
      input.onEvent({ type: 'session', nativeSessionId: id, ...(starts.length === 1 ? { forkedFromId: input.nativeSessionId } : {}) });
      if (starts.length === 1) await new Promise((resolve, reject) => {
        release = resolve;
        input.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'stopped' })), { once: true });
      });
      return { body: 'Finished', nativeSessionId: id };
    },
  } });
  const project = await f.bind('a');
  const listed = await (await f.post('projects/list', identity('a'))).json();
  const originalRef = listed.sessions[0].id;
  const first = await runningStream(await f.post('run', body('a', project.id, { sessionRef: originalRef })));
  try {
    assert.notEqual(first.sessionRef, originalRef);
    const duplicate = await finish(await f.post('run', body('a', project.id, { requestId: 'same-fork', conversationId: 'second-conversation', sessionRef: first.sessionRef })));
    assert.equal(duplicate.at(-1).code, 'session_busy');
    assert.deepEqual(starts, ['original-native']);
    const original = await finish(await f.post('run', body('a', project.id, { requestId: 'use-original', conversationId: 'other-conversation', sessionRef: originalRef })));
    assert.equal(original.at(-1).type, 'done');
    assert.deepEqual(starts, ['original-native', 'original-native']);
  } finally { release(); await first.finish(); }
  f.restart();
  const history = [{ requestId: 'request-1', prompt: 'Earlier question', body: 'Finished', evidenceIds: [], context: [] }];
  const after = await finish(await f.post('run', body('a', project.id, { requestId: 'after-restart', history })));
  assert.equal(after.at(-1).type, 'done');
  assert.equal(after.at(-1).nativeSessionRef, first.sessionRef);
  assert.equal(starts.at(-1), 'fork-native');
});

test('unconfirmed OpenCode stop reaches HTTP clients and persists a read-only native session after restart', async t => {
  let starts = 0;
  const f = await fixture(t, { opencode: {
    async listSessions() { return { sessions: [{ ...native('ses_unconfirmed'), canResume: false }] }; },
    async readSession({ sessionId }) { return { ...native(sessionId), canResume: false, reason: '跨客户端状态未知', messages: [] }; },
    async run(input) {
      starts++; input.onEvent({ type: 'session', nativeSessionId: 'ses_unconfirmed' });
      if (starts > 1) return { body: 'Unexpected unsafe retry', nativeSessionId: 'ses_unconfirmed' };
      return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('OpenCode 本轮停止状态尚未确认；请先核对记录。'), { code: 'stop_unconfirmed' })), 20), { once: true }));
    },
  } });
  const project = await f.bind('a'); const request = body('a', project.id, { connectionId: 'opencode' });
  const stream = await runningStream(await f.post('run', request));
  const stopIdentity = Object.fromEntries(['workspaceId', 'researchId', 'requestId', 'conversationId', 'connectionId'].map(key => [key, request[key]]));
  assert.equal((await (await f.post('stop', stopIdentity)).json()).stopped, true);
  const final = (await stream.finish()).at(-1); assert.equal(final.code, 'stop_unconfirmed'); assert.match(final.error, /未确认|核对/);
  f.restart();
  const read = await (await f.post('projects/read', { ...identity('a'), sessionRef: stream.sessionRef })).json();
  assert.equal(read.canResume, false); assert.match(read.reason, /停止|核对|未确认/);
  const blocked = await finish(await f.post('run', body('a', project.id, { requestId: 'retry-unknown', connectionId: 'opencode', sessionRef: stream.sessionRef })));
  assert.ok(['session_busy', 'stop_unconfirmed', 'session_state_unknown'].includes(blocked.at(-1).code)); assert.equal(starts, 1);
  const history = [{ requestId: 'request-1', prompt: request.prompt, body: '', context: [], evidenceIds: [] }];
  const mapped = await finish(await f.post('run', body('a', project.id, { requestId: 'retry-without-ref', connectionId: 'opencode', history })));
  assert.ok(['session_busy', 'stop_unconfirmed', 'session_state_unknown'].includes(mapped.at(-1).code)); assert.equal(starts, 1);
});

test('selecting another owned native session does not carry over the previous provider model', async t => {
  const calls = [];
  const f = await fixture(t, { opencode: {
    async run(input) {
      calls.push(input);
      const id = input.nativeSessionId || `ses_owned${calls.length}`;
      const model = id === 'ses_owned1' ? 'provider-a/model-a' : 'provider-b/model-b';
      input.onEvent({ type: 'session', nativeSessionId: id, model });
      return { body: 'Answer', nativeSessionId: id, model };
    },
  } });
  const project = await f.bind('a');
  await finish(await f.post('run', body('a', project.id, { connectionId: 'opencode' })));
  const other = await finish(await f.post('run', body('a', project.id, { requestId: 'other-first', conversationId: 'other-local', connectionId: 'opencode' })));
  const ref = other.at(-1).nativeSessionRef;
  const history = [{ requestId: 'request-1', prompt: 'Earlier question', body: 'Answer', context: [], evidenceIds: [] }];
  const selected = await finish(await f.post('run', body('a', project.id, { requestId: 'select-other', connectionId: 'opencode', sessionRef: ref, history })));
  assert.equal(selected.at(-1).type, 'done'); assert.equal(calls[2].nativeSessionId, 'ses_owned2'); assert.notEqual(calls[2].nativeModel, 'provider-a/model-a');
});

test('directory creation routes accept a new draft identity and return only locally verified conflict owners', async t => {
  const f = await fixture(t);
  const input = { ...identity('not-created-yet'), path: join(f.root, 'new-draft'), mode: 'new', operationId: 'operation-draft' };
  const defaults = await (await f.post('projects/defaults', identity('not-created-yet'))).json(); assert.equal(typeof defaults.parentPath, 'string');
  assert.equal((await f.post('projects/preview', input)).status, 200);
  const firstResponse = await f.post('projects/bind', input); assert.equal(firstResponse.status, 200); const first = await firstResponse.json();
  f.restart(); assert.deepEqual(await (await f.post('projects/bind', input)).json(), first);
  const conflict = await f.post('projects/preview', { ...identity('another'), path: input.path, mode: 'existing', operationId: 'other' });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).ownerResearchId, input.researchId);
  const foreign = await (await f.post('projects/preview', { ...identity('another'), workspaceId: 'foreign-workspace', path: input.path, mode: 'existing', operationId: 'other' })).json();
  assert.equal(foreign.code, 'directory_in_use'); assert.equal(foreign.ownerResearchId, undefined); assert.ok(!foreign.error.includes(input.researchId));
  assert.deepEqual(f.calls, []);
});

test('sync accepts research files above the normal request limit only after binding and cannot cross research', async t => {
  const f = await fixture(t); const binding = await f.bind('a');
  const file = (path, content) => ({ path, content, encoding: 'utf8', hash: createHash('sha256').update(content).digest('hex') });
  const content = JSON.stringify({ text: 'a'.repeat(1_010_000) });
  const files = [file('README.md', '# Research files'), file('research.json', content)];
  const response = await f.post('projects/sync', { ...identity('a'), bindingId: binding.id, files });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.files, 2); assert.ok(result.bytes > 1_000_000);
  assert.equal(await readFile(join(f.paths.a, 'Papertrail', 'research.json'), 'utf8'), content);
  const wrong = await f.post('projects/sync', { ...identity('b'), bindingId: binding.id, files });
  assert.equal(wrong.status, 409); assert.equal((await wrong.json()).code, 'project_required');
  const normal = await f.post('projects/preview', { ...identity('a'), path: f.paths.a, padding: content });
  assert.equal(normal.status, 413); assert.equal((await normal.json()).code, 'request_too_large');
  assert.deepEqual(f.calls, []);
});
