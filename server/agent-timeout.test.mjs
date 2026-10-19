import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHandler } from './agents.mjs';

const identity = { workspaceId: 'workspace', researchId: 'research', conversationId: 'chat', requestId: 'request', connectionId: 'codex' };
const runBody = { ...identity, purpose: 'chat', prompt: 'Test', context: [], history: [], codex: {} };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'read-paper-timeout-'));
  const entered = deferred(), finish = deferred();
  let input;
  let runs = 0;
  let mainResponse;
  const sent = [];
  const handler = createAgentHandler({ stateDir, ports: [5173], timeoutMs: 100, runtimes: { codex: {
    run(value) {
      if (++runs > 1) return Promise.resolve({ nativeSessionId: 'native', body: 'Next answer' });
      input = value;
      input.signal.addEventListener('abort', () => finish.reject(Object.assign(new Error('Stopped'), { code: 'stopped' })), { once: true });
      entered.resolve();
      return finish.promise;
    },
  } } });
  t.after(async () => {
    await handler.close();
    for (const dir of await readdir(join(stateDir, 'materials')).catch(() => [])) await chmod(join(stateDir, 'materials', dir), 0o700);
    await rm(stateDir, { recursive: true, force: true });
  });
  const call = async (body, path = 'run') => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST'; req.url = `/api/ai/agents/${path}`;
    req.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json' };
    let text = '';
    const res = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); if (body.requestId === identity.requestId && path === 'run') sent.push(JSON.parse(chunk.toString())); res.headersSent = true; callback(); } });
    res.setHeader = () => {};
    if (body.requestId === identity.requestId && path === 'run') mainResponse = res;
    await handler(req, res);
    return { status: res.statusCode || 200, events: text.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = call(runBody);
  await entered.promise;
  return { handler, input, running, call, sent, disconnect: () => mainResponse.destroy(), done: () => finish.resolve({ nativeSessionId: 'native', body: 'Finished' }) };
}

test('active answer and tool events survive multiple original timeout deadlines', async t => {
  const f = await fixture(t);
  for (const event of [
    { type: 'delta', text: 'First answer' },
    { type: 'progress', kind: 'tool', id: 'tool', toolName: 'commandExecution', status: 'running', text: 'Running' },
    { type: 'progress', kind: 'tool', id: 'tool', toolName: 'commandExecution', status: 'done', text: 'Finished' },
    { type: 'delta', text: 'Last answer' },
  ]) {
    t.mock.timers.tick(80);
    assert.equal(f.input.signal.aborted, false, 'actual activity must refresh the idle deadline');
    f.input.onEvent(event);
  }
  f.done();
  const result = await f.running;
  assert.equal(result.events.at(-1).type, 'done');
  assert.equal(result.events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'First answerLast answer');
});

test('private native activity keeps a silent reasoning turn alive without sending content', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index++) {
    t.mock.timers.tick(80); f.input.onActivity();
    assert.equal(f.input.signal.aborted, false);
  }
  f.done();
  const result = await f.running;
  assert.deepEqual(result.events.map(event => event.type), ['delta', 'done']);
  f.input.onActivity(); f.input.onEvent({ type: 'delta', text: 'LATE AFTER DONE' });
  t.mock.timers.tick(300);
  assert.equal(f.input.signal.aborted, false);
  assert.doesNotMatch(JSON.stringify(f.sent), /LATE AFTER DONE/);
});

test('inactivity still stops the runtime, retains partial content and releases its session', async t => {
  const f = await fixture(t);
  t.mock.timers.tick(80); f.input.onEvent({ type: 'delta', text: 'Partial answer' });
  t.mock.timers.tick(99); assert.equal(f.input.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(f.input.signal.aborted, true);
  const result = await f.running;
  assert.equal(result.events[0].text, 'Partial answer');
  assert.equal(result.events.at(-1).code, 'timeout');
  assert.match(result.events.at(-1).error, /长时间未返回新进展/);
  f.input.onActivity(); f.input.onEvent({ type: 'delta', text: 'LATE' });
  assert.doesNotMatch(JSON.stringify(result), /LATE/);
  const next = await f.call({ ...runBody, requestId: 'next' });
  assert.equal(next.events.at(-1).type, 'done');
});

test('empty deltas and generic status updates do not keep a stalled run alive', async t => {
  const f = await fixture(t);
  const tool = { type: 'progress', kind: 'tool', id: 'command1', toolName: 'commandExecution', status: 'running', text: 'Running' };
  f.input.onEvent(tool);
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(30);
    f.input.onEvent({ type: 'delta', text: '' });
    f.input.onEvent({ type: 'progress', kind: 'status', text: 'Heartbeat' });
    f.input.onEvent({ type: 'progress', kind: 'tool', text: 'Missing actual item' });
    f.input.onEvent(tool);
  }
  t.mock.timers.tick(10);
  assert.equal(f.input.signal.aborted, true);
  assert.equal((await f.running).events.at(-1).code, 'timeout');
});

test('activity cannot restart the timeout while any approval or question remains pending', async t => {
  const f = await fixture(t);
  const first = f.input.onInteraction({ kind: 'approval', title: 'First' });
  const second = f.input.onInteraction({ kind: 'question', title: 'Second', questions: [{ id: 'focus', question: 'Focus?', options: [] }] });
  await flush();
  const interactions = f.sent.filter(event => event.type === 'interaction');
  assert.equal(interactions.length, 2);
  f.input.onActivity(); f.input.onEvent({ type: 'delta', text: 'Other activity' });
  t.mock.timers.tick(300); assert.equal(f.input.signal.aborted, false);
  assert.equal((await f.call({ ...identity, interactionId: interactions[0].interaction.id, reply: { decision: 'deny' } }, 'respond')).status, 200);
  f.input.onActivity();
  t.mock.timers.tick(300); assert.equal(f.input.signal.aborted, false);
  assert.equal((await f.call({ ...identity, interactionId: interactions[1].interaction.id, reply: { answers: { focus: ['Evidence'] } } }, 'respond')).status, 200);
  await Promise.all([first, second]);
  t.mock.timers.tick(99); assert.equal(f.input.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(f.input.signal.aborted, true);
  assert.equal((await f.running).events.at(-1).code, 'timeout');
});

for (const action of ['stop', 'disconnect', 'shutdown']) test(`${action} cancels an active run and late activity cannot revive it`, async t => {
  const f = await fixture(t);
  t.mock.timers.tick(80); f.input.onActivity();
  if (action === 'stop') await f.call(identity, 'stop');
  else if (action === 'disconnect') { f.disconnect(); await flush(); }
  else await f.handler.close();
  assert.equal(f.input.signal.aborted, true);
  f.input.onActivity(); t.mock.timers.tick(300);
  const result = await f.running;
  if (action === 'disconnect') assert.equal(result.events.some(event => ['done', 'error'].includes(event.type)), false);
  else assert.equal(result.events.at(-1).code, 'stopped');
});
