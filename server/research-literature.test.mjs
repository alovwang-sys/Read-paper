import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiteratureHandler } from './literature.mjs';
import { createResearchLiterature, RESEARCH_LITERATURE_TOOLS } from './research-literature.mjs';

const value = result => JSON.parse(result.contentItems[0].text);
const work = { id: 'https://openalex.org/W1', display_name: 'Real returned paper', publication_year: 2024,
  doi: 'https://doi.org/10.1234/example', authorships: [{ author: { display_name: 'Author' } }], abstract_inverted_index: { Source: [0], abstract: [1] } };
const json = (results = [work]) => new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });

test('the only new tool searches real service results without sending the private question or auto-collecting', async () => {
  const events = [];
  const service = createLiteratureHandler({ env: {}, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://api.openalex.org/works');
    assert.equal(parsed.searchParams.get('search'), 'retrieval evidence');
    assert.equal(parsed.searchParams.get('filter'), 'publication_year:2020-2024');
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ['filter', 'page', 'per_page', 'search', 'select']);
    assert.equal(options.redirect, 'error');
    return json();
  } });
  try {
    const tools = createResearchLiterature({ search: service.search, onSearch: item => events.push(item) });
    assert.deepEqual(tools.definitions.map(item => item.name), ['search_literature']);
    assert.equal(RESEARCH_LITERATURE_TOOLS[0].inputSchema.additionalProperties, false);
    const result = await tools.call({ query: ' retrieval evidence ', yearFrom: 2020, yearTo: 2024 });
    assert.equal(result.success, true);
    assert.deepEqual(events.map(item => item.status), ['searching', 'done']);
    assert.equal(events[0].candidates.length, 0);
    assert.equal(events[1].candidates[0].providerId, 'W1');
    assert.equal(events[1].candidates[0].abstract, 'Source abstract');
    assert.match(value(result).scope, /未读取 PDF/);
    assert.match(value(result).scope, /尚未加入资料库/);
    assert.equal(events[1].candidates[0].documentId, undefined);
  } finally { await service.stop(); }
});

test('zero results stay an explicit successful empty search', async () => {
  const events = [];
  const tools = createResearchLiterature({ search: async () => ({ candidates: [] }), onSearch: item => events.push(item) });
  const result = await tools.call({ query: 'no matches' });
  assert.equal(result.success, true);
  assert.deepEqual(value(result).candidates, []);
  assert.equal(events.at(-1).status, 'done');
  assert.deepEqual(tools.searches[0].candidates, []);
});

test('query-only schema rejects prompt, private text, URLs as endpoints and invalid filters before searching', async () => {
  let calls = 0;
  const tools = createResearchLiterature({ search: async () => { calls += 1; return { candidates: [] }; } });
  for (const args of [null, [], {}, { query: '' }, { query: 'q'.repeat(501) }, { query: 'a\nb' },
    { query: 'q', prompt: 'private question' }, { query: 'q', image: 'private image' }, { query: 'q', history: [] },
    { query: 'q', endpoint: 'https://example.com' }, { query: 'q', yearFrom: 2025, yearTo: 2024 }, { query: 'q', yearTo: '2024' }]) {
    const result = await tools.call(args);
    assert.equal(result.success, false);
    assert.equal(value(result).code, 'invalid_request');
  }
  assert.equal(calls, 0);
  assert.deepEqual(tools.searches, []);
  assert.equal((await tools.call({ query: 'valid next query' })).success, true);
});

test('at most three searches execute per run, including failed requests, without retries', async () => {
  let calls = 0;
  const tools = createResearchLiterature({ search: async () => { calls += 1; throw new Error('untrusted secret'); } });
  for (let index = 0; index < 3; index++) {
    const result = await tools.call({ query: `query ${index}` });
    assert.equal(result.success, false);
    assert.equal(value(result).code, 'connection_failed');
    assert.equal(JSON.stringify(result).includes('untrusted secret'), false);
  }
  assert.equal(value(await tools.call({ query: 'fourth query' })).code, 'search_limit');
  assert.equal(calls, 3);
  assert.deepEqual(tools.searches.map(item => item.id), ['literature-1', 'literature-2', 'literature-3']);
  assert.ok(tools.searches.every(item => item.status === 'error' && !item.candidates.length));
});

test('real authentication and quota failures become visible error searches and never fabricated candidates', async () => {
  for (const [status, code] of [[401, 'authentication_failed'], [429, 'rate_limited'], [502, 'upstream_error']]) {
    const events = [];
    const service = createLiteratureHandler({ env: {}, fetchImpl: async () => new Response('private upstream response', { status }) });
    try {
      const tools = createResearchLiterature({ search: service.search, onSearch: item => events.push(item) });
      const result = await tools.call({ query: 'q' });
      assert.equal(result.success, false);
      assert.equal(value(result).code, code);
      assert.equal(events.at(-1).status, 'error');
      assert.equal(events.at(-1).errorCode, code);
      assert.deepEqual(events.at(-1).candidates, []);
      assert.equal(JSON.stringify([result, events]).includes('private upstream response'), false);
    } finally { await service.stop(); }
  }
});

test('parent cancellation stops the actual fetch and publishes stopped without accepting a late result', async () => {
  const events = [], controller = new AbortController();
  let ready, fetchSignal;
  const started = new Promise(resolve => { ready = resolve; });
  const service = createLiteratureHandler({ env: {}, fetchImpl: async (_url, options) => { fetchSignal = options.signal; ready(); return new Promise(() => {}); } });
  try {
    const tools = createResearchLiterature({ search: service.search, signal: controller.signal, onSearch: item => events.push(item) });
    const pending = tools.call({ query: 'q' });
    const rejected = assert.rejects(pending, error => error.code === 'aborted');
    await started;
    controller.abort();
    await rejected;
    assert.equal(fetchSignal.aborted, true);
    assert.deepEqual(events.map(item => item.status), ['searching', 'stopped']);
    assert.equal(events.at(-1).candidates.length, 0);
    await assert.rejects(tools.call({ query: 'again' }), error => error.code === 'aborted');
    assert.equal(tools.searches.length, 1);
  } finally { await service.stop(); }
});

test('a slow external service times out as an error, rather than a false empty search', async () => {
  const service = createLiteratureHandler({ env: {}, timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  try {
    const tools = createResearchLiterature({ search: service.search });
    const result = await tools.call({ query: 'q' });
    assert.equal(value(result).code, 'timeout');
    assert.equal(tools.searches[0].status, 'error');
  } finally { await service.stop(); }
});

test('events and stored search snapshots do not share mutable candidate data with callers', async () => {
  const found = { candidates: [{ title: 'original' }], warnings: ['incomplete'], partial: true };
  const events = [];
  const tools = createResearchLiterature({ search: async () => found, onSearch: item => events.push(item) });
  await tools.call({ query: 'q' });
  found.candidates[0].title = 'changed service return';
  events.at(-1).candidates[0].title = 'changed event';
  const snapshot = tools.searches;
  snapshot[0].candidates[0].title = 'changed getter';
  assert.equal(tools.searches[0].candidates[0].title, 'original');
  assert.deepEqual(tools.searches[0].warnings, ['incomplete']);
  assert.equal(tools.searches[0].partial, true);
});

test('unavailable search never suggests model-generated candidates', async () => {
  const tools = createResearchLiterature();
  const result = await tools.call({ query: 'q' });
  assert.equal(result.success, false);
  assert.equal(value(result).code, 'unavailable');
  assert.deepEqual(tools.searches, []);
});
