import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHandler } from './agents.mjs';
import { createCodexRuntime } from './codex-runtime.mjs';

const evidence = (id = 'e1') => ({ evidenceId: id, documentId: 'doc1', documentHash: 'hash1', title: 'Selected paper', pageIndex: 0, quote: `Selected quote ${id}` });
const request = (overrides = {}) => ({ workspaceId: 'workspace1', requestId: 'request1', researchId: 'research1', conversationId: 'conversation1', connectionId: 'codex', purpose: 'chat', prompt: 'Explain the selected source', context: [evidence()], history: [], ...overrides });
const history = (id = 'request1', context = [evidence()]) => ({ requestId: id, prompt: 'Previous question', body: 'Original answer [7]', sentBody: 'Renumbered answer [1]', evidenceIds: context.map((item) => item.evidenceId), context });
async function fixture(t, runtime, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'read-paper-agent-test-'));
  let handler;
  const server = createServer((req, res) => { handler(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const setup = () => createAgentHandler({ runtimes: { codex: runtime, claude: { probe: async () => ({ state: 'needs-auth' }) }, opencode: { probe: async () => ({ state: 'not-installed' }) } }, stateDir, ports: [port, 5173], ...options });
  handler = setup();
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); for (const entry of await readdir(join(stateDir, 'materials')).catch(() => [])) await chmod(join(stateDir, 'materials', entry), 0o700); await rm(stateDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  return { stateDir, url, restart() { handler.close(); handler = setup(); }, post: (body, path = '/api/ai/agents/run', init = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...init }) };
}
async function events(response) { return (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
const simpleRuntime = (calls = []) => ({ probe: async () => ({ state: 'ready', version: 'test' }), async run(input) { calls.push(input); const nativeSessionId = input.nativeSessionId || `native-${calls.length}`; input.onEvent({ type: 'session', nativeSessionId }); input.onEvent({ type: 'progress', kind: 'tool', text: 'Reading materials' }); input.onEvent({ type: 'delta', text: 'Answer [1]' }); return { body: 'Answer [1]', nativeSessionId, model: 'test-model' }; } });

test('agent discovery is bounded, local-only, and accurately reports capabilities', async (t) => {
  const f = await fixture(t, simpleRuntime());
  const data = await (await fetch(`${f.url}/api/ai/agents`)).json();
  assert.deepEqual(data.agents.map((item) => item.state), ['ready', 'needs-auth', 'not-installed']);
  assert.equal(data.agents[0].capabilities.permissions, 'read-only');
  assert.equal(data.agents[1].capabilities.tools, false);
  const forbidden = await fetch(`${f.url}/api/ai/agents`, { headers: { Origin: 'https://evil.test' } }); assert.equal(forbidden.status, 403);
  const timed = await fixture(t, { probe: () => new Promise(() => {}) }, { probeTimeoutMs: 10 });
  assert.equal((await (await fetch(`${timed.url}/api/ai/agents`)).json()).agents[0].state, 'error');
});

test('streams only answer deltas, saves explicit snapshots, and resumes across service restart', async (t) => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  const result = await events(await f.post(request()));
  assert.equal(result.at(-1).type, 'done'); assert.equal(result.at(-1).model, 'test-model');
  assert.ok(result.every((event) => event.researchId === 'research1' && event.requestId === 'request1' && event.workspaceId === 'workspace1'));
  assert.equal(result.filter((event) => event.type === 'delta').map((event) => event.text).join(''), 'Answer [1]');
  const files = await readdir(calls[0].cwd); assert.deepEqual(files.sort(), ['manifest.json', 'materials.md']);
  const manifest = JSON.parse(await readFile(join(calls[0].cwd, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.context, [evidence()]); assert.equal((await stat(join(calls[0].cwd, 'materials.md'))).mode & 0o222, 0);
  f.restart();
  await events(await f.post(request({ requestId: 'request2', history: [history()] })));
  assert.equal(calls[1].nativeSessionId, 'native-1'); assert.equal(calls[1].cwd, calls[0].cwd);
  assert.match(calls[1].prompt, /Renumbered answer \[1\]/); assert.doesNotMatch(calls[1].prompt, /Original answer/);
  assert.equal((await readdir(join(f.stateDir, 'snapshots'))).length, 2);
});

test('workspace, research and connection isolate sessions; narrowing history starts a new native session', async (t) => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  await events(await f.post(request()));
  await events(await f.post(request({ requestId: 'request2', history: [history()] })));
  const narrowed = await events(await f.post(request({ requestId: 'request3', history: [history('request2')] })));
  assert.equal(calls[2].nativeSessionId, undefined); assert.ok(narrowed.some((event) => event.kind === 'status' && /缩小/.test(event.text)));
  await events(await f.post(request({ requestId: 'request4', workspaceId: 'other-workspace', history: [history()] })));
  await events(await f.post(request({ requestId: 'request5', researchId: 'other-research', history: [history()] })));
  assert.equal(calls[3].nativeSessionId, undefined); assert.equal(calls[4].nativeSessionId, undefined);
});

test('changed evidence fingerprints and explicit reset cannot reuse a native context', async (t) => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  await events(await f.post(request()));
  const changed = { ...evidence(), documentHash: 'new-version', quote: 'Changed text' };
  await events(await f.post(request({ requestId: 'request2', context: [changed], history: [history('request1', [changed])] })));
  assert.equal(calls[1].nativeSessionId, undefined);
  await events(await f.post(request({ requestId: 'request3', reset: true, history: [history('request1', [changed]), history('request2', [changed])], context: [changed] })));
  assert.equal(calls[2].nativeSessionId, undefined);
});

test('card/revision requests use separate native sessions and preserve the chat session', async (t) => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  await events(await f.post(request()));
  await events(await f.post(request({ requestId: 'card1', purpose: 'card' })));
  await events(await f.post(request({ requestId: 'revision1', purpose: 'revision' })));
  await events(await f.post(request({ requestId: 'chat2', history: [history()] })));
  assert.equal(calls[1].nativeSessionId, undefined); assert.equal(calls[2].nativeSessionId, undefined); assert.equal(calls[3].nativeSessionId, 'native-1');
  assert.match(calls[1].prompt, /只输出 JSON 对象/);
});

test('stop is request-scoped, duplicate requests cannot unlock a busy session, and new work proceeds after cancellation', async (t) => {
  const calls = []; let aborted = false;
  const runtime = { probe: async () => ({ state: 'ready' }), run(input) { calls.push(input); input.onEvent({ type: 'session', nativeSessionId: 'native-stop' }); input.onEvent({ type: 'progress', kind: 'status', text: 'Working' }); return new Promise((_, reject) => { input.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }); }); } };
  const f = await fixture(t, runtime);
  const first = await f.post(request());
  assert.equal((await f.post(request())).status, 409);
  assert.equal((await f.post(request({ requestId: 'request2' }))).status, 409);
  const identity = Object.fromEntries(['workspaceId', 'requestId', 'researchId', 'conversationId', 'connectionId'].map((key) => [key, request()[key]]));
  const wrong = await (await f.post({ ...identity, researchId: 'other' }, '/api/ai/agents/stop')).json(); assert.equal(wrong.stopped, false); assert.equal(aborted, false);
  assert.equal((await (await f.post(identity, '/api/ai/agents/stop')).json()).stopped, true);
  assert.equal((await events(first)).at(-1).code, 'stopped'); assert.equal(aborted, true);
  assert.equal((await f.post(request())).status, 409);
});

test('timeout and browser disconnection cancel the underlying runtime', async (t) => {
  let stops = 0;
  const runtime = { probe: async () => ({ state: 'ready' }), run({ signal, onEvent }) { onEvent({ type: 'progress', kind: 'status', text: 'Working' }); return new Promise((_, reject) => signal.addEventListener('abort', () => { stops++; reject(new Error('stopped')); }, { once: true })); } };
  const timed = await fixture(t, runtime, { timeoutMs: 20 });
  assert.equal((await events(await timed.post(request()))).at(-1).code, 'timeout'); assert.equal(stops, 1);
  const f = await fixture(t, runtime); const controller = new AbortController(); const response = await f.post(request(), undefined, { signal: controller.signal });
  const reader = response.body.getReader(); await reader.read(); controller.abort(); await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(stops, 2);
});

test('rejects untrusted native IDs, images, bad content types and excessive context before runtime', async (t) => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  assert.equal((await f.post(request({ nativeSessionId: 'attacker-chosen' }))).status, 400);
  assert.equal((await f.post(request({ context: [{ ...evidence(), kind: 'region' }] }))).status, 400);
  assert.equal((await f.post(request({ prompt: 'x'.repeat(120001) }))).status, 413);
  assert.equal((await f.post(request(), undefined, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.post(request({ workspaceId: undefined }))).status, 400); assert.equal(calls.length, 0);
});

test('session lock remains held until a cancelled native runtime actually exits', async (t) => {
  let started = 0;
  let release;
  const runtime = { probe: async () => ({ state: 'ready' }), async run(input) {
    started++;
    if (started > 1) return { body: 'Next answer', nativeSessionId: 'native-next' };
    input.onEvent({ type: 'progress', kind: 'status', text: 'Working' });
    await new Promise((resolve) => { release = resolve; });
    throw Object.assign(new Error('Stopped'), { code: 'stopped' });
  } };
  const f = await fixture(t, runtime); const first = await f.post(request());
  const identity = Object.fromEntries(['workspaceId', 'requestId', 'researchId', 'conversationId', 'connectionId'].map((key) => [key, request()[key]]));
  await f.post(identity, '/api/ai/agents/stop');
  assert.equal((await events(first)).at(-1).code, 'stopped');
  assert.equal((await f.post(request({ requestId: 'blocked' }))).status, 409);
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await events(await f.post(request({ requestId: 'next' })))).at(-1).type, 'done');
});

test('damaged session mappings fail visibly and native failures do not expose raw details', async (t) => {
  const f = await fixture(t, simpleRuntime()); await events(await f.post(request()));
  const mapping = (await readdir(f.stateDir)).find((name) => name.endsWith('.json'));
  await writeFile(join(f.stateDir, mapping), '{broken'); f.restart();
  const failed = await f.post(request({ requestId: 'next', history: [history()] }));
  assert.equal(failed.status, 500); assert.match((await events(failed)).at(-1).error, /映射/);
  const secret = await fixture(t, { probe: async () => ({ state: 'ready' }), run: async () => { throw Object.assign(new Error('secret-api-token'), { code: 'EACCES' }); } });
  assert.doesNotMatch(JSON.stringify(await events(await secret.post(request()))), /secret-api-token/);
});

function fakeCodex({ unsafe = false, interactive = false, hang = false } = {}) {
  const captured = []; const children = []; let native = 0;
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); return true; };
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString()); captured.push(message);
      if (!message.method) { callback(); return; }
      let result;
      if (message.method === 'initialize') result = { userAgent: 'codex/0.test' };
      if (message.method === 'account/read') result = { requiresOpenaiAuth: true, account: { type: 'apiKey' } };
      if (message.method === 'config/read') result = { config: { mcp_servers: { secret_tools: {} }, plugins: { extra: {} } } };
      if (message.method === 'skills/list') result = { data: [{ skills: [{ path: '/user/skills/private' }] }] };
      if (message.method === 'command/exec') result = { exitCode: message.params.command[0].includes('touch') || (!unsafe && message.params.command[1].endsWith('outside.txt')) ? 1 : 0, stdout: '', stderr: '' };
      if (message.method === 'thread/start') result = { thread: { id: `native-${++native}` }, model: 'codex-test' };
      if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId }, model: 'codex-test' };
      if (message.method === 'turn/start') {
        result = { turn: { id: 'turn1' } };
        setImmediate(() => {
          if (interactive) { send({ id: 'input-request', method: 'item/tool/requestUserInput', params: { questions: [] } }); return; }
          send({ method: 'item/started', params: { threadId: 'native-1', item: { type: 'commandExecution', command: 'cat materials.md' } } });
          send({ method: 'item/commandExecution/outputDelta', params: { threadId: 'native-1', delta: 'TOOL OUTPUT MUST NOT BECOME ANSWER' } });
          send({ method: 'item/agentMessage/delta', params: { threadId: 'native-1', turnId: 'turn1', delta: '中文回答' } });
          if (!hang) send({ method: 'turn/completed', params: { threadId: 'native-1', turn: { id: 'turn1', status: 'completed' } } });
        });
      }
      if (message.id !== undefined && result) send({ id: message.id, result }); callback();
    } });
    captured.push({ executable, args, options }); children.push(child); return child;
  };
  return { captured, children, runtime: createCodexRuntime({ spawnImpl, rpcTimeoutMs: 100 }) };
}

test('Codex uses native RPC streaming/resume and a verified readonly profile, without mixing tool output', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-codex-test-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const fake = fakeCodex(); const notifications = [];
  const result = await fake.runtime.run({ cwd, prompt: 'Question', onEvent: (event) => notifications.push(event) });
  assert.equal(result.body, '中文回答'); assert.equal(result.nativeSessionId, 'native-1');
  assert.ok(notifications.some((event) => event.kind === 'tool')); assert.ok(notifications.some((event) => event.type === 'session'));
  await fake.runtime.run({ cwd, prompt: 'Follow up', nativeSessionId: result.nativeSessionId });
  assert.ok(fake.captured.some((entry) => entry.method === 'thread/resume' && entry.params.threadId === 'native-1'));
  const start = fake.captured.find((entry) => entry.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never'); assert.equal(start.params.permissions, 'read_paper_materials');
  assert.equal(start.params.config['mcp_servers.secret_tools.enabled'], false); assert.equal(start.params.config['plugins.extra.enabled'], false);
  assert.deepEqual(start.params.config['skills.config'], [{ path: '/user/skills/private', enabled: false }]);
  assert.ok(fake.captured.filter((entry) => entry.executable).every((entry) => entry.options.shell === false && !entry.args.some((arg) => arg.includes('bypass'))));
  assert.ok(fake.children.every((child) => child.killed));
});

test('Codex rejects unsupported sandbox and structured input, and abort kills only its owned child', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-codex-test-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const unsafe = fakeCodex({ unsafe: true });
  await assert.rejects(unsafe.runtime.run({ cwd, prompt: 'Question' }), /不能隔离/); assert.ok(!unsafe.captured.some((entry) => entry.method === 'thread/start'));
  const interactive = fakeCodex({ interactive: true }); const notifications = [];
  await assert.rejects(interactive.runtime.run({ cwd, prompt: 'Question', onEvent: (event) => notifications.push(event) }), /结构化输入/);
  assert.ok(notifications.some((event) => event.kind === 'permission'));
  const hanging = fakeCodex({ hang: true }); const controller = new AbortController();
  const run = hanging.runtime.run({ cwd, prompt: 'Question', signal: controller.signal, onEvent(event) { if (event.type === 'delta') controller.abort(); } });
  await assert.rejects(run, /停止/); assert.ok(hanging.children.every((child) => child.killed));
});
