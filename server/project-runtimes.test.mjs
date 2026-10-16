import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeRuntime } from './claude-runtime.mjs';
import { createOpenCodeRuntime } from './opencode-runtime.mjs';

const sid = 'ses_fixedProjectSession';
const uuid = '11111111-2222-3333-4444-555555555555';
const deny = [{ action: '*', resource: '*', effect: 'deny' }];
function fakeProcesses(outputs) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const call = { args, options, input: '' }; calls.push(call);
    child.stdin.on('data', bytes => { call.input += bytes.toString(); }); child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    assert.ok(outputs.length, 'unexpected native invocation');
    const output = outputs.shift();
    queueMicrotask(() => { if (typeof output === 'function') { output({ child, call }); return; } child.stdout.end(typeof output === 'string' ? output : JSON.stringify(output)); child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  return { calls, spawnImpl };
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'read-paper-project-runtime-test-'));
  const cwd = await realpath(await mkdir(join(root, 'research')).then(() => join(root, 'research')));
  const other = await mkdir(join(root, 'other')).then(() => realpath(join(root, 'other')));
  const config = join(root, 'claude');
  const path = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(path, { recursive: true });
  try { await run({ root, cwd, other, config, path }); } finally { await rm(root, { recursive: true, force: true }); }
}
const info = cwd => ({ id: sid, title: '研究问题', location: { directory: cwd }, time: { created: 1000, updated: 2000 }, permissions: deny });
const row = (cwd, id, type, content, extra = {}) => ({ cwd, sessionId: uuid, uuid: id, type, timestamp: '2026-10-17T00:00:00Z', message: { content }, ...extra });

test('OpenCode discovers only canonical exact project sessions through its shared native daemon', () => fixture(async ({ cwd, other, root }) => {
  const alias = join(root, 'alias'); await symlink(cwd, alias);
  const fake = fakeProcesses([{ data: [info(cwd), { ...info(other), id: 'ses_other' }], cursor: { next: 'next' } }, { data: { [sid]: {} } }]);
  const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl }).listSessions({ cwd: alias });
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0], { id: sid, title: '研究问题', updatedAt: '1970-01-01T00:00:02.000Z', state: 'busy', canResume: false, reason: '正在 OpenCode 原生应用中运行，完成后可刷新查看。' });
  assert.equal(result.nextCursor, 'next');
  const path = new URL(fake.calls[0].args[2], 'http://localhost');
  assert.equal(path.searchParams.get('directory'), cwd); assert.equal(path.searchParams.get('limit'), '100');
  assert.ok(fake.calls.every(call => !call.args.includes('--standalone')));
}));

test('OpenCode does not interpret absence from one daemon as a cross-process idle guarantee', () => fixture(async ({ cwd }) => {
  const fake = fakeProcesses([{ data: [info(cwd)] }, { data: {} }]);
  const [session] = (await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl }).listSessions({ cwd })).sessions;
  assert.equal(session.state, 'unknown'); assert.equal(session.canResume, false); assert.match(session.reason, /独立进程/);
}));

test('OpenCode verifies session project before retrieving paged history and excludes reasoning', () => fixture(async ({ cwd, other }) => {
  const foreign = fakeProcesses([{ data: info(other) }]);
  await assert.rejects(createOpenCodeRuntime({ spawnImpl: foreign.spawnImpl }).readSession({ cwd, sessionId: sid }), error => error.code === 'invalid_session');
  assert.equal(foreign.calls.length, 1);
  const fake = fakeProcesses([
    { data: info(cwd) },
    { data: [{ id: 'msg_a', type: 'assistant', time: { created: 2000 }, content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '回答' }, { type: 'tool', name: 'read' }] }], cursor: { next: 'page2' } },
    { data: [{ id: 'msg_u', type: 'user', time: { created: 1000 }, text: '问题' }], cursor: { next: null } },
    { data: {} },
  ]);
  const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl }).readSession({ cwd, sessionId: sid });
  assert.deepEqual(result.messages.map(message => message.id), ['msg_u', 'msg_a']);
  assert.equal(result.messages[1].text, '回答\n[附件或工具记录未展开]');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal(new URL(fake.calls[2].args[2], 'http://localhost').searchParams.get('order'), null);
  assert.equal(result.canResume, false);
}));

test('OpenCode bound projects create in the shared store with native deny rules and preserve model selection', () => fixture(async ({ cwd }) => {
  const fake = fakeProcesses([
    [{ type: 'document', info: { model: 'local/selected' } }],
    { data: info(cwd) }, { data: {} },
    [{ type: 'text', sessionID: sid, part: { id: 'part1', text: 'answer' } }, { type: 'step_finish', sessionID: sid, part: { reason: 'stop' } }].map(value => JSON.stringify(value)).join('\n'),
  ]);
  const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).run({ cwd, materialCwd: '/snapshots/one', prompt: 'question', title: '用户问题标题' });
  assert.equal(result.nativeSessionId, sid); assert.equal(result.model, 'local/selected');
  assert.deepEqual(fake.calls[0].args, ['api', '--standalone', 'GET', '/api/config']);
  const payload = JSON.parse(fake.calls[1].args[4]); assert.deepEqual(payload.permissions, deny); assert.equal(payload.location.directory, cwd); assert.equal(payload.title, '用户问题标题');
  const run = fake.calls[3]; assert.equal(run.args.includes('--standalone'), false); assert.equal(run.args.includes('--agent'), false); assert.equal(run.options.cwd, cwd); assert.equal(run.input, 'question');
}));

test('OpenCode shared cancellation interrupts only this invocation session and confirms the daemon stopped it', () => fixture(async ({ cwd }) => {
  for (const remainsBusy of [false, true]) {
    const controller = new AbortController();
    const fake = fakeProcesses([
      [{ type: 'document', info: {} }], { data: info(cwd) }, { data: {} },
      () => { setTimeout(() => controller.abort(), 5); },
      { interrupted: true }, { data: remainsBusy ? { [sid]: {} } : {} },
    ]);
    await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).run({ cwd, materialCwd: '/snapshots/one', nativeSessionId: sid, prompt: 'question', signal: controller.signal }), error => error.code === (remainsBusy ? 'stop_unconfirmed' : 'stopped'));
    assert.deepEqual(fake.calls[4].args, ['api', 'POST', `/api/session/${sid}/interrupt?resume=false`]);
    assert.equal(fake.calls.some(call => call.args.includes('daemon')), false);
  }
}));

test('OpenCode announces a created native identity before a later startup failure so retry cannot orphan it', () => fixture(async ({ cwd }) => {
  const fake = fakeProcesses([[{ type: 'document', info: { model: 'local/model' } }], { data: info(cwd) }, { data: [] }]);
  const events = [];
  await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).run({ cwd, materialCwd: '/snapshots/one', prompt: 'question', onEvent: event => events.push(event) }), error => error.code === 'session_state_unknown');
  assert.deepEqual(events, [{ type: 'session', nativeSessionId: sid, model: 'local/model' }]);
}));

test('OpenCode refuses known busy or changed native permissions without altering external sessions', () => fixture(async ({ cwd }) => {
  for (const [permissions, active, code] of [[deny, { [sid]: {} }, 'session_busy'], [[], undefined, 'permission_error']]) {
    const scripts = [[{ type: 'document', info: {} }], { data: { ...info(cwd), permissions } }];
    if (active) scripts.push({ data: active });
    const fake = fakeProcesses(scripts);
    await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).run({ cwd, materialCwd: '/snapshots/one', nativeSessionId: sid, prompt: 'question' }), error => error.code === code);
    assert.equal(fake.calls.some(call => call.args[0] === 'run'), false);
    assert.equal(fake.calls.some(call => call.args.includes('PATCH')), false);
  }
}));

test('Claude local discovery needs no authentication, isolates canonical cwd and preserves native message IDs', () => fixture(async ({ cwd, other, path, config }) => {
  await writeFile(join(path, `${uuid}.jsonl`), [
    row(cwd, 'u1', 'user', '研究问题'), row(cwd, 'a1', 'assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '回答' }]),
    row(cwd, 'a1', 'assistant', [{ type: 'text', text: '完整回答' }]),
    { type: 'custom-title', customTitle: '自定义标题', sessionId: uuid },
  ].map(value => JSON.stringify(value)).join('\n'));
  await writeFile(join(path, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), JSON.stringify(row(other, 'other', 'user', '不得显示', { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })));
  const fake = fakeProcesses([[], []]);
  const runtime = createClaudeRuntime({ env: { CLAUDE_CONFIG_DIR: config }, spawnImpl: fake.spawnImpl });
  const listed = await runtime.listSessions({ cwd }); assert.equal(listed.sessions.length, 1); assert.equal(listed.sessions[0].title, '自定义标题');
  assert.equal(listed.sessions[0].state, 'unknown'); assert.equal(listed.sessions[0].canResume, false);
  const result = await runtime.readSession({ cwd, sessionId: uuid }); assert.deepEqual(result.messages.map(message => message.id), ['u1', 'a1']); assert.equal(result.messages[1].text, '完整回答');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.ok(fake.calls.every(call => call.args[0] === 'agents' && call.args.includes('--cwd') && !call.args.includes('--print')));
}));

test('Claude uses supported activity metadata only to mark busy and extracts user-facing Read-paper titles', () => fixture(async ({ cwd, other, path, config }) => {
  await writeFile(join(path, `${uuid}.jsonl`), JSON.stringify(row(cwd, 'u1', 'user', '[Read-paper requestId=internal-id]\n材料说明\n用户本次问题：\n真正的问题\n第二行')));
  const fake = fakeProcesses([[{ sessionId: uuid, cwd: other, status: 'busy' }], [{ sessionId: uuid, cwd, status: 'waiting', kind: 'interactive' }]]);
  const runtime = createClaudeRuntime({ env: { CLAUDE_CONFIG_DIR: config }, spawnImpl: fake.spawnImpl });
  const first = await runtime.readSession({ cwd, sessionId: uuid }); assert.equal(first.state, 'unknown'); assert.equal(first.title, '真正的问题');
  const second = await runtime.readSession({ cwd, sessionId: uuid }); assert.equal(second.state, 'busy'); assert.equal(second.canResume, false);
}));

test('Claude rejects symlink transcripts, wrong project identity, oversized and corrupt records', () => fixture(async ({ cwd, other, path, config, root }) => {
  const file = join(path, `${uuid}.jsonl`); const fake = fakeProcesses([[]]); const runtime = createClaudeRuntime({ env: { CLAUDE_CONFIG_DIR: config }, spawnImpl: fake.spawnImpl });
  await writeFile(join(root, 'outside'), JSON.stringify(row(cwd, 'u', 'user', 'outside'))); await symlink(join(root, 'outside'), file);
  await assert.rejects(runtime.readSession({ cwd, sessionId: uuid }), error => error.code === 'history_unavailable'); await rm(file);
  await writeFile(file, JSON.stringify(row(other, 'u', 'user', 'foreign')));
  await assert.rejects(runtime.readSession({ cwd, sessionId: uuid }), error => error.code === 'invalid_session');
  await writeFile(file, '{}'); await truncate(file, 8_000_001);
  await assert.rejects(runtime.readSession({ cwd, sessionId: uuid }), error => error.code === 'history_unsupported');
  await writeFile(file, 'broken\n' + JSON.stringify(row(cwd, 'u', 'user', 'q')));
  await assert.rejects(runtime.readSession({ cwd, sessionId: uuid }), error => error.code === 'history_unavailable');
  await writeFile(file, JSON.stringify(row(cwd, 'u', 'user', 'q')) + '\n{"partial":');
  const result = await runtime.readSession({ cwd, sessionId: uuid }); assert.equal(result.truncated, true); assert.equal(result.messages.length, 1);
}));

test('both project runtimes reject unknown or malformed directories and session identifiers before native access', () => fixture(async ({ cwd, config }) => {
  for (const runtime of [createClaudeRuntime({ env: { CLAUDE_CONFIG_DIR: config }, spawnImpl: () => assert.fail() }), createOpenCodeRuntime({ spawnImpl: () => assert.fail() })]) {
    await assert.rejects(runtime.listSessions({ cwd: '/a/missing/research-directory' }), error => error.code === 'project_unavailable');
    await assert.rejects(runtime.readSession({ cwd, sessionId: '../../auth' }), error => error.code === 'invalid_session');
  }
}));
