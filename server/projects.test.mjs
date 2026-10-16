import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, realpath, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { createProjectStore } from './projects.mjs';

const identity = (researchId = 'research-a', workspaceId = 'workspace-a') => ({ workspaceId, researchId });
const native = (id, extra = {}) => ({ id, title: `Conversation ${id}`, updatedAt: '2026-10-17T01:00:00.000Z', state: 'unknown', canResume: false, ...extra });
const visible = (id = 'message-1', text = 'A visible answer', role = 'assistant') => ({ id, role, text });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'read-paper-project-store-test-')));
  const stateDir = join(root, 'state'); const first = join(root, 'first'); const second = join(root, 'second');
  await mkdir(first); await mkdir(second); await symlink(first, join(root, 'alias'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; const data = new Map(); let busy = false;
  const runtimes = Object.fromEntries(['codex', 'opencode', 'claude'].map((agentId) => [agentId, {
    async listSessions({ cwd }) { calls.push({ method: 'list', agentId, cwd }); return data.get(`${agentId}:${cwd}`)?.listed || { sessions: [] }; },
    async readSession({ cwd, sessionId }) { calls.push({ method: 'read', agentId, cwd, sessionId }); return data.get(`${agentId}:${cwd}`)?.history?.[sessionId] || { ...native(sessionId), messages: [visible()] }; },
  }]));
  const setup = () => createProjectStore({ stateDir, runtimes, isBusy: () => busy });
  let store = setup();
  return {
    root, stateDir, first, second, calls, data, get store() { return store; },
    restart() { store = setup(); }, setBusy(value) { busy = value; },
    bind: (path = first, scope = identity()) => store.bind({ ...scope, path, title: 'Research project' }),
    set: (path, value, agentId = 'codex') => data.set(`${agentId}:${path}`, value),
  };
}
const exists = (path) => stat(path).then(() => true, () => false);

test('directory preview and cancelling leave existing contents and proposed new directories untouched', async (t) => {
  const f = await fixture(t); const fresh = join(f.root, 'new-research');
  await writeFile(join(f.first, 'paper.txt'), 'original material');
  assert.deepEqual(await f.store.preview({ ...identity(), path: fresh }), { path: fresh, name: 'new-research' });
  await f.store.preview({ ...identity(), path: f.first });
  assert.equal(await exists(fresh), false); assert.deepEqual(await readdir(f.first), ['paper.txt']);
  assert.deepEqual(await readdir(f.stateDir), []); assert.equal(await f.store.status(identity()), undefined);
});

test('canonical alias binding is idempotent and another research cannot claim or replace it', async (t) => {
  const f = await fixture(t); const first = await f.bind();
  const alias = await f.bind(join(f.root, 'alias'));
  assert.deepEqual(alias, first); assert.equal(alias.path, f.first);
  await assert.rejects(f.bind(f.first, identity('research-b')), { code: 'directory_in_use' });
  await assert.rejects(f.bind(f.second), { code: 'directory_changed' });
  assert.deepEqual(await f.store.status(identity()), first);
  const manifest = JSON.parse(await readFile(join(f.first, '.read-paper', 'project.json'), 'utf8'));
  assert.equal(manifest.projectId, first.projectId); assert.equal(manifest.researchId, 'research-a');
  assert.equal(await exists(join(f.second, '.read-paper')), false);
});

test('root, user parent, credential and symlinked credential directories are rejected without project files', async (t) => {
  const f = await fixture(t); const privatePath = join(f.root, '.codex', 'sessions');
  await mkdir(privatePath, { recursive: true }); await symlink(privatePath, join(f.root, 'innocent-alias'));
  for (const path of [parse(f.root).root, homedir(), privatePath, join(f.root, 'innocent-alias')]) {
    await assert.rejects(f.store.preview({ ...identity(), path }), { code: 'invalid_directory' });
    await assert.rejects(f.bind(path), { code: 'invalid_directory' });
  }
  assert.equal(await exists(join(privatePath, '.read-paper')), false);
});

test('unrecognized project manifests and symlink metadata are preserved instead of overwritten', async (t) => {
  const f = await fixture(t); const metadata = join(f.first, '.read-paper');
  await mkdir(metadata); await writeFile(join(metadata, 'project.json'), '{broken original');
  await assert.rejects(f.bind(), { code: 'invalid_project' });
  assert.equal(await readFile(join(metadata, 'project.json'), 'utf8'), '{broken original');
  await symlink(metadata, join(f.second, '.read-paper'));
  await assert.rejects(f.bind(f.second, identity('research-b')), { code: 'invalid_project' });
});

test('binding and opaque native identities survive restart and cannot cross research or agent boundaries', async (t) => {
  const f = await fixture(t); const a = await f.bind(); await f.bind(f.second, identity('research-b'));
  f.set(f.first, { listed: { sessions: [native('native-session')] } });
  const first = await f.store.list(identity()); const ref = first.sessions[0].id;
  assert.notEqual(ref, 'native-session'); assert.equal(first.sessions[0].nativeSessionId, 'native-session');
  f.restart();
  assert.deepEqual(await f.store.status(identity()), a);
  assert.equal((await f.store.list(identity())).sessions[0].id, ref);
  const before = f.calls.length;
  await assert.rejects(f.store.read({ ...identity('research-b'), sessionRef: ref }), { code: 'session_not_found' });
  await assert.rejects(f.store.read({ ...identity(), sessionRef: ref, agentId: 'claude' }), { code: 'session_not_found' });
  assert.equal(f.calls.length, before);
  const result = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(result.nativeSessionId, 'native-session'); assert.equal(result.messages[0].text, 'A visible answer');
  assert.equal(f.calls.at(-1).cwd, f.first);
});

test('session discovery bounds each agent page and makes remaining native pages visible', async (t) => {
  const f = await fixture(t); await f.bind();
  f.set(f.first, { listed: { sessions: Array.from({ length: 101 }, (_, i) => native(`session-${i}`)), nextCursor: 'older-page' } });
  const result = await f.store.list(identity());
  assert.equal(result.sessions.length, 100); assert.match(result.errors.find((e) => e.agentId === 'codex').error, /100|尚未载入/);
  const repeated = await f.store.list(identity());
  assert.deepEqual(new Set(repeated.sessions.map((s) => s.id)), new Set(result.sessions.map((s) => s.id)));
});

test('history retains native truncation and marks application message and text limits', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'many-messages');
  f.set(f.first, { history: { 'many-messages': { ...native('many-messages'), messages: Array.from({ length: 2001 }, (_, i) => visible(`m${i}`)) } } });
  const many = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(many.messages.length, 2000); assert.equal(many.truncated, true);
  f.set(f.first, { history: { 'many-messages': { ...native('many-messages'), truncated: true, messages: [visible()] } } });
  assert.equal((await f.store.read({ ...identity(), sessionRef: ref })).truncated, true);
  f.set(f.first, { history: { 'many-messages': { ...native('many-messages'), messages: [visible('oversized', 'x'.repeat(100_001))] } } });
  const clipped = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(clipped.messages[0].text.length, 100_000); assert.equal(clipped.truncated, true);
  f.set(f.first, { history: { 'many-messages': { ...native('many-messages'), messages: Array.from({ length: 20 }, (_, i) => visible(`m${i}`, 'x'.repeat(100_000))) } } });
  const bounded = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(bounded.messages.length, 10); assert.equal(bounded.truncated, true);
});

test('owned session continuation remains distinct from unsupported external sessions and busy sessions cannot resume', async (t) => {
  const f = await fixture(t); const project = await f.bind();
  const external = await f.store.remember(project, 'opencode', 'external');
  const owned = await f.store.remember(project, 'opencode', 'owned', 'read-paper');
  assert.equal((await f.store.read({ ...identity(), sessionRef: external })).canResume, false);
  await assert.rejects(f.store.resume({ ...identity(), sessionRef: external }), { code: 'session_busy' });
  assert.equal((await f.store.read({ ...identity(), sessionRef: owned })).canResume, true);
  assert.equal((await f.store.resume({ ...identity(), sessionRef: owned })).nativeSessionId, 'owned');
  f.setBusy(true);
  const busy = await f.store.read({ ...identity(), sessionRef: owned });
  assert.equal(busy.state, 'busy'); assert.equal(busy.canResume, false);
  await assert.rejects(f.store.resume({ ...identity(), sessionRef: owned }), { code: 'session_busy' });
  f.setBusy(false);
  f.set(f.first, { history: { owned: { ...native('owned', { state: 'busy', canResume: true }), messages: [visible()] } } }, 'opencode');
  await assert.rejects(f.store.resume({ ...identity(), sessionRef: owned }), { code: 'session_busy' });
});

test('only an exact owned user envelope extracts request deduplication identity; ordinary external text stays intact', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'envelopes');
  const envelope = '[Read-paper requestId=request-1]\nInternal materials\n用户本次问题：\nWhat is the evidence?';
  const ordinary = 'Please explain this literal example: [Read-paper requestId=request-1]\n用户本次问题：\nAn example';
  f.set(f.first, { history: { envelopes: { ...native('envelopes'), messages: [visible('u', envelope, 'user'), visible('external', ordinary, 'user'), visible('a', envelope)] } } });
  const result = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(result.messages[0].requestId, 'request-1'); assert.equal(result.messages[0].text, 'What is the evidence?');
  assert.equal(result.messages[1].text, ordinary); assert.equal(result.messages[1].requestId, undefined);
  assert.equal(result.messages[2].text, envelope); assert.equal(result.messages[2].requestId, undefined);
});

test('conversation and request archives preserve readable material and stable native identity without raw filenames', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'native-session');
  await f.store.read({ ...identity(), sessionRef: ref });
  const request = { requestId: 'request-1', prompt: 'Explain [1]', context: [{ evidenceId: 'e1', documentId: 'd1', documentHash: 'hash', pageIndex: 0, quote: 'Source text' }] };
  await f.store.archiveRequest(project, request);
  const files = await readdir(join(f.first, '.read-paper'));
  const conversationFile = files.find((name) => /^conversation-[a-f0-9]{64}\.json$/.test(name));
  const requestFile = files.find((name) => /^request-[a-f0-9]{64}\.json$/.test(name));
  assert.ok(conversationFile); assert.ok(requestFile);
  const conversation = JSON.parse(await readFile(join(f.first, '.read-paper', conversationFile), 'utf8'));
  assert.equal(conversation.version, 1); assert.equal(conversation.projectId, project.projectId); assert.equal(conversation.nativeSessionId, 'native-session'); assert.equal(conversation.messages[0].text, 'A visible answer');
  const archived = JSON.parse(await readFile(join(f.first, '.read-paper', requestFile), 'utf8'));
  assert.deepEqual(archived.context, request.context); assert.equal(archived.prompt, request.prompt);
  assert.equal((await stat(join(f.first, '.read-paper', requestFile))).mode & 0o777, 0o600);
});

test('workspace/research identities with separators cannot collide or expose another binding', async (t) => {
  const f = await fixture(t); await f.bind(f.first, identity('c', 'a:b'));
  assert.equal(await f.store.status(identity('b:c', 'a')), undefined);
  await f.bind(f.second, identity('b:c', 'a'));
  assert.notEqual((await f.store.status(identity('c', 'a:b'))).projectId, (await f.store.status(identity('b:c', 'a'))).projectId);
});

test('another workspace cannot bind the same directory by reusing the research identifier', async (t) => {
  const f = await fixture(t); await f.bind();
  await assert.rejects(f.bind(f.first, identity('research-a', 'workspace-b')), { code: 'directory_in_use' });
});

test('safe native tool events remain attached to their visible assistant message', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'tool-events');
  f.set(f.first, { history: { 'tool-events': { ...native('tool-events'), messages: [{ ...visible(), events: [{ kind: 'tool', id: 'tool-1', text: 'Command completed', toolName: 'commandExecution', command: 'cat materials.md', output: 'Selected quote', status: 'done', exitCode: 0 }] }] } } });
  const result = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(result.messages[0].events?.[0].output, 'Selected quote');
  assert.equal(result.messages[0].events?.[0].status, 'done');
});


test('concurrent binding of canonical aliases has only one research winner', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.bind(), f.bind(join(f.root, 'alias'), identity('research-b'))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'directory_in_use').length, 1);
});

test('corrupt persisted registry fails closed and preserves the original file', async (t) => {
  const f = await fixture(t); await f.bind();
  const registry = join(f.stateDir, 'projects.json');
  await writeFile(registry, '{unreadable existing registry'); f.restart();
  await assert.rejects(f.store.status(identity()), { code: 'project_read_failed' });
  assert.equal(await readFile(registry, 'utf8'), '{unreadable existing registry');
});

test('an externally discovered session becomes managed after a real app run without changing its origin or opaque identity', async (t) => {
  const f = await fixture(t); const project = await f.bind();
  f.set(f.first, { listed: { sessions: [native('external-then-managed')] } });
  const discovered = (await f.store.list(identity())).sessions[0];
  assert.equal(discovered.origin, 'native'); assert.equal(discovered.canResume, false);
  assert.equal(await f.store.remember(project, 'codex', 'external-then-managed', 'read-paper'), discovered.id);
  const stored = JSON.parse(await readFile(join(f.stateDir, 'projects.json'), 'utf8')).sessions[discovered.id];
  assert.equal(stored.origin, 'native'); assert.equal(stored.managed, true);
  f.restart();
  const listed = (await f.store.list(identity())).sessions[0];
  assert.equal(listed.id, discovered.id); assert.equal(listed.origin, 'native'); assert.equal(listed.canResume, true);
  const read = await f.store.read({ ...identity(), sessionRef: discovered.id });
  assert.equal(read.origin, 'native'); assert.equal(read.canResume, true);
  assert.equal((await f.store.resume({ ...identity(), sessionRef: discovered.id })).nativeSessionId, 'external-then-managed');
});

test('tool output shares the history size budget rather than bypassing the text limit', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'large-tools');
  f.set(f.first, { history: { 'large-tools': { ...native('large-tools'), messages: [{ ...visible(), events: Array.from({ length: 200 }, (_, id) => ({ kind: 'tool', id: String(id), text: 'Tool result', output: 'x'.repeat(12000) })) }] } } });
  const result = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(result.truncated, true);
  assert.ok(result.messages[0].events.length < 200);
  assert.ok(JSON.stringify(result).length < 1_010_000);
});

test('a stalled native history query is bounded and aborts only its owned read connection', async (t) => {
  const f = await fixture(t); await f.bind(); let aborted = 0;
  const stalled = ({ signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted++; }, { once: true }); });
  const store = createProjectStore({ stateDir: f.stateDir, queryTimeoutMs: 15, runtimes: { codex: { listSessions: stalled, readSession: stalled } } });
  const result = await store.list(identity());
  assert.deepEqual(result.sessions, []);
  assert.match(result.errors.find(error => error.agentId === 'codex').error, /超时/);
  const project = await store.binding(identity()); const ref = await store.remember(project, 'codex', 'stalled-native');
  await assert.rejects(store.read({ ...identity(), sessionRef: ref }), { code: 'history_timeout' });
  assert.equal(aborted, 2);
});
