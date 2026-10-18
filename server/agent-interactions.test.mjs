import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHandler } from './agents.mjs';

const identity = { workspaceId: 'workspace', researchId: 'research', conversationId: 'chat', requestId: 'request', connectionId: 'codex' };
const runBody = { ...identity, purpose: 'chat', prompt: 'Test', context: [], history: [], codex: {}, skillIds: [] };
// Leave time for real filesystem setup under parallel tests, then wait past this same deadline.
const interactiveTimeoutMs = 400;
async function fixture(t, runtime, timeoutMs = 3000) {
  const stateDir = await mkdtemp(join(tmpdir(), 'read-paper-interactions-'));
  let handler;
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  handler = createAgentHandler({ runtimes: { codex: runtime }, stateDir, ports: [port], timeoutMs });
  t.after(async () => {
    handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const dir of await readdir(join(stateDir, 'materials')).catch(() => [])) await chmod(join(stateDir, 'materials', dir), 0o700);
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    get: (path, headers) => fetch(`http://127.0.0.1:${port}/api/ai/agents/${path}`, { headers }),
    post: (body, path = 'run') => fetch(`http://127.0.0.1:${port}/api/ai/agents/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}
async function firstInteraction(response) {
  const reader = response.body.getReader(); let text = '';
  while (true) {
    const part = await reader.read(); text += new TextDecoder().decode(part.value);
    const event = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'interaction');
    if (event) return { reader, event };
    if (part.done) throw new Error(`Missing interaction: ${text}`);
  }
}
async function rest(reader) { let text = ''; while (true) { const part = await reader.read(); text += new TextDecoder().decode(part.value); if (part.done) return text; } }

test('capabilities discovery stays local and invalid skill/model inputs never reach the runtime', async t => {
  let runs = 0;
  const capabilities = { skills: [], models: [{ id: 'native', name: 'Native' }], plan: true };
  const f = await fixture(t, { capabilities: async () => capabilities, run: async () => { runs++; } });
  assert.deepEqual(await (await f.get('codex/capabilities')).json(), capabilities);
  assert.equal((await f.get('codex/capabilities', { Origin: 'https://outside.example' })).status, 403);
  for (const input of [{ skillIds: ['../SKILL.md'] }, { skillIds: ['a', 'a'] }, { codex: { mode: 'invalid' } }, { connectionId: 'claude' }, { purpose: 'card' }]) assert.equal((await f.post({ ...runBody, ...input })).status, 400);
  assert.equal(runs, 0);
});

test('approval replies require the original request identity and can only be consumed once', async t => {
  let answer;
  const f = await fixture(t, { async run(input) {
    answer = await input.onInteraction({ kind: 'approval', title: 'Read requested source', command: 'cat materials.md' });
    return { nativeSessionId: 'native', body: 'Continued' };
  } });
  const { reader, event } = await firstInteraction(await f.post(runBody));
  const body = { ...identity, interactionId: event.interaction.id, reply: { decision: 'allowOnce' } };
  assert.equal((await f.post({ ...body, researchId: 'another' }, 'respond')).status, 409);
  assert.equal((await f.post({ ...body, reply: { decision: 'always' } }, 'respond')).status, 400);
  assert.equal((await f.post(body, 'respond')).status, 200);
  assert.equal((await f.post(body, 'respond')).status, 409);
  assert.deepEqual(answer, { decision: 'allowOnce' });
  const output = await rest(reader);
  assert.match(output, /interaction-resolved/); assert.match(output, /Continued/); assert.match(output, /"type":"done"/);
});

test('question time does not spend the model timeout and malformed answers cannot resolve it', async t => {
  let answer;
  const f = await fixture(t, { async run(input) {
    answer = await input.onInteraction({ kind: 'question', title: 'Choose a focus', questions: [{ id: 'focus', question: 'Which focus?', options: [{ label: 'Evidence' }] }] });
    return { nativeSessionId: 'native', body: 'Answered' };
  } }, interactiveTimeoutMs);
  const { reader, event } = await firstInteraction(await f.post(runBody));
  await new Promise(resolve => setTimeout(resolve, interactiveTimeoutMs * 2 + 10));
  const body = { ...identity, interactionId: event.interaction.id };
  assert.equal((await f.post({ ...body, reply: { answers: { other: ['Evidence'] } } }, 'respond')).status, 400);
  assert.equal((await f.post({ ...body, reply: { answers: { focus: ['My own focus'] } } }, 'respond')).status, 200);
  assert.deepEqual(answer, { answers: { focus: ['My own focus'] } });
  assert.match(await rest(reader), /"type":"done"/);
});

test('stop rejects a pending interaction and late answers cannot resume it', async t => {
  let aborted = false;
  const f = await fixture(t, { async run(input) {
    try { await input.onInteraction({ kind: 'approval', title: 'Pending action' }); }
    catch (error) { aborted = input.signal.aborted; throw error; }
  } });
  const { reader, event } = await firstInteraction(await f.post(runBody));
  assert.equal((await f.post(identity, 'stop')).status, 200);
  assert.match(await rest(reader), /"code":"stopped"/);
  assert.equal(aborted, true);
  assert.equal((await f.post({ ...identity, interactionId: event.interaction.id, reply: { decision: 'allowOnce' } }, 'respond')).status, 409);
});

test('answering one parallel approval keeps the timeout paused for remaining user input', async t => {
  const f = await fixture(t, { async run(input) {
    await Promise.all(['First', 'Second'].map(title => input.onInteraction({ kind: 'approval', title })));
    return { nativeSessionId: 'native', body: 'Both answered' };
  } }, interactiveTimeoutMs);
  const response = await f.post(runBody), reader = response.body.getReader(); let text = '';
  let interactions = [];
  while (interactions.length < 2) {
    const part = await reader.read(); text += new TextDecoder().decode(part.value);
    interactions = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === 'interaction');
  }
  const reply = event => ({ ...identity, interactionId: event.interaction.id, reply: { decision: 'deny' } });
  assert.equal((await f.post(reply(interactions[0]), 'respond')).status, 200);
  await new Promise(resolve => setTimeout(resolve, interactiveTimeoutMs * 2 + 10));
  assert.equal((await f.post(reply(interactions[1]), 'respond')).status, 200);
  assert.match(await rest(reader), /"type":"done"/);
});

test('removing a Skill starts a fresh native thread instead of retaining its instructions', async t => {
  const calls = [];
  const f = await fixture(t, { async run(input) { calls.push(input); return { nativeSessionId: `native-${calls.length}`, body: 'Answer' }; } });
  await (await f.post({ ...runBody, skillIds: ['skill-one'] })).text();
  const history = [{ requestId: 'request', prompt: 'Test', body: 'Answer', evidenceIds: [], context: [] }];
  await (await f.post({ ...runBody, requestId: 'second', history, skillIds: [] })).text();
  assert.equal(calls[1].nativeSessionId, undefined);
});

test('adding an external-tool Skill starts a fresh thread so its native tools are registered', async t => {
  const calls = [];
  const f = await fixture(t, { async run(input) { calls.push(input); return { nativeSessionId: `native-${calls.length}`, body: 'Answer' }; } });
  await (await f.post(runBody)).text();
  const history = [{ requestId: 'request', prompt: 'Test', body: 'Answer', evidenceIds: [], context: [] }];
  await (await f.post({ ...runBody, requestId: 'second', history, skillIds: ['tikhub'] })).text();
  assert.equal(calls[1].nativeSessionId, undefined);
  assert.equal(calls[1].prompt.includes('Answer'), true);
});

test('Codex access and reasoning settings pass the request boundary unchanged while malformed values never run', async t => {
  const inputs = [];
  const f = await fixture(t, { async run(input) { inputs.push(input); return { nativeSessionId: 'native', body: 'Answered' }; } });
  for (const codex of [{ access: 'danger-full-access' }, { access: true }, { effort: '' }, { effort: 'ultra\n' }, { effort: 'x'.repeat(41) }, { effort: 5 }]) {
    assert.equal((await f.post({ ...runBody, codex })).status, 400);
  }
  assert.equal(inputs.length, 0);
  const codex = { model: 'native-model', mode: 'plan', effort: 'ultra', access: 'full-access' };
  const response = await f.post({ ...runBody, codex });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(inputs[0].codex, codex);
});
