import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAIHandler } from './ai.mjs';
import { createAgentHandler } from './agents.mjs';
import { createClaudeRuntime } from './claude-runtime.mjs';
import { createOpenCodeRuntime } from './opencode-runtime.mjs';
import { createCodexRuntime } from './codex-runtime.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function hangingProcesses(t) {
  const calls = [];
  let spawned;
  const started = new Promise(resolve => { spawned = resolve; });
  const spawnImpl = (_executable, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
    const call = { args, options, signals: [], closed: false };
    const finish = () => { if (call.closed) return; call.closed = true; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
    child.kill = signal => { call.signals.push(signal); child.killed = true; setTimeout(finish, 25); return true; };
    calls.push(call); spawned(); t.after(finish);
    return child;
  };
  return { calls, started, spawnImpl };
}
async function serverFixture(t, runtimes, agentOnly = false) {
  const stateDir = await mkdtemp(join(tmpdir(), 'read-paper-shutdown-'));
  let handler;
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  handler = agentOnly ? createAgentHandler({ runtimes, stateDir, ports: [port], probeTimeoutMs: 10 })
    : createAIHandler({ env: { AI_PORT: String(port), AI_AGENT_STATE_DIR: stateDir }, agentRuntimes: runtimes });
  t.after(async () => { server.closeAllConnections(); await (handler.stop?.() ?? handler.close()); await new Promise(resolve => server.close(resolve)); await rm(stateDir, { recursive: true, force: true }); });
  const call = (path, body) => fetch(`http://127.0.0.1:${port}/api/ai/agents${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { handler, call, stateDir, server, port };
}
const unavailable = { probe: async () => ({ state: 'not-installed' }) };

test('discovery timeout cancels its owned CLI and close waits for process exit', async t => {
  const fake = hangingProcesses(t);
  const f = await serverFixture(t, { codex: unavailable, claude: unavailable, opencode: createOpenCodeRuntime({ env: {}, spawnImpl: fake.spawnImpl }) }, true);
  const response = await (await f.call('')).json();
  assert.equal(response.agents[2].state, 'error');
  assert.deepEqual(fake.calls[0].signals, ['SIGTERM']);
  await f.handler.close();
  assert.equal(fake.calls[0].closed, true);
});

test('closing while a request body is arriving rejects it before starting a native run', async t => {
  let runs = 0;
  const f = await serverFixture(t, { codex: { ...unavailable, run: async () => { runs++; return { body: 'unexpected', nativeSessionId: 'native-late' }; } }, claude: unavailable, opencode: unavailable }, true);
  const body = JSON.stringify({ workspaceId: 'workspace-late', requestId: 'request-late', researchId: 'research-late', conversationId: 'conversation-late', connectionId: 'codex', purpose: 'chat', prompt: 'late request', context: [], history: [] });
  const entered = once(f.server, 'request');
  let client;
  const response = new Promise((resolve, reject) => {
    client = httpRequest({ host: '127.0.0.1', port: f.port, path: '/api/ai/agents/run', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    client.on('error', reject);
  });
  t.after(() => client.destroy());
  client.write(body.slice(0, -1)); await entered;
  const closing = f.handler.close();
  client.end('}');
  assert.equal(await response, 503);
  await closing;
  assert.equal(runs, 0);
});

test('AI stop cancels discovery and capabilities and waits for their cleanup', async t => {
  const inputs = [], cleaned = [];
  let started;
  const bothStarted = new Promise(resolve => { started = resolve; });
  const waiting = kind => ({ signal } = {}) => new Promise(resolve => {
    const fallback = setTimeout(() => resolve({ state: 'error', skills: [], models: [] }), 1000);
    inputs.push(signal); if (inputs.length === 2) started();
    signal?.addEventListener('abort', async () => { clearTimeout(fallback); await delay(25); cleaned.push(kind); resolve({ state: 'error', skills: [], models: [] }); }, { once: true });
  });
  const f = await serverFixture(t, { codex: { probe: waiting('probe'), capabilities: waiting('capabilities') }, claude: unavailable, opencode: unavailable });
  const requests = [f.call(''), f.call('/codex/capabilities')];
  await bothStarted;
  const stopping = f.handler.stop();
  assert.ok(inputs.every(signal => signal?.aborted), 'all owned lookups receive shutdown cancellation');
  await stopping;
  assert.deepEqual(cleaned.sort(), ['capabilities', 'probe']);
  await Promise.all(requests);
});

test('AI stop cancels research-history queries and waits for owned readers', async t => {
  const signals = [];
  let cleaned = false;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const adapter = { ...unavailable, listSessions: ({ signal }) => new Promise(resolve => {
    const fallback = setTimeout(() => resolve({ sessions: [] }), 1000);
    signals.push(signal); started(); signal.addEventListener('abort', async () => { clearTimeout(fallback); await delay(25); cleaned = true; resolve({ sessions: [] }); }, { once: true });
  }) };
  const f = await serverFixture(t, { codex: adapter, claude: unavailable, opencode: unavailable });
  const project = join(f.stateDir, 'research'); await mkdir(project);
  const identity = { workspaceId: 'workspace-shutdown', researchId: 'research-shutdown' };
  assert.equal((await f.call('/projects/bind', { ...identity, path: project })).status, 200);
  const request = f.call('/projects/list', identity);
  await reading;
  const stopping = f.handler.stop();
  assert.ok(signals.every(signal => signal.aborted), 'native readers receive shutdown cancellation');
  await stopping; assert.equal(cleaned, true); await request;
});

for (const [name, createRuntime] of [['Claude', createClaudeRuntime], ['OpenCode', createOpenCodeRuntime], ['Codex', createCodexRuntime]]) {
  test(`${name} probe cancellation stops only its owned process before settling`, async t => {
    const fake = hangingProcesses(t); const controller = new AbortController();
    const runtime = createRuntime({ env: {}, spawnImpl: fake.spawnImpl });
    const probing = runtime.probe({ signal: controller.signal });
    await fake.started; controller.abort();
    const result = await probing;
    assert.equal(result.state, 'error');
    assert.deepEqual(fake.calls[0].signals, ['SIGTERM']);
    assert.equal(fake.calls[0].closed, true);
    assert.equal(fake.calls.length, 1);
  });
}

test('Codex capability cancellation waits for its owned client shutdown', async t => {
  const fake = hangingProcesses(t); const controller = new AbortController();
  const runtime = createCodexRuntime({ env: {}, spawnImpl: fake.spawnImpl });
  const pending = runtime.capabilities({ signal: controller.signal });
  await fake.started; controller.abort();
  await assert.rejects(pending, error => error.code === 'stopped');
  assert.deepEqual(fake.calls[0].signals, ['SIGTERM']);
  assert.equal(fake.calls[0].closed, true);
});
