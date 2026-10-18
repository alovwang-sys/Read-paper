import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHandler } from './agents.mjs';
import { createCodexRuntime } from './codex-runtime.mjs';
import { createHash } from 'node:crypto';
import { IMAGE_LIMITS, MAX_IMAGE_BODY_BYTES } from './images.mjs';

const evidence = (id = 'e1') => ({ evidenceId: id, documentId: 'doc1', documentHash: 'hash1', title: 'Selected paper', pageIndex: 0, quote: `Selected quote ${id}` });
const request = (overrides = {}) => ({ workspaceId: 'workspace1', requestId: 'request1', researchId: 'research1', conversationId: 'conversation1', connectionId: 'codex', purpose: 'chat', prompt: 'Explain the selected source', context: [evidence()], history: [], ...overrides });
const history = (id = 'request1', context = [evidence()]) => ({ requestId: id, prompt: 'Previous question', body: 'Original answer [7]', sentBody: 'Renumbered answer [1]', evidenceIds: context.map((item) => item.evidenceId), context });
const png = size => { const bytes = Buffer.alloc(size ?? 8); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); return bytes; };
const region = (id = 'image-evidence', bytes = png()) => ({ ...evidence(id), quote: '', kind: 'region', region: { assetId: `asset-${id}`, hash: createHash('sha256').update(bytes).digest('hex'), rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 }, rotation: 0, width: 100, height: 80 } });
const image = (source = region(), bytes = png()) => ({ evidenceId: source.evidenceId, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
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
  assert.deepEqual(data.agents.map((item) => item.installation.url), ['https://learn.chatgpt.com/docs/cli', 'https://code.claude.com/docs/en/quickstart', 'https://opencode.ai/v2/docs/']);
  assert.ok(data.agents.every((item) => typeof item.installation.label === 'string' && item.installation.label.length > 0));
  const forbidden = await fetch(`${f.url}/api/ai/agents`, { headers: { Origin: 'https://evil.test' } }); assert.equal(forbidden.status, 403);
  const timed = await fixture(t, { probe: () => new Promise(() => {}) }, { probeTimeoutMs: 10 });
  const failed = (await (await fetch(`${timed.url}/api/ai/agents`)).json()).agents[0];
  assert.equal(failed.state, 'error'); assert.equal(failed.installation.url, 'https://learn.chatgpt.com/docs/cli');
  const forged = await fixture(t, { probe: async () => ({ state: 'ready', installation: { url: 'https://evil.example/install', label: 'untrusted' } }) });
  assert.equal((await (await fetch(`${forged.url}/api/ai/agents`)).json()).agents[0].installation.url, 'https://learn.chatgpt.com/docs/cli');
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
  assert.equal(calls[1].nativeSessionId, 'native-1'); assert.equal(calls[1].nativeModel, 'test-model'); assert.equal(calls[1].cwd, calls[0].cwd);
  assert.match(calls[1].prompt, /Renumbered answer \[1\]/); assert.doesNotMatch(calls[1].prompt, /Original answer/);
  assert.equal((await readdir(join(f.stateDir, 'snapshots'))).length, 2);
});

test('native model is saved with the session before an interrupted answer and survives service restart', async (t) => {
  const calls = [];
  const runtime = { async run(input) {
    calls.push(input);
    input.onEvent({ type: 'session', nativeSessionId: 'native-model', model: 'local/original#high' });
    if (calls.length === 1) throw new Error('interrupted');
    return { body: 'Answer', nativeSessionId: 'native-model', model: input.nativeModel };
  } };
  const f = await fixture(t, runtime);
  assert.equal((await events(await f.post(request()))).at(-1).type, 'error');
  f.restart();
  await events(await f.post(request({ requestId: 'request2', history: [history()] })));
  assert.equal(calls[1].nativeSessionId, 'native-model');
  assert.equal(calls[1].nativeModel, 'local/original#high');
  await events(await f.post(request({ requestId: 'request3', reset: true })));
  assert.equal(calls[2].nativeModel, undefined);
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

test('image card model is retained without inheriting skills, planning or write access', async (t) => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  const source = region();
  await events(await f.post(request({ purpose: 'card', context: [source], images: [image(source)], codex: { model: 'vision' } })));
  assert.deepEqual(calls[0].codex, { model: 'vision' });
  assert.equal(calls[0].skillIds, undefined);
  assert.equal(calls[0].onInteraction, undefined);
  for (const [index, values] of [{ codex: { model: 'vision', access: 'full-access' } }, { codex: { mode: 'plan' } }, { codex: { effort: 'high' } }, { skillIds: [] }].entries()) {
    const response = await f.post(request({ purpose: 'revision', requestId: `blocked-${index}`, ...values }));
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 1);
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

test('Codex materializes exactly the submitted region images without base64 archives or history expansion', async t => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  const bytes = png(1_100_000), selected = region('selected', bytes), old = region('old');
  const result = await events(await f.post(request({ context: [selected], images: [image(selected, bytes)], history: [{ ...history('old-request', [old]), evidenceIds: [] }] })));
  assert.equal(result.at(-1).type, 'done');
  assert.equal(calls[0].imagePaths.length, 1);
  assert.equal(calls[0].imagePaths[0].evidenceId, selected.evidenceId);
  const file = calls[0].imagePaths[0].path;
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mode & 0o777, 0o400);
  assert.equal((await stat(calls[0].cwd)).mode & 0o777, 0o500);
  const manifestText = await readFile(join(calls[0].cwd, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifestText, /data:image|dataUrl/);
  assert.deepEqual(JSON.parse(manifestText).images, [{ evidenceId: selected.evidenceId, fileName: 'region-1.png' }]);
  const [archive] = await readdir(join(f.stateDir, 'snapshots'));
  assert.deepEqual(await readFile(join(f.stateDir, 'snapshots', archive, 'region-1.png')), bytes);
  assert.doesNotMatch(await readFile(join(f.stateDir, 'snapshots', archive, 'manifest.json'), 'utf8'), /data:image|dataUrl/);
  assert.match(calls[0].prompt, /image-evidence|对应图片已随本轮消息发送/);
  const second = await events(await f.post(request({ requestId: 'request2', context: [], history: [] })));
  assert.equal(second.at(-1).type, 'done');
  assert.equal(calls[1].imagePaths, undefined);
  assert.ok(!(await readdir(calls[1].cwd)).some(name => name.startsWith('region-')));
  assert.deepEqual(await readFile(file), bytes);
});

test('native image validation rejects missing, extra, duplicate, altered, external and excessive image data before runtime', async t => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls)); const source = region(); const valid = image(source);
  const cases = [
    { context: [source] },
    { context: [], images: [valid] },
    { context: [source], images: [{ ...valid, path: '/private/file.png' }] },
    { context: [source], images: [{ ...valid, dataUrl: 'https://example.com/image.png' }] },
    { context: [source], images: [{ ...valid, dataUrl: 'data:image/png;base64,YQ==' }] },
    { context: [source], images: [image(source, png(9))] },
    { context: [source, region('second')], images: [valid, valid] },
    { context: [source], images: [valid], connectionId: 'claude' },
    { context: [source], images: [valid], connectionId: 'opencode' },
  ];
  for (const value of cases) assert.equal((await f.post(request(value))).status, 400);
  const many = Array.from({ length: 5 }, (_, i) => region(`e${i}`));
  assert.equal((await f.post(request({ context: many, images: many.map(value => image(value)) }))).status, 413);
  const excessive = png(IMAGE_LIMITS.maxImageBytes + 1);
  assert.equal((await f.post(request({ context: [region('large', excessive)], images: [image(region('large', excessive), excessive)] }))).status, 413);
  assert.equal(calls.length, 0);
  assert.ok(1_000_000 + MAX_IMAGE_BODY_BYTES < 46_000_000);
});

test('at most two run bodies are read concurrently before allocating image payloads', async t => {
  const calls = []; const f = await fixture(t, simpleRuntime(calls));
  const unfinished = [0, 1].map(() => {
    const pending = httpRequest(`${f.url}/api/ai/agents/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    pending.on('error', () => {}); pending.write('{'); return pending;
  });
  t.after(() => unfinished.forEach(pending => pending.destroy()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.post(request())).status, 429);
  assert.equal(calls.length, 0);
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

function fakeCodex({ unsafe = false, interactive = false, hang = false, toolOutput = 'TOOL OUTPUT MUST NOT BECOME ANSWER', toolExitCode = 0, mismatchedEvents = false, lateOnKill = false, env } = {}) {
  const captured = []; const children = []; const sent = []; let native = 0;
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
    child.kill = () => {
      child.killed = true; child.exitCode = 0; child.emit('exit', 0);
      if (lateOnKill) {
        send({ method: 'item/started', params: { threadId: 'native-1', turnId: 'turn1', item: { type: 'commandExecution', id: 'late-tool', command: 'LATE COMMAND AFTER ABORT', status: 'inProgress' } } });
        send({ method: 'item/completed', params: { threadId: 'native-1', turnId: 'turn1', item: { type: 'commandExecution', id: 'late-tool', command: 'LATE COMMAND AFTER ABORT', status: 'completed', aggregatedOutput: 'LATE OUTPUT AFTER ABORT', exitCode: 0 } } });
        send({ method: 'item/agentMessage/delta', params: { threadId: 'native-1', turnId: 'turn1', delta: 'LATE ANSWER AFTER ABORT' } });
      }
      return true;
    };
    const send = (message) => { sent.push(message); child.stdout.write(`${JSON.stringify(message)}\n`); };
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
          child.stderr.write('private-stderr-must-not-forward');
          if (mismatchedEvents) {
            for (const scope of [{ threadId: 'other-thread', turnId: 'turn1' }, { threadId: 'native-1', turnId: 'other-turn' }]) {
              send({ method: 'item/started', params: { ...scope, item: { type: 'commandExecution', id: 'mismatched-tool', command: 'MISMATCHED COMMAND', status: 'inProgress' } } });
              send({ method: 'item/completed', params: { ...scope, item: { type: 'commandExecution', id: 'mismatched-tool', command: 'MISMATCHED COMMAND', status: 'completed', aggregatedOutput: 'MISMATCHED OUTPUT', exitCode: 0 } } });
              send({ method: 'item/agentMessage/delta', params: { ...scope, delta: 'MISMATCHED ANSWER' } });
              send({ method: 'turn/completed', params: { threadId: scope.threadId, turn: { id: scope.turnId, status: 'interrupted' } } });
            }
          }
          send({ method: 'item/started', params: { threadId: 'native-1', turnId: 'turn1', item: { type: 'commandExecution', id: 'tool1', command: 'cat materials.md', status: 'inProgress', privateConfig: 'must-not-forward-native' } } });
          send({ method: 'item/commandExecution/outputDelta', params: { threadId: 'native-1', turnId: 'turn1', itemId: 'tool1', delta: toolOutput } });
          send({ method: 'item/completed', params: { threadId: 'native-1', turnId: 'turn1', item: { type: 'commandExecution', id: 'tool1', command: 'cat materials.md', status: 'completed', aggregatedOutput: toolOutput, exitCode: toolExitCode, privateConfig: 'must-not-forward-native' } } });
          send({ method: 'item/agentMessage/delta', params: { threadId: 'native-1', turnId: 'turn1', delta: '中文回答' } });
          if (!hang) send({ method: 'turn/completed', params: { threadId: 'native-1', turn: { id: 'turn1', status: 'completed' } } });
        });
      }
      if (message.id !== undefined && result) send({ id: message.id, result }); callback();
    } });
    captured.push({ executable, args, options }); children.push(child); return child;
  };
  return { captured, children, sent, runtime: createCodexRuntime({ spawnImpl, rpcTimeoutMs: 100, ...(env ? { env } : {}) }) };
}

test('Codex uses native RPC streaming/resume and a verified readonly profile, without mixing tool output', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-codex-test-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const fake = fakeCodex(); const notifications = [];
  const result = await fake.runtime.run({ cwd, prompt: 'Question', onEvent: (event) => notifications.push(event) });
  assert.equal(result.body, '中文回答'); assert.equal(result.nativeSessionId, 'native-1');
  assert.ok(notifications.some((event) => event.kind === 'tool')); assert.ok(notifications.some((event) => event.type === 'session'));
  const tools = notifications.filter((event) => event.kind === 'tool');
  assert.deepEqual(tools.map((event) => [event.id, event.status]), [['tool1', 'running'], ['tool1', 'done']]);
  assert.ok(tools.every((event) => event.toolName === 'commandExecution' && event.command === 'cat materials.md'));
  assert.equal(tools[1].output, 'TOOL OUTPUT MUST NOT BECOME ANSWER'); assert.equal(tools[1].exitCode, 0);
  assert.equal(notifications.filter((event) => event.type === 'delta').map((event) => event.text).join(''), '中文回答');
  assert.doesNotMatch(JSON.stringify(notifications), /private-stderr-must-not-forward|must-not-forward-native|privateConfig/);
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

test('Codex reports failed commands with bounded output without turning their output into answer text', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-codex-test-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const fake = fakeCodex({ toolExitCode: 2, toolOutput: 'bounded-tool-output ' + 'x'.repeat(13_000) }); const notifications = [];
  const result = await fake.runtime.run({ cwd, prompt: 'Question', onEvent: (event) => notifications.push(event) });
  const tools = notifications.filter((event) => event.kind === 'tool');
  assert.deepEqual(tools.map((event) => [event.id, event.status]), [['tool1', 'running'], ['tool1', 'error']]);
  assert.equal(tools[1].exitCode, 2); assert.ok(tools[1].output.length <= 12_000); assert.match(tools[1].output, /bounded-tool-output/);
  assert.equal(result.body, '中文回答');
  assert.equal(notifications.filter((event) => event.type === 'delta').map((event) => event.text).join(''), '中文回答');
});

test('Codex ignores tool, answer and completion events from another thread or turn', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-codex-test-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const fake = fakeCodex({ mismatchedEvents: true }); const notifications = [];
  const result = await fake.runtime.run({ cwd, prompt: 'Question', onEvent: (event) => notifications.push(event) });
  assert.equal(result.body, '中文回答'); assert.doesNotMatch(JSON.stringify(notifications), /MISMATCHED|mismatched-tool/);
  assert.deepEqual(notifications.filter((event) => event.kind === 'tool').map((event) => event.id), ['tool1', 'tool1']);
});

test('Codex ignores late tool and answer notifications after abort even while its owned process exits', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-codex-test-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const fake = fakeCodex({ hang: true, lateOnKill: true }); const controller = new AbortController(); const notifications = [];
  await assert.rejects(fake.runtime.run({ cwd, prompt: 'Question', signal: controller.signal, onEvent(event) {
    notifications.push(event); if (event.type === 'delta') controller.abort();
  } }), /停止/);
  assert.ok(fake.sent.some((event) => event.params?.item?.id === 'late-tool'), 'fake CLI delivered late notifications');
  assert.doesNotMatch(JSON.stringify(notifications), /LATE|late-tool/); assert.ok(fake.children.every((child) => child.killed));
});

test('agent proxy whitelists bounded tool metadata and redacts secrets while preserving answer text', async (t) => {
  const env = { AI_API_KEY: 'proxy-api-private-value', OPENAI_API_KEY: 'openai-private-value', ANTHROPIC_API_KEY: 'anthropic-private-value' };
  const bearer = 'Bearer-token-private-value-12345'; const sk = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456789';
  const pem = 'private-pem-body-do-not-expose'; const configKey = 'json-config-api-private-value'; const configToken = 'json-config-token-private-value'; const configContent = 'hidden-config-private-value';
  const output = ['Read 3 source files.', ...Object.values(env), `Authorization: Bearer ${bearer}`, sk, `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`, JSON.stringify({ api_key: configKey, access_token: configToken })].join('\n');
  const body = `原文保留 ${env.AI_API_KEY} and ${sk}`;
  const runtime = { probe: async () => ({ state: 'ready' }), async run({ onEvent }) {
    onEvent({ type: 'progress', kind: 'tool', text: `Reading materials ${env.ANTHROPIC_API_KEY}`, id: 'tool1', toolName: 'commandExecution', command: `cat materials.md # ${env.OPENAI_API_KEY}`, status: 'done', output, exitCode: 0, unknown: 'must-not-forward', credentials: { token: 'must-not-forward' }, researchId: 'forged-research' });
    onEvent({ type: 'progress', kind: 'tool', text: 'Inspecting config', id: 'config-tool', toolName: 'commandExecution', command: 'cat ~/.codex/config.toml', status: 'done', output: JSON.stringify({ mcp_servers: { local: { env: { PASSWORD: configContent } } } }), exitCode: 0 });
    onEvent({ type: 'progress', kind: 'tool', text: 'oversized metadata', id: 'i'.repeat(201), toolName: 't'.repeat(101), command: 'c'.repeat(2001), status: 'invented', output: 'o'.repeat(12_001), exitCode: 1.5, extra: 'must-not-forward' });
    onEvent({ type: 'progress', kind: 'tool', text: 'invalid metadata', id: {}, toolName: 123, command: [], status: {}, output: {}, exitCode: '0' });
    onEvent({ type: 'progress', kind: 'debug', text: 'UNSUPPORTED PROGRESS KIND' });
    onEvent({ type: 'delta', text: body }); return { body, nativeSessionId: 'native-metadata', model: 'test-model' };
  } };
  const f = await fixture(t, runtime, { env }); const result = await events(await f.post(request()));
  const tools = result.filter((event) => event.type === 'progress' && event.kind === 'tool');
  const complete = tools.find((event) => event.id === 'tool1');
  assert.ok(complete); assert.equal(complete.toolName, 'commandExecution'); assert.equal(complete.status, 'done'); assert.equal(complete.exitCode, 0);
  assert.ok(typeof complete.output === 'string');
  const metadata = JSON.stringify(tools);
  for (const secret of [...Object.values(env), bearer, sk, pem, configKey, configToken, configContent]) assert.equal(metadata.includes(secret), false, 'tool metadata contains a secret');
  const allowed = new Set(['type', 'kind', 'text', 'id', 'toolName', 'command', 'status', 'output', 'exitCode', 'workspaceId', 'requestId', 'researchId', 'conversationId', 'connectionId']);
  for (const event of tools) {
    assert.ok(Object.keys(event).every((key) => allowed.has(key))); assert.equal(event.researchId, 'research1');
    for (const [key, limit] of [['id', 200], ['toolName', 100], ['command', 2000], ['output', 12_000]]) {
      if (key in event) { assert.equal(typeof event[key], 'string'); assert.ok(event[key].length <= limit); }
    }
    if ('status' in event) assert.ok(['running', 'done', 'error'].includes(event.status));
    if ('exitCode' in event) assert.ok(Number.isInteger(event.exitCode));
  }
  assert.equal(result.filter((event) => event.type === 'delta').map((event) => event.text).join(''), body);
  assert.doesNotMatch(JSON.stringify(result), /must-not-forward|UNSUPPORTED PROGRESS KIND/);
  assert.equal(result.at(-1).type, 'done');
});

test('agent proxy ignores tool and answer events emitted by a cancelled runtime', async (t) => {
  let lateEvents = 0;
  const runtime = { probe: async () => ({ state: 'ready' }), run({ signal, onEvent }) {
    onEvent({ type: 'progress', kind: 'tool', id: 'tool-before-stop', toolName: 'commandExecution', command: 'cat materials.md', status: 'running', text: 'Reading materials' });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      onEvent({ type: 'progress', kind: 'tool', id: 'late-tool', toolName: 'commandExecution', command: 'LATE COMMAND', status: 'done', text: 'LATE PROGRESS', output: 'LATE TOOL OUTPUT', exitCode: 0 });
      onEvent({ type: 'delta', text: 'LATE ANSWER' }); lateEvents += 2; reject(new Error('cancelled'));
    }, { once: true }));
  } };
  const f = await fixture(t, runtime); const first = await f.post(request());
  const identity = Object.fromEntries(['workspaceId', 'requestId', 'researchId', 'conversationId', 'connectionId'].map((key) => [key, request()[key]]));
  assert.equal((await (await f.post(identity, '/api/ai/agents/stop')).json()).stopped, true);
  const result = await events(first); assert.equal(lateEvents, 2);
  assert.doesNotMatch(JSON.stringify(result), /LATE|late-tool/); assert.equal(result.at(-1).code, 'stopped');
});
