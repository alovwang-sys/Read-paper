import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createLiteratureHandler } from './literature.mjs';

const secret = 'private-openalex-key';
const work = () => ({
  id: 'https://openalex.org/W4389519118', display_name: 'Active Retrieval Augmented Generation',
  publication_year: 2023, doi: 'https://doi.org/10.18653/v1/2023.emnlp-main.495',
  authorships: [{ author: { display_name: 'Zhengbao Jiang' } }, { raw_author_name: 'Frank F. Xu' }],
  abstract_inverted_index: { evidence: [1], 'More': [0, 2] },
  primary_location: { landing_page_url: 'https://doi.org/10.18653/v1/2023.emnlp-main.495', is_oa: false, pdf_url: 'https://closed.example/paper.pdf' },
  best_oa_location: { is_oa: true, pdf_url: 'https://aclanthology.org/2023.emnlp-main.495.pdf' },
});
const json = (results = [work()]) => new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
async function withServer(options, run) {
  const handler = createLiteratureHandler({ env: {}, ...options });
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(server.address().port, handler); }
  finally { await handler.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function call(port, { path = '/api/ai/literature/search', method = 'POST', body = { query: 'retrieval augmented generation' }, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('search sends only bounded query to OpenAlex and returns traceable JSON metadata without credentials', async () => {
  let calls = 0;
  await withServer({ env: { OPENALEX_API_KEY: ` ${secret} ` }, fetchImpl: async (input, options) => {
    calls += 1;
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://api.openalex.org/works');
    assert.equal(url.searchParams.get('search'), 'A & B? #context');
    assert.equal(url.searchParams.get('per_page'), '10');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.has('api_key'), false);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(options.headers.Accept, 'application/json');
    return json();
  } }, async port => {
    const result = await call(port, { body: { query: ' A & B? #context ' } });
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /application\/json/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.body.includes(secret), false);
    const { candidates, partial } = JSON.parse(result.body);
    assert.equal(partial, undefined);
    assert.deepEqual({ ...candidates[0], retrievedAt: 'time' }, {
      id: 'openalex-W4389519118', provider: 'openalex', providerId: 'W4389519118',
      title: 'Active Retrieval Augmented Generation', authors: ['Zhengbao Jiang', 'Frank F. Xu'], year: 2023,
      doi: '10.18653/v1/2023.emnlp-main.495', url: 'https://doi.org/10.18653/v1/2023.emnlp-main.495',
      abstract: 'More evidence More', pdfUrl: 'https://aclanthology.org/2023.emnlp-main.495.pdf', retrievedAt: 'time',
    });
    assert.ok(Number.isFinite(Date.parse(candidates[0].retrievedAt)));
  });
  assert.equal(calls, 1);
});

test('anonymous query works; absent metadata stays absent and skipped entries are distinguished from zero results', async () => {
  const minimal = { id: 'https://openalex.org/W1', display_name: '<b>untrusted title</b>', primary_location: { landing_page_url: 'javascript:alert(1)' }, best_oa_location: { is_oa: false, pdf_url: 'https://example.com/restricted.pdf' } };
  await withServer({ fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, undefined); return json([minimal, null, minimal]); } }, async port => {
    const result = await call(port);
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.partial, true);
    assert.equal(body.candidates.length, 1);
    assert.deepEqual(body.candidates[0].authors, []);
    assert.equal(body.candidates[0].title, '<b>untrusted title</b>');
    assert.equal(body.candidates[0].url, 'https://openalex.org/W1');
    for (const field of ['year', 'doi', 'abstract', 'pdfUrl']) assert.equal(Object.hasOwn(body.candidates[0], field), false);
    assert.equal(body.warnings.length, 2);
  });
  await withServer({ fetchImpl: async () => json([]) }, async port => {
    assert.deepEqual(JSON.parse((await call(port)).body), { candidates: [] });
  });
  await withServer({ fetchImpl: async () => json([null, { id: 'https://openalex.org/W1', display_name: null }]) }, async port => {
    const result = await call(port);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).code, 'invalid_response');
  });
});

test('malformed abstracts and unsafe PDF links do not invent source content', async () => {
  for (const index of [{ one: [500_000_000] }, { one: [0], two: [0] }, { one: [1] }, { one: [-1] }, { one: ['0'] }, { one: [] }]) {
    await withServer({ fetchImpl: async () => json([{ ...work(), abstract_inverted_index: index, best_oa_location: { is_oa: true, pdf_url: 'https://user:password@example.com/file.pdf' } }]) }, async port => {
      const body = JSON.parse((await call(port)).body);
      assert.equal(body.candidates[0].abstract, undefined);
      assert.equal(body.candidates[0].pdfUrl, undefined);
      assert.equal(body.partial, true);
    });
  }
});

test('invalid input and non-search paths never reach the external service', async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => { calls += 1; return json(); } }, async port => {
    for (const options of [
      { body: { query: '' } }, { body: { query: 'q'.repeat(501) } }, { body: { query: 'a\nb' } },
      { body: { query: 'q', endpoint: 'https://example.com' } }, { body: [] }, { body: 'invalid json' },
    ]) assert.equal((await call(port, options)).status, 400);
    assert.equal((await call(port, { method: 'GET', body: '' })).status, 405);
    assert.equal((await call(port, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await call(port, { body: 'x'.repeat(5000) })).status, 413);
    assert.equal((await call(port, { path: '/other' })).status, 404);
    assert.equal((await call(port, { body: { query: 'q'.repeat(500) } })).status, 200);
  });
  assert.equal(calls, 1);
});

test('publication year filters use inclusive bounds and remain absent unless selected', async () => {
  const bodies = [{ query: 'q', yearFrom: 2020, yearTo: 2024 }, { query: 'q', yearFrom: 2024 }, { query: 'q', yearTo: 2024 }, { query: 'q', yearFrom: 1, yearTo: 9999 }, { query: 'q', yearFrom: 2024, yearTo: 2024 }, { query: 'q' }];
  const filters = ['publication_year:2020-2024', 'publication_year:2024-9999', 'publication_year:1-2024', 'publication_year:1-9999', 'publication_year:2024-2024', null];
  let calls = 0;
  await withServer({ fetchImpl: async input => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('filter'), filters[calls++]);
    assert.equal(url.searchParams.get('search'), 'q');
    assert.equal(url.searchParams.get('per_page'), '10');
    return json();
  } }, async port => { for (const body of bodies) assert.equal((await call(port, { body })).status, 200); });
  assert.equal(calls, bodies.length);
});

test('invalid years, reversed ranges and extra filter fields are rejected before fetching', async () => {
  await withServer({ fetchImpl: async () => { assert.fail('must not fetch'); } }, async port => {
    for (const fields of [{ yearFrom: 0 }, { yearTo: 10000 }, { yearFrom: 2020.5 }, { yearTo: '2024' }, { yearFrom: null }, { yearFrom: 2025, yearTo: 2020 }, { yearFrom: 2020, filter: 'is_oa:true' }, { yearFrom: [] }]) {
      const result = await call(port, { body: { query: 'q', ...fields } });
      assert.equal(result.status, 400);
      assert.equal(JSON.parse(result.body).code, 'invalid_request');
    }
  });
});

test('invalid key configuration fails locally without exposing the key', async () => {
  for (const key of [`${secret}\ninvalid`, `${secret} invalid`, 'x'.repeat(4097)]) {
    await withServer({ env: { OPENALEX_API_KEY: key }, fetchImpl: async () => { assert.fail('must not fetch'); } }, async port => {
      const result = await call(port);
      assert.equal(result.status, 503);
      assert.equal(JSON.parse(result.body).code, 'configuration_invalid');
      assert.equal(result.body.includes(secret), false);
    });
  }
});

test('authentication, quota, network and invalid responses remain separate, sanitized and never retried', async () => {
  for (const [fetchImpl, status, code] of [
    [async () => new Response(secret, { status: 401 }), 502, 'authentication_failed'],
    [async () => new Response(secret, { status: 403 }), 502, 'authentication_failed'],
    [async () => new Response(secret, { status: 429 }), 429, 'rate_limited'],
    [async () => new Response(secret, { status: 400 }), 400, 'invalid_query'],
    [async () => new Response(secret, { status: 503 }), 502, 'upstream_error'],
    [async () => { throw new Error(secret); }, 502, 'connection_failed'],
    [async () => new Response(secret, { headers: { 'Content-Type': 'text/html' } }), 502, 'invalid_response'],
    [async () => new Response(secret, { headers: { 'Content-Type': 'application/json' } }), 502, 'invalid_response'],
    [async () => json(Array.from({ length: 11 }, work)), 502, 'invalid_response'],
  ]) {
    let calls = 0;
    await withServer({ fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); } }, async port => {
      const result = await call(port);
      assert.equal(result.status, status);
      assert.equal(JSON.parse(result.body).code, code);
      assert.equal(result.body.includes(secret), false);
    });
    assert.equal(calls, 1);
  }
});

test('content length and streamed response size are bounded', async () => {
  for (const fetchImpl of [
    async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '3000000' } }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    await withServer({ fetchImpl }, async port => {
      const result = await call(port);
      assert.equal(result.status, 502);
      assert.equal(JSON.parse(result.body).code, 'response_too_large');
    });
  }
});

test('timeout aborts both a stalled fetch and a stalled response body', async () => {
  for (const streaming of [false, true]) {
    let signal;
    let canceled = false;
    await withServer({ timeoutMs: 25, fetchImpl: async (_url, options) => {
      signal = options.signal;
      if (!streaming) return new Promise(() => {});
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'application/json' } });
    } }, async port => {
      const result = await call(port);
      assert.equal(result.status, 504);
      assert.equal(JSON.parse(result.body).code, 'timeout');
      assert.equal(signal.aborted, true);
      if (streaming) assert.equal(canceled, true);
    });
  }
});

test('browser disconnect and service stop abort in-flight requests', async () => {
  let signal;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  await withServer({ fetchImpl: async (_url, options) => { signal = options.signal; started(); return new Promise(() => {}); } }, async port => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/ai/literature/search', method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify({ query: 'query' }));
    await ready;
    const aborted = once(signal, 'abort');
    req.destroy();
    await aborted;
    assert.equal(signal.aborted, true);
  });
  let startedStop;
  const readyStop = new Promise(resolve => { startedStop = resolve; });
  await withServer({ fetchImpl: async () => { startedStop(); return new Promise(() => {}); } }, async (port, handler) => {
    const request = call(port);
    await readyStop;
    await handler.stop();
    assert.equal(JSON.parse((await request).body).code, 'aborted');
  });
});

test('two active requests cap concurrent external searches', async () => {
  const releases = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  await withServer({ fetchImpl: () => new Promise(resolve => { releases.push(() => resolve(json())); if (releases.length === 2) started(); }) }, async port => {
    const requests = [call(port), call(port)];
    await ready;
    const third = await call(port);
    assert.equal(third.status, 429);
    assert.equal(JSON.parse(third.body).code, 'concurrency_limit');
    assert.equal(releases.length, 2);
    releases.forEach(release => release());
    assert.ok((await Promise.all(requests)).every(result => result.status === 200));
  });
});

test('HTTP and Agent searches share the same two-request concurrency boundary', async () => {
  const releases = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  await withServer({ fetchImpl: () => new Promise(resolve => { releases.push(() => resolve(json())); if (releases.length === 2) started(); }) }, async (port, handler) => {
    const direct = handler.search({ query: 'Agent search', yearFrom: 2024 });
    const browser = call(port);
    await ready;
    await assert.rejects(handler.search({ query: 'third request' }), error => error.status === 429 && error.code === 'concurrency_limit');
    assert.equal(releases.length, 2);
    releases.forEach(release => release());
    assert.equal((await direct).candidates.length, 1);
    assert.equal((await browser).status, 200);
  });
});

test('shared search rejects invalid direct arguments and an already-canceled request without fetching', async () => {
  let calls = 0;
  const handler = createLiteratureHandler({ env: {}, fetchImpl: async () => { calls += 1; return json(); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(handler.search({ query: 'q', prompt: 'private content' }), error => error.code === 'invalid_request');
  await assert.rejects(handler.search({ query: 'q' }, { signal: controller.signal }), error => error.code === 'aborted');
  assert.equal(calls, 0);
  await handler.stop();
});

test('service shutdown also cancels a shared Agent search', async () => {
  let started, fetchSignal;
  const ready = new Promise(resolve => { started = resolve; });
  const handler = createLiteratureHandler({ env: {}, fetchImpl: async (_url, options) => { fetchSignal = options.signal; started(); return new Promise(() => {}); } });
  const pending = handler.search({ query: 'q' });
  const rejected = assert.rejects(pending, error => error.code === 'aborted');
  await ready;
  await handler.stop();
  await rejected;
  assert.equal(fetchSignal.aborted, true);
});
