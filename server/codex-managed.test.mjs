import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexRuntime, sanitizeAgentItem } from './codex-runtime.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'papertrail-managed-codex-')));
  await writeFile(join(cwd, 'manifest.json'), '{}');
  const calls = []; const children = []; const turns = [];
  let requestId = 1000;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); return true; };
    const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    const waiting = new Map();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString()); calls.push(message);
      if (!message.method) { waiting.get(message.id)?.(message.result); waiting.delete(message.id); callback(); return; }
      const result = {
        initialize: {}, 'config/read': { config: {} }, 'skills/list': { data: [] },
        'model/list': { data: [{ id: 'default', model: 'native-model', displayName: 'Native', isDefault: true }] },
        'permissionProfile/list': { data: [{ id: 'read_paper_materials', allowed: true }] }, 'collaborationMode/list': { data: [] },
        'command/exec': { exitCode: message.params?.command?.[0].includes('touch') || message.params?.command?.[1].endsWith('outside.txt') ? 1 : 0 },
        'thread/start': { thread: { id: `thread-${children.length}`, cwd }, model: 'native-model' },
        'thread/resume': { thread: { id: message.params?.threadId, cwd }, model: 'native-model' },
        'thread/read': { thread: { id: message.params?.threadId, cwd } },
        'turn/steer': { turnId: message.params?.expectedTurnId },
      }[message.method] || {};
      if (message.method === 'turn/start' || message.method === 'thread/compact/start') {
        const id = `turn-${turns.length + 1}`; const threadId = message.params.threadId;
        const notify = (method, params = {}) => send({ method, params: { threadId, turnId: id, ...params } });
        const context = { id, threadId, child, notify,
          request: (method, params = {}) => new Promise(resolve => { const requestIdValue = ++requestId; waiting.set(requestIdValue, resolve); send({ id: requestIdValue, method, params: { threadId, turnId: id, ...params } }); }),
          finish: (status = 'completed', items) => notify('turn/completed', { turn: { id, status, ...(items ? { items } : {}) } }),
          answer: (text = `answer-${id}`) => { notify('item/agentMessage/delta', { itemId: 'answer', delta: text }); notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text, phase: 'final_answer' } }); notify('turn/completed', { turn: { id, status: 'completed' } }); },
        };
        turns.push(context);
        if (message.method === 'turn/start') result.turn = { id };
        setImmediate(() => Promise.resolve(options.onTurn ? options.onTurn(context, message.method) : context.answer()).catch(error => child.emit('error', error)));
      }
      if (message.method === 'turn/interrupt') options.onInterrupt?.(turns.find(turn => turn.id === message.params.turnId), message);
      if (message.id !== undefined && !(options.dropTurnStartReply && message.method === 'turn/start')) send({ id: message.id, result });
      callback();
    } });
    children.push(child); return child;
  };
  const runtime = createCodexRuntime({ spawnImpl, rpcTimeoutMs: 100, interruptTimeoutMs: options.interruptTimeoutMs ?? 40, idleTimeoutMs: options.idleTimeoutMs ?? 60_000, env: { PRIVATE_TOKEN: 'private-test-secret' } });
  t.after(async () => { await runtime.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, runtime, calls, children, turns };
}

test('20 managed turns reuse one initialized client and one native thread, then close releases it', async t => {
  const f = await fixture(t);
  let session;
  for (let index = 0; index < 20; index++) {
    const events = [];
    const result = await f.runtime.run({ managedKey: 'chat-one', cwd: f.cwd, nativeSessionId: session, prompt: `question ${index}`, onEvent: event => events.push(event) });
    session ||= result.nativeSessionId;
    assert.equal(result.nativeSessionId, session); assert.equal(result.nativeTurnId, `turn-${index + 1}`);
    assert.equal(result.body, `answer-turn-${index + 1}`); assert.equal(result.status, 'completed');
    assert.ok(events.some(event => event.type === 'session' && event.nativeTurnId === result.nativeTurnId));
    assert.ok(!JSON.stringify(events).includes(`answer-turn-${index}` + '"'));
  }
  assert.equal(f.children.length, 1); assert.equal(f.children[0].killed, false);
  for (const [method, count] of [['initialize', 1], ['thread/start', 1], ['thread/resume', 0], ['turn/start', 20], ['command/exec', 3]]) assert.equal(f.calls.filter(call => call.method === method).length, count, method);
  await f.runtime.close(); assert.equal(f.children[0].killed, true);
  await assert.rejects(f.runtime.run({ managedKey: 'chat-one', cwd: f.cwd, prompt: 'after close' }), { code: 'agent_closed' });
});

test('managed writer rejects concurrent sends and binding changes without stealing or forking', async t => {
  let first;
  const f = await fixture(t, { onTurn(turn) { if (!first) first = turn; else turn.answer(); }, onInterrupt(turn) { turn.finish('interrupted'); } });
  const running = f.runtime.run({ managedKey: 'one', cwd: f.cwd, prompt: 'one' });
  while (!first) await tick();
  await assert.rejects(f.runtime.run({ managedKey: 'one', cwd: f.cwd, prompt: 'duplicate' }), { code: 'session_busy' });
  const other = await f.runtime.run({ managedKey: 'two', cwd: f.cwd, prompt: 'another conversation' });
  assert.notEqual(other.nativeSessionId, first.threadId);
  first.answer(); await running;
  await assert.rejects(f.runtime.run({ managedKey: 'one', cwd: f.cwd, nativeSessionId: 'wrong-thread', prompt: 'wrong' }), { code: 'invalid_session' });
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.ok(!f.calls.some(call => call.method === 'thread/fork'));
});

test('stop waits for native interrupted confirmation and a confirmed stop keeps the same connection', async t => {
  let active; let interrupted = false;
  const f = await fixture(t, { onTurn(turn) { active = turn; if (turn.id === 'turn-1') turn.notify('item/agentMessage/delta', { itemId: 'a', delta: 'partial' }); else turn.answer(); }, onInterrupt() { interrupted = true; }, interruptTimeoutMs: 500 });
  const controller = new AbortController(); const events = []; let settled = false;
  const running = f.runtime.run({ managedKey: 'stop', cwd: f.cwd, prompt: 'Q', signal: controller.signal, onEvent: event => events.push(event) });
  running.finally(() => { settled = true; }).catch(() => {});
  while (!active) await tick();
  controller.abort(); await tick();
  assert.equal(interrupted, true); assert.equal(settled, false); assert.equal(f.children[0].killed, false);
  active.notify('item/agentMessage/delta', { itemId: 'a', delta: 'LATE' });
  active.finish('interrupted');
  await assert.rejects(running, error => error.code === 'stopped' && error.body === 'partial' && error.nativeTurnId === 'turn-1');
  assert.doesNotMatch(JSON.stringify(events), /LATE/); assert.equal(f.children[0].killed, false);
  const resumed = await f.runtime.run({ managedKey: 'stop', nativeSessionId: active.threadId, cwd: f.cwd, prompt: 'continue' });
  assert.equal(resumed.nativeSessionId, 'thread-1'); assert.equal(f.children.length, 1);
});

test('unconfirmed stop closes only its owned client and reports uncertainty, never success', async t => {
  let active;
  const f = await fixture(t, { onTurn(turn) { active = turn; } });
  const controller = new AbortController();
  const running = f.runtime.run({ managedKey: 'stop', cwd: f.cwd, prompt: 'Q', signal: controller.signal });
  while (!active) await tick(); controller.abort();
  await assert.rejects(running, error => error.code === 'stop_unconfirmed' && error.status === 'unknown' && /尚未确认/.test(error.message));
  assert.equal(f.calls.filter(call => call.method === 'turn/interrupt').length, 1); assert.equal(f.children[0].killed, true);
});

test('native ordered items retain commentary and sanitized tools while final answer repairs streaming text', async t => {
  const f = await fixture(t, { onTurn(turn) {
    turn.notify('item/started', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: '' } });
    turn.notify('item/agentMessage/delta', { itemId: 'comment', delta: 'I will inspect' });
    turn.notify('item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'I will inspect' } });
    turn.notify('item/started', { item: { id: 'secret', type: 'reasoning', text: 'PRIVATE REASONING' } });
    turn.notify('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'cat .env' } });
    turn.notify('item/completed', { item: { id: 'tool', type: 'commandExecution', command: 'cat .env', aggregatedOutput: 'private-test-secret', exitCode: 0 } });
    turn.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'partial final' });
    turn.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Complete corrected final' } });
    turn.finish();
  } });
  const events = [];
  const result = await f.runtime.run({ managedKey: 'items', cwd: f.cwd, prompt: 'Q', onEvent: event => events.push(event) });
  assert.equal(result.body, 'Complete corrected final'); assert.deepEqual(result.items.map(item => item.id), ['comment', 'tool', 'answer']);
  assert.equal(result.items[0].text, 'I will inspect'); assert.match(result.items[1].output, /已隐藏/);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE REASONING|private-test-secret/);
  assert.deepEqual(sanitizeAgentItem(result.items[1], false, { PRIVATE_TOKEN: 'private-test-secret' }), result.items[1]);
});

test('compaction, plan and token/status notifications expose bounded state without raw reasoning', async t => {
  let activities = 0;
  const f = await fixture(t, { onTurn(turn) {
    turn.notify('thread/status/changed', { turnId: undefined, status: { type: 'active', activeFlags: ['waitingOnApproval', 'unknown'] } });
    turn.notify('thread/tokenUsage/updated', { turnId: undefined, tokenUsage: { total: { totalTokens: 120, private: 'secret' }, last: { inputTokens: 20 }, modelContextWindow: 1000, private: 'secret' } });
    turn.notify('thread/status/changed', { threadId: 'foreign', turnId: undefined, status: { type: 'systemError' } });
    turn.notify('thread/tokenUsage/updated', { threadId: 'foreign', turnId: undefined, tokenUsage: { total: { totalTokens: 999 } } });
    assert.equal(activities, 0);
    turn.notify('item/started', { item: { id: 'compact', type: 'contextCompaction', private: 'secret' } });
    turn.notify('item/completed', { item: { id: 'compact', type: 'contextCompaction', private: 'secret' } });
    turn.notify('turn/plan/updated', { plan: [{ status: 'completed', step: 'Read selected material' }] });
    turn.finish();
  } });
  const events = [];
  const result = await f.runtime.run({ managedKey: 'usage', cwd: f.cwd, prompt: 'Q', onEvent: event => events.push(event), onActivity: () => activities++ });
  assert.equal(result.body, ''); assert.equal(result.status, 'completed');
  assert.deepEqual(events.find(event => event.type === 'usage').usage, { total: { totalTokens: 120 }, last: { inputTokens: 20 }, modelContextWindow: 1000 });
  assert.deepEqual(events.find(event => event.type === 'status').activeFlags, ['waitingOnApproval']);
  assert.equal(result.items[0].type, 'contextCompaction'); assert.equal(result.items[0].status, 'done');
  assert.ok(result.items.some(item => item.type === 'plan')); assert.doesNotMatch(JSON.stringify(events), /private|secret|unknown/);
  assert.equal(activities, 2);
  assert.equal(events.filter(event => event.type === 'status').length, 1);
  assert.equal(events.filter(event => event.type === 'usage').length, 1);
});

test('a reused managed client binds private activity only to its current turn callback', async t => {
  const events = [];
  const counts = [0, 0];
  const f = await fixture(t, { onTurn(turn) {
    if (turn.id !== 'turn-1') turn.notify('item/reasoning/textDelta', { turnId: 'turn-1', itemId: 'previous', delta: 'PRIVATE PREVIOUS TURN' });
    turn.notify('item/started', { item: { id: 'reasoning', type: 'reasoning' } });
    turn.notify('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'PRIVATE CURRENT REASONING' });
    turn.notify('item/completed', { item: { id: 'reasoning', type: 'reasoning' } });
    turn.answer();
  } });
  const first = await f.runtime.run({ managedKey: 'activity', cwd: f.cwd, prompt: 'first', onActivity: () => counts[0]++, onEvent: event => events.push(event) });
  assert.deepEqual(counts, [5, 0]);
  const second = await f.runtime.run({ managedKey: 'activity', cwd: f.cwd, nativeSessionId: first.nativeSessionId, prompt: 'second', onActivity: () => counts[1]++, onEvent: event => events.push(event) });
  assert.deepEqual(counts, [5, 5]);
  assert.equal(first.nativeSessionId, second.nativeSessionId);
  assert.equal(f.children.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE PREVIOUS TURN|PRIVATE CURRENT REASONING/);
});

test('steer appends to the expected active turn and compact retains the existing native thread', async t => {
  let active;
  const f = await fixture(t, { onTurn(turn, method) {
    active = turn;
    if (method === 'thread/compact/start') {
      turn.notify('turn/started', { turn: { id: turn.id, status: 'inProgress' } });
      turn.notify('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
      turn.notify('item/completed', { item: { id: 'compact', type: 'contextCompaction' } });
      turn.finish();
    }
  }, onInterrupt(turn) { turn.finish('interrupted'); } });
  const running = f.runtime.run({ managedKey: 'control', cwd: f.cwd, prompt: 'Q' });
  while (!active) await tick();
  await assert.rejects(f.runtime.control({ managedKey: 'control', action: 'steer', text: 'late', expectedTurnId: 'wrong' }), { code: 'turn_changed' });
  const accepted = await f.runtime.control({ managedKey: 'control', action: 'steer', text: 'Focus on methods', expectedTurnId: active.id, inputId: 'steer-id-1' });
  assert.equal(f.calls.find(call => call.method === 'turn/steer').params.clientUserMessageId, 'steer-id-1');
  assert.equal(accepted.nativeTurnId, active.id); assert.equal(accepted.accepted, true);
  await assert.rejects(f.runtime.control({ managedKey: 'control', action: 'compact' }), { code: 'session_busy' });
  active.answer(); const result = await running;
  const events = [];
  const compacted = await f.runtime.control({ managedKey: 'control', action: 'compact', onEvent: event => events.push(event) });
  assert.equal(compacted.nativeSessionId, result.nativeSessionId); assert.equal(compacted.status, 'completed');
  assert.equal(compacted.items[0].type, 'contextCompaction'); assert.equal(f.children.length, 1);
  assert.ok(events.some(event => event.type === 'session' && event.nativeTurnId === compacted.nativeTurnId));
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
});

test('idle expiry releases the writer and resumes the same native thread on the next send', async t => {
  const f = await fixture(t, { idleTimeoutMs: 15 });
  const first = await f.runtime.run({ managedKey: 'idle', cwd: f.cwd, prompt: 'Q' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.children[0].killed, true);
  const second = await f.runtime.run({ managedKey: 'idle', nativeSessionId: first.nativeSessionId, cwd: f.cwd, prompt: 'Q2' });
  assert.equal(second.nativeSessionId, first.nativeSessionId); assert.equal(f.children.length, 2);
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 1);
});


test('client request identity reaches the native turn and accepted transport loss remains unknown', async t => {
  for (const dropTurnStartReply of [false, true]) {
    const f = await fixture(t, { dropTurnStartReply, onTurn(turn) { turn.child.exitCode = 1; turn.child.emit('exit', 1); } });
    await assert.rejects(f.runtime.run({ managedKey: 'delivery', requestId: 'request-durable-1', cwd: f.cwd, prompt: 'Do not resend' }), error => error.code === 'delivery_unknown' && error.status === 'unknown' && error.nativeSessionId === 'thread-1' && (dropTurnStartReply ? !error.nativeTurnId : error.nativeTurnId === 'turn-1'));
    const starts = f.calls.filter(call => call.method === 'turn/start');
    assert.equal(starts.length, 1); assert.equal(starts[0].params.clientUserMessageId, 'request-durable-1');
    assert.ok(!f.calls.some(call => call.method === 'thread/fork'));
  }
});

test('a reused native client binds approval callbacks only to the current conversation turn', async t => {
  const replies = []; const shown = [];
  const f = await fixture(t, { async onTurn(turn) { replies.push(await turn.request('item/commandExecution/requestApproval', { command: `cat material-${turn.id}.md` })); turn.answer(); } });
  const first = await f.runtime.run({ managedKey: 'callbacks', cwd: f.cwd, prompt: 'first', codex: {}, onInteraction(input) { shown.push(`first:${input.command}`); return { decision: 'allowOnce' }; } });
  await f.runtime.run({ managedKey: 'callbacks', nativeSessionId: first.nativeSessionId, cwd: f.cwd, prompt: 'second', codex: {}, onInteraction(input) { shown.push(`second:${input.command}`); return { decision: 'deny' }; } });
  assert.equal(f.children.length, 1);
  assert.deepEqual(replies, [{ decision: 'accept' }, { decision: 'decline' }]);
  assert.deepEqual(shown, ['first:cat material-turn-1.md', 'second:cat material-turn-2.md']);
});

test('live final answers beyond the old item preview limit remain complete up to the run limit', async t => {
  const full = 'A complete native final paragraph. '.repeat(5000);
  assert.ok(full.length > 120_000 && full.length < 1_000_000);
  const f = await fixture(t, { onTurn(turn) { turn.answer(full); } });
  const result = await f.runtime.run({ managedKey: 'long-final', cwd: f.cwd, prompt: 'Return a long answer' });
  assert.equal(result.body, full); assert.equal(result.items.at(-1).text, full); assert.equal(result.items.at(-1).contentComplete, true);
});

test('an oversized native completion fails explicitly and retains the previously received answer', async t => {
  const partial = 'Already received and preserved.';
  const f = await fixture(t, { onTurn(turn) {
    turn.notify('item/agentMessage/delta', { itemId: 'answer', delta: partial });
    turn.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'x'.repeat(1_000_001) } });
  } });
  const events = [];
  await assert.rejects(f.runtime.run({ managedKey: 'over-limit', cwd: f.cwd, prompt: 'Q', onEvent: event => events.push(event) }), error => error.code === 'output_too_large' && error.body === partial);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), partial);
  assert.ok(events.filter(event => event.type === 'item').every(event => (event.item.text?.length || 0) <= 1_000_000));
});
