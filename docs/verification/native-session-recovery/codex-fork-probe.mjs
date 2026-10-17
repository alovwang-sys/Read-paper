import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexClient } from '../../../server/codex-runtime.mjs';

const root = await mkdtemp(join(tmpdir(), 'papertrail-fork-probe-'));
const state = join(root, 'isolated-state');
const cwd = join(root, 'project');
const clients = [];
const question = 'SYNTHETIC LOCAL FORK PROBE: no user data and no real model call.';
const answer = 'SYNTHETIC LOCAL ANSWER: completed by the loopback mock provider.';
let providerRequests = 0;
let providerError;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, undefined);
    let body = '';
    for await (const chunk of req) { body += chunk; assert.ok(body.length < 2_000_000); }
    assert.ok(body.includes(question));
    providerRequests++;
    assert.equal(providerRequests, 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const item = { id: 'synthetic-answer', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    send({ type: 'response.created', response: { id: 'synthetic-response', object: 'response', status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer });
    send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'synthetic-response', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch (error) {
    providerError = error;
    res.writeHead(500); res.end('Synthetic probe failed.');
  }
});
const make = async (onNotification = () => {}) => {
  const client = createCodexClient({ executable: 'codex', env: { PATH: process.env.PATH, CODEX_HOME: state, NO_PROXY: '127.0.0.1,localhost' }, cwd, onNotification, rpcTimeoutMs: 15000 });
  clients.push(client);
  await client.initialize();
  return client;
};
const inject = (client, threadId, text) => client.rpc('thread/inject_items', {
  threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
});
const assertHistory = (items) => {
  assert.ok(items.data.some(({ item }) => item.type === 'userMessage' && item.content.some(part => part.type === 'text' && part.text === question)), 'The fork must retain the completed synthetic question.');
  assert.ok(items.data.some(({ item }) => item.type === 'agentMessage' && item.text === answer), 'The fork must retain the completed synthetic answer.');
};

try {
  await mkdir(state);
  await mkdir(cwd);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await writeFile(join(state, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "synthetic_probe"\n[analytics]\nenabled = false\n[model_providers.synthetic_probe]\nname = "Local zero-cost probe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const owner = await make(({ method, params }) => { if (method === 'turn/completed') finish(params.turn); });
  const params = { cwd, runtimeWorkspaceRoots: [cwd], model: 'gpt-5.4', modelProvider: 'synthetic_probe', approvalPolicy: 'never', permissions: 'read_paper_materials', ephemeral: false };
  const { thread: source } = await owner.rpc('thread/start', params);
  await owner.rpc('turn/start', { threadId: source.id, input: [{ type: 'text', text: question, text_elements: [] }] });
  let timer;
  try {
    const turn = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic turn did not complete.')), 15000); })]);
    assert.equal(turn.status, 'completed');
  } finally { clearTimeout(timer); }
  if (providerError) throw providerError;
  assert.equal(providerRequests, 1);
  console.log(JSON.stringify({ phase: 'completed-synthetic-turn', localhostProviderRequests: providerRequests, realModelCalls: 0 }));
  const reader = await make();
  await assert.rejects(reader.rpc('thread/resume', { ...params, threadId: source.id, excludeTurns: true }), { code: 'session_busy' });
  console.log(JSON.stringify({ phase: 'resume-blocked-with-active-writer', pass: true }));
  const { thread: fork } = await reader.rpc('thread/fork', { ...params, threadId: source.id, excludeTurns: true, deferGoalContinuation: true });
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.forkedFromId, source.id);
  assert.equal(fork.ephemeral, false);
  const items = await reader.rpc('thread/items/list', { threadId: fork.id, limit: 100 });
  assertHistory(items);
  console.log(JSON.stringify({ phase: 'fork-retains-completed-question-and-answer', pass: true, itemCount: items.data.length }));
  // Both owners remain usable; the fork did not take over the source writer.
  await inject(owner, source.id, 'SOURCE OWNER STILL ACTIVE.');
  await inject(reader, fork.id, 'FORK OWNER ALSO ACTIVE.');
  assert.equal(providerRequests, 1);
  console.log(JSON.stringify({ phase: 'independent-source-and-fork-writers', pass: true, localhostProviderRequests: providerRequests, realModelCalls: 0 }));
  await reader.shutdown();
  const reopened = await make();
  const { thread: stored } = await reopened.rpc('thread/read', { threadId: fork.id, includeTurns: false });
  assert.equal(stored.forkedFromId, source.id);
  assertHistory(await reopened.rpc('thread/items/list', { threadId: fork.id, limit: 100 }));
  assert.equal(providerRequests, 1);
  console.log(JSON.stringify({ phase: 'persisted-fork-history-readable-after-client-restart', pass: true }));
} finally {
  try {
    const closed = await Promise.allSettled(clients.map(client => client.shutdown()));
    assert.ok(closed.every(result => result.status === 'fulfilled'), 'All owned clients must shut down.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ phase: 'own-clients-and-server-closed-temporary-state-removed' }));
  }
}
