import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createResearchHandler, createResearchTools, validateResearchInput, RESEARCH_TOOLS } from './research.mjs';
import { createCodexRuntime } from './codex-runtime.mjs';

const source = { id: 'doc1', title: 'A research paper', hash: 'hash1', totalPages: 3, pages: [{ pageIndex: 1, text: 'First result.\nThe method reduces error under this condition. Final result.' }] };
const citation = { documentId: source.id, documentHash: source.hash, pageIndex: 1, quote: 'The method reduces error under this condition.' };
const artifact = { title: '研究结论草稿', body: '方法降低了误差。[1]', citations: [citation] };
const request = (overrides = {}) => ({ requestId: 'request1', researchId: 'research1', connectionId: 'codex', prompt: '比较这些论文，生成带引用的研究结论', sources: [structuredClone(source)], history: [], ...overrides });
const value = result => JSON.parse(result.contentItems[0].text);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBLsAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sort(value[key])])) : value;
function drawing(mode = 'image', mutate = () => {}) {
  const snapshot = { id: 'drawing1', boardId: 'board1', boardTitle: 'My diagram', createdAt: '2026-10-21T04:00:00.000Z', image: { assetId: 'drawing-image1', hash: hash(png), width: 1, height: 1 }, elements: [
    { id: 'shape1', type: 'rectangle', x: 10, y: 20, width: 120, height: 40, angle: 0, text: 'Selected label' },
    { id: 'arrow1', type: 'arrow', x: 130, y: 40, width: 100, height: 0, angle: 0 },
  ], connections: [{ id: 'arrow1', startId: 'shape1', endOutside: true, endArrowhead: 'arrow' }] };
  mutate(snapshot); snapshot.hash = hash(JSON.stringify(sort(snapshot)));
  return { mode, snapshot, ...(mode === 'image' ? { imageDataUrl: `data:image/png;base64,${png.toString('base64')}` } : {}) };
}

test('research snapshot validation bounds scope, pages, history and metadata-only sources', () => {
  assert.deepEqual(validateResearchInput(request()), request());
  assert.doesNotThrow(() => validateResearchInput(request({ sources: [{ id: 'metadata', title: 'No PDF', hash: '', totalPages: 0, pages: [], unavailable: '未导入全文' }] })));
  for (const patch of [
    { requestId: '' }, { requestId: 123 }, { researchId: 123 }, { nativeSessionId: 'external' }, { sources: [source, source] }, { sources: [{ ...source, id: 123 }] },
    { sources: [{ ...source, pages: [{ pageIndex: 3, text: 'wrong page' }] }] },
    { sources: [{ ...source, pages: [{ pageIndex: 1, text: 'x'.repeat(12001) }] }] },
    { sources: [{ ...source, hash: '', totalPages: 0 }] },
    { sources: Array.from({ length: 9 }, (_, index) => ({ ...source, id: `doc${index}` })) },
    { history: Array.from({ length: 7 }, () => ({ prompt: 'q', body: 'a' })) },
    { history: [{ prompt: 'x'.repeat(7000), body: 'a'.repeat(6000) }] },
    { focus: { ref: { kind: 'card', id: 'c1' }, title: 't', body: 'b', documents: ['other'] } },
  ]) assert.throws(() => validateResearchInput(request(patch)), { code: 'invalid_request' });
  const big = Array.from({ length: 2 }, (_, index) => ({ ...source, id: `doc${index}`, totalPages: 24, pages: Array.from({ length: 12 }, (_, pageIndex) => ({ pageIndex, text: 'x'.repeat(12000) })) }));
  assert.throws(() => validateResearchInput(request({ sources: big })), { status: 413 });
});

test('drawing snapshots validate exact scope, canonical hashes, selected text budgets and real PNG bytes', () => {
  const valid = request({ sources: [], drawing: drawing() });
  assert.deepEqual(validateResearchInput(valid), valid);
  assert.doesNotThrow(() => validateResearchInput(request({ sources: [], drawing: drawing('text') })));
  const reordered = drawing(); reordered.snapshot.image = Object.fromEntries(Object.entries(reordered.snapshot.image).reverse());
  assert.doesNotThrow(() => validateResearchInput(request({ sources: [], drawing: reordered })));
  const wrongHash = drawing(); wrongHash.snapshot.elements[0].text = 'Changed after selection';
  for (const patch of [
    { sources: [source], drawing: drawing() }, { focus: { ref: { kind: 'draft', id: 'old' }, title: 'Old draft', body: 'Do not overwrite' }, drawing: drawing() },
    { drawing: { ...drawing(), path: '/private/other.png' } }, { drawing: { ...drawing(), imageDataUrl: 'https://example.com/image.png' } },
    { drawing: { ...drawing(), imageDataUrl: 'data:image/png;base64,YQ==' } }, { drawing: wrongHash },
    { drawing: drawing('image', snapshot => { snapshot.image.hash = 'a'.repeat(64); }) },
    { drawing: drawing('image', snapshot => { snapshot.image.width = 2049; }) },
    { drawing: drawing('image', snapshot => { snapshot.image.width = 2; }) },
    { drawing: drawing('image', snapshot => { snapshot.elements[0].resource = { ref: { kind: 'draft', id: 'd1' }, title: '', body: 'Draft text' }; }) },
    { drawing: drawing('image', snapshot => { snapshot.elements[0].text = 'x'.repeat(12001); }) },
    { drawing: drawing('image', snapshot => { snapshot.elements = []; snapshot.connections = []; }) },
    { drawing: drawing('image', snapshot => { snapshot.elements = Array.from({ length: 101 }, (_, i) => ({ ...snapshot.elements[0], id: `shape${i}` })); snapshot.connections = []; }) },
    { drawing: drawing('image', snapshot => { snapshot.connections[0].endId = 'outside-node'; }) },
    { drawing: drawing('image', snapshot => { snapshot.connections[0].startOutside = true; }) },
    { drawing: drawing('text', snapshot => { delete snapshot.elements[0].text; }) },
    { drawing: { ...drawing('text'), imageDataUrl: drawing().imageDataUrl } },
  ]) assert.throws(() => validateResearchInput(request({ sources: [], ...patch })), { code: 'invalid_request' });
  const tools = createResearchTools(validateResearchInput(valid));
  assert.match(tools.instructions, /用户的想法/); assert.match(tools.instructions, /不能修改原图/);
  assert.match(createResearchTools(validateResearchInput(request({ sources: [], drawing: drawing('text') }))).instructions, /本轮未看图/);
});

test('research tools expose metadata first, read only authorized pages, and validate submitted citations against actual reads', async () => {
  const events = [];
  const tools = createResearchTools(validateResearchInput(request()), { onProgress: event => events.push(event) });
  const catalog = value(await tools.call('search_sources', {}));
  assert.deepEqual(catalog.sources[0].availablePages, [1]);
  assert.ok(!JSON.stringify(catalog).includes('reduces error'));
  for (const args of [{ documentId: 'unrelated', pageIndex: 1 }, { documentId: source.id, pageIndex: 0 }, { documentId: source.id, pageIndex: 1, path: '/private' }]) assert.equal((await tools.call('read_page', args)).success, false);
  assert.equal((await tools.call('submit_result', artifact)).success, false, 'not read yet');
  assert.equal(value(await tools.call('read_page', { documentId: source.id, pageIndex: 1 })).text, source.pages[0].text);
  for (const bad of [
    { ...artifact, citations: [{ ...citation, quote: 'fabricated text' }] },
    { ...artifact, citations: [{ ...citation, documentHash: 'different-version' }] },
    { ...artifact, citations: [{ ...citation, pageIndex: 0 }] },
    { ...artifact, body: 'Unsupported reference [2]' },
    { ...artifact, citations: [] },
  ]) assert.equal((await tools.call('submit_result', bad)).success, false);
  assert.equal((await tools.call('submit_result', artifact)).success, true);
  assert.deepEqual(tools.artifact, artifact);
  assert.equal((await tools.call('submit_result', artifact)).success, false);
  assert.deepEqual(tools.readPages, [{ documentId: source.id, pageIndex: 1 }]);
  assert.equal(events.filter(event => event.toolName === 'submit_result').length, 1);
  const mutable = tools.artifact; mutable.body = 'outside change'; assert.equal(tools.artifact.body, artifact.body);
});

test('local focus and history do not authorize extra sources; cancelled tools cannot read or submit', async () => {
  const input = request({ focus: { ref: { kind: 'document', id: 'hidden-document' }, title: 'Hidden', body: 'not source text' }, history: [{ prompt: 'old', body: 'hidden text' }] });
  const controller = new AbortController();
  const tools = createResearchTools(validateResearchInput(input), { signal: controller.signal });
  assert.equal((await tools.call('read_page', { documentId: 'hidden-document', pageIndex: 0 })).success, false);
  controller.abort();
  await assert.rejects(tools.call('read_page', { documentId: source.id, pageIndex: 1 }), { code: 'stopped' });
  await assert.rejects(tools.call('submit_result', { title: 'no evidence', body: 'unverified', citations: [] }), { code: 'stopped' });
  assert.equal(tools.artifact, undefined);
});

async function fixture(t, runtime, options = {}) {
  let handler;
  const server = createServer((req, res) => handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  handler = createResearchHandler({ runtimes: { codex: runtime }, ports: [port, 5173], ...options });
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${port}`;
  return { handler, url, post: (body, init = {}) => fetch(`${url}/api/ai/research/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...init }) };
}
const events = async response => (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('research capabilities retain connections honestly and reject remote callers and unsupported runtimes', async t => {
  const f = await fixture(t, { probe: async () => ({ state: 'ready' }), run: () => assert.fail() });
  const capabilities = await (await fetch(`${f.url}/api/ai/research/capabilities`)).json();
  assert.deepEqual(capabilities.connections.map(item => [item.id, item.research]), [['codex', true], ['claude', false], ['opencode', false], ['model', false], ['demo', false]]);
  assert.ok(capabilities.connections.every(item => item.images === false));
  assert.equal((await fetch(`${f.url}/api/ai/research/capabilities`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.post(request({ connectionId: 'claude' }))).status, 400);
  const unavailable = await fixture(t, { probe: async () => ({ state: 'needs-auth' }) });
  assert.equal((await (await fetch(`${unavailable.url}/api/ai/research/capabilities`)).json()).connections[0].research, false);
});

test('drawing routes send one owned private image with frozen metadata, no PDFs, and remove it after success or failure', async t => {
  const paths = [];
  const f = await fixture(t, { probe: async () => ({ state: 'ready', images: true }), async run(input) {
    assert.equal(input.localImages.length, 1); const path = input.localImages[0]; paths.push(path);
    assert.equal(path, join(input.cwd, 'drawing.png')); assert.deepEqual(await readFile(path), png); assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(input.cwd, 'manifest.json'), 'utf8')).sourceIds, []);
    assert.match(input.prompt, /Selected label/); assert.match(input.prompt, /已附真实PNG/); assert.doesNotMatch(input.prompt, /data:image|base64/);
    assert.deepEqual(value(await input.researchTools.call('search_sources', {})).sources, []);
    assert.equal((await input.researchTools.call('read_page', { documentId: source.id, pageIndex: 1 })).success, false);
    if (input.prompt.includes('force-failure')) throw new Error('private-image-path');
    input.onEvent({ type: 'delta', text: 'I can inspect this selected diagram.' }); return { model: 'vision-model' };
  } });
  const capabilities = await (await fetch(`${f.url}/api/ai/research/capabilities`)).json(); assert.equal(capabilities.connections[0].images, true); assert.ok(capabilities.connections.slice(1).every(item => !item.images));
  assert.equal((await events(await f.post(request({ sources: [], drawing: drawing() })))).at(-1).type, 'done');
  const failed = await events(await f.post(request({ requestId: 'failed-image', prompt: 'force-failure', sources: [], drawing: drawing() })));
  assert.equal(failed.at(-1).type, 'error'); assert.doesNotMatch(JSON.stringify(failed), /private-image-path/);
  for (const path of paths) await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('explicit text mode never passes a local image and unsupported vision remains a visible failure', async t => {
  const f = await fixture(t, { async run(input) {
    assert.equal(input.localImages, undefined); assert.match(input.prompt, /未看图，仅文字与结构/); assert.match(input.researchTools.instructions, /本轮未看图/);
    input.onEvent({ type: 'delta', text: '未看图，仅分析所选文字。' }); return {};
  } });
  assert.equal((await events(await f.post(request({ sources: [], drawing: drawing('text') })))).at(-1).type, 'done');
  let path;
  const unsupported = await fixture(t, { async run(input) { path = input.localImages[0]; throw Object.assign(new Error('当前 Codex 模型的图片能力未确认；附件已保留。'), { code: 'images_unsupported' }); } });
  const failed = await events(await unsupported.post(request({ sources: [], drawing: drawing() })));
  assert.match(failed.at(-1).error, /图片能力未确认/); await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('research route runs a fresh isolated native session and emits a single validated artifact followed by a read trace', async t => {
  const calls = [];
  const f = await fixture(t, { async run(input) {
    calls.push(input);
    assert.equal(input.nativeSessionId, undefined); assert.equal(input.skillIds, undefined); assert.equal(input.codex, undefined);
    const manifest = JSON.parse(await readFile(join(input.cwd, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.sourceIds, [source.id]);
    assert.ok(!JSON.stringify(manifest).includes('reduces error'));
    assert.equal((await input.researchTools.call('read_page', { documentId: source.id, pageIndex: 1 })).success, true);
    assert.equal((await input.researchTools.call('submit_result', artifact)).success, true);
    input.onEvent({ type: 'delta', text: '草稿已完成。' });
    return { body: '草稿已完成。', nativeSessionId: 'native1', model: 'real-runtime' };
  } });
  const result = await events(await f.post(request()));
  assert.equal(result.filter(event => event.type === 'artifact').length, 1);
  assert.deepEqual(result.find(event => event.type === 'artifact').artifact, artifact);
  assert.deepEqual(result.at(-1), { type: 'done', model: 'real-runtime', nativeSessionId: 'native1', readPages: [{ documentId: source.id, pageIndex: 1 }] });
  assert.equal(result.filter(event => event.type === 'delta').map(event => event.text).join(''), '草稿已完成。');
  await assert.rejects(readFile(join(calls[0].cwd, 'manifest.json')), { code: 'ENOENT' });
});

test('ordinary answers do not fabricate artifacts and failed native turns do not commit proposed results', async t => {
  const ordinary = await fixture(t, { async run({ onEvent }) { onEvent({ type: 'delta', text: '简短解释' }); return { body: '简短解释' }; } });
  assert.deepEqual((await events(await ordinary.post(request()))).map(event => event.type), ['progress', 'delta', 'done']);
  const failed = await fixture(t, { async run({ researchTools }) {
    await researchTools.call('submit_result', { title: 'Unverified', body: '无证据草稿', citations: [] });
    throw new Error('secret-token-must-not-leak');
  } });
  const result = await events(await failed.post(request()));
  assert.equal(result.at(-1).type, 'error'); assert.ok(result.every(event => event.type !== 'artifact'));
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('timeout aborts the owned run, rejects concurrent requests, and prevents late artifacts', async t => {
  let observed = false;
  const f = await fixture(t, { run({ signal, researchTools }) {
    return new Promise((resolve, reject) => signal.addEventListener('abort', async () => {
      observed = true;
      await assert.rejects(researchTools.call('submit_result', { title: 'Late', body: 'Late', citations: [] }), { code: 'stopped' });
      reject(Object.assign(new Error('stopped'), { code: 'stopped' }));
    }, { once: true }));
  } }, { timeoutMs: 100 });
  const first = await f.post(request());
  assert.equal((await f.post(request({ requestId: 'other' }))).status, 409);
  const result = await events(first);
  assert.equal(observed, true); assert.equal(result.at(-1).type, 'error'); assert.match(result.at(-1).error, /超时/);
  assert.ok(result.every(event => event.type !== 'artifact'));
});

test('Codex research dynamic tools disable shell and ignore foreign, repeated or late tool calls', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-research-rpc-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const captured = [], replies = [], callLog = [];
  let child;
  const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const spawnImpl = () => {
    child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
    child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; };
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString()); captured.push(message);
      if (!message.method) { replies.push(message); callback(); return; }
      let result;
      if (message.method === 'initialize') result = {};
      if (message.method === 'config/read') result = { config: { mcp_servers: { unwanted: {} }, plugins: { unwanted: {} } } };
      if (message.method === 'skills/list') result = { data: [] };
      if (message.method === 'command/exec') result = { exitCode: message.params.command[0].includes('touch') || message.params.command[1].endsWith('outside.txt') ? 1 : 0 };
      if (message.method === 'thread/start') result = { thread: { id: 'native1' }, model: 'native-model' };
      if (message.method === 'thread/name/set') result = {};
      if (message.method === 'turn/start') {
        result = { turn: { id: 'turn1' } };
        setImmediate(() => {
          for (const [id, overrides] of [['foreign', { threadId: 'other' }], ['missing', { turnId: undefined }], ['first', {}], ['retry', {}], ['changed', { arguments: { query: 'changed' } }], ['unknown', { tool: 'shell' }]]) {
            send({ id, method: 'item/tool/call', params: { threadId: 'native1', turnId: 'turn1', callId: 'call1', tool: 'search_sources', arguments: {}, ...overrides } });
          }
          setTimeout(() => {
            send({ method: 'item/agentMessage/delta', params: { threadId: 'native1', turnId: 'turn1', delta: 'Done' } });
            send({ method: 'turn/completed', params: { threadId: 'native1', turn: { id: 'turn1', status: 'completed' } } });
            send({ id: 'late', method: 'item/tool/call', params: { threadId: 'native1', turnId: 'turn1', callId: 'late', tool: 'search_sources', arguments: {} } });
          }, 15);
        });
      }
      if (result) send({ id: message.id, result }); callback();
    } });
    return child;
  };
  const runtime = createCodexRuntime({ spawnImpl, env: {}, rpcTimeoutMs: 300 });
  const tools = { definitions: RESEARCH_TOOLS, instructions: 'Research tools only', async call(name, args) { callLog.push([name, args]); return { success: true, contentItems: [{ type: 'inputText', text: '{}' }] }; } };
  const result = await runtime.run({ cwd, prompt: 'Research', title: 'Temporary research turn', researchTools: tools });
  assert.equal(result.body, 'Done'); assert.deepEqual(callLog, [['search_sources', {}]]);
  const thread = captured.find(message => message.method === 'thread/start').params;
  assert.deepEqual(thread.dynamicTools, RESEARCH_TOOLS); assert.equal(thread.config['features.shell_tool'], false);
  assert.equal(thread.config['mcp_servers.unwanted.enabled'], false); assert.equal(thread.config['plugins.unwanted.enabled'], false);
  assert.equal(thread.approvalPolicy, 'never'); assert.equal(thread.developerInstructions, tools.instructions);
  assert.equal(thread.ephemeral, true);
  assert.ok(!captured.some(message => message.method === 'thread/name/set'));
  assert.ok(replies.find(reply => reply.id === 'first').result.success); assert.ok(replies.find(reply => reply.id === 'retry').result.success);
  for (const id of ['foreign', 'missing', 'changed', 'unknown']) assert.equal(replies.find(reply => reply.id === id)?.result.success, false, id);
  assert.notEqual(replies.find(reply => reply.id === 'late')?.result.success, true);
  assert.ok(child.killed);
  await assert.rejects(runtime.run({ cwd, prompt: 'bad', researchTools: tools, nativeSessionId: 'old' }), { code: 'invalid_input' });
});
