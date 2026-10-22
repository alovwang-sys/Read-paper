import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createResearchHandler, createResearchTools, validateResearchInput, RESEARCH_TOOLS } from './research.mjs';
import { createCodexRuntime } from './codex-runtime.mjs';
import { createLiteratureHandler } from './literature.mjs';
import { IMAGE_LIMITS, MAX_IMAGE_BODY_BYTES } from './images.mjs';

const source = { id: 'doc1', title: 'A research paper', hash: 'hash1', totalPages: 3, pages: [{ pageIndex: 1, text: 'First result.\nThe method reduces error under this condition. Final result.' }] };
const citation = { documentId: source.id, documentHash: source.hash, pageIndex: 1, quote: 'The method reduces error under this condition.' };
const artifact = { title: '研究结论草稿', body: '方法降低了误差。[1]', citations: [citation] };
const request = (overrides = {}) => ({ requestId: 'request1', researchId: 'research1', connectionId: 'codex', prompt: '比较这些论文，生成带引用的研究结论', sources: [structuredClone(source)], history: [], ...overrides });
const value = result => JSON.parse(result.contentItems[0].text);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBLsAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const chatImage = (assetId = 'chat-image1', bytes = png, mimeType = 'image/png') => ({ assetId, hash: hash(bytes), name: 'user image.png', mimeType, size: bytes.length, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` });
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
    { history: Array.from({ length: 4097 }, () => ({ prompt: 'q', body: 'a' })) },
    { focus: { ref: { kind: 'card', id: 'c1' }, title: 't', body: 'b', documents: ['other'] } },
  ]) assert.throws(() => validateResearchInput(request(patch)), { code: 'invalid_request' });
  const big = Array.from({ length: 2 }, (_, index) => ({ ...source, id: `doc${index}`, totalPages: 24, pages: Array.from({ length: 12 }, (_, pageIndex) => ({ pageIndex, text: 'x'.repeat(12000) })) }));
  assert.throws(() => validateResearchInput(request({ sources: big })), { status: 413 });
});

test('long prompts and complete conversations past six turns and 12,000 characters stay intact', () => {
  const history = Array.from({ length: 8 }, (_, index) => ({ prompt: `question-${index}:` + 'q'.repeat(1000), body: `answer-${index}:` + 'a'.repeat(1000) }));
  const input = request({ prompt: '当前完整目标：' + '问'.repeat(9000), history });
  const validated = validateResearchInput(input);
  assert.deepEqual(validated, input);
  assert.equal(validated.history.length, 8);
  assert.ok(validated.history.reduce((count, item) => count + item.prompt.length + item.body.length, 0) > 12000);
  assert.equal(validated.history[0].prompt, history[0].prompt);
  validated.history[0].body = 'caller modification';
  assert.equal(input.history[0].body, history[0].body);
});

test('history replay and combined input budgets reject explicitly without dropping early turns', () => {
  const historyAtLimit = [{ prompt: 'q', body: 'a'.repeat(79999) }];
  assert.doesNotThrow(() => validateResearchInput(request({ history: historyAtLimit })));
  assert.throws(() => validateResearchInput(request({ history: [{ prompt: 'qq', body: 'a'.repeat(79999) }] })), { status: 413 });
  const history = [{ prompt: 'old question', body: 'h'.repeat(70000) }];
  const focus = { ref: { kind: 'draft', id: 'draft1' }, title: 'Existing draft', body: 'f'.repeat(12000) };
  const input = request({ prompt: 'p'.repeat(37000), history, focus });
  assert.ok(JSON.stringify({ prompt: input.prompt, history, focus }).length + 2048 > 120000);
  assert.throws(() => validateResearchInput(input), { status: 413 });
  assert.equal(input.history[0].body.length, 70000);
  assert.equal(input.prompt.length, 37000);
  const escaped = request({ prompt: 'p' + '\n'.repeat(60000) + 'p' });
  assert.ok(escaped.prompt.length < 120000);
  assert.throws(() => validateResearchInput(escaped), { status: 413 }, 'JSON escaping and fixed instructions also consume input capacity');
  const overhead = JSON.stringify({ prompt: '', history: [] }).length + 2048;
  assert.doesNotThrow(() => validateResearchInput(request({ prompt: 'p'.repeat(120000 - overhead) })));
  assert.throws(() => validateResearchInput(request({ prompt: 'p'.repeat(120001 - overhead) })), { status: 413 });
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

test('ordinary images validate exact metadata, original bytes, safe IDs, declared types and shared drawing limits', () => {
  const images = [chatImage(), chatImage('jpeg', Buffer.from([255, 216, 255, 1]), 'image/jpeg'), chatImage('webp', Buffer.from('RIFF1234WEBP'), 'image/webp')];
  const input = request({ images });
  assert.deepEqual(validateResearchInput(input), input);
  assert.doesNotThrow(() => validateResearchInput(request({ images: [] })));
  assert.doesNotThrow(() => validateResearchInput(request({ images, sources: [], drawing: drawing() })));
  assert.doesNotThrow(() => validateResearchInput(request({ images: [...images, chatImage('fourth')], sources: [], drawing: drawing('text') })));
  for (const invalidImage of [
    { path: '/private/image.png' }, { url: 'https://example.com/image.png' }, { assetId: '../private' }, { name: '' }, { name: 'x'.repeat(201) },
    { hash: 'a'.repeat(64) }, { size: png.length + 1 }, { size: 0 }, { size: IMAGE_LIMITS.maxImageBytes + 1 }, { mimeType: 'image/jpeg' },
    { dataUrl: 'https://example.com/image.png' }, { dataUrl: '/tmp/image.png' }, { dataUrl: 'data:image/png;base64,YQ==' },
    { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }, { dataUrl: chatImage().dataUrl + '=' }, { dataUrl: chatImage().dataUrl.replace(/I=$/, 'J=') },
  ]) assert.throws(() => validateResearchInput(request({ images: [{ ...chatImage(), ...invalidImage }] })), { code: 'invalid_request' });
  for (const images of [null, {}, [chatImage(), chatImage()], Array.from({ length: 5 }, (_, index) => chatImage(`image${index}`))]) assert.throws(() => validateResearchInput(request({ images })), { code: 'invalid_request' });
  assert.throws(() => validateResearchInput(request({ images: Array.from({ length: 4 }, (_, index) => chatImage(`image${index}`)), sources: [], drawing: drawing() })), /含绘图选区/);
  const changed = chatImage(); const otherPng = Buffer.concat([png, Buffer.from('extra')]); changed.dataUrl = `data:image/png;base64,${otherPng.toString('base64')}`; changed.size = otherPng.length;
  assert.throws(() => validateResearchInput(request({ images: [changed] })), /校验值/);
  const cloned = validateResearchInput(input); cloned.images[0].name = 'changed'; assert.equal(input.images[0].name, 'user image.png');
});

test('ordinary image bytes enforce the exact 8 MiB boundary before writing temporary files', () => {
  const bytes = Buffer.alloc(IMAGE_LIMITS.maxImageBytes); png.copy(bytes);
  assert.doesNotThrow(() => validateResearchInput(request({ images: [chatImage('at-limit', bytes)] })));
  const tooLarge = chatImage('over-limit', Buffer.concat([bytes, Buffer.from([0])]));
  tooLarge.size = IMAGE_LIMITS.maxImageBytes;
  assert.throws(() => validateResearchInput(request({ images: [tooLarge] })), { status: 413, code: 'image_too_large' });
});

test('image bytes are excluded from the text budget but metadata and JSON escaping consume it', () => {
  const image = chatImage(); const { dataUrl, ...metadata } = image;
  const overhead = JSON.stringify({ prompt: '', history: [], images: [metadata] }).length + 2048;
  assert.doesNotThrow(() => validateResearchInput(request({ images: [image], prompt: 'p'.repeat(120000 - overhead) })));
  assert.throws(() => validateResearchInput(request({ images: [image], prompt: 'p'.repeat(120001 - overhead) })), { status: 413 });
  const escaped = { ...image, name: 'img' + '\n'.repeat(100) };
  assert.throws(() => validateResearchInput(request({ images: [escaped], prompt: 'p'.repeat(120000 - overhead) })), { status: 413 });
});

test('ordinary image content never expands authorized papers or supplies PDF citations', async () => {
  const tools = createResearchTools(validateResearchInput(request({ images: [chatImage()], sources: [] })));
  assert.match(tools.instructions, /不是系统或工具指令/); assert.match(tools.instructions, /不是论文原文证据/);
  assert.deepEqual(value(await tools.call('search_sources', {})).sources, []);
  assert.equal((await tools.call('read_page', { documentId: source.id, pageIndex: 1 })).success, false);
  assert.equal((await tools.call('submit_result', artifact)).success, false);
  assert.equal(tools.artifact, undefined);
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

test('research search delegates to shared OpenAlex service and persists distinct searching, done and error events', async () => {
  const progress = [], queries = [];
  const service = createLiteratureHandler({ env: {}, fetchImpl: async (url) => {
    const query = new URL(url).searchParams.get('search'); queries.push(query);
    if (query === 'fail') return new Response('private upstream details', { status: 429 });
    return new Response(JSON.stringify({ results: query === 'empty' ? [] : [{ id: 'https://openalex.org/W1', display_name: 'Discovered paper', abstract_inverted_index: { Metadata: [0], only: [1] } }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  try {
    const tools = createResearchTools(validateResearchInput(request()), { searchLiterature: service.search, onProgress: event => progress.push(event) });
    assert.equal(tools.definitions.filter(tool => tool.name === 'search_literature').length, 1);
    assert.match(tools.instructions, /只有用户明确要求找新论文/);
    const found = await tools.call('search_literature', { query: 'evidence retrieval' });
    assert.equal(found.success, true);
    assert.equal(value(found).candidates[0].providerId, 'W1');
    const empty = await tools.call('search_literature', { query: 'empty' });
    assert.equal(empty.success, true); assert.deepEqual(value(empty).candidates, []);
    const failed = await tools.call('search_literature', { query: 'fail' });
    assert.equal(failed.success, false); assert.equal(value(failed).code, 'rate_limited');
    const searches = progress.filter(event => event.type === 'literature').map(event => event.search);
    assert.deepEqual(searches.map(item => item.status), ['searching', 'done', 'searching', 'done', 'searching', 'error']);
    assert.deepEqual(searches.filter(item => item.status === 'searching').map(item => item.candidates), [[], [], []]);
    assert.deepEqual(queries, ['evidence retrieval', 'empty', 'fail']);
    assert.equal(JSON.stringify(progress).includes('private upstream details'), false);
    assert.equal((await tools.call('search_literature', { query: 'fourth query' })).success, false);
    assert.equal(queries.length, 3);
  } finally { await service.stop(); }
});

test('discovered candidates never expand PDF authorization or become valid page citations', async () => {
  const candidate = { id: 'openalex-W1', provider: 'openalex', providerId: 'W1', title: 'Candidate', authors: [], url: 'https://openalex.org/W1', abstract: 'Metadata claim', retrievedAt: new Date().toISOString() };
  const tools = createResearchTools(validateResearchInput(request()), { searchLiterature: async () => ({ candidates: [candidate] }) });
  assert.equal((await tools.call('search_literature', { query: 'new papers' })).success, true);
  assert.deepEqual(value(await tools.call('search_sources', {})).sources.map(item => item.documentId), [source.id]);
  assert.equal((await tools.call('read_page', { documentId: candidate.id, pageIndex: 0 })).success, false);
  assert.equal((await tools.call('submit_result', { title: 'False evidence', body: 'An abstract claim [1]', citations: [{ documentId: candidate.id, documentHash: 'metadata', pageIndex: 0, quote: candidate.abstract }] })).success, false);
  assert.deepEqual(tools.readPages, []);
  assert.equal(tools.artifact, undefined);
  assert.equal((await tools.call('submit_result', { title: 'Search leads', body: '[Candidate](https://openalex.org/W1) is a search lead; PDF not read.', citations: [] })).success, true);
});

test('canceling research interrupts its shared literature request and refuses subsequent tools', async () => {
  const controller = new AbortController(), progress = [];
  let started, fetchSignal;
  const ready = new Promise(resolve => { started = resolve; });
  const service = createLiteratureHandler({ env: {}, fetchImpl: async (_url, options) => { fetchSignal = options.signal; started(); return new Promise(() => {}); } });
  try {
    const tools = createResearchTools(validateResearchInput(request()), { signal: controller.signal, searchLiterature: service.search, onProgress: event => progress.push(event) });
    const pending = tools.call('search_literature', { query: 'pending papers' });
    const rejected = assert.rejects(pending, error => error.code === 'aborted');
    await ready; controller.abort(); await rejected;
    assert.equal(fetchSignal.aborted, true);
    assert.deepEqual(progress.filter(item => item.type === 'literature').map(item => item.search.status), ['searching', 'stopped']);
    await assert.rejects(tools.call('search_literature', { query: 'late query' }), { code: 'stopped' });
    await assert.rejects(tools.call('read_page', { documentId: source.id, pageIndex: 1 }), { code: 'stopped' });
    assert.deepEqual(tools.readPages, []);
  } finally { await service.stop(); }
});

test('collected source abstracts are visible as metadata and remain ineligible for PDF citations', async () => {
  const metadata = { id: 'collected', title: 'Collected paper', hash: '', totalPages: 0, pages: [], abstract: 'Only the provider abstract was retrieved.', unavailable: '尚无 PDF 全文' };
  const tools = createResearchTools(validateResearchInput(request({ sources: [metadata] })));
  const catalog = value(await tools.call('search_sources', {})).sources[0];
  assert.equal(catalog.abstract, metadata.abstract);
  assert.match(catalog.abstractNotice, /不能用于页码引用/);
  assert.deepEqual(catalog.availablePages, []);
  assert.equal((await tools.call('read_page', { documentId: metadata.id, pageIndex: 0 })).success, false);
  assert.equal((await tools.call('submit_result', { title: 'Invalid abstract citation', body: 'Claim [1]', citations: [{ documentId: metadata.id, documentHash: '', pageIndex: 0, quote: metadata.abstract }] })).success, false);
  assert.equal(tools.artifact, undefined);
  assert.throws(() => validateResearchInput(request({ sources: [{ ...metadata, abstract: 'x'.repeat(12001) }] })), { code: 'invalid_request' });
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

test('HTTP NDJSON carries actual shared search snapshots for successful, empty and failed searches', async t => {
  const service = createLiteratureHandler({ env: {}, fetchImpl: async (url) => {
    const query = new URL(url).searchParams.get('search');
    if (query === 'fail') return new Response('not public', { status: 429 });
    return new Response(JSON.stringify({ results: query === 'empty' ? [] : [{ id: 'https://openalex.org/W7', display_name: 'HTTP discovered paper' }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  t.after(() => service.stop());
  const f = await fixture(t, { async run(input) {
    assert.equal(input.nativeSessionId, undefined);
    assert.equal(input.researchTools.definitions.filter(tool => tool.name === 'search_literature').length, 1);
    const query = input.prompt.includes('query=fail') ? 'fail' : input.prompt.includes('query=empty') ? 'empty' : 'good';
    const result = await input.researchTools.call('search_literature', { query });
    assert.equal(result.success, query !== 'fail');
    input.onEvent({ type: 'delta', text: query === 'fail' ? '检索受限，请稍后重试。' : '以下为检索线索，尚未读取 PDF。' });
    return {};
  } }, { searchLiterature: service.search });
  for (const query of ['good', 'empty', 'fail']) {
    const response = await f.post(request({ requestId: `search-${query}`, prompt: `明确找论文 query=${query}` }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const stream = await events(response);
    const searches = stream.filter(event => event.type === 'literature').map(event => event.search);
    assert.deepEqual(searches.map(item => item.status), ['searching', query === 'fail' ? 'error' : 'done']);
    assert.equal(searches[1].candidates.length, query === 'good' ? 1 : 0);
    if (query === 'good') assert.equal(searches[1].candidates[0].providerId, 'W7');
    if (query === 'fail') assert.equal(searches[1].errorCode, 'rate_limited');
    assert.equal(stream.at(-1).type, 'done');
    assert.deepEqual(stream.at(-1).readPages, []);
    assert.equal(stream.some(event => event.type === 'artifact'), false);
    assert.doesNotMatch(JSON.stringify(stream), /not public/);
  }
});

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

test('HTTP ordinary images pass exact private files to Codex, coexist with drawing, and are cleaned on failure', async t => {
  const paths = [];
  let calls = 0;
  const f = await fixture(t, { async run(input) {
    calls++;
    assert.equal(input.localImages.length, 4);
    assert.deepEqual(input.localImages.map(path => path.slice(input.cwd.length + 1)), ['drawing.png', 'chat-image-1.png', 'chat-image-2.jpg', 'chat-image-3.webp']);
    const expected = [png, png, Buffer.from([255, 216, 255, 1]), Buffer.from('RIFF1234WEBP')];
    for (const [index, path] of input.localImages.entries()) {
      paths.push(path); assert.deepEqual(await readFile(path), expected[index]);
      assert.equal((await stat(path)).mode & 0o777, index ? 0o400 : 0o600);
    }
    assert.doesNotMatch(input.prompt, /data:image|base64/);
    assert.match(input.prompt, /本轮普通图片/); assert.match(input.prompt, /user image/);
    assert.deepEqual(JSON.parse(await readFile(join(input.cwd, 'manifest.json'), 'utf8')).sourceIds, []);
    if (input.prompt.includes('force-failure')) throw new Error('must-not-leak-image-path');
    input.onEvent({ type: 'delta', text: '图片回答' }); return {};
  } });
  const images = [chatImage(), chatImage('jpeg', Buffer.from([255, 216, 255, 1]), 'image/jpeg'), chatImage('webp', Buffer.from('RIFF1234WEBP'), 'image/webp')];
  assert.equal((await events(await f.post(request({ sources: [], drawing: drawing(), images })))).at(-1).type, 'done');
  const failed = await events(await f.post(request({ requestId: 'failed-images', prompt: 'force-failure', sources: [], drawing: drawing(), images })));
  assert.equal(failed.at(-1).type, 'error'); assert.doesNotMatch(JSON.stringify(failed), /must-not-leak-image-path/);
  const tampered = await f.post(request({ requestId: 'tampered-images', images: [{ ...chatImage(), hash: 'a'.repeat(64) }] }));
  assert.equal(tampered.status, 400); assert.match((await events(tampered)).at(-1).error, /校验值/);
  assert.equal(calls, 2);
  for (const path of paths) await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('image payloads above the old body limit reach the runtime without entering the text prompt', async t => {
  const bytes = Buffer.concat([png, Buffer.alloc(3_200_000)]);
  const body = request({ images: [chatImage('large-image', bytes)] });
  assert.ok(JSON.stringify(body).length > 4_100_000);
  const f = await fixture(t, { async run(input) {
    assert.deepEqual(await readFile(input.localImages[0]), bytes);
    assert.ok(input.prompt.length < 3000); assert.doesNotMatch(input.prompt, /data:image|base64/); return {};
  } });
  assert.equal((await events(await f.post(body))).at(-1).type, 'done');
});

test('unsupported vision is an explicit image failure with owned temporary files removed', async t => {
  let path;
  const f = await fixture(t, { async run(input) {
    path = input.localImages[0];
    throw Object.assign(new Error('当前 Codex 模型不支持图片；附件已保留。'), { code: 'images_unsupported' });
  } });
  const input = request({ images: [chatImage()] });
  const result = await events(await f.post(input));
  assert.match(result.at(-1).error, /不支持图片/); assert.ok(result.every(event => event.type !== 'done'));
  assert.equal(input.images[0].dataUrl, chatImage().dataUrl);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

function pendingBody(handler, headers = {}) {
  const req = new PassThrough(); req.method = 'POST'; req.url = '/api/ai/research/run';
  req.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json', ...headers };
  const sent = [], responseHeaders = {};
  const res = new Writable({ write(chunk, _encoding, callback) { sent.push(JSON.parse(chunk.toString())); res.headersSent = true; callback(); } });
  res.setHeader = (key, value) => { responseHeaders[key] = value; };
  return { req, res, sent, responseHeaders, running: handler(req, res) };
}

test('only two concurrent bodies are allocated; disconnect releases a slot and shutdown cancels unfinished uploads', async () => {
  let calls = 0;
  const handler = createResearchHandler({ ports: [5173], runtimes: { codex: { async run() { calls++; return {}; } } } });
  try {
    const first = pendingBody(handler), second = pendingBody(handler);
    first.req.write('{'); second.req.write('{');
    const third = pendingBody(handler); await third.running;
    assert.equal(third.res.statusCode, 429); assert.equal(third.responseHeaders.Connection, 'close');
    assert.match(third.sent.at(-1).error, /两个请求正在上传/); assert.equal(third.req.readableFlowing, null);
    first.res.destroy(); await first.running; assert.equal(first.req.destroyed, true);
    const afterDisconnect = pendingBody(handler);
    afterDisconnect.req.end(JSON.stringify(request())); await afterDisconnect.running;
    assert.equal(afterDisconnect.sent.at(-1).type, 'done'); assert.equal(calls, 1);
    handler.close(); await second.running; assert.equal(second.req.destroyed, true);
    assert.equal(calls, 1);
    const closed = pendingBody(handler); await closed.running; assert.equal(closed.res.statusCode, 503);
    third.req.destroy(); closed.req.destroy();
  } finally { handler.close(); }
});

test('declared oversized bodies are rejected before any upload buffers or runtime calls', async () => {
  const handler = createResearchHandler({ ports: [5173], runtimes: { codex: { run: () => assert.fail('invalid body cannot run') } } });
  try {
    const f = pendingBody(handler, { 'content-length': String(MAX_IMAGE_BODY_BYTES + 4_100_001) });
    await f.running; assert.equal(f.res.statusCode, 413); assert.equal(f.req.readableFlowing, null); f.req.destroy();
    assert.match(f.sent.at(-1).error, /图片过大/);
  } finally { handler.close(); }
});

test('chunked uploads count actual bytes and reject past the shared image body limit', async () => {
  const handler = createResearchHandler({ ports: [5173], runtimes: { codex: { run: () => assert.fail('oversized body cannot run') } } });
  try {
    const f = pendingBody(handler);
    f.req.end(Buffer.alloc(MAX_IMAGE_BODY_BYTES + 4_100_001));
    await f.running;
    assert.equal(f.res.statusCode, 413); assert.match(f.sent.at(-1).error, /图片过大/);
  } finally { handler.close(); }
});

test('disconnecting an active image turn cancels Codex and removes every owned attachment', async t => {
  let entered, stopped, paths;
  const started = new Promise(resolve => { entered = resolve; });
  const done = new Promise(resolve => { stopped = resolve; });
  const f = await fixture(t, { run(input) {
    paths = input.localImages; entered();
    return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => { stopped(); reject(Object.assign(new Error('stopped'), { code: 'stopped' })); }, { once: true }));
  } });
  const controller = new AbortController();
  const response = await f.post(request({ images: [chatImage()] }), { signal: controller.signal });
  await started; const body = response.text().catch(() => {}); controller.abort(); await done; await body;
  for (const path of paths) {
    for (let index = 0; index < 30; index++) {
      try { await stat(path); await new Promise(resolve => setTimeout(resolve, 10)); } catch (failure) { if (failure.code === 'ENOENT') break; throw failure; }
    }
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
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
  assert.equal(observed, true); assert.equal(result.at(-1).type, 'error'); assert.match(result.at(-1).error, /长时间未返回新进展/);
  assert.ok(result.every(event => event.type !== 'artifact'));
});

async function idleFixture(t) {
  let input, entered, finish, reject;
  const started = new Promise(resolve => { entered = resolve; });
  const completed = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const sent = [];
  const handler = createResearchHandler({ ports: [5173], timeoutMs: 100, runtimes: { codex: { run(value) {
    input = value;
    input.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'stopped' })), { once: true });
    entered();
    return completed;
  } } } });
  t.after(() => handler.close());
  const req = Readable.from([Buffer.from(JSON.stringify(request()))]);
  req.method = 'POST'; req.url = '/api/ai/research/run';
  req.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json' };
  const res = new Writable({ write(chunk, _encoding, callback) { sent.push(JSON.parse(chunk.toString())); res.headersSent = true; callback(); } });
  res.setHeader = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = handler(req, res);
  await started;
  return { handler, input, sent, running, disconnect: () => res.destroy(), done: () => finish({ model: 'controlled-runtime' }) };
}

test('research stays alive across several original deadlines while reasoning, model and tool work progress', async t => {
  const f = await idleFixture(t);
  t.mock.timers.tick(80); f.input.onActivity();
  t.mock.timers.tick(80); f.input.onEvent({ type: 'delta', text: 'Partial answer' });
  t.mock.timers.tick(80); await f.input.researchTools.call('read_page', { documentId: source.id, pageIndex: 1 });
  t.mock.timers.tick(80); f.input.onEvent({ type: 'progress', kind: 'tool', id: 'tool1', toolName: 'read_page', status: 'running', text: 'Reading' });
  t.mock.timers.tick(80); f.input.onEvent({ type: 'progress', kind: 'tool', id: 'tool1', toolName: 'read_page', status: 'done', text: 'Read' });
  assert.equal(f.input.signal.aborted, false);
  f.done(); await f.running;
  assert.equal(f.sent.at(-1).type, 'done');
  assert.deepEqual(f.sent.at(-1).readPages, [{ documentId: source.id, pageIndex: 1 }]);
  assert.equal(f.sent.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Partial answer');
  f.input.onActivity(); f.input.onEvent({ type: 'delta', text: 'LATE AFTER DONE' });
  t.mock.timers.tick(300);
  assert.equal(f.input.signal.aborted, false, 'completion must prevent late callbacks from rearming the timer');
  assert.doesNotMatch(JSON.stringify(f.sent), /LATE AFTER DONE/);
});

test('research idle timeout still stops the runtime and retains partial output without accepting late work', async t => {
  const f = await idleFixture(t);
  t.mock.timers.tick(80); f.input.onEvent({ type: 'delta', text: 'Saved partial answer' });
  t.mock.timers.tick(99); assert.equal(f.input.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(f.input.signal.aborted, true);
  await f.running;
  assert.match(f.sent.at(-1).error, /长时间未返回新进展/);
  assert.ok(f.sent.some(event => event.type === 'delta' && event.text === 'Saved partial answer'));
  f.input.onActivity(); f.input.onEvent({ type: 'delta', text: 'LATE AFTER TIMEOUT' });
  await assert.rejects(f.input.researchTools.call('submit_result', { title: 'Late', body: 'Late result', citations: [] }), { code: 'stopped' });
  t.mock.timers.tick(300);
  assert.doesNotMatch(JSON.stringify(f.sent), /LATE AFTER TIMEOUT/);
  assert.ok(f.sent.every(event => event.type !== 'artifact' && event.type !== 'done'));
});

test('empty model output, generic statuses and unchanged native tool events do not postpone research inactivity', async t => {
  const f = await idleFixture(t);
  const tool = { type: 'progress', kind: 'tool', id: 'tool1', toolName: 'read_page', status: 'running', text: 'Reading' };
  f.input.onEvent(tool);
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(30);
    f.input.onEvent({ type: 'delta', text: ' ' });
    f.input.onEvent({ type: 'progress', kind: 'status', text: 'Heartbeat only' });
    f.input.onEvent(tool);
  }
  t.mock.timers.tick(10);
  assert.equal(f.input.signal.aborted, true);
  await f.running;
  assert.match(f.sent.at(-1).error, /长时间未返回新进展/);
});

for (const action of ['disconnect', 'shutdown']) test(`research ${action} stops immediately and late activity cannot change it into an idle timeout`, async t => {
  const f = await idleFixture(t);
  t.mock.timers.tick(80); f.input.onActivity();
  if (action === 'disconnect') { f.disconnect(); await new Promise(resolve => setImmediate(resolve)); }
  else f.handler.close();
  assert.equal(f.input.signal.aborted, true);
  f.input.onActivity(); f.input.onEvent({ type: 'delta', text: 'LATE AFTER STOP' });
  t.mock.timers.tick(300);
  await f.running;
  assert.doesNotMatch(JSON.stringify(f.sent), /LATE AFTER STOP|长时间未返回新进展/);
  if (action === 'shutdown') assert.match(f.sent.at(-1).error, /研究已停止/);
  else assert.ok(f.sent.every(event => event.type !== 'done' && event.type !== 'error'));
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
