import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentHandler } from './agents.mjs';
import { createManagedRunStore } from './managed-runs.mjs';

const identity = { workspaceId: 'workspace', requestId: 'request', researchId: 'research', conversationId: 'conversation', connectionId: 'codex' };
const source = { evidenceId: 'evidence', documentId: 'paper', documentHash: 'hash', title: 'Paper', pageIndex: 0, quote: 'A unique original material paragraph.' };
const body = changes => ({ ...identity, purpose: 'chat', prompt: 'Explain', context: [source], history: [], codex: {}, skillIds: [], managed: true, ...changes });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, runtime, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'papertrail-managed-run-'));
  let handler;
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const setup = () => createAgentHandler({ runtimes: { codex: runtime }, stateDir, ports: [port], timeoutMs: 20, ...options });
  handler = setup();
  t.after(async () => {
    await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const name of await readdir(join(stateDir, 'materials')).catch(() => [])) await chmod(join(stateDir, 'materials', name), 0o700);
    await rm(stateDir, { recursive: true, force: true });
  });
  return { stateDir, async restart() { await handler.close(); handler = setup(); }, post(input, path = 'run', init = {}) { return fetch(`http://127.0.0.1:${port}/api/ai/agents/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), ...init }); } };
}
async function stream(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', closed = false;
  const waiting = [];
  return {
    cancel: () => reader.cancel(),
    async next(predicate = () => true) {
      while (true) {
        while (waiting.length) { const event = waiting.shift(); if (predicate(event)) return event; }
        if (closed) throw new Error(`Stream ended: ${buffer}`);
        const part = await reader.read(); closed = part.done;
        buffer += decoder.decode(part.value, { stream: !part.done });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        waiting.push(...lines.filter(Boolean).map(line => JSON.parse(line)));
      }
    },
    async rest() {
      const output = [...waiting]; waiting.length = 0;
      while (!closed) {
        const part = await reader.read(); closed = part.done;
        buffer += decoder.decode(part.value, { stream: !part.done });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        output.push(...lines.filter(Boolean).map(line => JSON.parse(line)));
      }
      return output;
    },
  };
}
const all = async response => (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('managed execution survives observer disconnection and resumes with one authoritative snapshot', async t => {
  const finish = deferred(); let calls = 0, input;
  t.after(() => finish.resolve());
  const f = await fixture(t, { async run(value) {
    input = value; calls++;
    value.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    value.onEvent({ type: 'item', item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', status: 'done', text: 'Reading' } });
    value.onEvent({ type: 'delta', text: 'Partial' });
    await finish.promise;
    return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Final answer', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', status: 'done', text: 'Final answer' }] };
  } });
  const initial = await stream(await f.post(body()));
  const first = await initial.next(event => event.type === 'delta');
  await initial.cancel(); await pause(40);
  assert.equal(input.signal.aborted, false); assert.equal(typeof input.managedKey, 'string');
  const resumed = await stream(await f.post({ ...identity, after: first.seq }, 'observe'));
  const snapshot = await resumed.next();
  assert.equal(snapshot.type, 'snapshot'); assert.equal(snapshot.body, 'Partial');
  assert.equal(snapshot.delivery, 'accepted'); assert.equal(snapshot.nativeTurnId, 'turn');
  assert.equal(snapshot.items[0].phase, 'commentary');
  finish.resolve();
  const remaining = await resumed.rest();
  assert.equal(remaining.at(-1).type, 'done'); assert.equal(remaining.at(-1).body, 'Final answer');
  assert.ok(remaining.every(event => event.seq > snapshot.seq)); assert.equal(calls, 1);
  const completed = (await all(await f.post({ ...identity, after: 0 }, 'observe')))[0];
  assert.equal(completed.body, 'Final answer'); assert.equal(completed.state, 'completed');
  assert.equal(completed.items.at(-1).phase, 'final_answer');
});

test('same identity reconnects without execution and foreign identities cannot observe or stop it', async t => {
  const finish = deferred(); let calls = 0;
  t.after(() => finish.resolve());
  const f = await fixture(t, { async run(input) { calls++; await finish.promise; return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Answer' }; } });
  const first = await stream(await f.post(body())); await first.next();
  for (let count = 0; calls === 0 && count < 100; count++) await pause(2);
  const again = await stream(await f.post(body({ prompt: 'Must never become a second turn' })));
  assert.equal((await again.next()).type, 'snapshot'); assert.equal(calls, 1);
  for (const key of ['workspaceId', 'researchId', 'conversationId', 'connectionId']) {
    const foreign = { ...identity, [key]: key === 'connectionId' ? 'claude' : 'another' };
    assert.equal((await f.post(foreign, 'observe')).status, key === 'connectionId' ? 400 : 404);
    assert.equal((await (await f.post(foreign, 'stop')).json()).stopped, false);
  }
  assert.equal((await f.post(body({ requestId: 'other' }))).status, 409);
  finish.resolve(); await first.rest(); await again.rest();
});

test('managed runs have no total model timeout and stop waits for native confirmation', async t => {
  const stopped = deferred(); let input;
  t.after(() => stopped.resolve());
  const f = await fixture(t, { async run(value) { input = value; value.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' }); await stopped.promise; throw Object.assign(new Error('Interrupted'), { code: 'stopped' }); } });
  const observer = await stream(await f.post(body())); await observer.next(event => event.nativeTurnId === 'turn');
  await pause(70); assert.equal(input.signal.aborted, false);
  assert.equal((await (await f.post(identity, 'stop')).json()).state, 'stopping');
  assert.equal(input.signal.aborted, true);
  const stopping = await observer.next(event => event.type === 'state'); assert.equal(stopping.state, 'stopping');
  assert.equal((await f.post(body({ requestId: 'next' }))).status, 409);
  stopped.resolve(); const events = await observer.rest();
  assert.equal(events.at(-1).state, 'interrupted'); assert.equal(events.at(-1).code, 'stopped');
});

test('native thread remains stable across evidence removal and skills changes, with no repeated history or material body', async t => {
  const calls = [];
  const f = await fixture(t, { async run(input) {
    calls.push(input); const nativeSessionId = input.nativeSessionId || 'native'; const nativeTurnId = `turn-${calls.length}`;
    input.onEvent({ type: 'session', nativeSessionId, nativeTurnId });
    return { nativeSessionId, nativeTurnId, body: 'Answer [1]' };
  } });
  await all(await f.post(body()));
  await all(await f.post(body({ requestId: 'second', context: [], skillIds: ['different-skill'] })));
  await all(await f.post(body({ requestId: 'third', history: [{ requestId: 'old', prompt: 'Old question', body: 'Never repeat this old answer', evidenceIds: [], context: [] }] })));
  assert.equal(calls.length, 3); assert.equal(calls[1].nativeSessionId, 'native'); assert.equal(calls[2].nativeSessionId, 'native');
  assert.match(calls[0].prompt, /A unique original material paragraph/);
  assert.doesNotMatch(calls[2].prompt, /A unique original material paragraph|Never repeat this old answer/);
  assert.match(calls[2].prompt, /\[1\] evidenceId=evidence/); assert.match(calls[2].prompt, /materials\.md/);
  assert.equal((await f.post(body({ requestId: 'reset', reset: true }))).status, 409);
});

test('a thread binding is persisted before start but request history waits for native turn acceptance', async t => {
  const accept = deferred(); let input;
  t.after(() => accept.resolve());
  const f = await fixture(t, { async run(value) {
    input = value; value.onEvent({ type: 'session', nativeSessionId: 'native' });
    await accept.promise; value.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Answer' };
  } });
  const observer = await stream(await f.post(body())); await observer.next(event => event.type === 'session');
  let mapping = JSON.parse(await readFile(join(f.stateDir, `${input.managedKey}.json`), 'utf8'));
  assert.deepEqual(mapping.scope.history, []);
  accept.resolve(); await observer.rest();
  mapping = JSON.parse(await readFile(join(f.stateDir, `${input.managedKey}.json`), 'utf8'));
  assert.deepEqual(mapping.scope.history, ['request']);
});

test('approval survives UI disconnection and remains bound to the original identity', async t => {
  let reply;
  const f = await fixture(t, { async run(input) {
    input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    reply = await input.onInteraction({ kind: 'approval', title: 'Read a source' });
    return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Approved' };
  } });
  const first = await stream(await f.post(body()));
  const interaction = (await first.next(event => event.type === 'interaction')).interaction;
  await first.cancel();
  const observer = await stream(await f.post(identity, 'observe'));
  const snapshot = await observer.next(); assert.equal(snapshot.state, 'waiting-input'); assert.equal(snapshot.interactions[0].id, interaction.id);
  const answer = { ...identity, interactionId: interaction.id, reply: { decision: 'allowOnce' } };
  assert.equal((await f.post({ ...answer, researchId: 'foreign' }, 'respond')).status, 409);
  assert.equal((await f.post(answer, 'respond')).status, 200);
  assert.equal((await f.post(answer, 'respond')).status, 409);
  assert.equal((await observer.rest()).at(-1).body, 'Approved'); assert.deepEqual(reply, { decision: 'allowOnce' });
});

test('a question created while disconnected restores its preceding native item anchor from the snapshot', async t => {
  const disconnected = deferred(), asked = deferred();
  t.after(() => disconnected.resolve());
  const f = await fixture(t, { async run(input) {
    input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    await disconnected.promise;
    input.onEvent({ type: 'item', item: { id: 'tool-before-question', type: 'commandExecution', status: 'done', command: 'read source', output: 'Source read', exitCode: 0 } });
    const answer = input.onInteraction({ kind: 'question', title: 'Which source should I compare?' });
    asked.resolve(); await answer;
    return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Compared' };
  } });
  const initial = await stream(await f.post(body()));
  await initial.next(event => event.nativeTurnId === 'turn'); await initial.cancel();
  disconnected.resolve(); await asked.promise;
  const observer = await stream(await f.post(identity, 'observe'));
  const snapshot = await observer.next();
  assert.equal(snapshot.type, 'snapshot'); assert.equal(snapshot.state, 'waiting-input');
  assert.equal(snapshot.items.at(-1).id, 'tool-before-question');
  assert.equal(snapshot.interactions[0].afterItemId, 'tool-before-question');
  const snapshotFile = (await readdir(join(f.stateDir, 'managed-runs'))).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const persisted = JSON.parse(await readFile(join(f.stateDir, 'managed-runs', snapshotFile), 'utf8'));
  assert.equal(persisted.snapshot.interactions[0].afterItemId, 'tool-before-question');
  assert.equal((await f.post({ ...identity, interactionId: snapshot.interactions[0].id, reply: { answers: {} } }, 'respond')).status, 200);
  assert.equal((await observer.rest()).at(-1).body, 'Compared');
});

test('service restart reconciles an unknown original turn without submitting it again', async t => {
  let calls = 0, reads = 0, ready = false;
  const runtime = { async run(input) {
    calls++; input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    throw Object.assign(new Error('Connection lost'), { code: 'delivery_unknown' });
  }, async readSession() {
    reads++;
    return { turns: [{ id: 'turn', status: ready ? 'completed' : 'inProgress', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Recovered full answer', status: 'done' }] }] };
  } };
  const f = await fixture(t, runtime);
  assert.equal((await all(await f.post(body()))).at(-1).state, 'unknown');
  await f.restart();
  assert.equal((await f.post(body({ requestId: 'must-not-submit' }))).status, 409);
  ready = true;
  const recovered = await all(await f.post(identity, 'observe'));
  assert.equal(recovered[0].state, 'completed'); assert.equal(recovered[0].body, 'Recovered full answer');
  assert.equal(recovered[0].delivery, 'accepted'); assert.equal(calls, 1); assert.ok(reads >= 2);
  const repeated = await all(await f.post(body())); assert.equal(repeated[0].state, 'completed'); assert.equal(calls, 1);
});

test('only the trusted original terminal turn clears an unconfirmed stop and allows the same native thread to continue', async t => {
  let recovery = 'active', projectPath; const calls = [];
  t.after(async () => {
    if (projectPath) {
      const materialRoot = join(projectPath, '.read-paper', 'materials');
      for (const name of await readdir(materialRoot).catch(() => [])) await chmod(join(materialRoot, name), 0o700);
    }
  });
  const f = await fixture(t, { async run(input) {
    calls.push(input);
    if (calls.length === 1) {
      input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'original-turn' });
      throw Object.assign(new Error('Stop confirmation lost'), { code: 'stop_unconfirmed' });
    }
    input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'next-turn' });
    return { nativeSessionId: 'native', nativeTurnId: 'next-turn', body: 'Next answer' };
  }, async readSession() {
    return { id: 'native', state: 'idle', canResume: true, messages: [], turns: [{ id: recovery === 'wrong-turn' ? 'different-turn' : 'original-turn', status: recovery === 'active' ? 'inProgress' : 'completed', answerComplete: true, items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', status: 'done', text: 'Recovered answer' }] }] };
  } });
  projectPath = join(f.stateDir, 'research'); await mkdir(projectPath);
  const binding = await (await f.post({ ...identity, path: projectPath }, 'projects/bind')).json();
  assert.equal(typeof binding.id, 'string');
  const failed = await all(await f.post(body({ bindingId: binding.id })));
  assert.equal(failed.at(-1).state, 'unknown'); await f.restart();
  const sessionRef = failed.find(event => event.nativeSessionRef)?.nativeSessionRef;
  assert.equal(typeof sessionRef, 'string');
  const read = () => f.post({ ...identity, bindingId: binding.id, sessionRef }, 'projects/read');
  assert.equal((await (await read()).json()).canResume, false, 'an idle native reader must not clear an unconfirmed original turn');
  recovery = 'wrong-turn';
  assert.equal((await all(await f.post(identity, 'observe')))[0].state, 'unknown');
  assert.equal((await (await read()).json()).canResume, false, 'a different completed turn cannot clear the original stop marker');
  const before = JSON.parse(await readFile(join(f.stateDir, 'projects.json'), 'utf8')).sessions[sessionRef];
  assert.deepEqual(before.unconfirmedRun, { requestId: identity.requestId, nativeTurnId: 'original-turn' });
  recovery = 'original-turn';
  const recovered = (await all(await f.post(identity, 'observe')))[0];
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.body, 'Recovered answer');
  const confirmed = JSON.parse(await readFile(join(f.stateDir, 'projects.json'), 'utf8')).sessions[sessionRef];
  assert.equal(confirmed.stopUnconfirmed, undefined); assert.equal(confirmed.unconfirmedRun, undefined);
  assert.equal((await (await read()).json()).canResume, true);
  const next = await all(await f.post(body({ requestId: 'next', bindingId: binding.id })));
  assert.equal(next.at(-1).body, 'Next answer'); assert.equal(next.at(-1).type, 'done');
  assert.equal(calls.length, 2); assert.equal(calls[1].nativeSessionId, 'native');
});

test('two concurrent runs are allowed and a third cannot bypass the global cap', async t => {
  const finish = deferred(); let calls = 0;
  t.after(() => finish.resolve());
  const f = await fixture(t, { async run(input) { calls++; await finish.promise; return { nativeSessionId: input.managedKey, nativeTurnId: `turn-${calls}`, body: 'Done' }; } });
  const first = await stream(await f.post(body())); await first.next();
  const secondBody = body({ conversationId: 'second', requestId: 'second' });
  const second = await stream(await f.post(secondBody)); await second.next();
  assert.equal((await f.post(body({ conversationId: 'third', requestId: 'third' }))).status, 429);
  const duplicate = await stream(await f.post(body())); assert.equal((await duplicate.next()).type, 'snapshot');
  finish.resolve(); await Promise.all([first.rest(), second.rest(), duplicate.rest()]); assert.equal(calls, 2);
});

test('evicted response snapshots leave permanent receipts and cannot execute the same identity again', async t => {
  let calls = 0;
  const f = await fixture(t, { async run() { calls++; throw new Error('Must not execute an evicted request'); } });
  const store = createManagedRunStore({ directory: join(f.stateDir, 'managed-runs') });
  for (let index = 0; index < 131; index++) {
    const next = { ...identity, requestId: index === 0 ? identity.requestId : `past-${index}` };
    const { record } = await store.create(next);
    await store.publish(record, { type: 'done', body: 'Past answer', nativeSessionId: 'native', nativeTurnId: `turn-${index}` });
  }
  const files = await readdir(join(f.stateDir, 'managed-runs'));
  assert.ok(files.filter(name => name.endsWith('.json')).length <= 129);
  assert.equal((await readdir(join(f.stateDir, 'managed-runs', 'seen'))).length, 131);
  const response = await f.post(body()); assert.equal(response.status, 410);
  assert.equal((await all(response)).at(-1).code, 'run_expired'); assert.equal(calls, 0);
  await store.close();
});

test('corrupt persisted state and delivery are rejected without starting a model', async t => {
  for (const change of [{ state: 'invented' }, { delivery: 'maybe' }, { items: [{ id: 'bad', type: 'agentMessage', status: 'made-up' }] }]) {
    await t.test(JSON.stringify(change), async t => {
      let calls = 0;
      const f = await fixture(t, { async run() { calls++; } });
      const store = createManagedRunStore({ directory: join(f.stateDir, 'managed-runs') });
      const { record } = await store.create(identity);
      await store.publish(record, { type: 'done', body: 'Old', nativeSessionId: 'native', nativeTurnId: 'turn' }); await store.close();
      const file = join(f.stateDir, 'managed-runs', `${record.key}.json`), value = JSON.parse(await readFile(file, 'utf8'));
      Object.assign(value.snapshot, change); await writeFile(file, JSON.stringify(value));
      const response = await f.post(body()); assert.equal(response.status, 500);
      assert.equal((await all(response)).at(-1).code, 'run_read_failed'); assert.equal(calls, 0);
    });
  }
});

test('automatic compaction streams its state without changing the native thread or user turn', async t => {
  const finish = deferred(), compacted = deferred(); let input;
  t.after(() => { compacted.resolve(); finish.resolve(); });
  const f = await fixture(t, { async run(value) {
    input = value; value.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    value.onEvent({ type: 'item', item: { id: 'compact', type: 'contextCompaction', status: 'running' } });
    await compacted.promise;
    value.onEvent({ type: 'item', item: { id: 'compact', type: 'contextCompaction', status: 'done' } });
    await finish.promise; return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Continued after compaction' };
  } });
  const observer = await stream(await f.post(body()));
  assert.equal((await observer.next(event => event.type === 'state')).state, 'compacting');
  const restored = await stream(await f.post(identity, 'observe'));
  const snapshot = await restored.next(); assert.equal(snapshot.state, 'compacting'); assert.equal(snapshot.nativeTurnId, 'turn');
  compacted.resolve(); assert.equal((await observer.next(event => event.type === 'state')).state, 'running');
  assert.equal(input.signal.aborted, false); finish.resolve();
  assert.equal((await observer.rest()).at(-1).body, 'Continued after compaction'); await restored.rest();
});

test('steering requires the active turn and original identity; manual compaction does not reopen completed requests', async t => {
  const finish = deferred(), controls = []; t.after(() => finish.resolve());
  const f = await fixture(t, { async run(input) {
    input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    await finish.promise; return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Done' };
  }, async control(input) { controls.push(input); return { accepted: true, nativeTurnId: 'turn' }; } });
  const observer = await stream(await f.post(body())); await observer.next(event => event.nativeTurnId === 'turn');
  const steer = { ...identity, action: 'steer', inputId: 'supplement-one', text: 'Focus on evidence', expectedTurnId: 'turn' };
  assert.equal((await f.post({ ...steer, expectedTurnId: 'other' }, 'control')).status, 409);
  assert.equal((await f.post({ ...steer, workspaceId: 'other' }, 'control')).status, 409);
  assert.equal((await f.post(steer, 'control')).status, 200); assert.equal(controls.length, 1);
  assert.equal(controls[0].text, 'Focus on evidence'); assert.equal(controls[0].expectedTurnId, 'turn');
  assert.equal(controls[0].inputId, steer.inputId);
  const confirmed = await observer.next(event => event.type === 'user-input'); assert.equal(confirmed.input.id, steer.inputId); assert.equal(confirmed.input.text, steer.text);
  assert.equal((await f.post(steer, 'control')).status, 200); assert.equal(controls.length, 1);
  assert.equal((await f.post({ ...steer, text: 'Different text' }, 'control')).status, 409);
  finish.resolve(); await observer.rest();
  assert.equal((await f.post({ ...steer, inputId: 'another-input' }, 'control')).status, 409);
  assert.equal((await f.post(steer, 'control')).status, 200); assert.equal(controls.length, 1);
  const recovered = (await all(await f.post(identity, 'observe')))[0]; assert.equal(recovered.supplementalInputs.length, 1);
  assert.equal((await f.post({ ...identity, action: 'compact' }, 'control')).status, 409);
  assert.equal(controls.length, 1);
});

test('an unavailable permanent receipt directory rejects a run before native execution', async t => {
  let calls = 0;
  const f = await fixture(t, { async run() { calls++; } });
  assert.equal((await f.post(identity, 'observe')).status, 404);
  const ledger = join(f.stateDir, 'managed-runs', 'seen');
  await rm(ledger, { recursive: true, force: true }); await writeFile(ledger, 'not a directory');
  assert.equal((await f.post(body())).status, 500); assert.equal(calls, 0);
});

test('a steering response lost in transit remains unknown and is never sent twice', async t => {
  const finish = deferred(); t.after(() => finish.resolve()); let controls = 0, nativeSeen = false;
  const f = await fixture(t, { async run(input) {
    input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' });
    await finish.promise; return { nativeSessionId: 'native', nativeTurnId: 'turn', body: 'Done' };
  }, async control() { controls++; throw Object.assign(new Error('Timed out'), { code: 'timeout' }); }, async readSession() {
    return { turns: [{ id: 'turn', status: 'inProgress', items: nativeSeen ? [{ id: 'native-user', type: 'userMessage', clientId: 'uncertain', text: 'Supplement' }] : [] }] };
  } });
  const observer = await stream(await f.post(body())); await observer.next(event => event.nativeTurnId === 'turn');
  const input = { ...identity, action: 'steer', inputId: 'uncertain', text: 'Supplement', expectedTurnId: 'turn' };
  assert.equal((await f.post(input, 'control')).status, 502);
  const again = await f.post(input, 'control'); assert.equal(again.status, 409);
  assert.equal((await all(again)).at(-1).code, 'input_unknown'); assert.equal(controls, 1);
  const unknown = await stream(await f.post(identity, 'observe')); assert.equal((await unknown.next()).supplementalInputs?.length || 0, 0); await unknown.cancel();
  nativeSeen = true;
  const recovered = await stream(await f.post(identity, 'observe')); const known = await recovered.next();
  assert.equal(known.supplementalInputs[0].id, 'uncertain'); assert.equal(known.supplementalInputs[0].text, 'Supplement');
  assert.equal((await f.post(input, 'control')).status, 200); assert.equal(controls, 1);
  finish.resolve(); await observer.rest();
  await recovered.rest();
  const snapshot = (await all(await f.post(identity, 'observe')))[0]; assert.equal(snapshot.supplementalInputs.length, 1);
});

test('a truncated history preview never replaces a longer received answer or completes the original request', async t => {
  const partial = 'p'.repeat(80_000), full = 'p'.repeat(80_000) + 'final-tail'.repeat(3000);
  let complete = false, runs = 0;
  const f = await fixture(t, { async run(input) {
    runs++; input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: 'turn' }); input.onEvent({ type: 'delta', text: partial });
    throw Object.assign(new Error('Transport lost'), { code: 'delivery_unknown' });
  }, async readSession() {
    return { turns: [{ id: 'turn', status: 'completed', answerComplete: complete, items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: complete ? full : full.slice(0, 60_000), status: 'done', contentComplete: complete }] }], truncated: !complete };
  } });
  await all(await f.post(body())); await f.restart();
  const preview = (await all(await f.post(identity, 'observe')))[0];
  assert.equal(preview.state, 'unknown'); assert.equal(preview.body, partial); assert.match(preview.error, /截断预览/);
  complete = true;
  const recovered = (await all(await f.post(identity, 'observe')))[0];
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.body, full); assert.equal(runs, 1);
});

test('the managed mapping persists its registered native tool version across service restart', async t => {
  const calls = [];
  const f = await fixture(t, { async run(input) { calls.push(input); input.onEvent({ type: 'session', nativeSessionId: 'native', nativeTurnId: `turn-${calls.length}`, nativeToolsVersion: 1 }); return { nativeSessionId: 'native', nativeTurnId: `turn-${calls.length}`, body: 'Answer', nativeToolsVersion: 1 }; } });
  await all(await f.post(body())); await f.restart();
  await all(await f.post(body({ requestId: 'next' })));
  assert.equal(calls[1].nativeSessionId, 'native'); assert.equal(calls[1].nativeToolsVersion, 1);
});
