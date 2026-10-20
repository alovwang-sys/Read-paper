// Isolated protocol probe: synthetic localhost responses, no user threads or credentials.
// This verifies two clients of one server; it does not connect the independent Codex desktop app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCodexClient } from '../../../server/codex-runtime.mjs';
const root = await mkdtemp(join(tmpdir(), 'papertrail-shared-daemon-'));
const state = join(root, 'state'), cwd = join(root, 'project');
const clients = [];
const phases = [];
const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
const report = phase => { phases.push(phase); console.log(JSON.stringify(phase)); };
const question = 'SYNTHETIC LOCAL SHARED SERVER PROBE; NO USER DATA.';
const answer = 'SYNTHETIC SHARED ANSWER';
let finishProvider, providerRequests = 0, providerError, daemon, endpoint;
const completionGate = new Promise(resolve => { finishProvider = resolve; });
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, undefined);
    let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 2_000_000); }
    assert.ok(body.includes(question)); providerRequests++; assert.equal(providerRequests, 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const item = { id: 'synthetic-answer', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    send({ type: 'response.created', response: { id: 'synthetic-response', object: 'response', status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    await completionGate;
    send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer });
    send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'synthetic-response', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  } catch (error) { providerError = error; if (!res.headersSent) res.writeHead(500); res.end('Synthetic probe error'); }
});
const env = { PATH: process.env.PATH, CODEX_HOME: state, NO_PROXY: '127.0.0.1,localhost' };
const waitFor = async (predicate, description) => { for (let i = 0; i < 300; i++) { if (await predicate()) return; await sleep(25); } throw new Error(`Timed out: ${description}`); };
const make = async (shared = true) => {
  const notifications = [];
  if (!shared) {
    const client = createCodexClient({ env, cwd, onNotification: message => notifications.push(message) });
    clients.push(client); await client.initialize(); return { client, notifications };
  }
  const ws = new WebSocket(endpoint);
  const pending = new Map(); let seq = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : entry.resolve(message.result); }
    else notifications.push(message);
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const client = {
    rpc(method, params) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); },
    async shutdown() { if (ws.readyState === WebSocket.CLOSED) return; await new Promise(resolve => { ws.addEventListener('close', resolve, { once: true }); ws.close(); }); },
  };
  clients.push(client);
  await client.rpc('initialize', { clientInfo: { name: 'papertrail_synthetic_probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { client, notifications };
};

try {
  await mkdir(state); await mkdir(cwd);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(join(state, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "synthetic_probe"\napproval_policy = "never"\n[analytics]\nenabled = false\n[model_providers.synthetic_probe]\nname = "Local zero-cost probe"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); endpoint = `ws://127.0.0.1:${reservation.address().port}`; await new Promise(resolve => reservation.close(resolve));
  daemon = spawn('codex', ['app-server', '--listen', endpoint], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; daemon.stderr.on('data', chunk => { stderr += chunk; });
  await waitFor(async () => { if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${stderr.slice(-500)}`); return fetch(endpoint.replace('ws:', 'http:') + '/readyz').then(r => r.ok, () => false); }, 'websocket listener');
  const owner = await make();
  const { thread } = await owner.client.rpc('thread/start', { cwd, runtimeWorkspaceRoots: [cwd], model: 'gpt-5.4', modelProvider: 'synthetic_probe', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false });
  const { turn } = await owner.client.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: question, text_elements: [] }] });
  await waitFor(() => providerRequests === 1, 'provider started');
  const observer = await make();
  const resumed = await observer.client.rpc('thread/resume', { threadId: thread.id, excludeTurns: true });
  assert.equal(resumed.thread.id, thread.id); assert.equal(resumed.thread.status.type, 'active');
  report({ phase: 'same-daemon-second-client-rejoins-active-thread', pass: true, realModelCalls: 0 });
  const separate = await make(false);
  const read = await separate.client.rpc('thread/read', { threadId: thread.id, includeTurns: false });
  assert.equal(read.thread.id, thread.id);
  report({ phase: 'separate-daemon-can-read-persisted-thread', nativeState: read.thread.status.type });
  await assert.rejects(separate.client.rpc('thread/resume', { threadId: thread.id, excludeTurns: true }), { code: 'session_busy' });
  report({ phase: 'separate-daemon-cannot-acquire-active-writer', pass: true });
  await observer.client.shutdown();
  assert.equal(owner.notifications.filter(n => n.method === 'turn/completed').length, 0);
  const rejoined = await make();
  const again = await rejoined.client.rpc('thread/resume', { threadId: thread.id, excludeTurns: true });
  assert.equal(again.thread.status.type, 'active');
  finishProvider();
  await waitFor(() => [owner, rejoined].every(c => c.notifications.some(n => n.method === 'turn/completed' && n.params.turn.id === turn.id)), 'both completion notifications');
  if (providerError) throw providerError;
  for (const c of [owner, rejoined]) {
    const completion = c.notifications.find(n => n.method === 'turn/completed' && n.params.turn.id === turn.id); assert.equal(completion.params.turn.status, 'completed');
    assert.ok(c.notifications.some(n => n.method === 'item/agentMessage/delta' && n.params.delta === answer));
  }
  assert.equal(providerRequests, 1);
  report({ phase: 'observer-disconnect-and-rejoin-receive-same-turn-deltas-and-completion', pass: true, localhostProviderRequests: providerRequests, realModelCalls: 0 });

} finally {
  finishProvider();
  const closed = await Promise.allSettled(clients.map(client => client.shutdown()));
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise(resolve => daemon.once('exit', resolve));
    if (process.platform === 'win32') daemon.kill('SIGTERM'); else process.kill(-daemon.pid, 'SIGTERM');
    await Promise.race([exited, sleep(2000)]);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      if (process.platform === 'win32') daemon.kill('SIGKILL'); else process.kill(-daemon.pid, 'SIGKILL');
      await exited;
    }
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  assert.ok(closed.every(result => result.status === 'fulfilled'), 'All owned clients must close.');
  assert.ok(!daemon || daemon.exitCode !== null || daemon.signalCode !== null, 'The owned shared server must exit.');
  report({ phase: 'temporary-state-and-owned-processes-cleaned' });
}

await writeFile(new URL('./shared-daemon-probe.json', import.meta.url), JSON.stringify({ version, generatedAt: new Date().toISOString(), simulatedProvider: 'localhost Responses fixture', localhostProviderRequests: providerRequests, realModelCalls: 0, phases }, null, 2) + '\n');
