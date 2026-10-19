import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createAIHandler, readCompletionStream, validateAISettings } from './ai.mjs';

const secret = 'test-private-key-never-send-to-client';
const env = { AI_API_KEY: secret };
const prompt = { requestId: 'request-1', purpose: 'chat', messages: [{ role: 'user', content: '解释这段论文。' }] };
const chunk = (content, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`;
const goodSSE = `${chunk('这是一条回答。')}${chunk('', 'stop')}data: [DONE]\n\n`;
const response = (body = goodSSE) => new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
const events = (text) => text.trim().split('\n').map((line) => JSON.parse(line));

async function withServer(options, run) {
  const server = createServer(createAIHandler({ env, ...options }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(server.address().port); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

function call(port, { path = '/api/ai/chat', method = 'POST', body = prompt, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1:8787', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('SSE parser preserves split UTF-8, CRLF, multiline data and excludes reasoning', async () => {
  const input = ': ping\r\ndata: {"choices": [\r\ndata: {"delta":{"reasoning_content":"hidden","content":"中文🦉"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(input);
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await Array.fromAsync(readCompletionStream(stream)), [{ type: 'delta', text: '中文🦉' }, { type: 'done' }]);
});

test('SSE accepts explicit stop or DONE, and detects truncated/error/length/malformed streams', async () => {
  for (const sse of [`${chunk('answer')}${chunk('', 'stop')}`, `${chunk('answer')}data: [DONE]`]) {
    assert.deepEqual(await Array.fromAsync(readCompletionStream(response(sse).body)), [{ type: 'delta', text: 'answer' }, { type: 'done' }]);
  }
  for (const [sse, code] of [
    [chunk('partial'), 'stream_interrupted'],
    [`${chunk('partial')}${chunk('', 'length')}`, 'output_limit'],
    [`${chunk('partial')}${chunk('', 'sensitive')}`, 'incomplete_response'],
    [`data: {"error":{"message":"${secret}"}}\n\n`, 'upstream_error'],
    ['data: not-json\n\n', 'invalid_stream'],
    ['data: {"choices":{}}\n\n', 'invalid_stream'],
    ['data: [DONE]\n\n', 'empty_response'],
  ]) {
    await assert.rejects(Array.fromAsync(readCompletionStream(response(sse).body)), (error) => error.code === code && !error.message.includes(secret));
  }
});

test('config exposes capabilities, never key or endpoint; missing config cannot call upstream', async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => { calls += 1; return response(); } }, async (port) => {
    const res = await call(port, { path: '/api/ai/config', method: 'GET', body: '' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { configured: true, model: 'glm-5.3-flash', provider: '智谱', images: false, mode: 'live', runtime: 'pi', tools: [], limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } });
    assert.equal(res.body.includes(secret), false);
    assert.equal(res.body.includes('bigmodel.cn'), false);
  });
  await withServer({ env: {}, fetchImpl: async () => { calls += 1; return response(); } }, async (port) => {
    assert.equal((await call(port)).status, 503);
    assert.equal(JSON.parse((await call(port, { path: '/api/ai/config', method: 'GET', body: '' })).body).mode, 'demo');
  });
  assert.equal(calls, 0);
});

test('invalid server configuration fails without exposing its value', () => {
  for (const config of [
    { AI_BASE_URL: `invalid-${secret}` },
    { AI_BASE_URL: `https://${secret}@example.com` },
    { AI_BASE_URL: `https://example.com/?key=${secret}` },
    { AI_PORT: secret }, { AI_MODEL: `${secret} ` + 'invalid model' },
  ]) assert.throws(() => createAIHandler({ env: { ...env, ...config } }), (error) => !error.message.includes(secret));
});

test('settings validation returns public capabilities without credentials', () => {
  const validated = validateAISettings({ ...env, AI_MODEL: 'custom-model', AI_BASE_URL: 'https://example.com/v1', AI_IMAGES: 'true' });
  assert.equal(validated.configured, true);
  assert.equal(validated.model, 'custom-model');
  assert.equal(validated.images, true);
  assert.equal(JSON.stringify(validated).includes(secret), false);
  assert.equal(JSON.stringify(validated).includes('example.com'), false);
  assert.throws(() => validateAISettings({ AI_BASE_URL: `http://${secret}.example` }), (error) => !error.message.includes(secret));
});

test('API keys reject non-visible ASCII, internal whitespace and excessive length before making a request', () => {
  const invalidKeys = ['synthetic-中文', 'synthetic-🔑', 'synthetic-\u200bkey', 'synthetic-é', 'synthetic-\u00a0key', 'synthetic key', 'synthetic\tkey', 'synthetic\nkey', 'synthetic\rkey', 'synthetic\u0000key', 'synthetic\u007fkey', 'x'.repeat(4097)];
  for (const key of invalidKeys) {
    const sanitized = error => error instanceof Error && /密钥|AI_API_KEY/.test(error.message) && !error.message.includes(key);
    assert.throws(() => validateAISettings({ AI_API_KEY: key }), sanitized);
    assert.throws(() => createAIHandler({ env: { AI_API_KEY: key } }), sanitized);
  }
  assert.equal(validateAISettings({ AI_API_KEY: 'x'.repeat(4096) }).configured, true);
  assert.equal(validateAISettings({ AI_API_KEY: ' \t\r\n ' }).configured, false);
});

test('API keys trim surrounding whitespace before forming the upstream authorization header', async () => {
  let calls = 0;
  await withServer({ env: { AI_API_KEY: ` \t\r\n${secret}\r\n ` }, fetchImpl: async (_url, options) => {
    calls += 1;
    assert.equal(options.headers.Authorization === `Bearer ${secret}`, true);
    assert.doesNotThrow(() => new Headers(options.headers));
    return response();
  } }, async (port) => {
    assert.equal((await call(port)).status, 200);
  });
  assert.equal(calls, 1);
});

test('optional desktop token protects both endpoints and retains caller validation', async () => {
  const localToken = 'desktop-session-private-token';
  let calls = 0;
  await withServer({ localToken, fetchImpl: async () => { calls += 1; return response(); } }, async (port) => {
    for (const token of [undefined, 'wrong', `${localToken}extra`, 'x'.repeat(localToken.length)]) {
      const headers = token === undefined ? {} : { 'X-Papertrail-Token': token };
      for (const options of [{}, { path: '/api/ai/config', method: 'GET', body: '' }]) {
        const res = await call(port, { ...options, headers });
        assert.equal(res.status, 403);
        assert.equal(events(res.body)[0].code, 'forbidden_token');
        assert.equal(res.body.includes(localToken), false);
      }
    }
    const headers = { 'X-Papertrail-Token': localToken };
    assert.equal((await call(port, { headers })).status, 200);
    const config = await call(port, { path: '/api/ai/config', method: 'GET', body: '', headers });
    assert.equal(config.status, 200);
    assert.equal(config.body.includes(localToken), false);
    assert.equal(config.body.includes(secret), false);
    assert.equal((await call(port, { headers: { ...headers, Origin: 'null' } })).status, 403);
    assert.equal((await call(port, { headers: { ...headers, Host: 'attacker.example:8787' } })).status, 403);
    assert.equal((await call(port, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });
  assert.equal(calls, 1);
});

test('live endpoint fixes model, URL and key server-side, emits only content with one terminal frame', async () => {
  let calls = 0;
  await withServer({ fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { model: 'glm-5.3-flash', messages: prompt.messages, stream: true, reasoning_effort: 'low', max_tokens: 8192 });
    return response();
  } }, async (port) => {
    const res = await call(port);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-type'], /^application\/x-ndjson/);
    assert.deepEqual(events(res.body), [{ type: 'delta', text: '这是一条回答。' }, { type: 'done', model: 'glm-5.3-flash' }]);
    assert.equal(res.body.includes(secret), false);
  });
  assert.equal(calls, 1);
});

test('shared Pi endpoint preserves card and revision JSON drafts without tool or file access', async () => {
  const draft = '{"title":"方法的条件","body":"只在给定条件下成立。","citationIds":["evidence-1"]}';
  let calls = 0;
  await withServer({ fetchImpl: async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.equal('tools' in body, false);
    assert.equal('tool_choice' in body, false);
    assert.deepEqual(body.messages, prompt.messages);
    return response(`${chunk(draft)}${chunk('', 'stop')}`);
  } }, async (port) => {
    for (const purpose of ['card', 'revision']) {
      const result = await call(port, { body: { ...prompt, requestId: purpose, purpose } });
      assert.equal(result.status, 200);
      const frames = events(result.body);
      assert.equal(frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text).join(''), draft);
      assert.deepEqual(frames.at(-1), { type: 'done', model: 'glm-5.3-flash' });
    }
  });
  assert.equal(calls, 2);
});

test('host, origin, fetch site, content type, roles and client configuration are checked before billing', async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => { calls += 1; return response(); } }, async (port) => {
    for (const headers of [
      { Host: 'attacker.example:8787' }, { Host: '127.0.0.1.attacker.example:8787' },
      { Origin: 'https://attacker.example' }, { Origin: 'null' },
      { Origin: 'http://localhost:1234' }, { Origin: 'http://localhost:5173/anything' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) assert.equal((await call(port, { headers })).status, 403);
    assert.equal((await call(port, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    for (const body of [
      { ...prompt, requestId: '' }, { ...prompt, purpose: 'tools' }, { ...prompt, model: 'other' },
      { ...prompt, key: 'other' }, { ...prompt, url: 'http://internal' },
      { ...prompt, messages: [] }, { ...prompt, messages: [{ role: 'tool', content: 'secret' }] },
      { ...prompt, messages: [{ role: 'assistant', content: 'unfinished' }] },
      { ...prompt, messages: [{ role: 'user', content: '' }] }, 'not-json',
    ]) assert.equal((await call(port, { body })).status, 400);
  });
  assert.equal(calls, 0);
});

test('text boundary is accepted, boundary plus one rejected before calling upstream', async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => { calls += 1; return response(); } }, async (port) => {
    const body = { ...prompt, messages: [{ role: 'user', content: 'x'.repeat(120000) }] };
    assert.equal((await call(port, { body })).status, 200);
    body.messages[0].content += 'x';
    const res = await call(port, { body });
    assert.equal(res.status, 413);
    assert.equal(events(res.body)[0].code, 'context_too_large');
  });
  assert.equal(calls, 1);
});

test('images require explicit capability; only bounded local image data is accepted', async () => {
  const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;
  const body = (url, count = 1) => ({ ...prompt, messages: [{ role: 'user', content: [{ type: 'text', text: '这张图是什么？' }, ...Array.from({ length: count }, () => ({ type: 'image_url', image_url: { url } }))] }] });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(); };
  await withServer({ fetchImpl }, async (port) => {
    assert.equal(events((await call(port, { body: body(png) })).body)[0].code, 'images_unsupported');
  });
  await withServer({ env: { ...env, AI_IMAGES: 'true' }, fetchImpl }, async (port) => {
    for (const url of ['http://127.0.0.1/private', 'https://attacker.example/image.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,%%%%', 'data:image/png;base64,YQ==']) {
      assert.equal((await call(port, { body: body(url) })).status, 400);
    }
    assert.equal((await call(port, { body: body(png, 5) })).status, 413);
    const large = Buffer.alloc(8388609);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(large);
    assert.equal(events((await call(port, { body: body(`data:image/png;base64,${large.toString('base64')}`) })).body)[0].code, 'image_too_large');
    assert.equal((await call(port, { body: body(png) })).status, 200);
  });
  assert.equal(calls, 1);
});

test('upstream authentication, quota and malformed streams are sanitized, without automatic retries', async () => {
  for (const [status, code] of [[401, 'authentication_failed'], [403, 'authentication_failed'], [429, 'rate_limited'], [500, 'upstream_error']]) {
    let calls = 0;
    await withServer({ fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ error: { message: secret } }), { status }); } }, async (port) => {
      const res = await call(port);
      assert.equal(events(res.body)[0].code, code);
      assert.equal(res.body.includes(secret), false);
    });
    assert.equal(calls, 1);
  }
  for (const [fetchImpl, code] of [
    [async () => { throw new Error(secret); }, 'connection_failed'],
    [async () => new Response(secret), 'invalid_stream'],
    [async () => response(chunk('partial')), 'stream_interrupted'],
    [async () => response(`data: {"error":{"message":"${secret}"}}\n\n`), 'upstream_error'],
  ]) await withServer({ fetchImpl }, async (port) => {
    const res = await call(port);
    assert.equal(events(res.body).at(-1).code, code);
    assert.equal(events(res.body).some((event) => event.type === 'done'), false);
    assert.equal(res.body.includes(secret), false);
  });
});

test('timeouts abort the upstream and emit a single recoverable error', async () => {
  let aborted = false;
  await withServer({ timeoutMs: 20, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) }, async (port) => {
    const res = await call(port);
    assert.equal(res.status, 504);
    assert.equal(events(res.body)[0].code, 'timeout');
    assert.equal(events(res.body).length, 1);
  });
  assert.equal(aborted, true);
});

test('timeouts after a partial answer retain the partial text and never report completion', async () => {
  await withServer({ timeoutMs: 20, fetchImpl: async (_url, { signal }) => response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(chunk('partial')));
    signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  } })) }, async (port) => {
    const res = await call(port);
    assert.equal(res.status, 200);
    assert.deepEqual(events(res.body).map((event) => event.type), ['delta', 'error']);
    assert.equal(events(res.body)[0].text, 'partial');
    assert.equal(events(res.body)[1].code, 'timeout');
  });
});

test('closing the browser response cancels the upstream request', async () => {
  let upstreamSignal;
  let resolveAbort;
  const abortSeen = new Promise((resolve) => { resolveAbort = resolve; });
  await withServer({ fetchImpl: async (_url, { signal }) => {
    upstreamSignal = signal;
    return response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk('partial')));
      signal.addEventListener('abort', () => { resolveAbort(); controller.error(signal.reason); }, { once: true });
    } }));
  } }, async (port) => {
    await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/ai/chat', method: 'POST', headers: { Host: 'localhost:8787', 'Content-Type': 'application/json' } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', reject);
      req.end(JSON.stringify(prompt));
    });
    await Promise.race([abortSeen, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('upstream did not abort')), 1000); timer.unref(); })]);
    assert.equal(upstreamSignal.aborted, true);
  });
});

test('concurrent duplicate requests and more than two active calls do not create extra billed calls', async () => {
  const releases = [];
  await withServer({ fetchImpl: () => new Promise((resolve) => { releases.push(() => resolve(response())); }) }, async (port) => {
    const first = call(port);
    while (releases.length < 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await call(port)).status, 409);
    const second = call(port, { body: { ...prompt, requestId: 'request-2' } });
    while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await call(port, { body: { ...prompt, requestId: 'request-3' } })).status, 429);
    releases.forEach((release) => release());
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.equal(releases.length, 2);
  });
});
