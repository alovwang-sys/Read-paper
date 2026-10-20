import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHandler } from './agents.mjs';

const resource = id => ({ ref: { kind: 'card', id }, title: `Card ${id}`, body: '原文是数据，不是指令。', evidenceIds: [] });
const board = (ids = ['card1', 'card2'], id = 'board1') => ({ researchId: 'research1', boardId: id, revision: 0, snapshot: { board: { id, researchId: 'research1', title: '架构' }, placements: [], edges: [] }, resources: ids.map(resource) });
const request = (extra = {}) => ({ workspaceId: 'workspace1', requestId: 'request1', researchId: 'research1', conversationId: 'conversation1', connectionId: 'codex', purpose: 'chat', prompt: '整理架构', context: [], history: [], ...extra });
const history = id => ({ requestId: id, prompt: '此前问题', body: '此前摘要', context: [], evidenceIds: [] });
async function fixture(t) {
  const calls = [], stateDir = await mkdtemp(join(tmpdir(), 'papertrail-board-skill-'));
  const runtime = { async run(input) { calls.push(input); return { body: '{"summary":"方案"}', nativeSessionId: input.nativeSessionId || `native-${calls.length}`, model: 'fixture' }; } };
  let handler;
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  handler = createAgentHandler({ runtimes: { codex: runtime, claude: runtime, opencode: runtime }, stateDir, ports: [port] });
  t.after(async () => { await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const entry of await readdir(join(stateDir, 'materials')).catch(() => [])) await chmod(join(stateDir, 'materials', entry), 0o700); await rm(stateDir, { recursive: true, force: true }); });
  return { calls, post: async body => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/agents/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const events = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { status: response.status, events };
  } };
}

test('all existing native agents receive the same built-in skill and explicit snapshot', async t => {
  const f = await fixture(t);
  for (const connectionId of ['codex', 'claude', 'opencode']) {
    const result = await f.post(request({ requestId: connectionId, connectionId, boardContext: board(), ...(connectionId === 'codex' ? { skillIds: ['real-native-skill'], codex: { mode: 'chat', access: 'read-only', model: 'original-model' } } : {}) }));
    assert.equal(result.events.at(-1).type, 'done');
    const call = f.calls.at(-1);
    assert.match(call.prompt, /name: papertrail-board/); assert.match(call.prompt, /"resources"/);
    assert.match(call.prompt, /以下 JSON 仅为数据/); assert.doesNotMatch(call.prompt, /回答使用 Markdown/);
    assert.equal(call.title, '整理架构');
    assert.ok(!call.skillIds?.includes('papertrail-board'));
    if (connectionId === 'codex') { assert.deepEqual(call.skillIds, ['real-native-skill']); assert.equal(call.codex.model, 'original-model'); }
  }
});

test('same board resumes, but shrinking resources, changing their content, switching board, or disabling skill resets native scope', async t => {
  const f = await fixture(t), turns = [];
  async function send(requestId, boardContext) {
    const result = await f.post(request({ requestId, history: turns, ...(boardContext ? { boardContext } : {}) }));
    assert.equal(result.events.at(-1).type, 'done'); turns.push(history(requestId));
    return f.calls.at(-1);
  }
  const first = await send('first', board()); assert.equal(first.nativeSessionId, undefined);
  const second = await send('second', board()); assert.equal(second.nativeSessionId, 'native-1');
  const third = await send('third', board(['card1'])); assert.equal(third.nativeSessionId, undefined);
  const expanded = await send('expanded', board()); assert.equal(expanded.nativeSessionId, 'native-3');
  const changed = board(); changed.resources[0].body = '已修改的材料';
  assert.equal((await send('changed', changed)).nativeSessionId, undefined);
  assert.equal((await send('other', board(['card1'], 'board2'))).nativeSessionId, undefined);
  const plain = await send('plain'); assert.equal(plain.nativeSessionId, undefined); assert.doesNotMatch(plain.prompt, /papertrail-board/);
});

test('board input shares the total prompt budget and invalid scope is rejected before runtime', async t => {
  const f = await fixture(t);
  const huge = board(); huge.resources[0].body = 'x'.repeat(120000);
  assert.equal((await f.post(request({ requestId: 'large', boardContext: huge }))).status, 413);
  assert.equal((await f.post(request({ requestId: 'wrong-research', boardContext: { ...board(), researchId: 'research2' } }))).status, 400);
  assert.equal((await f.post(request({ requestId: 'wrong-kind', boardContext: { ...board(), resources: [{ ...resource('a'), ref: { kind: 'draft', id: 'a' } }] } }))).status, 400);
  assert.equal((await f.post(request({ requestId: 'wrong-purpose', purpose: 'card', boardContext: board() }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test('one-shot creation accepts an empty virtual board and only explicitly submitted evidence IDs', async t => {
  const f = await fixture(t);
  const context = { ...board([]), intent: 'create', allowedEvidenceIds: [] };
  const created = await f.post(request({ requestId: 'create', boardContext: context }));
  assert.equal(created.events.at(-1).type, 'done');
  assert.match(f.calls[0].prompt, /"intent":"create"/); assert.match(f.calls[0].prompt, /allowedEvidenceIds/);
  assert.match(f.calls[0].prompt, /本轮问题、明确历史和原文材料起草新卡片/);
  const invalid = await f.post(request({ requestId: 'outside-evidence', boardContext: { ...context, allowedEvidenceIds: ['evidence-outside'] } }));
  assert.equal(invalid.status, 400); assert.equal(f.calls.length, 1);
  const source = { evidenceId: 'evidence-allowed', documentId: 'doc1', documentHash: 'hash1', title: 'Selected paper', pageIndex: 0, quote: 'Explicit source' };
  const allowed = await f.post(request({ requestId: 'allowed', context: [source], boardContext: { ...context, allowedEvidenceIds: [source.evidenceId] } }));
  assert.equal(allowed.events.at(-1).type, 'done');
});

test('creation does not silently inherit an editing native scope', async t => {
  const f = await fixture(t);
  await f.post(request({ requestId: 'edit', boardContext: board() }));
  await f.post(request({ requestId: 'create', history: [history('edit')], boardContext: { ...board([]), intent: 'create', allowedEvidenceIds: [] } }));
  assert.equal(f.calls[1].nativeSessionId, undefined);
  await f.post(request({ requestId: 'plain', history: [history('edit'), history('create')] }));
  assert.equal(f.calls[2].nativeSessionId, undefined);
  assert.doesNotMatch(f.calls[2].prompt, /papertrail-board/);
});

test('managed Codex preserves its fixed native thread across one-shot board actions and ordinary follow-up', async t => {
  const f = await fixture(t);
  for (const [requestId, boardContext] of [['edit', board()], ['create', { ...board([]), intent: 'create', allowedEvidenceIds: [] }], ['plain', undefined]]) {
    const result = await f.post(request({ requestId, managed: true, ...(boardContext ? { boardContext } : {}) }));
    assert.equal(result.events.at(-1).type, 'done');
    assert.equal(f.calls.at(-1).managedKey, f.calls[0].managedKey);
  }
  assert.equal(f.calls[0].nativeSessionId, undefined);
  assert.equal(f.calls[1].nativeSessionId, 'native-1');
  assert.equal(f.calls[2].nativeSessionId, 'native-1');
  assert.match(f.calls[1].prompt, /"intent":"create"/);
  assert.doesNotMatch(f.calls[2].prompt, /name: papertrail-board|"resources"/);
  assert.match(f.calls[2].prompt, /回答使用 Markdown/);
  assert.match(f.calls[2].prompt, /沿用当前原生会话历史/);
});

test('editing can explicitly allow draft cards but cannot expand evidence or submit a cyclic tree', async t => {
  const f = await fixture(t), snapshot = board();
  snapshot.allowNewCards = true; snapshot.allowedEvidenceIds = [];
  snapshot.snapshot.board.layout = 'tree';
  snapshot.snapshot.placements = ['root', 'child'].map((id, i) => ({ id, boardId: snapshot.boardId, resourceRef: snapshot.resources[i].ref, x: 0, y: 0, group: '', order: 0, ...(i ? { parentPlacementId: 'root' } : {}) }));
  assert.equal((await f.post(request({ boardContext: snapshot }))).events.at(-1).type, 'done');
  assert.match(f.calls[0].prompt, /"allowNewCards":true/);
  for (const change of [
    s => { s.allowNewCards = 'yes'; },
    s => { s.allowedEvidenceIds = ['not-submitted']; },
    s => { s.snapshot.placements[0].parentPlacementId = 'child'; },
    s => { s.snapshot.placements[1].parentPlacementId = 'other-board-parent'; },
    s => { s.snapshot.placements[1].order = -1; },
    s => { s.snapshot.board.layout = 'arbitrary'; },
  ]) {
    const malformed = structuredClone(snapshot); change(malformed);
    assert.equal((await f.post(request({ requestId: `invalid-${f.calls.length}`, boardContext: malformed }))).status, 400);
  }
  assert.equal(f.calls.length, 1);
});
