import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, realpath, rm, symlink, stat, chmod } from 'node:fs/promises';
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

test('request deduplication identity requires a matching accepted archive; ordinary external text stays intact', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'envelopes');
  const envelope = '[Read-paper requestId=request-1]\nInternal materials\n用户本次问题：\nWhat is the evidence?';
  const ordinary = 'Please explain this literal example: [Read-paper requestId=request-1]\n用户本次问题：\nAn example';
  f.set(f.first, { history: { envelopes: { ...native('envelopes'), messages: [visible('u', envelope, 'user'), visible('external', ordinary, 'user'), visible('a', envelope)] } } });
  const untrusted = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(untrusted.messages[0].requestId, undefined);
  await f.store.archiveRequest(project, { ...identity(), requestId: 'request-1', nativeSessionId: 'envelopes', prompt: 'What is the evidence?' });
  const result = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(result.messages[0].requestId, 'request-1'); assert.equal(result.messages[0].text, 'What is the evidence?');
  assert.equal(result.messages[1].text, ordinary); assert.equal(result.messages[1].requestId, undefined);
  assert.equal(result.messages[2].text, envelope); assert.equal(result.messages[2].requestId, undefined);
  const longEnvelope = `[Read-paper requestId=large-request]\n${'original materials '.repeat(7000)}\n用户本次问题：\nThe real question survives.`;
  await f.store.archiveRequest(project, { ...identity(), requestId: 'large-request', nativeSessionId: 'envelopes', prompt: 'The real question survives.' });
  f.set(f.first, { history: { envelopes: { ...native('envelopes'), messages: [visible('u', longEnvelope, 'user')] } } });
  const long = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(long.messages[0].text, 'The real question survives.'); assert.equal(long.messages[0].requestId, 'large-request');
  assert.equal(long.truncated, undefined);
  const extracted = { ...visible('u', envelope, 'user'), requestId: 'already-extracted' };
  f.set(f.first, { history: { envelopes: { ...native('envelopes'), messages: [extracted] } } });
  const untrustedExtracted = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(untrustedExtracted.messages[0].requestId, undefined);
  assert.equal(untrustedExtracted.messages[0].text, envelope);
  await f.store.archiveRequest(project, { ...identity(), requestId: extracted.requestId, nativeSessionId: 'envelopes', prompt: envelope });
  const repeated = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(repeated.messages[0].text, envelope); assert.equal(repeated.messages[0].requestId, extracted.requestId);
});

test('native client user identity restores only an accepted request from the same research and turn', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'client-thread');
  const original = 'Unwrapped native question';
  const message = { ...visible('u', original, 'user'), clientUserMessageId: 'client-request', turnId: 'turn-1' };
  f.set(f.first, { history: { 'client-thread': { ...native('client-thread'), messages: [message, { ...message, id: 'assistant', role: 'assistant' }] } } });
  const read = () => f.store.read({ ...identity(), sessionRef: ref });
  const archive = { ...identity(), conversationId: 'conversation-a', requestId: 'client-request', nativeSessionId: 'client-thread', nativeTurnId: 'turn-1', prompt: 'The accepted application question' };
  assert.equal((await read()).messages[0].requestId, undefined);
  for (const mismatch of [{ workspaceId: 'other-workspace' }, { researchId: 'other-research' }, { nativeSessionId: 'other-thread' }, { nativeTurnId: 'other-turn' }]) {
    await f.store.archiveRequest(project, { ...archive, ...mismatch });
    const rejected = await read();
    assert.equal(rejected.messages[0].requestId, undefined);
    assert.equal(rejected.messages[0].text, original);
  }
  await f.store.archiveRequest(project, archive);
  const accepted = await read();
  assert.equal(accepted.messages[0].requestId, archive.requestId);
  assert.equal(accepted.messages[0].text, archive.prompt);
  assert.equal(accepted.messages[0].clientUserMessageId, archive.requestId);
  assert.equal(accepted.messages[1].requestId, undefined);
  assert.equal(accepted.messages[1].text, original);
});

test('accepted request archive restores the real question before native display truncation', async (t) => {
  const f = await fixture(t); const project = await f.bind(); const ref = await f.store.remember(project, 'codex', 'long-thread');
  await f.store.archiveRequest(project, { ...identity(), requestId: 'long-request', nativeSessionId: 'long-thread', nativeTurnId: 'turn-1', prompt: '问题位于长材料之后' });
  f.set(f.first, { history: { 'long-thread': { ...native('long-thread'), messages: [{ ...visible('u', '[Read-paper requestId=long-request]\n' + '材料'.repeat(30_000), 'user'), turnId: 'turn-1' }], turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', status: 'done', text: '答复', phase: 'final_answer' }] }] } } });
  const result = await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(result.messages[0].text, '问题位于长材料之后');
  assert.equal(result.messages[0].requestId, 'long-request');
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

test('new bindings and manifests use the canonical directory name rather than the UI title or symlink alias', async (t) => {
  const f = await fixture(t);
  const binding = await f.store.bind({ ...identity(), path: join(f.root, 'alias'), title: 'Unrelated display title' });
  assert.equal(binding.path, f.first); assert.equal(binding.name, 'first');
  const manifest = JSON.parse(await readFile(join(f.first, '.read-paper', 'project.json'), 'utf8'));
  assert.equal(manifest.title, 'first'); assert.equal(manifest.projectId, binding.projectId);
  assert.equal((await f.store.status(identity())).name, 'first');
});

test('reconnecting a previously named project updates only its manifest title and retains native identity', async (t) => {
  const f = await fixture(t); const original = await f.bind();
  const ref = await f.store.remember(original, 'codex', 'existing-native-session', 'read-paper');
  const file = join(f.first, '.read-paper', 'project.json');
  const prior = { ...JSON.parse(await readFile(file, 'utf8')), title: 'Earlier application name', createdAt: '2025-01-02T03:04:05.000Z', customMetadata: { keep: true } };
  await writeFile(file, JSON.stringify(prior)); f.restart();
  const reconnected = await f.store.bind({ ...identity(), path: join(f.root, 'alias'), title: 'Another UI title' });
  assert.equal(reconnected.id, original.id); assert.equal(reconnected.projectId, original.projectId);
  assert.equal(reconnected.researchId, original.researchId); assert.equal(reconnected.path, original.path); assert.equal(reconnected.name, 'first');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...prior, title: 'first' });
  const registry = JSON.parse(await readFile(join(f.stateDir, 'projects.json'), 'utf8'));
  assert.equal(registry.sessions[ref].nativeId, 'existing-native-session');
  await f.store.read({ ...identity(), sessionRef: ref });
  assert.equal(f.calls.at(-1).sessionId, 'existing-native-session'); assert.equal(f.calls.at(-1).cwd, original.path);
});

test('status derives the canonical name for legacy bindings without rewriting manifest or registry files', async (t) => {
  const f = await fixture(t); const original = await f.bind();
  const manifestFile = join(f.first, '.read-paper', 'project.json'); const registryFile = join(f.stateDir, 'projects.json');
  const manifest = { ...JSON.parse(await readFile(manifestFile, 'utf8')), title: 'Preserve until explicit reconnect' };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const registry = JSON.parse(await readFile(registryFile, 'utf8'));
  for (const binding of Object.values(registry.bindings)) delete binding.name;
  await writeFile(registryFile, JSON.stringify(registry)); f.restart();
  const before = await Promise.all([manifestFile, registryFile].map(async file => ({ text: await readFile(file, 'utf8'), info: await stat(file) })));
  const status = await f.store.status(identity());
  assert.deepEqual(status, { ...original, name: 'first' });
  for (const [index, file] of [manifestFile, registryFile].entries()) {
    assert.equal(await readFile(file, 'utf8'), before[index].text);
    const after = await stat(file); assert.equal(after.ino, before[index].info.ino); assert.equal(after.mtimeMs, before[index].info.mtimeMs);
  }
});

const createIntent = (path, extra = {}) => ({ ...identity(), path, mode: 'new', operationId: 'create-operation-1', ...extra });

test('explicit creation preview, defaults and cancellation never write proposed project files', async (t) => {
  const f = await fixture(t); const path = join(f.root, '新研究');
  assert.deepEqual(await f.store.preview(createIntent(path)), { path, name: '新研究' });
  assert.deepEqual(await f.store.preview(createIntent(f.first, { mode: 'existing' })), { path: f.first, name: 'first' });
  const defaults = await f.store.defaults(identity());
  assert.equal((await stat(defaults.parentPath)).isDirectory(), true);
  assert.equal(await exists(path), false);
  assert.deepEqual(await readdir(f.first), []);
  assert.deepEqual(await readdir(f.stateDir), []);
  assert.equal(await f.store.status(identity()), undefined);
});

test('new mode strictly rejects existing files and folders, missing parents and invalid names', async (t) => {
  const f = await fixture(t); const file = join(f.root, 'existing-file'); await writeFile(file, 'keep');
  for (const path of [f.first, file]) await assert.rejects(f.store.bind(createIntent(path)), { code: 'directory_exists' });
  await assert.rejects(f.store.bind(createIntent(join(f.root, 'missing', 'nested'))), { code: 'directory_unavailable' });
  for (const name of ['..', '.', ' trailing ', 'a\\b', `control${String.fromCharCode(1)}`, 'x'.repeat(256)]) await assert.rejects(f.store.preview(createIntent(`${f.root}/${name}`)), { code: 'invalid_name' });
  await assert.rejects(f.store.preview({ ...identity(), path: join(f.root, 'new'), mode: 'new' }), { code: 'invalid_operation' });
  await assert.rejects(f.store.preview(createIntent(f.first, { mode: 'unknown' })), { code: 'invalid_operation' });
  assert.equal(await readFile(file, 'utf8'), 'keep'); assert.deepEqual(await readdir(f.first), []);
});

test('new creation confirms once with a durable operation and repeated responses keep the same identity', async (t) => {
  const f = await fixture(t); const input = createIntent(join(f.root, '新研究'));
  const responses = await Promise.all([f.store.bind(input), f.store.bind(input)]);
  assert.deepEqual(responses[0], responses[1]);
  f.restart(); assert.deepEqual(await f.store.bind(input), responses[0]);
  const manifest = JSON.parse(await readFile(join(input.path, '.read-paper', 'project.json'), 'utf8'));
  const registry = JSON.parse(await readFile(join(f.stateDir, 'projects.json'), 'utf8'));
  assert.equal(manifest.operationId, input.operationId); assert.equal(manifest.projectId, responses[0].projectId);
  assert.equal(registry.operations[input.operationId].bindingId, responses[0].id);
  assert.equal((await stat(input.path)).mode & 0o777, 0o700);
  await assert.rejects(f.store.bind({ ...input, path: join(f.root, 'another') }), { code: 'operation_mismatch' });
  await assert.rejects(f.store.bind({ ...input, ...identity('research-b') }), { code: 'operation_mismatch' });
});

test('existing mode requires a real directory, preserves its contents and keeps operation retries stable', async (t) => {
  const f = await fixture(t); await writeFile(join(f.first, 'notes.md'), 'My original notes');
  const input = createIntent(f.first, { mode: 'existing' });
  const result = await f.store.bind(input); f.restart();
  assert.deepEqual(await f.store.bind(input), result);
  assert.equal(await readFile(join(f.first, 'notes.md'), 'utf8'), 'My original notes');
  await assert.rejects(f.store.bind(createIntent(join(f.root, 'missing'), { mode: 'existing', researchId: 'research-b', operationId: 'other' })), { code: 'directory_unavailable' });
});

test('only a matching durable operation and project manifest can recover a missing final registry binding', async (t) => {
  const f = await fixture(t); const input = createIntent(join(f.root, 'recoverable')); const result = await f.store.bind(input);
  const file = join(f.stateDir, 'projects.json'); const registry = JSON.parse(await readFile(file, 'utf8'));
  delete registry.bindings[JSON.stringify(['workspace-a', 'research-a'])]; await writeFile(file, JSON.stringify(registry)); f.restart();
  assert.equal(await f.store.status(identity()), undefined);
  assert.deepEqual(await f.store.bind(input), result);
  delete registry.operations[input.operationId]; await writeFile(file, JSON.stringify(registry)); f.restart();
  await assert.rejects(f.store.bind(input), { code: 'directory_exists' });
  assert.equal(JSON.parse(await readFile(join(input.path, '.read-paper', 'project.json'), 'utf8')).projectId, result.projectId);
});

test('incomplete directory creation and damaged manifests remain explicitly unconfirmed and untouched', async (t) => {
  const f = await fixture(t); const input = createIntent(join(f.root, 'incomplete')); await f.store.bind(input);
  const file = join(f.stateDir, 'projects.json'); const registry = JSON.parse(await readFile(file, 'utf8')); registry.bindings = {};
  await writeFile(file, JSON.stringify(registry)); await rm(join(input.path, '.read-paper'), { recursive: true }); f.restart();
  await assert.rejects(f.store.bind(input), { code: 'creation_unconfirmed' });
  assert.deepEqual(await readdir(input.path), []);
  await mkdir(join(input.path, '.read-paper')); const manifest = join(input.path, '.read-paper', 'project.json'); await writeFile(manifest, '{partial');
  await assert.rejects(f.store.bind(input), { code: 'creation_unconfirmed' });
  assert.equal(await readFile(manifest, 'utf8'), '{partial'); assert.equal(await f.store.status(identity()), undefined);
});

test('creation intent persistence fails before touching the proposed directory', async (t) => {
  const f = await fixture(t); const input = createIntent(join(f.root, 'never-created'));
  await f.store.preview(input); await mkdir(join(f.stateDir, 'projects.json'));
  await assert.rejects(f.store.bind(input), { code: 'project_write_failed' });
  assert.equal(await exists(input.path), false);
  assert.equal(await f.store.status(identity()), undefined);
});

test('permission rejection before creation allows changing the target under the same draft operation', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('POSIX directory permissions require a non-root test user');
  const f = await fixture(t); const parent = join(f.root, 'read-only'); await mkdir(parent); await chmod(parent, 0o500);
  t.after(() => chmod(parent, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  await assert.rejects(f.store.bind(createIntent(join(parent, 'cannot-create'))), { code: 'directory_unwritable' });
  const available = createIntent(join(f.root, 'available'));
  assert.equal((await f.store.bind(available)).path, available.path);
  assert.deepEqual(await readdir(parent), []);
  await chmod(parent, 0o700);
});

test('a manifest write failure keeps its operation pending and retries without losing existing directory contents', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('POSIX directory permissions require a non-root test user');
  const f = await fixture(t); const metadata = join(f.first, '.read-paper'); await mkdir(metadata); await chmod(metadata, 0o500);
  t.after(() => chmod(metadata, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  await writeFile(join(f.first, 'notes.md'), 'keep my notes');
  const input = createIntent(f.first, { mode: 'existing' });
  await assert.rejects(f.store.bind(input), { code: 'creation_unconfirmed' });
  assert.equal(await f.store.status(identity()), undefined);
  assert.equal(await readFile(join(f.first, 'notes.md'), 'utf8'), 'keep my notes');
  await chmod(metadata, 0o700); f.restart();
  assert.equal((await f.store.bind(input)).path, f.first);
});

test('conflicts expose an owner only when the same workspace registry and manifest verify it', async (t) => {
  const f = await fixture(t); await f.bind();
  await assert.rejects(f.store.preview({ ...identity('research-b'), path: f.first }), error => error.code === 'directory_in_use' && error.ownerResearchId === 'research-a');
  await assert.rejects(f.store.preview({ ...identity('research-b', 'another-workspace'), path: f.first }), error => error.code === 'directory_in_use' && error.ownerResearchId === undefined && !error.message.includes('research-a'));
  const file = join(f.stateDir, 'projects.json'); const registry = JSON.parse(await readFile(file, 'utf8')); registry.bindings = {};
  await writeFile(file, JSON.stringify(registry)); f.restart();
  await assert.rejects(f.store.preview({ ...identity('research-b'), path: f.first }), error => error.code === 'directory_in_use' && error.ownerResearchId === undefined);
});
