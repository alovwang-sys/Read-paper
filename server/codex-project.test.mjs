import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexRuntime } from './codex-runtime.mjs';

async function fixture(t, respond = () => undefined) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'read-paper-codex-project-test-')));
  const cwd = join(root, 'project'); const materials = join(root, 'materials');
  await mkdir(cwd); await mkdir(materials); await mkdir(join(cwd, 'child')); await symlink(cwd, join(root, 'alias'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; const children = [];
  const spawnImpl = (_executable, _args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); return true; };
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()); calls.push(request);
      if (request.id !== undefined) {
        const defaults = {
          initialize: {}, 'config/read': { config: { mcp_servers: { external: {} } } }, 'skills/list': { data: [] },
          'model/list': { data: [{ id: 'default', model: 'native', displayName: 'Native', isDefault: true }] }, 'collaborationMode/list': { data: [] },
          'command/exec': { exitCode: request.params?.command?.[0].includes('touch') || request.params?.command?.[1].endsWith('outside.txt') ? 1 : 0 },
          'thread/start': { thread: { id: 'new-thread', cwd } }, 'turn/start': { turn: { id: 'new-turn' } },
        };
        const result = respond(request, { cwd, root, send, child }) ?? defaults[request.method] ?? {};
        send({ id: request.id, result });
        if (request.method === 'turn/start') setImmediate(() => {
          send({ method: 'item/agentMessage/delta', params: { threadId: 'new-thread', turnId: 'new-turn', delta: 'OK' } });
          send({ method: 'turn/completed', params: { threadId: 'new-thread', turnId: 'new-turn', turn: { id: 'new-turn', status: 'completed' } } });
        });
      }
      callback();
    } });
    children.push({ child, options }); return child;
  };
  return { root, cwd, materials, calls, children, runtime: createCodexRuntime({ spawnImpl, env: { SECRET_TOKEN: 'hidden-value' }, rpcTimeoutMs: 100 }) };
}
const summary = (cwd, id = 'native-session', extra = {}) => ({ id, cwd, name: 'Project chat', preview: 'Preview', updatedAt: 1_760_700_000, status: { type: 'notLoaded' }, ...extra });
const turn = (id, items, extra = {}) => ({ id, status: 'completed', items, itemsView: 'full', startedAt: 1_760_700_000, completedAt: 1_760_700_001, ...extra });

test('Codex discovery filters canonical exact project cwd, caps results and never treats local idle as global idle', async (t) => {
  const f = await fixture(t, (request, { cwd, root }) => request.method === 'thread/list' ? { data: [
    summary(cwd), summary(join(cwd, 'child'), 'child'), summary(join(root, 'materials'), 'other'), summary(join(root, 'alias'), 'alias', { status: { type: 'idle' } }),
    summary(cwd, 'active', { status: { type: 'active' } }), ...Array.from({ length: 110 }, (_, i) => summary(cwd, `extra-${i}`)),
  ], nextCursor: 'more' } : undefined);
  const result = await f.runtime.listSessions({ cwd: join(f.root, 'alias') });
  assert.ok(result.sessions.length <= 100); assert.ok(!result.sessions.some((s) => ['child', 'other'].includes(s.id)));
  assert.equal(result.sessions[0].state, 'unknown'); assert.equal(result.sessions.find((s) => s.id === 'alias').state, 'unknown');
  assert.ok(result.sessions.every((s) => (s.canResume === (s.state !== 'busy')) && s.reason)); assert.equal(result.sessions.find((s) => s.id === 'active').state, 'busy');
  const params = f.calls.find((c) => c.method === 'thread/list').params;
  assert.equal(params.cwd, f.cwd); assert.equal(params.limit, 100); assert.equal(params.useStateDbOnly, true); assert.ok(params.sourceKinds.includes('appServer'));
  assert.equal(result.nextCursor, 'more'); assert.ok(f.children.every(({ child }) => child.killed));
  assert.ok(!f.calls.some((c) => ['thread/resume', 'thread/start'].includes(c.method)));
});

test('Codex read verifies project ownership before loading any history and rejects untrusted IDs', async (t) => {
  const f = await fixture(t, (request, { cwd }) => request.method === 'thread/read' ? { thread: summary(join(cwd, 'child')) } : undefined);
  await assert.rejects(f.runtime.readSession({ cwd: f.cwd, sessionId: 'native-session' }), { code: 'invalid_session' });
  assert.ok(!f.calls.some((c) => c.method === 'thread/turns/list'));
  const before = f.children.length;
  await assert.rejects(f.runtime.readSession({ cwd: f.cwd, sessionId: '../other' }), { code: 'invalid_session' });
  await assert.rejects(f.runtime.listSessions({ cwd: `${f.cwd}/missing` }), { code: 'project_unavailable' });
  assert.equal(f.children.length, before);
});

test('Codex history returns stable visible messages and sanitized activity without instructions, credentials or reasoning', async (t) => {
  const f = await fixture(t, (request, { cwd }) => request.method === 'thread/read' ? { thread: summary(cwd) } : request.method === 'thread/turns/list' ? { data: [
    turn('turn2', [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Second question' }] }, { id: 'a', type: 'agentMessage', text: 'Second answer' }]),
    turn('turn1', [
      { id: 'd', type: 'developerMessage', text: 'PRIVATE DEVELOPER' }, { id: 'r', type: 'reasoning', content: ['PRIVATE REASONING'] },
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'First hidden-value question' }, { type: 'localImage', path: '/private/image.png' }] },
      { id: 'tool', type: 'commandExecution', command: 'cat .env', aggregatedOutput: 'SENSITIVE FILE', exitCode: 0, status: 'completed' },
      { id: 'a', type: 'agentMessage', text: 'First answer' },
    ]),
  ], nextCursor: null } : undefined);
  const first = await f.runtime.readSession({ cwd: f.cwd, sessionId: 'native-session' });
  const second = await f.runtime.readSession({ cwd: f.cwd, sessionId: 'native-session' });
  assert.deepEqual(first, second); assert.deepEqual(first.messages.map((m) => m.id), ['turn1:u', 'turn1:a', 'turn2:u', 'turn2:a']);
  assert.equal(first.messages[0].role, 'user'); assert.match(first.messages[0].text, /已隐藏凭据/); assert.match(first.messages[0].text, /原始附件/);
  assert.equal(first.messages[1].events[0].kind, 'tool'); assert.match(first.messages[1].events[0].output, /已隐藏/);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE DEVELOPER|PRIVATE REASONING|hidden-value|SENSITIVE FILE|\/private\/image/);
  assert.equal(first.truncated, false); assert.equal(first.canResume, true);
  assert.ok(f.calls.filter((c) => c.method === 'thread/read').every((c) => c.params.includeTurns === false));
});

test('Codex history bounds pagination, deduplicates overlapping native turns and marks incomplete history', async (t) => {
  let page = 0;
  const f = await fixture(t, (request, { cwd }) => request.method === 'thread/read' ? { thread: summary(cwd) } : request.method === 'thread/turns/list' ? { data: [turn('same-turn', [{ id: 'a', type: 'agentMessage', text: 'x'.repeat(60_001) }])], nextCursor: `cursor-${++page}` } : undefined);
  const result = await f.runtime.readSession({ cwd: f.cwd, sessionId: 'native-session' });
  assert.equal(f.calls.filter((c) => c.method === 'thread/turns/list').length, 2); assert.equal(result.messages.length, 1); assert.equal(result.messages[0].text.length, 60_000); assert.equal(result.truncated, true);
});

test('project run uses the actual research cwd plus readonly material root without probing writes in the research', async (t) => {
  const f = await fixture(t);
  const events = [];
  const result = await f.runtime.run({ cwd: join(f.root, 'alias'), materialCwd: f.materials, prompt: 'Only synthetic materials', title: 'A useful project title', codex: { mode: 'chat' }, onEvent: (event) => events.push(event) });
  const thread = f.calls.find((c) => c.method === 'thread/start').params;
  const started = f.calls.find((c) => c.method === 'turn/start').params;
  assert.deepEqual(f.calls.find((c) => c.method === 'thread/name/set').params, { threadId: 'new-thread', name: 'A useful project title' });
  assert.equal(thread.cwd, f.cwd); assert.deepEqual(thread.runtimeWorkspaceRoots, [f.cwd, f.materials]);
  assert.equal(thread.permissions, 'read_paper_materials'); assert.equal(thread.config['mcp_servers.external.enabled'], false);
  assert.deepEqual(started.runtimeWorkspaceRoots, [f.cwd, f.materials]);
  assert.ok(f.calls.filter((c) => c.method === 'command/exec').every((c) => !c.params.cwd.startsWith(f.cwd)));
  assert.equal(result.nativeTurnId, 'new-turn'); assert.ok(events.some((e) => e.nativeTurnId === 'new-turn'));
});


test('native writer ownership rejects project resume before turn/start with a static busy message', async (t) => {
  const f = await fixture(t, (request, { cwd, send }) => {
    if (request.method === 'thread/read') return { thread: summary(cwd, 'locked-thread') };
    if (request.method === 'thread/resume') {
      send({ id: request.id, error: { code: -32600, message: 'thread locked-thread already has an active writer /private/native/record' } });
      return {};
    }
  });
  await assert.rejects(f.runtime.run({ cwd: f.cwd, materialCwd: f.materials, nativeSessionId: 'locked-thread', prompt: 'Q' }), (error) => {
    assert.equal(error.code, 'session_busy'); assert.match(error.message, /其他客户端/); assert.doesNotMatch(error.message, /private|writer|locked-thread/); return true;
  });
  assert.ok(!f.calls.some((c) => c.method === 'turn/start')); assert.ok(f.children.every(({ child }) => child.killed));
});

test('project resume validates the stored cwd before acquiring writer ownership', async (t) => {
  const f = await fixture(t, (request, { cwd }) => request.method === 'thread/read' ? { thread: summary(join(cwd, 'child')) } : undefined);
  await assert.rejects(f.runtime.run({ cwd: f.cwd, materialCwd: f.materials, nativeSessionId: 'native-session', prompt: 'Q' }), { code: 'invalid_session' });
  assert.ok(!f.calls.some((c) => ['thread/resume', 'turn/start'].includes(c.method)));
});
